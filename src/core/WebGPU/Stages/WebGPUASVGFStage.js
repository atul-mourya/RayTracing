import { Fn, vec3, vec4, float, uv, uniform, If, dot, max, min, abs, normalize, mix, int } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { HalfFloatType, FloatType, RGBAFormat, NearestFilter, Vector2 } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import RenderTargetHelper from '../../../lib/RenderTargetHelper.js';

/**
 * WebGPU ASVGF Stage — Adaptive Spatio-Temporal Variance-Guided Filtering
 *
 * Full rewrite of the skeleton ASVGF using proper temporal denoising:
 *
 * Sub-pass 1 — Temporal Gradient:
 *   Computes temporal gradient between current and reprojected previous frame.
 *   Selects brightest pixel from 3x3 neighbourhood (A-SVGF paper technique).
 *
 * Sub-pass 2 — Temporal Accumulation:
 *   Blends current frame with history using motion-vector reprojection,
 *   neighbourhood colour clamping, normal/depth similarity weighting,
 *   and gradient-adaptive alpha. History length tracked in alpha channel.
 *
 * Sub-pass 3 — Final Copy:
 *   Copies temporal result to output target.
 *
 * Execution: PER_CYCLE — only denoise complete frame data.
 *
 * Events listened:
 *   asvgf:reset, asvgf:setTemporal, asvgf:updateParameters, camera:moved, pipeline:reset
 *
 * Textures published:
 *   asvgf:output, asvgf:temporalColor
 *
 * Textures read:
 *   pathtracer:color, pathtracer:normalDepth, motionVector:screenSpace
 */
export class WebGPUASVGFStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'WebGPUASVGF', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;

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

		// Input texture nodes (swappable — no shader recompile)
		this._colorTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();
		this._prevColorTexNode = new TextureNode();
		this._prevNormalDepthTexNode = new TextureNode();
		this._gradientTexNode = new TextureNode();

		// Render targets
		const w = options.width || 1;
		const h = options.height || 1;
		const rtOpts = {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};

		this.temporalColorTarget = new RenderTarget( w, h, rtOpts );
		this.prevColorTarget = new RenderTarget( w, h, rtOpts );
		this.prevNormalDepthTarget = new RenderTarget( w, h, rtOpts );
		this.temporalGradientTarget = new RenderTarget( w, h, rtOpts );
		this.outputTarget = new RenderTarget( w, h, rtOpts );

		// Heatmap debug visualization
		this.showHeatmap = false;
		this.debugMode = uniform( 0, 'int' ); // 0=beauty, 1=variance, 2=history, 3=motion, 4=normal, 5=gradient

		// Heatmap render target — FloatType for clean CPU readback
		this.heatmapTarget = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Heatmap texture nodes (separate from main pipeline to avoid interference)
		this._heatmapRawColorTexNode = new TextureNode();  // raw pathtracer:color input
		this._heatmapColorTexNode = new TextureNode();      // denoised ASVGF output
		this._heatmapTemporalTexNode = new TextureNode();   // temporal accumulation (history in .w)
		this._heatmapNDTexNode = new TextureNode();
		this._heatmapMotionTexNode = new TextureNode();
		this._heatmapGradientTexNode = new TextureNode();

		// Build materials
		this._buildGradientMaterial();
		this._buildTemporalMaterial();
		this._buildCopyMaterial();
		this._buildHeatmapMaterial();

		// Floating overlay for heatmap visualization
		this.heatmapHelper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-right',
			theme: 'dark',
			title: 'ASVGF Debug',
			autoUpdate: false
		} );
		this.heatmapHelper.hide();
		document.body.appendChild( this.heatmapHelper );

		this.frameCount = 0;

	}

	// ──────────────────────────────────────────────────
	// Sub-pass 1: Temporal Gradient
	// ──────────────────────────────────────────────────

	_buildGradientMaterial() {

		const colorTex = this._colorTexNode;
		const prevColorTex = this._prevColorTexNode;
		const motionTex = this._motionTexNode;
		const resW = this.resW;
		const resH = this.resH;

		const shader = Fn( () => {

			const coord = uv();
			const txW = float( 1.0 ).div( resW );
			const txH = float( 1.0 ).div( resH );

			// Find brightest pixel in 3x3 neighbourhood (A-SVGF technique)
			const bestLum = float( - 1.0 ).toVar();
			const bestColor = vec3( 0.0 ).toVar();
			const bestUV = coord.toVar();

			// Unrolled 3x3
			const offsets = [
				[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ],
				[ - 1, 0 ], [ 0, 0 ], [ 1, 0 ],
				[ - 1, 1 ], [ 0, 1 ], [ 1, 1 ],
			];

			for ( const [ dx, dy ] of offsets ) {

				const sUV = coord.add( vec3( txW.mul( dx ), txH.mul( dy ), 0 ).xy );
				const s = colorTex.sample( sUV ).xyz;
				const lum = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );

				If( lum.greaterThan( bestLum ), () => {

					bestLum.assign( lum );
					bestColor.assign( s );
					bestUV.assign( sUV );

				} );

			}

			// Read motion vector at brightest pixel
			const motion = motionTex.sample( bestUV );
			const prevUV = bestUV.sub( motion.xy );

			// Sample previous frame at reprojected position
			const prevColor = prevColorTex.sample( prevUV ).xyz;
			const prevLum = dot( prevColor, vec3( 0.2126, 0.7152, 0.0722 ) );

			// Temporal gradient = difference in luminance
			const gradient = abs( bestLum.sub( prevLum ) ).div( max( bestLum, float( 0.001 ) ) );

			// Clamp gradient to useful range
			const clampedGradient = gradient.clamp( 0.0, 1.0 );

			return vec4( clampedGradient, bestLum, prevLum, 1.0 );

		} );

		this.gradientMaterial = new MeshBasicNodeMaterial();
		this.gradientMaterial.colorNode = shader();
		this.gradientMaterial.toneMapped = false;
		this.gradientQuad = new QuadMesh( this.gradientMaterial );

	}

	// ──────────────────────────────────────────────────
	// Sub-pass 2: Temporal Accumulation
	// ──────────────────────────────────────────────────

	_buildTemporalMaterial() {

		const colorTex = this._colorTexNode;
		const prevColorTex = this._prevColorTexNode;
		const normalDepthTex = this._normalDepthTexNode;
		const prevNDTex = this._prevNormalDepthTexNode;
		const motionTex = this._motionTexNode;
		const gradientTex = this._gradientTexNode;

		const temporalAlpha = this.temporalAlpha;
		const gradientScale = this.gradientScale;
		const gradientMin = this.gradientMin;
		const gradientMax = this.gradientMax;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const maxAccumFrames = this.maxAccumFrames;
		const varianceClip = this.varianceClip;
		const temporalEnabledU = this.temporalEnabledU;
		const resW = this.resW;
		const resH = this.resH;

		const shader = Fn( () => {

			const coord = uv();
			const currentColor = colorTex.sample( coord ).xyz;

			// If temporal disabled, pass through with history = 1
			const result = vec4( currentColor, 1.0 ).toVar();

			If( temporalEnabledU.greaterThan( 0.5 ), () => {

				// Read motion vector
				const motion = motionTex.sample( coord );
				const motionValid = motion.w.greaterThan( 0.5 );

				// Reprojected UV
				const prevUV = coord.sub( motion.xy );
				const prevOnScreen = prevUV.x.greaterThanEqual( 0.0 )
					.and( prevUV.x.lessThanEqual( 1.0 ) )
					.and( prevUV.y.greaterThanEqual( 0.0 ) )
					.and( prevUV.y.lessThanEqual( 1.0 ) );

				If( motionValid.and( prevOnScreen ), () => {

					// Normal/depth similarity check
					const nd = normalDepthTex.sample( coord );
					const prevND = prevNDTex.sample( prevUV );

					const currentNormal = nd.xyz.mul( 2.0 ).sub( 1.0 );
					const prevNormal = prevND.xyz.mul( 2.0 ).sub( 1.0 );

					const normalSim = max( dot( currentNormal, prevNormal ), float( 0.0 ) );
					const normalWeight = normalSim.pow( phiNormal );

					const depthDiff = abs( nd.w.sub( prevND.w ) );
					const depthWeight = depthDiff.negate().div( max( phiDepth, float( 0.001 ) ) ).exp();

					const similarity = normalWeight.mul( depthWeight );

					// Previous frame colour + history length
					const prevData = prevColorTex.sample( prevUV );
					const prevColor = prevData.xyz;
					const historyLength = prevData.w;

					// 3x3 neighbourhood colour clamping
					const txW = float( 1.0 ).div( resW );
					const txH = float( 1.0 ).div( resH );
					const nMin = vec3( 1e10 ).toVar();
					const nMax = vec3( - 1e10 ).toVar();
					const nMean = vec3( 0.0 ).toVar();

					// Unrolled 3x3
					const nOffsets = [
						[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ],
						[ - 1, 0 ], [ 0, 0 ], [ 1, 0 ],
						[ - 1, 1 ], [ 0, 1 ], [ 1, 1 ],
					];

					for ( const [ dx, dy ] of nOffsets ) {

						const sUV = coord.add( vec3( txW.mul( dx ), txH.mul( dy ), 0 ).xy );
						const s = colorTex.sample( sUV ).xyz;
						nMin.assign( min( nMin, s ) );
						nMax.assign( max( nMax, s ) );
						nMean.addAssign( s );

					}

					nMean.divAssign( 9.0 );

					// Expand bounding box by variance clip factor
					const boxExtent = nMax.sub( nMin ).mul( varianceClip );
					const clampMin = nMin.sub( boxExtent );
					const clampMax = nMax.add( boxExtent );
					const clampedPrev = prevColor.clamp( clampMin, clampMax );

					// Gradient-adaptive alpha
					const gradient = gradientTex.sample( coord ).x;
					const gradientFactor = gradient.sub( gradientMin ).div(
						max( gradientMax.sub( gradientMin ), float( 0.001 ) )
					).clamp( 0.0, 1.0 );
					const adaptiveAlpha = temporalAlpha.add(
						float( 1.0 ).sub( temporalAlpha ).mul( gradientFactor ).mul( gradientScale )
					).clamp( temporalAlpha, 1.0 );

					// Final alpha: accounts for similarity and adaptive gradient
					const effectiveAlpha = adaptiveAlpha.div(
						max( similarity, float( 0.1 ) )
					).clamp( temporalAlpha, 1.0 );

					// Blend
					const blended = mix( clampedPrev, currentColor, effectiveAlpha );

					// Update history length
					const newHistory = min(
						historyLength.add( 1.0 ),
						maxAccumFrames
					);

					result.assign( vec4( blended, newHistory ) );

				} ).Else( () => {

					// No valid reprojection — use current colour, reset history
					result.assign( vec4( currentColor, 1.0 ) );

				} );

			} );

			return result;

		} );

		this.temporalMaterial = new MeshBasicNodeMaterial();
		// Use outputNode (not colorNode) to preserve alpha channel — colorNode
		// forces alpha=1.0 for opaque materials, destroying the history length in .w
		this.temporalMaterial.outputNode = shader();
		this.temporalMaterial.toneMapped = false;
		this.temporalQuad = new QuadMesh( this.temporalMaterial );

	}

	// ──────────────────────────────────────────────────
	// Sub-pass 3: Copy to output
	// ──────────────────────────────────────────────────

	_buildCopyMaterial() {

		const srcTex = this._colorTexNode; // reused node, value swapped at render time

		const shader = Fn( () => {

			return srcTex.sample( uv() );

		} );

		// Use a separate TextureNode for the copy pass
		this._copyTexNode = new TextureNode();

		const copyShader = Fn( () => {

			return this._copyTexNode.sample( uv() );

		} );

		this.copyMaterial = new MeshBasicNodeMaterial();
		// Use outputNode to preserve .w channel (history length) during copy
		this.copyMaterial.outputNode = copyShader();
		this.copyMaterial.toneMapped = false;
		this.copyQuad = new QuadMesh( this.copyMaterial );

	}

	// ──────────────────────────────────────────────────
	// Sub-pass 4: Heatmap debug visualization
	// ──────────────────────────────────────────────────

	_buildHeatmapMaterial() {

		const rawColorTex = this._heatmapRawColorTexNode;
		const colorTex = this._heatmapColorTexNode;
		const temporalTex = this._heatmapTemporalTexNode;
		const ndTex = this._heatmapNDTexNode;
		const motionTex = this._heatmapMotionTexNode;
		const gradientTex = this._heatmapGradientTexNode;
		const mode = this.debugMode;

		const shader = Fn( () => {

			const coord = uv();
			const result = vec4( 0.0, 0.0, 0.0, 1.0 ).toVar();

			// Use If/ElseIf/Else chain — separate If() blocks cause TSL
			// to generate non-exclusive WGSL branches where texture samples
			// from inactive branches can contaminate the output.

			// Mode 0: Beauty (denoised output)
			If( mode.equal( int( 0 ) ), () => {

				const c = colorTex.sample( coord ).xyz;
				result.assign( vec4( c, 1.0 ) );

			} ).ElseIf( mode.equal( int( 1 ) ), () => {

				// Mode 1: Variance — raw input vs denoised output
				const raw = rawColorTex.sample( coord ).xyz;
				const denoised = colorTex.sample( coord ).xyz;
				const rawLum = dot( raw, vec3( 0.2126, 0.7152, 0.0722 ) );
				const denoisedLum = dot( denoised, vec3( 0.2126, 0.7152, 0.0722 ) );
				const t = abs( rawLum.sub( denoisedLum ) ).mul( 5.0 ).clamp( 0.0, 1.0 );

				// Blue → Cyan → Green → Yellow → Red
				const r = t.sub( 0.5 ).mul( 4.0 ).clamp( 0.0, 1.0 );
				const g = t.mul( 4.0 ).clamp( 0.0, 1.0 ).sub(
					t.sub( 0.75 ).mul( 4.0 ).clamp( 0.0, 1.0 )
				);
				const b = float( 1.0 ).sub( t.sub( 0.25 ).mul( 4.0 ).clamp( 0.0, 1.0 ) );
				result.assign( vec4( r, g, b, 1.0 ) );

			} ).ElseIf( mode.equal( int( 2 ) ), () => {

				// Mode 2: History length
				const historyLength = temporalTex.sample( coord ).w;
				const t = historyLength.div( 32.0 ).clamp( 0.0, 1.0 );
				result.assign( vec4( float( 1.0 ).sub( t ), t, float( 0.2 ), 1.0 ) );

			} ).ElseIf( mode.equal( int( 3 ) ), () => {

				// Mode 3: Motion vectors
				const motion = motionTex.sample( coord );
				const mx = abs( motion.x ).mul( 100.0 ).clamp( 0.0, 1.0 );
				const my = abs( motion.y ).mul( 100.0 ).clamp( 0.0, 1.0 );
				const magnitude = mx.add( my ).clamp( 0.0, 1.0 );
				result.assign( vec4( mx, my, magnitude.mul( 0.3 ), 1.0 ) );

			} ).ElseIf( mode.equal( int( 4 ) ), () => {

				// Mode 4: Normals
				const nd = ndTex.sample( coord );
				result.assign( vec4( nd.xyz, 1.0 ) );

			} ).Else( () => {

				// Mode 5: Temporal gradient
				const grad = gradientTex.sample( coord ).x;
				const t = grad.mul( 5.0 ).clamp( 0.0, 1.0 );
				result.assign( vec4( t, t.mul( 0.5 ), float( 1.0 ).sub( t ), 1.0 ) );

			} );

			return result;

		} );

		this.heatmapMaterial = new MeshBasicNodeMaterial();
		this.heatmapMaterial.colorNode = shader();
		this.heatmapMaterial.toneMapped = false;
		this.heatmapQuad = new QuadMesh( this.heatmapMaterial );

	}

	// ──────────────────────────────────────────────────
	// Pipeline lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'asvgf:reset', () => this.resetTemporalData() );
		this.on( 'camera:moved', () => this.resetTemporalData() );
		this.on( 'pipeline:reset', () => this.resetTemporalData() );

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

			if ( img.width !== this.temporalColorTarget.width ||
				img.height !== this.temporalColorTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Update input texture nodes
		this._colorTexNode.value = colorTex;
		if ( normalDepthTex ) this._normalDepthTexNode.value = normalDepthTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;
		this._prevColorTexNode.value = this.prevColorTarget.texture;
		this._prevNormalDepthTexNode.value = this.prevNormalDepthTarget.texture;

		// Sub-pass 1: Temporal gradient
		this.renderer.setRenderTarget( this.temporalGradientTarget );
		this._gradientTexNode.value = this.temporalGradientTarget.texture; // self-reference placeholder
		this.gradientQuad.render( this.renderer );

		// Update gradient texture reference for temporal pass
		this._gradientTexNode.value = this.temporalGradientTarget.texture;

		// Sub-pass 2: Temporal accumulation
		this.renderer.setRenderTarget( this.temporalColorTarget );
		this.temporalQuad.render( this.renderer );

		// Sub-pass 3: Copy temporal result to output
		this._copyTexNode.value = this.temporalColorTarget.texture;
		this.renderer.setRenderTarget( this.outputTarget );
		this.copyQuad.render( this.renderer );

		// Store current frame as previous for next frame
		// Copy temporal colour → prevColor
		this._copyTexNode.value = this.temporalColorTarget.texture;
		this.renderer.setRenderTarget( this.prevColorTarget );
		this.copyQuad.render( this.renderer );

		// Copy normalDepth → prevNormalDepth
		if ( normalDepthTex ) {

			this._copyTexNode.value = normalDepthTex;
			this.renderer.setRenderTarget( this.prevNormalDepthTarget );
			this.copyQuad.render( this.renderer );

		}

		// Publish outputs
		context.setTexture( 'asvgf:output', this.outputTarget.texture );
		context.setTexture( 'asvgf:temporalColor', this.temporalColorTarget.texture );

		// Render heatmap debug overlay if enabled
		if ( this.showHeatmap ) {

			this._heatmapRawColorTexNode.value = colorTex;               // raw pathtracer input
			this._heatmapColorTexNode.value = this.outputTarget.texture;  // denoised output
			this._heatmapTemporalTexNode.value = this.temporalColorTarget.texture;
			if ( normalDepthTex ) this._heatmapNDTexNode.value = normalDepthTex;
			if ( motionTex ) this._heatmapMotionTexNode.value = motionTex;
			this._heatmapGradientTexNode.value = this.temporalGradientTarget.texture;

			this.renderer.setRenderTarget( this.heatmapTarget );
			this.heatmapQuad.render( this.renderer );
			this.renderer.setRenderTarget( null ); // reset to prevent state corruption
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
		// Targets will be overwritten on next render — no explicit clear needed

	}

	setSize( width, height ) {

		this.temporalColorTarget.setSize( width, height );
		this.prevColorTarget.setSize( width, height );
		this.prevNormalDepthTarget.setSize( width, height );
		this.temporalGradientTarget.setSize( width, height );
		this.outputTarget.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

	}

	reset() {

		this.resetTemporalData();

	}

	dispose() {

		this.gradientMaterial?.dispose();
		this.temporalMaterial?.dispose();
		this.copyMaterial?.dispose();
		this.heatmapMaterial?.dispose();
		this.temporalColorTarget?.dispose();
		this.prevColorTarget?.dispose();
		this.prevNormalDepthTarget?.dispose();
		this.temporalGradientTarget?.dispose();
		this.outputTarget?.dispose();
		this.heatmapTarget?.dispose();
		this.heatmapHelper?.dispose();

	}

}
