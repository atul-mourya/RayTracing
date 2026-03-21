import { Fn, wgslFn, uniform, int, uint, ivec2, uvec2, If,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { NearestFilter, LinearFilter, RGBAFormat, HalfFloatType, FloatType } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import { DEFAULT_STATE } from '../../Constants.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Map temporal variance to normalised sample count with convergence logic.
 *
 * Uses temporal variance (frame-to-frame pixel change from VarianceEstimationStage)
 * as the primary convergence signal, with a small spatial variance boost for noisy
 * neighbourhoods where the temporal EMA may underestimate.
 *
 * Returns vec4f(normalizedSamples, varianceRatio, converged, 1.0).
 */
const computeSamplingGuidance = /*@__PURE__*/ wgslFn( `
	fn computeSamplingGuidance(
		temporalVariance: f32,
		spatialVariance: f32,
		meanLuminance: f32,
		threshold: f32,
		frame: i32,
		minFrames: i32,
		convThreshold: f32,
		sensitivity: f32,
		convSpeedScale: f32
	) -> vec4f {

		// The path tracer accumulates via alpha = 1/(frame+1), so temporal variance
		// of the accumulated output shrinks as ~sigma²/(frame+1)². Scale by (frame+1)
		// to get accumulated image quality ~sigma²/N — decreases as image converges.
		let frameScale = f32( frame + 1 );
		let effectiveVariance = temporalVariance * frameScale;

		// Normalize by luminance² — converts absolute variance to relative (CV²).
		// Floor of 0.01 prevents noise amplification for near-black pixels
		// (linear luminance < 0.1 → below perceptual visibility threshold).
		let normFactor = max( meanLuminance * meanLuminance, 0.01 );
		let normalizedVariance = effectiveVariance / normFactor;

		let varianceRatio = clamp( normalizedVariance / threshold, 0.0, 1.0 );

		// Apply sensitivity — higher values assign more samples to noisy pixels
		var normalizedSamples = clamp( varianceRatio * sensitivity, 0.0, 1.0 );

		// Small spatial boost for noisy neighbourhoods (un-scaled — provides
		// a minor secondary signal that naturally diminishes as image converges)
		let spatialBoost = clamp( spatialVariance / ( threshold * 4.0 ), 0.0, 0.2 );
		normalizedSamples = clamp( normalizedSamples + spatialBoost, 0.0, 1.0 );

		// Warm-up: variance estimates need a few frames to stabilise
		if ( frame < minFrames ) {

			let warmupFactor = f32( frame ) / f32( minFrames );
			normalizedSamples = mix( 1.0, normalizedSamples, warmupFactor * warmupFactor );

		}

		// Convergence: mark pixel only when per-frame noise is truly negligible.
		// convSpeedScale controls aggressiveness: higher = easier to converge
		// (scales the threshold up, so more pixels qualify as converged).
		let scaledConvThreshold = convThreshold * convSpeedScale;
		var converged = 0.0;
		if ( normalizedVariance < scaledConvThreshold && frame > minFrames ) {

			converged = 1.0;

		}

		return vec4f(
			normalizedSamples,
			varianceRatio,
			converged,
			1.0
		);

	}
` );

/**
 * 5-colour heatmap gradient with convergence desaturation.
 *
 * blue (t=0) → cyan → green → yellow → red (t=1)
 */
const heatmapGradient = /*@__PURE__*/ wgslFn( `
	fn heatmapGradient( t: f32, normalizedVariance: f32, converged: f32 ) -> vec4f {

		let r = clamp( ( t - 0.5 ) * 4.0, 0.0, 1.0 );
		let g = clamp( t * 4.0, 0.0, 1.0 ) - clamp( ( t - 0.75 ) * 4.0, 0.0, 1.0 );
		let b = 1.0 - clamp( ( t - 0.25 ) * 4.0, 0.0, 1.0 );

		var color = vec3f( r, g, b );

		// Convergence: desaturate converged pixels
		if ( converged > 0.5 ) {

			let gray = color.x * 0.299 + color.y * 0.587 + color.z * 0.114;
			color = mix( color, vec3f( gray ), 0.6 );

		}

		// Brightness modulation
		color *= 0.7 + normalizedVariance * 0.3;

		return vec4f( color, 1.0 );

	}
` );

/**
 * WebGPU Adaptive Sampling Stage (Compute Shader)
 *
 * Reads per-pixel temporal variance from VarianceEstimationStage and
 * produces a guidance texture that tells the path tracer how many
 * samples each pixel needs.
 *
 * Algorithm:
 *   1. Read temporal + spatial variance from variance:output
 *   2. Map temporal variance → normalised sample count (0–1)
 *   3. Apply sensitivity scaling and spatial boost
 *   4. Warm-up ramp for early frames (variance EMA not yet stable)
 *   5. Mark converged pixels (temporal variance below threshold)
 *   6. Write (normalizedSamples, varianceRatio, converged, 1) to StorageTexture
 *
 * Output format (RGBA HalfFloat):
 *   R — normalizedSamples  (0-1, multiply by adaptiveSamplingMax)
 *   G — variance / threshold (debug / convergence weight)
 *   B — convergedFlag       (1.0 = pixel converged, skip sampling)
 *   A — 1.0
 *
 * The path tracer reads this via getRequiredSamples() in TSL/PathTracer.js.
 *
 * Execution: PER_CYCLE — only updates when a full tile cycle completes,
 * ensuring variance is computed from complete frame data.
 *
 * Textures published:  adaptiveSampling:output
 * Textures read:       variance:output (from VarianceEstimationStage)
 */
export class AdaptiveSamplingStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'AdaptiveSampling', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;
		this.frameNumber = 0;
		this.delayByFrames = options.delayByFrames ?? 2;
		this.showAdaptiveSamplingHelper = false;

		// Sampling parameters
		this.adaptiveSamplingMax = uniform( options.adaptiveSamplingMax ?? DEFAULT_STATE.adaptiveSamplingMax ?? 32, 'int' );
		this.varianceThreshold = uniform( options.varianceThreshold ?? DEFAULT_STATE.adaptiveSamplingVarianceThreshold ?? 0.01 );
		this.materialBias = uniform( options.materialBias ?? DEFAULT_STATE.adaptiveSamplingMaterialBias ?? 1.2 );
		this.edgeBias = uniform( options.edgeBias ?? DEFAULT_STATE.adaptiveSamplingEdgeBias ?? 1.5 );
		this.convergenceSpeed = uniform( options.convergenceSpeed ?? DEFAULT_STATE.adaptiveSamplingConvergenceSpeed ?? 2.0 );
		this.frameNumberUniform = uniform( 0, 'int' );

		// Resolution uniforms (int for compute pixel coords)
		this.resolutionWidth = uniform( options.width || 1024 );
		this.resolutionHeight = uniform( options.height || 1024 );

		// Convergence parameters — temporal variance stabilises after ~10 frames (EMA alpha=0.1)
		this.minConvergenceFrames = uniform( 10 );
		// Must be well below varianceThreshold — convergence means "skip entirely".
		// With (frame+1)² scaling, effective variance ≈ 5×σ², so 0.01 → σ² ≈ 0.002.
		this.convergenceThreshold = uniform( 0.01 );

		// StorageTexture for compute output (replaces RenderTarget)
		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter for textureLoad codegen compatibility
		this._outputStorageTex = new StorageTexture( w, h );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = LinearFilter;
		this._outputStorageTex.magFilter = LinearFilter;

		// Heatmap StorageTexture for compute output
		this._heatmapStorageTex = new StorageTexture( w, h );
		this._heatmapStorageTex.type = FloatType;
		this._heatmapStorageTex.format = RGBAFormat;
		this._heatmapStorageTex.minFilter = NearestFilter;
		this._heatmapStorageTex.magFilter = NearestFilter;

		// Heatmap render target — FloatType for clean CPU readback via RenderTargetHelper
		this.heatmapTarget = new RenderTarget( w, h, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 16 );
		this._dispatchY = Math.ceil( h / 16 );

		// Input: variance texture from VarianceEstimationStage
		// Use regular TextureNode (not StorageTexture) as compile-time placeholder so
		// textureLoad codegen includes the required level parameter for texture_2d
		this._varianceTexNode = new TextureNode();

		// Build compute + heatmap shaders
		this._buildCompute();
		this._buildHeatmapCompute();

		// Floating overlay for heatmap visualization
		this.helper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-right',
			theme: 'dark',
			title: 'Adaptive Sampling',
			autoUpdate: false
		} );
		this.helper.hide();
		document.body.appendChild( this.helper );

	}

	/**
	 * Build compute shader that maps variance → sampling guidance.
	 *
	 * Reads per-pixel temporal and spatial variance from VarianceEstimationStage
	 * output and maps it to a normalised sample count. No shared memory needed —
	 * each thread processes one pixel independently.
	 *
	 * Workgroup: [8,8,1] — 64 threads per workgroup
	 */
	_buildCompute() {

		const varianceTex = this._varianceTexNode;
		const threshold = this.varianceThreshold;
		const sensitivity = this.materialBias; // "Sensitivity": higher = more samples for noisy pixels
		const convSpeedScale = this.convergenceSpeed; // "Convergence Speed": scales convergence threshold
		const frame = this.frameNumberUniform;
		const minFrames = this.minConvergenceFrames;
		const convThreshold = this.convergenceThreshold;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._outputStorageTex;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Variance texture: R=mean, G=meanSq, B=temporalVariance, A=spatialVariance
				const varianceData = textureLoad( varianceTex, ivec2( gx, gy ) );

				const result = computeSamplingGuidance(
					varianceData.z, // temporal variance
					varianceData.w, // spatial variance
					varianceData.x, // mean luminance (for HDR normalization)
					threshold,
					int( frame ),
					int( minFrames ),
					convThreshold,
					sensitivity,
					convSpeedScale
				);

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	/**
	 * Build heatmap visualization compute shader.
	 *
	 * Reads the sampling guidance StorageTexture via textureLoad and maps
	 * normalizedSamples to a smooth blue→cyan→green→yellow→red gradient.
	 * Converged pixels are desaturated, brightness is modulated by variance.
	 * Writes to _heatmapStorageTex, then copied to heatmapTarget for
	 * RenderTargetHelper display.
	 */
	_buildHeatmapCompute() {

		const samplingTex = this._outputStorageTex;
		const heatmapOut = this._heatmapStorageTex;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const data = textureLoad( samplingTex, ivec2( gx, gy ) );
				const result = heatmapGradient( data.x.clamp( 0.0, 1.0 ), data.y, data.z );

				textureStore(
					heatmapOut,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._heatmapComputeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	/**
	 * Toggle heatmap overlay visibility.
	 * @param {boolean} val — show/hide
	 */
	toggleHelper( val ) {

		this.showAdaptiveSamplingHelper = val;
		val ? this.helper.show() : this.helper.hide();

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Delay a few frames to let the path tracer accumulate
		this.frameNumber ++;
		if ( this.frameNumber <= this.delayByFrames ) return;

		this.frameNumberUniform.value = this.frameNumber;

		// Get temporal/spatial variance from VarianceEstimationStage
		const varianceTexture = context.getTexture( 'variance:output' );
		if ( ! varianceTexture ) return;

		// Auto-match storage texture size to variance output
		const img = varianceTexture.image;
		if ( img && img.width > 0 && img.height > 0 &&
			( img.width !== this._outputStorageTex.image.width ||
			  img.height !== this._outputStorageTex.image.height ) ) {

			this.setSize( img.width, img.height );

		}

		// Update input texture (no shader recompile, just swap value)
		this._varianceTexNode.value = varianceTexture;

		// Compute dispatch — map variance → sampling guidance
		this.renderer.compute( this._computeNode );

		// Publish guidance texture for PathTracingStage to consume
		// (StorageTexture extends Texture, works as regular texture for sampling)
		context.setTexture( 'adaptiveSampling:output', this._outputStorageTex );

		// Render heatmap + update helper overlay if visualization enabled
		if ( this.showAdaptiveSamplingHelper ) {

			this.renderer.compute( this._heatmapComputeNode );
			this.renderer.copyTextureToTexture( this._heatmapStorageTex, this.heatmapTarget.texture );
			this.helper.update();

		}

	}

	reset() {

		this.frameNumber = 0;
		this.frameNumberUniform.value = 0;

	}

	setSize( width, height ) {

		this._outputStorageTex.setSize( width, height );
		this._heatmapStorageTex.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.heatmapTarget.texture.needsUpdate = true;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		this._computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		this._heatmapComputeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	setAdaptiveSamplingMax( value ) {

		this.adaptiveSamplingMax.value = value;

	}

	setVarianceThreshold( value ) {

		this.varianceThreshold.value = value;

	}

	setMaterialBias( value ) {

		this.materialBias.value = value;

	}

	setEdgeBias( value ) {

		this.edgeBias.value = value;

	}

	setConvergenceSpeed( value ) {

		this.convergenceSpeed.value = value;

	}

	/**
	 * Unified setter for multiple adaptive sampling parameters.
	 * @param {Object} params
	 * @param {number} [params.threshold] - Variance threshold
	 * @param {number} [params.materialBias] - Material bias multiplier
	 * @param {number} [params.edgeBias] - Edge bias multiplier
	 * @param {number} [params.convergenceSpeedUp] - Convergence speed
	 * @param {number} [params.adaptiveSamplingMax] - Max samples
	 */
	setAdaptiveSamplingParameters( params ) {

		if ( params.threshold !== undefined ) this.setVarianceThreshold( params.threshold );
		if ( params.materialBias !== undefined ) this.setMaterialBias( params.materialBias );
		if ( params.edgeBias !== undefined ) this.setEdgeBias( params.edgeBias );
		if ( params.convergenceSpeedUp !== undefined ) this.setConvergenceSpeed( params.convergenceSpeedUp );
		if ( params.adaptiveSamplingMax !== undefined ) this.setAdaptiveSamplingMax( params.adaptiveSamplingMax );

	}

	dispose() {

		this._computeNode?.dispose();
		this._heatmapComputeNode?.dispose();
		this._heatmapStorageTex?.dispose();
		this._outputStorageTex?.dispose();
		this.heatmapTarget?.dispose();
		this.helper?.dispose();

	}

}
