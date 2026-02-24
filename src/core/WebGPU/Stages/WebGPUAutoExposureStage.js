import { Fn, vec2, vec3, vec4, float, uv, uniform, If, dot, max, mix } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { FloatType, RGBAFormat, NearestFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';

/**
 * WebGPU Auto-Exposure Stage
 *
 * GPU-based automatic exposure control with human eye-like adaptation.
 * Uses hierarchical luminance reduction and asymmetric temporal smoothing.
 *
 * Algorithm:
 *   1. Downsample (fragment): full res → 64×64 log-luminance
 *   2. Reduction (fragment × 6): hierarchical 2×2 sum → 1×1
 *      Final pass computes geometric mean: exp(Σlog(L) / N)
 *   3. Adaptation (fragment): temporal smoothing with prev exposure
 *   4. Async readback (1×1): apply to renderer.toneMappingExposure
 *
 * WebGPU advantage: async readback (no GPU pipeline stall).
 * 1-frame delay is imperceptible for slowly-changing exposure.
 *
 * Execution: ALWAYS
 *
 * Events listened:
 *   pipeline:reset              — reset temporal history
 *   autoexposure:toggle         — enable/disable
 *   autoexposure:updateParameters — update key value, speeds, bounds
 *
 * State published:  autoexposure:value, autoexposure:avgLuminance
 * Textures read:    edgeFiltering:output > asvgf:output > pathtracer:color
 */
export class WebGPUAutoExposureStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'AutoExposure', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// Reduction constants
		this.REDUCTION_SIZE = 64;
		this.REDUCTION_LEVELS = 6; // log2(64)

		// ── Adaptation uniforms ──────────────────────────

		this.keyValueU = uniform( options.keyValue ?? 0.18 );
		this.minExposureU = uniform( options.minExposure ?? 0.1 );
		this.maxExposureU = uniform( options.maxExposure ?? 20.0 );
		this.adaptSpeedBrightU = uniform( options.adaptSpeedBright ?? 3.0 );
		this.adaptSpeedDarkU = uniform( options.adaptSpeedDark ?? 0.5 );
		this.epsilonU = uniform( options.epsilon ?? 0.0001 );
		this.deltaTimeU = uniform( 1.0 / 60.0 );
		this.isFirstFrameU = uniform( 1.0 ); // 1.0 = true
		this.previousExposureU = uniform( options.initialExposure ?? 1.0 );

		// ── Reduction uniforms ───────────────────────────

		this.reductionTexelW = uniform( 1.0 / 64.0 );
		this.reductionTexelH = uniform( 1.0 / 64.0 );
		this.isFinalPassU = uniform( 0.0 ); // 1.0 on last reduction pass

		// ── Input texture nodes (swap .value, no recompile) ──

		this._inputTexNode = new TextureNode();
		this._reductionTexNode = new TextureNode();
		this._luminanceTexNode = new TextureNode();

		// ── CPU-side state ───────────────────────────────

		this.currentExposure = options.initialExposure ?? 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this.isFirstFrame = true;
		this._pendingReadback = false;

		// ── Render targets ───────────────────────────────

		this._initRenderTargets();
		this._buildMaterials();

	}

	_initRenderTargets() {

		const rtOpts = {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};

		// Reduction chain: [64, 32, 16, 8, 4, 2, 1]
		this._reductionTargets = [];
		let size = this.REDUCTION_SIZE;

		for ( let i = 0; i <= this.REDUCTION_LEVELS; i ++ ) {

			this._reductionTargets.push( new RenderTarget( size, size, rtOpts ) );
			size = Math.max( 1, size / 2 );

		}

		// Adaptation target (1×1)
		this._adaptationTarget = new RenderTarget( 1, 1, rtOpts );

	}

	// ──────────────────────────────────────────────────
	// TSL shader builders
	// ──────────────────────────────────────────────────

	_buildMaterials() {

		this._buildDownsampleMaterial();
		this._buildReductionMaterial();
		this._buildAdaptationMaterial();

	}

	/**
	 * Downsample: full resolution → 64×64
	 *
	 * Each output pixel covers a block of the input texture.
	 * Samples a 4×4 grid within the block, computing log(luminance).
	 *
	 * Output: R = Σ log(L + ε), G = valid pixel count
	 */
	_buildDownsampleMaterial() {

		const inputTex = this._inputTexNode;
		const epsilon = this.epsilonU;

		const SAMPLES = 4;
		const BLOCK_UV = 1.0 / 64.0; // Each output pixel covers 1/64 of UV space

		const shader = Fn( () => {

			const coord = uv();

			const logLumSum = float( 0.0 ).toVar();
			const validCount = float( 0.0 ).toVar();

			// Block origin: snap to grid then offset to start
			// coord is at pixel centre → block covers ±halfBlock around it
			for ( let sy = 0; sy < SAMPLES; sy ++ ) {

				for ( let sx = 0; sx < SAMPLES; sx ++ ) {

					// Offset within the block: (sx+0.5)/SAMPLES normalised to block
					const ox = float( ( sx + 0.5 ) / SAMPLES - 0.5 ).mul( BLOCK_UV );
					const oy = float( ( sy + 0.5 ) / SAMPLES - 0.5 ).mul( BLOCK_UV );

					const sampleUV = coord.add( vec2( ox, oy ) ).clamp( 0.0, 1.0 );
					const sColor = inputTex.sample( sampleUV ).xyz;
					const lum = dot( sColor, vec3( 0.2126, 0.7152, 0.0722 ) );

					If( lum.greaterThan( epsilon ), () => {

						logLumSum.addAssign( lum.add( epsilon ).log() );
						validCount.addAssign( 1.0 );

					} );

				}

			}

			return vec4( logLumSum, validCount, 0.0, 1.0 );

		} );

		this._downsampleMaterial = new MeshBasicNodeMaterial();
		this._downsampleMaterial.outputNode = shader();
		this._downsampleMaterial.toneMapped = false;
		this._downsampleQuad = new QuadMesh( this._downsampleMaterial );

	}

	/**
	 * Reduction: hierarchical 2×2 → 1
	 *
	 * Each pass halves the resolution by summing 2×2 neighbourhoods.
	 * On the final pass (isFinalPass == 1), computes geometric mean
	 * instead of raw sum.
	 *
	 * Output: R = sum/geometricMean, G = valid count, B = avgLogLum (final only)
	 */
	_buildReductionMaterial() {

		const tex = this._reductionTexNode;
		const texelW = this.reductionTexelW;
		const texelH = this.reductionTexelH;
		const isFinal = this.isFinalPassU;

		const shader = Fn( () => {

			const coord = uv();

			// Sample 2×2 block from input texture
			// ±0.25 texel offset selects the four unique input texels
			const halfW = texelW.mul( 0.25 );
			const halfH = texelH.mul( 0.25 );

			const s00 = tex.sample( coord.add( vec2( halfW.negate(), halfH.negate() ) ) );
			const s10 = tex.sample( coord.add( vec2( halfW, halfH.negate() ) ) );
			const s01 = tex.sample( coord.add( vec2( halfW.negate(), halfH ) ) );
			const s11 = tex.sample( coord.add( vec2( halfW, halfH ) ) );

			// Aggregate log-luminance sums and valid counts
			const totalLogSum = s00.x.add( s10.x ).add( s01.x ).add( s11.x );
			const totalCount = s00.y.add( s10.y ).add( s01.y ).add( s11.y );

			const result = vec4( totalLogSum, totalCount, 0.0, 1.0 ).toVar();

			// Final pass: convert sum to geometric mean
			If( isFinal.greaterThan( 0.5 ).and( totalCount.greaterThan( 0.0 ) ), () => {

				const avgLogLum = totalLogSum.div( totalCount );
				const geometricMean = avgLogLum.exp();

				result.assign( vec4( geometricMean, totalCount, avgLogLum, 1.0 ) );

			} );

			return result;

		} );

		this._reductionMaterial = new MeshBasicNodeMaterial();
		this._reductionMaterial.outputNode = shader();
		this._reductionMaterial.toneMapped = false;
		this._reductionQuad = new QuadMesh( this._reductionMaterial );

	}

	/**
	 * Adaptation: temporal smoothing
	 *
	 * Reads geometric mean luminance from 1×1 reduction target,
	 * computes target exposure (keyValue / luminance), and applies
	 * asymmetric exponential smoothing (fast bright, slow dark).
	 *
	 * Output: R = exposure, G = luminance, B = targetExposure, A = 1
	 */
	_buildAdaptationMaterial() {

		const lumTex = this._luminanceTexNode;
		const keyValue = this.keyValueU;
		const minExp = this.minExposureU;
		const maxExp = this.maxExposureU;
		const speedBright = this.adaptSpeedBrightU;
		const speedDark = this.adaptSpeedDarkU;
		const dt = this.deltaTimeU;
		const isFirst = this.isFirstFrameU;
		const prevExposure = this.previousExposureU;

		const shader = Fn( () => {

			const coord = uv();

			// Current geometric mean luminance
			const lumData = lumTex.sample( coord );
			const geoMean = lumData.x;

			// Target exposure: map average luminance to middle gray
			const targetExp = keyValue.div( max( geoMean, float( 0.001 ) ) )
				.clamp( minExp, maxExp );

			// Default: target directly (first frame, no history)
			const newExposure = targetExp.toVar();

			// Temporal smoothing (skip on first frame)
			If( isFirst.lessThan( 0.5 ), () => {

				// Asymmetric speed: brighter scenes adapt faster
				const speed = targetExp.lessThan( prevExposure ).select(
					speedBright, // Brighter → faster
					speedDark    // Darker   → slower
				);

				const alpha = float( 1.0 ).sub( dt.negate().mul( speed ).exp() );
				newExposure.assign( mix( prevExposure, targetExp, alpha ) );

			} );

			return vec4( newExposure, geoMean, targetExp, 1.0 );

		} );

		this._adaptationMaterial = new MeshBasicNodeMaterial();
		this._adaptationMaterial.outputNode = shader();
		this._adaptationMaterial.toneMapped = false;
		this._adaptationQuad = new QuadMesh( this._adaptationMaterial );

	}

	// ──────────────────────────────────────────────────
	// Event listeners
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this.reset() );

		this.on( 'autoexposure:toggle', ( enabled ) => {

			this.enabled = enabled;

		} );

		this.on( 'autoexposure:updateParameters', ( data ) => {

			if ( ! data ) return;
			if ( data.keyValue !== undefined ) this.keyValueU.value = data.keyValue;
			if ( data.minExposure !== undefined ) this.minExposureU.value = data.minExposure;
			if ( data.maxExposure !== undefined ) this.maxExposureU.value = data.maxExposure;
			if ( data.adaptSpeedBright !== undefined ) this.adaptSpeedBrightU.value = data.adaptSpeedBright;
			if ( data.adaptSpeedDark !== undefined ) this.adaptSpeedDarkU.value = data.adaptSpeedDark;

		} );

	}

	// ──────────────────────────────────────────────────
	// Render
	// ──────────────────────────────────────────────────

	render( context ) {

		if ( ! this.enabled ) return;

		// Resolve input texture (fallback chain)
		const inputTex = context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );

		if ( ! inputTex ) return;

		// Delta time
		const now = performance.now();
		const dt = Math.min( ( now - this.lastTime ) / 1000, 0.1 );
		this.lastTime = now;
		this.deltaTimeU.value = this.isFirstFrame ? 1.0 : dt;
		this.isFirstFrameU.value = this.isFirstFrame ? 1.0 : 0.0;
		this.previousExposureU.value = this.currentExposure;

		// ── Pass 1: Downsample full res → 64×64 ─────────

		this._inputTexNode.value = inputTex;
		this.renderer.setRenderTarget( this._reductionTargets[ 0 ] );
		this._downsampleQuad.render( this.renderer );

		// ── Pass 2–7: Hierarchical reduction ─────────────

		for ( let i = 0; i < this.REDUCTION_LEVELS; i ++ ) {

			const sourceTarget = this._reductionTargets[ i ];
			const destTarget = this._reductionTargets[ i + 1 ];
			const isFinal = ( i === this.REDUCTION_LEVELS - 1 );

			this.reductionTexelW.value = 1.0 / sourceTarget.width;
			this.reductionTexelH.value = 1.0 / sourceTarget.height;
			this.isFinalPassU.value = isFinal ? 1.0 : 0.0;

			this._reductionTexNode.value = sourceTarget.texture;
			this.renderer.setRenderTarget( destTarget );
			this._reductionQuad.render( this.renderer );

		}

		// ── Pass 8: Temporal adaptation ──────────────────

		const finalTarget = this._reductionTargets[ this.REDUCTION_LEVELS ];
		this._luminanceTexNode.value = finalTarget.texture;

		this.renderer.setRenderTarget( this._adaptationTarget );
		this._adaptationQuad.render( this.renderer );

		// ── Async readback (WebGPU advantage) ────────────

		if ( ! this._pendingReadback ) {

			this._pendingReadback = true;

			this.renderer.readRenderTargetPixelsAsync(
				this._adaptationTarget, 0, 0, 1, 1
			).then( ( data ) => {

				this._pendingReadback = false;
				this._applyReadback( data );

			} ).catch( () => {

				this._pendingReadback = false;

			} );

		}

		// ── Publish state ────────────────────────────────

		context.setState( 'autoexposure:value', this.currentExposure );
		context.setState( 'autoexposure:avgLuminance', this.currentLuminance );

		this.emit( 'autoexposure:updated', {
			exposure: this.currentExposure,
			luminance: this.currentLuminance,
			targetExposure: this.targetExposure
		} );

		this.isFirstFrame = false;

	}

	/**
	 * Process async readback data from 1×1 adaptation target.
	 */
	_applyReadback( data ) {

		if ( ! data || data.length < 3 ) return;

		let exposure = data[ 0 ];
		let luminance = data[ 1 ];
		let targetExp = data[ 2 ];

		// Validate
		if ( ! isFinite( exposure ) || exposure <= 0 ) exposure = 1.0;
		if ( ! isFinite( luminance ) || luminance <= 0 ) luminance = 0.18;
		if ( ! isFinite( targetExp ) || targetExp <= 0 ) targetExp = exposure;

		this.currentExposure = exposure;
		this.currentLuminance = luminance;
		this.targetExposure = targetExp;

		// Apply to renderer
		this.renderer.toneMappingExposure = exposure;

	}

	// ──────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────

	reset() {

		this.isFirstFrame = true;
		this.currentExposure = 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this._pendingReadback = false;

	}

	setSize( /* width, height */ ) {

		// Downsample and reduction targets are fixed-size (64×64 → 1×1)
		// No resizing needed — the downsample shader samples a 4×4 grid
		// per output pixel regardless of input resolution.

	}

	setExposure( value ) {

		this.currentExposure = value;
		this.previousExposureU.value = value;
		this.renderer.toneMappingExposure = value;

	}

	getExposure() {

		return this.currentExposure;

	}

	getLuminance() {

		return this.currentLuminance;

	}

	updateParameters( params ) {

		if ( params.keyValue !== undefined ) this.keyValueU.value = params.keyValue;
		if ( params.minExposure !== undefined ) this.minExposureU.value = params.minExposure;
		if ( params.maxExposure !== undefined ) this.maxExposureU.value = params.maxExposure;
		if ( params.adaptSpeedBright !== undefined ) this.adaptSpeedBrightU.value = params.adaptSpeedBright;
		if ( params.adaptSpeedDark !== undefined ) this.adaptSpeedDarkU.value = params.adaptSpeedDark;

	}

	dispose() {

		this._downsampleMaterial?.dispose();
		this._reductionMaterial?.dispose();
		this._adaptationMaterial?.dispose();
		this._reductionTargets?.forEach( t => t.dispose() );
		this._adaptationTarget?.dispose();

	}

}
