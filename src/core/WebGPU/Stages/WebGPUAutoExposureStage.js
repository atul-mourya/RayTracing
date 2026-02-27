import { Fn, wgslFn, vec2, vec4, float, int, uint, ivec2, uvec2, uv, uniform, If, max,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { FloatType, HalfFloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import { luminance } from '../TSL/Common.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Temporal adaptation: map luminance → target exposure, smooth asymmetrically.
 *
 * Returns vec4f(exposure, luminance, targetExposure, 1.0).
 */
const adaptExposure = /*@__PURE__*/ wgslFn( `
	fn adaptExposure(
		geoMean: f32,
		prevExposure: f32,
		keyValue: f32,
		minExp: f32,
		maxExp: f32,
		speedBright: f32,
		speedDark: f32,
		dt: f32,
		isFirstFrame: f32
	) -> vec4f {

		let targetExp = clamp( keyValue / max( geoMean, 0.001 ), minExp, maxExp );
		var newExposure = targetExp;

		// Temporal smoothing (skip on first frame)
		if ( isFirstFrame < 0.5 ) {

			// Asymmetric speed: brighter scenes adapt faster
			let speed = select( speedDark, speedBright, targetExp < prevExposure );
			let alpha = 1.0 - exp( -dt * speed );
			newExposure = mix( prevExposure, targetExp, alpha );

		}

		return vec4f( newExposure, geoMean, targetExp, 1.0 );

	}
` );

/**
 * WebGPU Auto-Exposure Stage (Fragment + Compute Shader)
 *
 * GPU-based automatic exposure control with human eye-like adaptation.
 * Uses hierarchical luminance reduction and asymmetric temporal smoothing.
 *
 * Algorithm:
 *   1. Downsample (fragment): full res → 64×64 log-luminance
 *   2. Reduction (compute): parallel reduction 64×64 → 1×1 via shared memory
 *      Single workgroup of 256 threads, each loads 16 texels.
 *      Computes geometric mean: exp(Σlog(L) / N)
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
 * Textures published:  (none — publishes state, not textures)
 * Textures read:       edgeFiltering:output > asvgf:output > pathtracer:color
 * State published:     autoexposure:value, autoexposure:avgLuminance
 */
export class WebGPUAutoExposureStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'AutoExposure', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// Reduction constant
		this.REDUCTION_SIZE = 64;

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

		// ── Input texture nodes (swap .value, no recompile) ──

		this._inputTexNode = new TextureNode();
		this._luminanceTexNode = new TextureNode();

		// ── CPU-side state ───────────────────────────────

		this.currentExposure = options.initialExposure ?? 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this.isFirstFrame = true;
		this._pendingReadback = false;

		// ── Render targets & storage textures ────────────

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

		// Downsample target (64×64) — fragment pass writes here
		this._downsampleTarget = new RenderTarget( this.REDUCTION_SIZE, this.REDUCTION_SIZE, rtOpts );

		// 1×1 StorageTexture for compute reduction output
		// LinearFilter so fragment shaders can sample it (NearestFilter + isStorageTexture
		// triggers a Three.js WGSL codegen bug: textureLoad without level parameter)
		this._reductionStorageTex = new StorageTexture( 1, 1 );
		this._reductionStorageTex.type = HalfFloatType;
		this._reductionStorageTex.format = RGBAFormat;
		this._reductionStorageTex.minFilter = LinearFilter;
		this._reductionStorageTex.magFilter = LinearFilter;

		// Adaptation target (1×1) — fragment pass for async readback
		this._adaptationTarget = new RenderTarget( 1, 1, rtOpts );

	}

	// ──────────────────────────────────────────────────
	// TSL shader builders
	// ──────────────────────────────────────────────────

	_buildMaterials() {

		this._buildDownsampleMaterial();
		this._buildReductionCompute();
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
					const lum = luminance( inputTex.sample( sampleUV ).xyz );

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
	 * Reduction: parallel compute 64×64 → 1×1
	 *
	 * Single workgroup of 256 threads. Each thread loads 16 texels
	 * from the 64×64 downsample texture, then participates in a
	 * shared-memory parallel reduction.
	 *
	 * Output: StorageTexture(1×1) = vec4(geometricMean, count, avgLogLum, 1)
	 */
	_buildReductionCompute() {

		const downsampleTex = this._downsampleTarget.texture;
		const outputTex = this._reductionStorageTex;

		const WGSIZE = 256;
		const TEXELS_PER_THREAD = 16; // 4096 / 256
		const TEX_SIZE = 64;

		const sharedLogSum = workgroupArray( 'float', WGSIZE );
		const sharedCount = workgroupArray( 'float', WGSIZE );

		const reductionFn = Fn( () => {

			const tid = localId.x;

			// ── Phase 1: Each thread loads and sums 16 texels ──

			const threadLogSum = float( 0.0 ).toVar();
			const threadCount = float( 0.0 ).toVar();

			for ( let i = 0; i < TEXELS_PER_THREAD; i ++ ) {

				const linearIdx = tid.mul( TEXELS_PER_THREAD ).add( i );
				const px = linearIdx.mod( TEX_SIZE );
				const py = linearIdx.div( TEX_SIZE );
				const data = textureLoad( downsampleTex, ivec2( int( px ), int( py ) ) );

				// data.x = logLumSum, data.y = validCount from downsample
				threadLogSum.addAssign( data.x );
				threadCount.addAssign( data.y );

			}

			sharedLogSum.element( tid ).assign( threadLogSum );
			sharedCount.element( tid ).assign( threadCount );

			// ── Phase 2: Parallel reduction (8 steps) ──────────
			// JS for-loop unrolls at shader build time

			for ( let stride = WGSIZE / 2; stride >= 1; stride = Math.floor( stride / 2 ) ) {

				workgroupBarrier();

				If( tid.lessThan( uint( stride ) ), () => {

					sharedLogSum.element( tid ).addAssign(
						sharedLogSum.element( tid.add( uint( stride ) ) )
					);
					sharedCount.element( tid ).addAssign(
						sharedCount.element( tid.add( uint( stride ) ) )
					);

				} );

			}

			// ── Phase 3: Thread 0 writes final result ──────────

			workgroupBarrier();

			If( tid.equal( uint( 0 ) ), () => {

				const totalLogSum = sharedLogSum.element( uint( 0 ) );
				const totalCount = sharedCount.element( uint( 0 ) );
				const safeCount = max( totalCount, float( 1.0 ) );
				const avgLogLum = totalLogSum.div( safeCount );
				const geometricMean = avgLogLum.exp();

				textureStore(
					outputTex,
					uvec2( uint( 0 ), uint( 0 ) ),
					vec4( geometricMean, totalCount, avgLogLum, 1.0 )
				).toWriteOnly();

			} );

		} );

		this._reductionComputeNode = reductionFn().compute( 1, [ WGSIZE, 1, 1 ] );

	}

	/**
	 * Adaptation: temporal smoothing
	 *
	 * Reads geometric mean luminance from 1×1 compute output,
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

			const geoMean = lumTex.sample( uv() ).x;

			return adaptExposure(
				geoMean, prevExposure, keyValue,
				minExp, maxExp, speedBright, speedDark,
				dt, isFirst
			);

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

		// ── Pass 1: Downsample full res → 64×64 (fragment) ──

		this._inputTexNode.value = inputTex;
		this.renderer.setRenderTarget( this._downsampleTarget );
		this._downsampleQuad.render( this.renderer );

		// ── Pass 2: Reduction 64×64 → 1×1 (compute) ────────

		this.renderer.setRenderTarget( null );
		this.renderer.compute( this._reductionComputeNode );

		// ── Pass 3: Temporal adaptation (fragment) ──────────

		this._luminanceTexNode.value = this._reductionStorageTex;
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
		this._adaptationMaterial?.dispose();
		this._reductionComputeNode?.dispose();
		this._downsampleTarget?.dispose();
		this._reductionStorageTex?.dispose();
		this._adaptationTarget?.dispose();

	}

}
