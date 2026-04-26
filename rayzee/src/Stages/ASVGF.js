import { Fn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, min, abs, mix,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, FloatType, RGBAFormat, NearestFilter, LinearFilter } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { createRenderTargetHelper } from '../Processor/createRenderTargetHelper.js';
import { luminance } from '../TSL/Common.js';

/**
 * WebGPU ASVGF Stage — temporal denoising via motion-vector reprojection
 * + 3×3 colour-distance disocclusion rejection. Ping-pong StorageTextures.
 *
 * Events:    asvgf:reset, asvgf:setTemporal, asvgf:updateParameters
 * Publishes: asvgf:output, asvgf:temporalColor
 * Reads:     pathtracer:color, motionVector:screenSpace
 */
export class ASVGF extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'ASVGF', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;
		this.debugContainer = options.debugContainer || null;

		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.1 );
		this.phiColor = uniform( options.phiColor ?? 10.0 );
		this.maxAccumFrames = uniform( options.maxAccumFrames ?? 32.0 );
		this.varianceClip = uniform( options.varianceClip ?? 1.0 );

		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		this.temporalEnabled = true;
		this.temporalEnabledU = uniform( 1.0 );

		this._colorTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();
		this._readTemporalTexNode = new TextureNode();

		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter required for textureLoad codegen.
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

		this._gradientStorageTex = new StorageTexture( w, h );
		this._gradientStorageTex.type = HalfFloatType;
		this._gradientStorageTex.format = RGBAFormat;
		this._gradientStorageTex.minFilter = LinearFilter;
		this._gradientStorageTex.magFilter = LinearFilter;

		this.currentMoments = 0; // 0 = write A, read B; 1 = write B, read A
		this._compiled = false;

		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildGradientCompute();
		this._buildTemporalCompute();

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

		// Separate from temporal-pass nodes to avoid binding interference.
		this._heatmapRawColorTexNode = new TextureNode();
		this._heatmapColorTexNode = new TextureNode();
		this._heatmapTemporalTexNode = new TextureNode();
		this._heatmapNDTexNode = new TextureNode();
		this._heatmapMotionTexNode = new TextureNode();
		this._heatmapGradientTexNode = new TextureNode();

		this._buildHeatmapCompute();

		this.heatmapHelper = createRenderTargetHelper( this.renderer, this.heatmapTarget, {
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

	// Temporal-luminance gradient (heatmap mode 5 only).
	// 10×10 shared tile; each thread does a 3×3 brightest search, reprojects,
	// and emits the normalized luminance delta against the previous frame.
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

			// All 64 threads load positions 0–63; threads 0–35 then load 64–99.
			const sx1 = linearIdx.mod( TILE_W );
			const sy1 = linearIdx.div( TILE_W );
			const gx1 = tileOriginX.add( int( sx1 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
			const gy1 = tileOriginY.add( int( sy1 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
			const sColor1 = textureLoad( colorTex, ivec2( gx1, gy1 ) ).xyz;
			sharedLum.element( linearIdx ).assign( luminance( sColor1 ) );

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

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( lx ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( ly ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

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

				const bestGx = gx.add( bestDx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const bestGy = gy.add( bestDy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
				const motion = textureLoad( motionTex, ivec2( bestGx, bestGy ) );

				// Reproject via motion vector (UV-space → pixel coords).
				const prevXf = float( bestGx ).sub( motion.x.mul( resW ) );
				const prevYf = float( bestGy ).sub( motion.y.mul( resH ) );
				const prevX = int( prevXf ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const prevY = int( prevYf ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				const prevColor = textureLoad( prevTemporalTex, ivec2( prevX, prevY ) ).xyz;
				const prevLum = luminance( prevColor );

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

	// One temporal node per ping-pong direction.
	_buildTemporalCompute() {

		this._temporalNodeA = this._buildTemporalForDirection( this._temporalTexA );
		this._temporalNodeB = this._buildTemporalForDirection( this._temporalTexB );

	}

	_buildTemporalForDirection( writeTemporalTex ) {

		const colorTex = this._colorTexNode;
		const motionTex = this._motionTexNode;
		const prevTemporalTex = this._readTemporalTexNode;

		const temporalAlpha = this.temporalAlpha;
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

				// Default: history = 1, no blend (used when temporal off or reprojection invalid).
				const result = vec4( currentColor, 1.0 ).toVar();

				If( temporalEnabledU.greaterThan( 0.5 ), () => {

					const motion = textureLoad( motionTex, coord );
					const motionValid = motion.w.greaterThan( 0.5 );

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

						const prevData = textureLoad( prevTemporalTex, prevCoord );
						const prevColor = prevData.xyz;
						const historyLength = prevData.w;

						// Euclidean colour-distance gate. Per-channel clipping
						// fails at silhouettes where wall/box colours overlap
						// in per-channel ranges. A normal/depth gate would be
						// stronger but shading normals jitter too much for it.
						const nMean = vec3( 0.0 ).toVar();
						const nMeanSq = vec3( 0.0 ).toVar();

						for ( let dy = - 1; dy <= 1; dy ++ ) {

							for ( let dx = - 1; dx <= 1; dx ++ ) {

								const sx = gx.add( dx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
								const sy = gy.add( dy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
								const s = textureLoad( colorTex, ivec2( sx, sy ) ).xyz;
								nMean.addAssign( s );
								nMeanSq.addAssign( s.mul( s ) );

							}

						}

						nMean.divAssign( 9.0 );
						nMeanSq.divAssign( 9.0 );
						const nVariance = max( nMeanSq.sub( nMean.mul( nMean ) ), vec3( 0.0 ) );
						const sigmaSq = dot( nVariance, vec3( 1.0 ) );

						// reject ∈ [0,1]: 0 = matches mean (keep history),
						// 1 = >k·σ away (force fresh sample). Squared form skips sqrt.
						const diff = prevColor.sub( nMean );
						const distSq = dot( diff, diff );
						const sigmaSqK = sigmaSq.mul( varianceClipU.mul( varianceClipU ) );
						const reject = distSq.div( max( sigmaSqK, float( 1e-6 ) ) ).clamp( 0.0, 1.0 );

						const baseAlpha = max(
							float( 1.0 ).div( historyLength.add( 1.0 ) ),
							temporalAlpha
						);
						const effectiveAlpha = mix( baseAlpha, float( 1.0 ), reject );
						const blended = mix( prevColor, currentColor, effectiveAlpha );
						const newHistory = mix(
							min( historyLength.add( 1.0 ), maxAccumFrames ),
							float( 1.0 ),
							reject
						);

						result.assign( vec4( blended, newHistory ) );

					} ).Else( () => {

						result.assign( vec4( currentColor, 1.0 ) );

					} );

				} );

				textureStore(
					writeTemporalTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

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

				// Must be chained If/ElseIf — separate If blocks let inactive-
				// branch texture samples contaminate the output.

				// 0: beauty
				If( mode.equal( int( 0 ) ), () => {

					const c = textureLoad( colorTex, coord ).xyz;
					result.assign( vec4( c, 1.0 ) );

				} ).ElseIf( mode.equal( int( 1 ) ), () => {

					// 1: 3×3 luminance variance of raw path-tracer input
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
					// Normalise by mean for HDR, scale to [0,1] for ramp.
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

					// 2: history length
					const historyLength = textureLoad( temporalTex, coord ).w;
					const t = historyLength.div( 32.0 ).clamp( 0.0, 1.0 );
					result.assign( vec4( float( 1.0 ).sub( t ), t, float( 0.2 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 3 ) ), () => {

					// 3: motion vectors
					const motion = textureLoad( motionTex, coord );
					const mx = abs( motion.x ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const my = abs( motion.y ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const magnitude = mx.add( my ).clamp( 0.0, 1.0 );
					result.assign( vec4( mx, my, magnitude.mul( 0.3 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 4 ) ), () => {

					// 4: normals
					const nd = textureLoad( ndTex, coord );
					result.assign( vec4( nd.xyz, 1.0 ) );

				} ).Else( () => {

					// 5: temporal-luminance gradient
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
			if ( data.phiColor !== undefined ) this.phiColor.value = data.phiColor;

		} );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( 'pathtracer:color' );
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! colorTex ) return;

		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this._temporalTexA.image.width ||
				img.height !== this._temporalTexA.image.height ) {

				this.setSize( img.width, img.height );

			}

		}

		this._colorTexNode.value = colorTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;

		// Force first-frame compile while TextureNodes still hold EmptyTexture,
		// so textureLoad codegen emits the required `level` parameter.
		if ( ! this._compiled ) {

			this.renderer.compute( this._gradientNode );
			this.renderer.compute( this._temporalNodeA );
			this.renderer.compute( this._temporalNodeB );
			this._compiled = true;

		}

		// Ping-pong: read opposite, write current
		const readTemporal = this.currentMoments === 0
			? this._temporalTexB : this._temporalTexA;
		const writeNode = this.currentMoments === 0
			? this._temporalNodeA : this._temporalNodeB;
		const writeTemporal = this.currentMoments === 0
			? this._temporalTexA : this._temporalTexB;

		this._readTemporalTexNode.value = readTemporal;
		this.renderer.compute( writeNode );

		context.setTexture( 'asvgf:output', writeTemporal );
		context.setTexture( 'asvgf:temporalColor', writeTemporal );

		this.currentMoments = 1 - this.currentMoments;

		if ( this.showHeatmap ) {

			this.renderer.compute( this._gradientNode );

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
		if ( params.phiColor !== undefined ) this.phiColor.value = params.phiColor;
		if ( params.debugMode !== undefined ) this.debugMode.value = params.debugMode;

	}

	resetTemporalData() {

		this.frameCount = 0;
		this.currentMoments = 0;

	}

	setSize( width, height ) {

		this._temporalTexA.setSize( width, height );
		this._temporalTexB.setSize( width, height );
		this._gradientStorageTex.setSize( width, height );
		this._heatmapStorageTex.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.heatmapTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._gradientNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._temporalNodeA.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._temporalNodeB.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._heatmapComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

	}

	reset() {

		// No-op: motion vectors handle camera moves; only explicit
		// 'asvgf:reset' (scene change, render-mode switch) clears history.

	}

	dispose() {

		this._gradientNode?.dispose();
		this._temporalNodeA?.dispose();
		this._temporalNodeB?.dispose();
		this._temporalTexA?.dispose();
		this._temporalTexB?.dispose();
		this._gradientStorageTex?.dispose();
		this._heatmapComputeNode?.dispose();
		this._heatmapStorageTex?.dispose();
		this.heatmapTarget?.dispose();

		this._colorTexNode?.dispose();
		this._motionTexNode?.dispose();
		this._readTemporalTexNode?.dispose();

		this._heatmapRawColorTexNode?.dispose();
		this._heatmapColorTexNode?.dispose();
		this._heatmapTemporalTexNode?.dispose();
		this._heatmapNDTexNode?.dispose();
		this._heatmapMotionTexNode?.dispose();
		this._heatmapGradientTexNode?.dispose();

		// also removes the DOM node
		this.heatmapHelper?.dispose();

	}

}
