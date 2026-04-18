import { Fn, wgslFn, vec4, float, int, uint, ivec2, uvec2, uniform, If, max,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId,
	attributeArray } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture, ReadbackBuffer } from 'three/webgpu';
import { FloatType, RGBAFormat, NearestFilter } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
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
 * WebGPU Auto-Exposure Stage (Fully Compute Shader)
 *
 * GPU-based automatic exposure control with human eye-like adaptation.
 * Uses hierarchical luminance reduction and asymmetric temporal smoothing.
 *
 * Algorithm:
 *   1. Downsample (compute): full res → 64×64 log-luminance
 *   2. Reduction (compute): parallel reduction 64×64 → 1×1 via shared memory
 *      Single workgroup of 256 threads, each loads 16 texels.
 *      Computes geometric mean: exp(Σlog(L) / N)
 *   3. Adaptation (compute): temporal smoothing with prev exposure; writes
 *      vec4(exposure, luminance, targetExposure, 1) into a 1-element storage buffer.
 *   4. Async readback via `renderer.getArrayBufferAsync(attr, ReadbackBuffer)`:
 *      the ReadbackBuffer pools its staging GPUBuffer across frames, avoiding
 *      per-frame allocation churn. Apply to renderer.toneMappingExposure.
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
export class AutoExposure extends RenderStage {

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

		// ── Input resolution uniforms (for downsample compute) ──

		this.inputResW = uniform( 1 );
		this.inputResH = uniform( 1 );

		// ── Input texture nodes (swap .value, no recompile) ──

		this._inputTexNode = new TextureNode();
		this._reductionReadTexNode = new TextureNode();

		// ── CPU-side state ───────────────────────────────

		this.currentExposure = options.initialExposure ?? 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this.isFirstFrame = true;
		this._pendingReadback = false;
		this._readbackGeneration = 0;

		// ── Render targets & storage textures ────────────

		this._initRenderTargets();
		this._buildCompute();

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

		// Downsample RenderTarget (64×64) — copy destination from compute StorageTexture
		this._downsampleTarget = new RenderTarget( this.REDUCTION_SIZE, this.REDUCTION_SIZE, rtOpts );

		// Downsample StorageTexture (64×64) — compute writes here
		this._downsampleStorageTex = new StorageTexture( this.REDUCTION_SIZE, this.REDUCTION_SIZE );
		this._downsampleStorageTex.type = FloatType;
		this._downsampleStorageTex.format = RGBAFormat;
		this._downsampleStorageTex.minFilter = NearestFilter;
		this._downsampleStorageTex.magFilter = NearestFilter;

		// 1×1 StorageTexture for compute reduction output
		this._reductionStorageTex = new StorageTexture( 1, 1 );
		this._reductionStorageTex.type = FloatType;
		this._reductionStorageTex.format = RGBAFormat;
		this._reductionStorageTex.minFilter = NearestFilter;
		this._reductionStorageTex.magFilter = NearestFilter;

		// 1×1 RenderTarget — readable copy of reduction output (cross-dispatch reads
		// from StorageTexture return zeros — must copy to RenderTarget first)
		this._reductionReadTarget = new RenderTarget( 1, 1, rtOpts );

		// Adaptation result — 1×vec4 storage buffer attribute. Compute writes
		// vec4(exposure, luminance, targetExposure, 1) here; CPU reads via
		// getArrayBufferAsync + a pooled ReadbackBuffer (16 bytes).
		this._adaptationResult = attributeArray( 1, 'vec4' );
		this._readbackBuffer = new ReadbackBuffer( 16 );
		this._readbackBuffer.name = 'AutoExposureAdaptation';

	}

	// ──────────────────────────────────────────────────
	// TSL shader builders
	// ──────────────────────────────────────────────────

	_buildCompute() {

		this._buildDownsampleCompute();
		this._buildReductionCompute();
		this._buildAdaptationCompute();

	}

	/**
	 * Downsample (compute): full resolution → 64×64
	 *
	 * Dispatch: [8, 8, 1] workgroups of [8, 8, 1] = 64×64 threads total.
	 * Each thread (one output pixel) samples a NxN grid from the input texture.
	 *
	 * Output: R = Σ log(L + ε), G = valid pixel count
	 */
	_buildDownsampleCompute() {

		const inputTex = this._inputTexNode;
		const outputTex = this._downsampleStorageTex;
		const epsilon = this.epsilonU;
		const resW = this.inputResW;
		const resH = this.inputResH;

		const SAMPLES = 4;
		const OUT_SIZE = 64;
		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			// Global thread ID → output pixel coordinate
			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			// Block size in input pixels: how many input pixels each output pixel covers
			const blockW = resW.div( float( OUT_SIZE ) );
			const blockH = resH.div( float( OUT_SIZE ) );

			// Block origin in input pixel space
			const blockOriginX = float( gx ).mul( blockW );
			const blockOriginY = float( gy ).mul( blockH );

			const logLumSum = float( 0.0 ).toVar();
			const validCount = float( 0.0 ).toVar();

			// Sample a SAMPLES×SAMPLES grid within the block
			for ( let sy = 0; sy < SAMPLES; sy ++ ) {

				for ( let sx = 0; sx < SAMPLES; sx ++ ) {

					// Offset within block: (sx+0.5)/SAMPLES normalised to block size
					const inputX = int( blockOriginX.add( float( ( sx + 0.5 ) / SAMPLES ).mul( blockW ) ) );
					const inputY = int( blockOriginY.add( float( ( sy + 0.5 ) / SAMPLES ).mul( blockH ) ) );

					const sample = textureLoad( inputTex, ivec2( inputX, inputY ) );
					const lum = luminance( sample.xyz );

					If( lum.greaterThan( epsilon ), () => {

						logLumSum.addAssign( lum.add( epsilon ).log() );
						validCount.addAssign( 1.0 );

					} );

				}

			}

			textureStore(
				outputTex,
				uvec2( uint( gx ), uint( gy ) ),
				vec4( logLumSum, validCount, 0.0, 1.0 )
			).toWriteOnly();

		} );

		this._downsampleComputeNode = computeFn().compute(
			[ OUT_SIZE / WG_SIZE, OUT_SIZE / WG_SIZE, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

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
	 * Adaptation (compute): temporal smoothing
	 *
	 * Single-thread compute dispatch [1, 1, 1], workgroup [1, 1, 1].
	 * Reads geometric mean from reduction RenderTarget, applies asymmetric
	 * temporal smoothing using the previous-exposure uniform, and writes
	 * vec4(exposure, luminance, targetExposure, 1) into a 1-element storage
	 * buffer which the CPU reads via getArrayBufferAsync + ReadbackBuffer.
	 */
	_buildAdaptationCompute() {

		const reductionTex = this._reductionReadTexNode;
		const resultBuf = this._adaptationResult;
		const keyValue = this.keyValueU;
		const minExp = this.minExposureU;
		const maxExp = this.maxExposureU;
		const speedBright = this.adaptSpeedBrightU;
		const speedDark = this.adaptSpeedDarkU;
		const dt = this.deltaTimeU;
		const isFirst = this.isFirstFrameU;
		const prevExposure = this.previousExposureU;

		const computeFn = Fn( () => {

			// Read geometric mean from reduction result (1×1 RenderTarget)
			const geoMean = textureLoad( reductionTex, ivec2( int( 0 ), int( 0 ) ) ).x;

			const result = adaptExposure(
				geoMean, prevExposure, keyValue,
				minExp, maxExp, speedBright, speedDark,
				dt, isFirst
			);

			resultBuf.element( uint( 0 ) ).assign( result );

		} );

		this._adaptationComputeNode = computeFn().compute( 1, [ 1, 1, 1 ] );

	}

	// ──────────────────────────────────────────────────
	// Event listeners
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this.reset() );
		this.on( 'autoexposure:resetHistory', () => this.resetHistory() );

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

		// Update input resolution uniforms for downsample compute
		this.inputResW.value = inputTex.image?.width || 1;
		this.inputResH.value = inputTex.image?.height || 1;

		// ── Pass 1: Downsample full res → 64×64 (compute) ──

		this._inputTexNode.value = inputTex;
		this.renderer.compute( this._downsampleComputeNode );
		this.renderer.copyTextureToTexture( this._downsampleStorageTex, this._downsampleTarget.texture );

		// ── Pass 2: Reduction 64×64 → 1×1 (compute) ────────

		this.renderer.compute( this._reductionComputeNode );
		this.renderer.copyTextureToTexture( this._reductionStorageTex, this._reductionReadTarget.texture );

		// ── Pass 3: Temporal adaptation (compute) ───────────

		this._reductionReadTexNode.value = this._reductionReadTarget.texture;
		this.renderer.compute( this._adaptationComputeNode );

		// ── Async readback via pooled ReadbackBuffer ─────
		// getArrayBufferAsync reuses the ReadbackBuffer's internal staging
		// GPUBuffer across frames. ReadbackBuffer.release() must be called
		// before it can be reused — the _pendingReadback flag gates reentry.

		if ( ! this._pendingReadback ) {

			this._pendingReadback = true;
			const generation = this._readbackGeneration;

			this.renderer.getArrayBufferAsync(
				this._adaptationResult.value, this._readbackBuffer
			).then( ( readback ) => {

				// Copy the 4 floats out of the mapped buffer before release(),
				// because release() nulls readback.buffer and unmaps the GPU buffer.
				const data = readback && readback.buffer
					? new Float32Array( readback.buffer.slice( 0 ) )
					: null;
				this._readbackBuffer.release();
				this._pendingReadback = false;

				// Discard stale readback from before a reset
				if ( data && generation === this._readbackGeneration ) {

					this._applyReadback( data );

				}

			} ).catch( () => {

				try {

					this._readbackBuffer.release();

				} catch { /* buffer may not be mapped on error */ }

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

		if ( ! this.enabled || ! data || data.length < 3 ) return;

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

	/**
	 * Soft reset: preserve exposure state, let temporal smoothing adapt.
	 * Called on pipeline:reset (camera moves, parameter changes).
	 */
	reset() {

		this.lastTime = performance.now();
		// Bump generation so any in-flight readback is discarded
		this._readbackGeneration ++;
		this._pendingReadback = false;

	}

	/**
	 * Hard reset: wipe exposure history for a clean start.
	 * Called on scene/environment changes where previous exposure is meaningless.
	 */
	resetHistory() {

		this.isFirstFrame = true;
		this.currentExposure = 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this._readbackGeneration ++;
		this._pendingReadback = false;

	}

	setSize( /* width, height */ ) {

		// Downsample and reduction targets are fixed-size (64×64 → 1×1)
		// No resizing needed — the downsample compute shader reads input
		// resolution from uniforms and computes block sizes dynamically.

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

		this._downsampleComputeNode?.dispose();
		this._reductionComputeNode?.dispose();
		this._adaptationComputeNode?.dispose();
		this._downsampleTarget?.dispose();
		this._downsampleStorageTex?.dispose();
		this._reductionStorageTex?.dispose();
		this._reductionReadTarget?.dispose();
		this._readbackBuffer?.dispose();

	}

}
