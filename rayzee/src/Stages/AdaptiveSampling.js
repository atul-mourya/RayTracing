import { Fn, wgslFn, uniform, int, uint, ivec2, uvec2, If,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { NearestFilter, LinearFilter, RGBAFormat, HalfFloatType, FloatType, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Map temporal variance to normalised sample count with convergence logic.
 *
 * Uses temporal variance (frame-to-frame pixel change from Variance)
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
 * Reads per-pixel temporal variance from Variance and
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
 * Textures read:       variance:output (from Variance)
 */
export class AdaptiveSampling extends RenderStage {

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

		// StorageTextures stay at max alloc — see resize crash fix (three.js #33061).

		// LinearFilter for textureLoad codegen compatibility
		this._outputStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = LinearFilter;
		this._outputStorageTex.magFilter = LinearFilter;

		// Heatmap StorageTexture for compute output
		this._heatmapStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._heatmapStorageTex.type = FloatType;
		this._heatmapStorageTex.format = RGBAFormat;
		this._heatmapStorageTex.minFilter = NearestFilter;
		this._heatmapStorageTex.magFilter = NearestFilter;

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Guidance render target — copy target of the over-allocated storage texture;
		// PathTracer UV-samples this, so it must stay at the active resolution.
		this._outputTarget = new RenderTarget( w, h, {
			format: RGBAFormat,
			type: HalfFloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Heatmap render target — FloatType, exposed as a public field for hosts to
		// display via their own readback helper.
		this.heatmapTarget = new RenderTarget( w, h, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		// Input: variance texture from Variance
		// Use regular TextureNode (not StorageTexture) as compile-time placeholder so
		// textureLoad codegen includes the required level parameter for texture_2d
		this._varianceTexNode = new TextureNode();

		// Build compute + heatmap shaders
		this._buildCompute();
		this._buildHeatmapCompute();

	}

	setupEventListeners() {

		this.on( 'pathtracer:viewpointChanged', () => this.reset() );

	}

	/**
	 * Build compute shader that maps variance → sampling guidance.
	 *
	 * Reads per-pixel temporal and spatial variance from Variance
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

		const WG_SIZE = 8;

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
	 * Writes to _heatmapStorageTex, then copied to the public heatmapTarget
	 * RenderTarget so the host can display it.
	 */
	_buildHeatmapCompute() {

		const samplingTex = this._outputStorageTex;
		const heatmapOut = this._heatmapStorageTex;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;

		const WG_SIZE = 8;

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
	 * Enable or disable the heatmap compute pass. When enabled, the heatmap is
	 * rendered each frame to {@link this.heatmapTarget} (a public RenderTarget)
	 * for the host to display however it wants.
	 */
	setHeatmapEnabled( enabled ) {

		this.showAdaptiveSamplingHelper = enabled;

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Delay a few frames to let the path tracer accumulate
		this.frameNumber ++;
		if ( this.frameNumber <= this.delayByFrames ) return;

		this.frameNumberUniform.value = this.frameNumber;

		// Get temporal/spatial variance from Variance
		const varianceTexture = context.getTexture( 'variance:output' );
		if ( ! varianceTexture ) return;

		// Auto-match output target size to variance output
		const img = varianceTexture.image;
		if ( img && img.width > 0 && img.height > 0 &&
			( img.width !== this._outputTarget.width ||
			  img.height !== this._outputTarget.height ) ) {

			this.setSize( img.width, img.height );

		}

		// Update input texture (no shader recompile, just swap value)
		this._varianceTexNode.value = varianceTexture;

		// Compute dispatch — map variance → sampling guidance
		this.renderer.compute( this._computeNode );

		// Copy active region out of the over-allocated StorageTexture into the
		// right-sized RenderTarget; PathTracer UV-samples the latter.
		this._srcRegion.max.set( this._outputTarget.width, this._outputTarget.height );
		this.renderer.copyTextureToTexture( this._outputStorageTex, this._outputTarget.texture, this._srcRegion );

		// Publish guidance texture for PathTracer to consume
		context.setTexture( 'adaptiveSampling:output', this._outputTarget.texture );

		// Render heatmap into public heatmapTarget when enabled
		if ( this.showAdaptiveSamplingHelper ) {

			this.renderer.compute( this._heatmapComputeNode );
			this._srcRegion.max.set( this.heatmapTarget.width, this.heatmapTarget.height );
			this.renderer.copyTextureToTexture( this._heatmapStorageTex, this.heatmapTarget.texture, this._srcRegion );

		}

	}

	reset() {

		this.frameNumber = 0;
		this.frameNumberUniform.value = 0;

		// Remove stale guidance from context so PathTracer (which runs
		// before us) doesn't read converged-pixel data from the old viewpoint
		// during the delay frames before we publish fresh guidance.
		if ( this.context ) this.context.removeTexture( 'adaptiveSampling:output' );

	}

	setSize( width, height ) {

		// StorageTextures stay at their max allocation (see constructor).
		this._outputTarget.setSize( width, height );
		this._outputTarget.texture.needsUpdate = true;
		this.heatmapTarget.setSize( width, height );
		this.heatmapTarget.texture.needsUpdate = true;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._heatmapComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

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
		this._outputTarget?.dispose();
		this.heatmapTarget?.dispose();
		this._varianceTexNode?.dispose();

		this._computeNode = null;
		this._heatmapComputeNode = null;
		this._heatmapStorageTex = null;
		this._outputStorageTex = null;
		this._outputTarget = null;
		this.heatmapTarget = null;
		this._varianceTexNode = null;

	}

}
