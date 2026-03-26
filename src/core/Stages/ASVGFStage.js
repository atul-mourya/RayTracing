import { Fn, wgslFn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, min, abs, mix,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, FloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import RenderTargetHelper from '../Processor/RenderTargetHelper.js';
import { luminance, normalDepthWeight } from '../TSL/Common.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Gradient-adaptive temporal blending alpha.
 *
 * Maps temporal gradient to effective alpha:
 *   low gradient  → baseAlpha (more accumulation)
 *   high gradient → up to 1.0 (fast adaptation)
 */
const gradientAdaptiveAlpha = /*@__PURE__*/ wgslFn( `
	fn gradientAdaptiveAlpha(
		gradient: f32,
		baseAlpha: f32,
		scale: f32,
		gMin: f32,
		gMax: f32
	) -> f32 {

		let remapped = clamp( ( gradient - gMin ) / max( gMax - gMin, 0.001 ), 0.0, 1.0 );
		return clamp( baseAlpha + ( 1.0 - baseAlpha ) * remapped * scale, baseAlpha, 1.0 );

	}
` );

/**
 * WebGPU ASVGF Stage (Compute Shader)
 *
 * Adaptive Spatio-Temporal Variance-Guided Filtering for real-time denoising.
 * Two compute passes per frame with ping-pong StorageTextures.
 *
 * Algorithm:
 *   1. Gradient (compute): Cooperative tile load → 3×3 brightest search
 *      → motion reprojection → normalized luminance gradient
 *   2. Temporal accumulation (compute): Motion validity check
 *      → normal/depth edge-stopping → 3×3 variance clipping
 *      → gradient-adaptive alpha → temporal blend + history tracking
 *      → write current ND to prevND for next frame
 *
 * Execution: PER_CYCLE
 *
 * Events listened:
 *   asvgf:reset, asvgf:setTemporal, asvgf:updateParameters,
 *   camera:moved, pipeline:reset
 *
 * Textures published:  asvgf:output, asvgf:temporalColor
 * Textures read:       pathtracer:color, pathtracer:normalDepth, motionVector:screenSpace
 */
export class ASVGFStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'ASVGF', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;
		this.debugContainer = options.debugContainer || null;

		// Parameters
		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.1 );
		this.gradientScale = uniform( options.gradientScale ?? 2.0 );
		this.gradientMin = uniform( options.gradientMin ?? 0.01 );
		this.gradientMax = uniform( options.gradientMax ?? 0.5 );
		this.phiColor = uniform( options.phiColor ?? 10.0 );
		this.phiNormal = uniform( options.phiNormal ?? 128.0 );
		this.phiDepth = uniform( options.phiDepth ?? 1.0 );
		this.maxAccumFrames = uniform( options.maxAccumFrames ?? 32.0 );
		this.varianceClip = uniform( options.varianceClip ?? 1.0 );

		// Resolution
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Temporal control
		this.temporalEnabled = true;
		this.temporalEnabledU = uniform( 1.0 ); // 1.0 = enabled

		// Input texture nodes (context textures — always regular Textures)
		this._colorTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();

		// Read-side TextureNode wrappers (pre-compile with EmptyTexture,
		// then set to StorageTextures at runtime)
		this._readTemporalTexNode = new TextureNode();
		this._readPrevNDTexNode = new TextureNode();
		this._gradientReadTexNode = new TextureNode();

		// Ping-pong StorageTextures
		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter for textureLoad codegen compatibility
		this._temporalTexA = new StorageTexture( w, h );
		this._temporalTexA.type = HalfFloatType;
		this._temporalTexA.format = RGBAFormat;
		this._temporalTexA.minFilter = LinearFilter;
		this._temporalTexA.magFilter = LinearFilter;

		this._temporalTexB = new StorageTexture( w, h );
		this._temporalTexB.type = HalfFloatType;
		this._temporalTexB.format = RGBAFormat;
		this._temporalTexB.minFilter = LinearFilter;
		this._temporalTexB.magFilter = LinearFilter;

		this._prevNDTexA = new StorageTexture( w, h );
		this._prevNDTexA.type = HalfFloatType;
		this._prevNDTexA.format = RGBAFormat;
		this._prevNDTexA.minFilter = LinearFilter;
		this._prevNDTexA.magFilter = LinearFilter;

		this._prevNDTexB = new StorageTexture( w, h );
		this._prevNDTexB.type = HalfFloatType;
		this._prevNDTexB.format = RGBAFormat;
		this._prevNDTexB.minFilter = LinearFilter;
		this._prevNDTexB.magFilter = LinearFilter;

		this._gradientStorageTex = new StorageTexture( w, h );
		this._gradientStorageTex.type = HalfFloatType;
		this._gradientStorageTex.format = RGBAFormat;
		this._gradientStorageTex.minFilter = LinearFilter;
		this._gradientStorageTex.magFilter = LinearFilter;

		this.currentMoments = 0; // 0 = write A, read B; 1 = write B, read A
		this._compiled = false;

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		// Build compute nodes
		this._buildGradientCompute();
		this._buildTemporalCompute();

		// ── Heatmap debug visualization (compute shader) ──

		this.showHeatmap = false;
		this.debugMode = uniform( 0, 'int' );

		this._heatmapStorageTex = new StorageTexture( w, h );
		this._heatmapStorageTex.type = FloatType;
		this._heatmapStorageTex.format = RGBAFormat;
		this._heatmapStorageTex.minFilter = NearestFilter;
		this._heatmapStorageTex.magFilter = NearestFilter;

		this.heatmapTarget = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Separate heatmap texture nodes (avoid interference with compute pipeline)
		this._heatmapRawColorTexNode = new TextureNode();
		this._heatmapColorTexNode = new TextureNode();
		this._heatmapTemporalTexNode = new TextureNode();
		this._heatmapNDTexNode = new TextureNode();
		this._heatmapMotionTexNode = new TextureNode();
		this._heatmapGradientTexNode = new TextureNode();

		this._buildHeatmapCompute();

		this.heatmapHelper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-right',
			theme: 'dark',
			title: 'ASVGF Debug',
			autoUpdate: false
		} );
		this.heatmapHelper.hide();
		( this.debugContainer || document.body ).appendChild( this.heatmapHelper );

		this.frameCount = 0;

	}

	// ──────────────────────────────────────────────────
	// Compute pass 1: Temporal Gradient
	// ──────────────────────────────────────────────────

	/**
	 * Build gradient compute node with shared memory 3×3 brightest search.
	 *
	 * Workgroup [8,8,1] loads a 10×10 luminance tile into shared memory.
	 * Each thread finds the brightest pixel in its 3×3 neighbourhood,
	 * reads the motion vector there, reprojects, and computes the
	 * normalized luminance gradient against the previous frame.
	 */
	_buildGradientCompute() {

		const colorTex = this._colorTexNode;
		const motionTex = this._motionTexNode;
		const prevTemporalTex = this._readTemporalTexNode;
		const gradientStorageTex = this._gradientStorageTex;
		const resW = this.resW;
		const resH = this.resH;

		const TILE_W = 10;
		const TILE_TOTAL = TILE_W * TILE_W; // 100
		const WG_SIZE = 8;
		const WG_THREADS = WG_SIZE * WG_SIZE; // 64
		const EXTRA_LOAD = TILE_TOTAL - WG_THREADS; // 36

		const sharedLum = workgroupArray( 'float', TILE_TOTAL );

		const computeFn = Fn( () => {

			const lx = localId.x;
			const ly = localId.y;
			const linearIdx = ly.mul( WG_SIZE ).add( lx );

			const tileOriginX = int( workgroupId.x ).mul( WG_SIZE ).sub( 1 );
			const tileOriginY = int( workgroupId.y ).mul( WG_SIZE ).sub( 1 );

			// ── Cooperative tile loading ─────────────────────

			// Load #1: all 64 threads load positions 0-63
			const sx1 = linearIdx.mod( TILE_W );
			const sy1 = linearIdx.div( TILE_W );
			const gx1 = tileOriginX.add( int( sx1 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
			const gy1 = tileOriginY.add( int( sy1 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
			const sColor1 = textureLoad( colorTex, ivec2( gx1, gy1 ) ).xyz;
			sharedLum.element( linearIdx ).assign( luminance( sColor1 ) );

			// Load #2: threads 0-35 load positions 64-99
			If( linearIdx.lessThan( uint( EXTRA_LOAD ) ), () => {

				const idx2 = linearIdx.add( uint( WG_THREADS ) );
				const sx2 = idx2.mod( TILE_W );
				const sy2 = idx2.div( TILE_W );
				const gx2 = tileOriginX.add( int( sx2 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const gy2 = tileOriginY.add( int( sy2 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
				const sColor2 = textureLoad( colorTex, ivec2( gx2, gy2 ) ).xyz;
				sharedLum.element( idx2 ).assign( luminance( sColor2 ) );

			} );

			workgroupBarrier();

			// ── Per-thread gradient computation ──────────────

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( lx ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( ly ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Find brightest in 3×3 from shared memory
				const bestLum = float( - 1.0 ).toVar();
				const bestDx = int( 0 ).toVar();
				const bestDy = int( 0 ).toVar();

				for ( let dy = - 1; dy <= 1; dy ++ ) {

					for ( let dx = - 1; dx <= 1; dx ++ ) {

						const val = sharedLum.element(
							ly.add( 1 + dy ).mul( TILE_W ).add( lx.add( 1 + dx ) )
						);

						If( val.greaterThan( bestLum ), () => {

							bestLum.assign( val );
							bestDx.assign( int( dx ) );
							bestDy.assign( int( dy ) );

						} );

					}

				}

				// Read motion at brightest pixel
				const bestGx = gx.add( bestDx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const bestGy = gy.add( bestDy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
				const motion = textureLoad( motionTex, ivec2( bestGx, bestGy ) );

				// Reproject via motion vector (UV-space → pixel coords)
				const prevXf = float( bestGx ).sub( motion.x.mul( resW ) );
				const prevYf = float( bestGy ).sub( motion.y.mul( resH ) );
				const prevX = int( prevXf ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const prevY = int( prevYf ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				// Previous frame luminance at reprojected position
				const prevColor = textureLoad( prevTemporalTex, ivec2( prevX, prevY ) ).xyz;
				const prevLum = luminance( prevColor );

				// Temporal gradient = normalized luminance difference
				const gradient = abs( bestLum.sub( prevLum ) )
					.div( max( bestLum, float( 0.001 ) ) )
					.clamp( 0.0, 1.0 );

				textureStore(
					gradientStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( gradient, bestLum, prevLum, 1.0 )
				).toWriteOnly();

			} );

		} );

		this._gradientNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// ──────────────────────────────────────────────────
	// Compute pass 2: Temporal Accumulation
	// ──────────────────────────────────────────────────

	/**
	 * Build two temporal compute nodes — one for each ping-pong direction.
	 *
	 * Each node writes to its temporal StorageTexture (accumulated color + history)
	 * AND its prevND StorageTexture (current ND saved for next frame),
	 * eliminating the need for a separate copy pass.
	 */
	_buildTemporalCompute() {

		this._temporalNodeA = this._buildTemporalForDirection(
			this._temporalTexA, this._prevNDTexA
		);
		this._temporalNodeB = this._buildTemporalForDirection(
			this._temporalTexB, this._prevNDTexB
		);

	}

	_buildTemporalForDirection( writeTemporalTex, writePrevNDTex ) {

		const colorTex = this._colorTexNode;
		const ndTex = this._normalDepthTexNode;
		const motionTex = this._motionTexNode;
		const prevTemporalTex = this._readTemporalTexNode;
		const prevNDTex = this._readPrevNDTexNode;
		const gradientTex = this._gradientReadTexNode;

		const temporalAlpha = this.temporalAlpha;
		const gradientScale = this.gradientScale;
		const gradientMinU = this.gradientMin;
		const gradientMaxU = this.gradientMax;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const maxAccumFrames = this.maxAccumFrames;
		const varianceClipU = this.varianceClip;
		const temporalEnabledU = this.temporalEnabledU;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const currentColor = textureLoad( colorTex, coord ).xyz;
				const currentND = textureLoad( ndTex, coord );

				// Default: pass through with history = 1
				const result = vec4( currentColor, 1.0 ).toVar();

				If( temporalEnabledU.greaterThan( 0.5 ), () => {

					// Read motion vector
					const motion = textureLoad( motionTex, coord );
					const motionValid = motion.w.greaterThan( 0.5 );

					// Reprojected pixel coords
					const prevXf = float( gx ).sub( motion.x.mul( resW ) );
					const prevYf = float( gy ).sub( motion.y.mul( resH ) );
					const prevOnScreen = prevXf.greaterThanEqual( 0.0 )
						.and( prevXf.lessThan( float( resW ) ) )
						.and( prevYf.greaterThanEqual( 0.0 ) )
						.and( prevYf.lessThan( float( resH ) ) );

					If( motionValid.and( prevOnScreen ), () => {

						const prevX = int( prevXf ).clamp( int( 0 ), int( resW ).sub( 1 ) );
						const prevY = int( prevYf ).clamp( int( 0 ), int( resH ).sub( 1 ) );
						const prevCoord = ivec2( prevX, prevY );

						// Normal/depth similarity check
						const currentNormal = currentND.xyz.mul( 2.0 ).sub( 1.0 );
						const prevND = textureLoad( prevNDTex, prevCoord );
						const prevNormal = prevND.xyz.mul( 2.0 ).sub( 1.0 );

						const similarity = normalDepthWeight(
							currentNormal, prevNormal,
							currentND.w, prevND.w,
							phiNormal, phiDepth
						);

						// Previous frame colour + history length
						const prevData = textureLoad( prevTemporalTex, prevCoord );
						const prevColor = prevData.xyz;
						const historyLength = prevData.w;

						// History confidence: 0 (fresh) → 1 (fully converged)
						const historyConfidence = historyLength.div( maxAccumFrames ).clamp( 0.0, 1.0 );

						// 3×3 neighbourhood colour clamping (variance clipping)
						const nMin = vec3( 1e10 ).toVar();
						const nMax = vec3( - 1e10 ).toVar();
						const nMean = vec3( 0.0 ).toVar();

						for ( let dy = - 1; dy <= 1; dy ++ ) {

							for ( let dx = - 1; dx <= 1; dx ++ ) {

								const sx = gx.add( dx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
								const sy = gy.add( dy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
								const s = textureLoad( colorTex, ivec2( sx, sy ) ).xyz;
								nMin.assign( min( nMin, s ) );
								nMax.assign( max( nMax, s ) );
								nMean.addAssign( s );

							}

						}

						nMean.divAssign( 9.0 );

						// Expand bounding box by variance clip factor
						// Widen box for high-history pixels: noisy current shouldn't clamp converged previous
						const historyExpand = float( 1.0 ).add( historyConfidence.mul( 3.0 ) );
						const boxExtent = nMax.sub( nMin ).mul( varianceClipU ).mul( historyExpand );
						const clampMin = nMin.sub( boxExtent );
						const clampMax = nMax.add( boxExtent );
						const clampedPrev = prevColor.clamp( clampMin, clampMax );

						// History-adaptive alpha: 1/(N+1), floored at temporalAlpha.
						// Standard SVGF approach — gives optimal noise reduction for
						// temporal accumulation. Variance clipping above handles
						// disocclusion; gradient not used here because with 1 SPP
						// input the gradient is dominated by Monte Carlo noise, not
						// scene changes, which drives alpha toward 1.0 and kills
						// accumulation.
						const effectiveAlpha = max(
							float( 1.0 ).div( historyLength.add( 1.0 ) ),
							temporalAlpha
						);

						// Blend
						const blended = mix( clampedPrev, currentColor, effectiveAlpha );

						// Update history length
						const newHistory = min( historyLength.add( 1.0 ), maxAccumFrames );

						result.assign( vec4( blended, newHistory ) );

					} ).Else( () => {

						// No valid reprojection — use current colour, reset history
						result.assign( vec4( currentColor, 1.0 ) );

					} );

				} );

				// Write temporal result (colour + history in .w)
				textureStore(
					writeTemporalTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

				// Write current ND to prevND for next frame
				textureStore(
					writePrevNDTex,
					uvec2( uint( gx ), uint( gy ) ),
					currentND
				).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// ──────────────────────────────────────────────────
	// Heatmap debug visualization (compute shader)
	// ──────────────────────────────────────────────────

	_buildHeatmapCompute() {

		const rawColorTex = this._heatmapRawColorTexNode;
		const colorTex = this._heatmapColorTexNode;
		const temporalTex = this._heatmapTemporalTexNode;
		const ndTex = this._heatmapNDTexNode;
		const motionTex = this._heatmapMotionTexNode;
		const gradientTex = this._heatmapGradientTexNode;
		const heatmapOut = this._heatmapStorageTex;
		const mode = this.debugMode;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const result = vec4( 0.0, 0.0, 0.0, 1.0 ).toVar();

				// Use If/ElseIf/Else chain — separate If() blocks cause TSL
				// to generate non-exclusive WGSL branches where texture samples
				// from inactive branches can contaminate the output.

				// Mode 0: Beauty (denoised output)
				If( mode.equal( int( 0 ) ), () => {

					const c = textureLoad( colorTex, coord ).xyz;
					result.assign( vec4( c, 1.0 ) );

				} ).ElseIf( mode.equal( int( 1 ) ), () => {

					// Mode 1: Spatial luminance variance of raw path tracer input.
					// Computes E[L²] - E[L]² over a 3×3 neighbourhood, which correctly
					// highlights noisy regions regardless of accumulation state.
					const meanLum = float( 0.0 ).toVar();
					const meanLumSq = float( 0.0 ).toVar();

					for ( let dy = - 1; dy <= 1; dy ++ ) {

						for ( let dx = - 1; dx <= 1; dx ++ ) {

							const sx = gx.add( dx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
							const sy = gy.add( dy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
							const s = textureLoad( rawColorTex, ivec2( sx, sy ) ).xyz;
							const lum = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
							meanLum.addAssign( lum );
							meanLumSq.addAssign( lum.mul( lum ) );

						}

					}

					meanLum.divAssign( 9.0 );
					meanLumSq.divAssign( 9.0 );
					const variance = max( meanLumSq.sub( meanLum.mul( meanLum ) ), float( 0.0 ) );

					// Relative variance (normalise by mean to handle HDR range),
					// then scale into 0-1 for the heatmap.
					const relVar = variance.div( max( meanLum.mul( meanLum ), float( 0.0001 ) ) );
					const t = relVar.mul( 10.0 ).clamp( 0.0, 1.0 );

					// Blue → Cyan → Green → Yellow → Red
					const r = t.sub( 0.5 ).mul( 4.0 ).clamp( 0.0, 1.0 );
					const g = t.mul( 4.0 ).clamp( 0.0, 1.0 ).sub(
						t.sub( 0.75 ).mul( 4.0 ).clamp( 0.0, 1.0 )
					);
					const b = float( 1.0 ).sub( t.sub( 0.25 ).mul( 4.0 ).clamp( 0.0, 1.0 ) );
					result.assign( vec4( r, g, b, 1.0 ) );

				} ).ElseIf( mode.equal( int( 2 ) ), () => {

					// Mode 2: History length
					const historyLength = textureLoad( temporalTex, coord ).w;
					const t = historyLength.div( 32.0 ).clamp( 0.0, 1.0 );
					result.assign( vec4( float( 1.0 ).sub( t ), t, float( 0.2 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 3 ) ), () => {

					// Mode 3: Motion vectors
					const motion = textureLoad( motionTex, coord );
					const mx = abs( motion.x ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const my = abs( motion.y ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const magnitude = mx.add( my ).clamp( 0.0, 1.0 );
					result.assign( vec4( mx, my, magnitude.mul( 0.3 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 4 ) ), () => {

					// Mode 4: Normals
					const nd = textureLoad( ndTex, coord );
					result.assign( vec4( nd.xyz, 1.0 ) );

				} ).Else( () => {

					// Mode 5: Temporal gradient
					const grad = textureLoad( gradientTex, coord ).x;
					const t = grad.mul( 5.0 ).clamp( 0.0, 1.0 );
					result.assign( vec4( t, t.mul( 0.5 ), float( 1.0 ).sub( t ), 1.0 ) );

				} );

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

	// ──────────────────────────────────────────────────
	// Pipeline lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'asvgf:reset', () => this.resetTemporalData() );

		this.on( 'asvgf:setTemporal', ( data ) => {

			if ( data && data.enabled !== undefined ) {

				this.temporalEnabled = data.enabled;
				this.temporalEnabledU.value = data.enabled ? 1.0 : 0.0;

			}

		} );

		this.on( 'asvgf:updateParameters', ( data ) => {

			if ( ! data ) return;
			if ( data.temporalAlpha !== undefined ) this.temporalAlpha.value = data.temporalAlpha;
			if ( data.gradientScale !== undefined ) this.gradientScale.value = data.gradientScale;
			if ( data.phiColor !== undefined ) this.phiColor.value = data.phiColor;
			if ( data.phiNormal !== undefined ) this.phiNormal.value = data.phiNormal;
			if ( data.phiDepth !== undefined ) this.phiDepth.value = data.phiDepth;

		} );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Read inputs from context
		const colorTex = context.getTexture( 'pathtracer:color' );
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! colorTex ) return;

		// Auto-size
		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this._temporalTexA.image.width ||
				img.height !== this._temporalTexA.image.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Update context texture nodes
		this._colorTexNode.value = colorTex;
		if ( normalDepthTex ) this._normalDepthTexNode.value = normalDepthTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;

		// Force-compile all compute nodes on first frame while TextureNode
		// wrappers still hold EmptyTexture. This ensures textureLoad codegen
		// includes the required level parameter.
		if ( ! this._compiled ) {

			this.renderer.compute( this._gradientNode );
			this.renderer.compute( this._temporalNodeA );
			this.renderer.compute( this._temporalNodeB );
			this._compiled = true;

		}

		// Ping-pong direction: read from opposite side, write to current side
		const readTemporal = this.currentMoments === 0
			? this._temporalTexB : this._temporalTexA;
		const readPrevND = this.currentMoments === 0
			? this._prevNDTexB : this._prevNDTexA;
		const writeNode = this.currentMoments === 0
			? this._temporalNodeA : this._temporalNodeB;
		const writeTemporal = this.currentMoments === 0
			? this._temporalTexA : this._temporalTexB;

		// Pass 1: Temporal gradient (shared memory 3×3 brightest search)
		this._readTemporalTexNode.value = readTemporal;
		this.renderer.compute( this._gradientNode );

		// Pass 2: Temporal accumulation + prevND write
		this._gradientReadTexNode.value = this._gradientStorageTex;
		this._readPrevNDTexNode.value = readPrevND;
		this.renderer.compute( writeNode );

		// Publish outputs
		context.setTexture( 'asvgf:output', writeTemporal );
		context.setTexture( 'asvgf:temporalColor', writeTemporal );

		// Swap for next frame
		this.currentMoments = 1 - this.currentMoments;

		// Render heatmap debug overlay if enabled
		if ( this.showHeatmap ) {

			this._heatmapRawColorTexNode.value = colorTex;
			this._heatmapColorTexNode.value = writeTemporal;
			this._heatmapTemporalTexNode.value = writeTemporal;
			if ( normalDepthTex ) this._heatmapNDTexNode.value = normalDepthTex;
			if ( motionTex ) this._heatmapMotionTexNode.value = motionTex;
			this._heatmapGradientTexNode.value = this._gradientStorageTex;

			this.renderer.compute( this._heatmapComputeNode );
			this.renderer.copyTextureToTexture( this._heatmapStorageTex, this.heatmapTarget.texture );
			this.heatmapHelper.update();

		}

		this.frameCount ++;

	}

	toggleHeatmap( enabled ) {

		this.showHeatmap = enabled;
		if ( enabled ) {

			this.heatmapHelper.show();

		} else {

			this.heatmapHelper.hide();

		}

	}

	setTemporalEnabled( enabled ) {

		this.temporalEnabled = enabled;

	}

	updateParameters( params ) {

		if ( ! params ) return;
		if ( params.temporalAlpha !== undefined ) this.temporalAlpha.value = params.temporalAlpha;
		if ( params.gradientScale !== undefined ) this.gradientScale.value = params.gradientScale;
		if ( params.phiColor !== undefined ) this.phiColor.value = params.phiColor;
		if ( params.phiNormal !== undefined ) this.phiNormal.value = params.phiNormal;
		if ( params.phiDepth !== undefined ) this.phiDepth.value = params.phiDepth;
		if ( params.debugMode !== undefined ) this.debugMode.value = params.debugMode;

	}

	resetTemporalData() {

		this.frameCount = 0;
		this.currentMoments = 0;

	}

	setSize( width, height ) {

		this._temporalTexA.setSize( width, height );
		this._temporalTexB.setSize( width, height );
		this._prevNDTexA.setSize( width, height );
		this._prevNDTexB.setSize( width, height );
		this._gradientStorageTex.setSize( width, height );
		this._heatmapStorageTex.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.heatmapTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._gradientNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		this._temporalNodeA.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		this._temporalNodeB.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		this._heatmapComputeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	reset() {

		// Intentionally does NOT reset temporal data.
		// ASVGF uses motion vectors to maintain temporal coherence across
		// camera movement. Only explicit 'asvgf:reset' events (scene change,
		// render mode switch) should clear temporal history.

	}

	dispose() {

		this._gradientNode?.dispose();
		this._temporalNodeA?.dispose();
		this._temporalNodeB?.dispose();
		this._temporalTexA?.dispose();
		this._temporalTexB?.dispose();
		this._prevNDTexA?.dispose();
		this._prevNDTexB?.dispose();
		this._gradientStorageTex?.dispose();
		this._heatmapComputeNode?.dispose();
		this._heatmapStorageTex?.dispose();
		this.heatmapTarget?.dispose();
		this.heatmapHelper?.dispose();

	}

}
