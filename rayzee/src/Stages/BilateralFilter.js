import { Fn, wgslFn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform, If, max, sqrt,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, LinearFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { luminance } from '../TSL/Common.js';
import { ALBEDO_EPS, MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';

// SVGF bilateral edge-stopping weight. All three φ params are relative
// tolerances (unitless fractions) so the filter is scale-invariant across
// scenes, HDR ranges, and camera distances. sigmaL is precomputed by the
// caller as phiLum * √variance / albedoLum + ε, compensating for the
// 1/albedo noise amplification introduced by demodulation.
const bilateralWeight = /*@__PURE__*/ wgslFn( `
	fn bilateralWeight(
		centerLum: f32, sLum: f32,
		centerNormal: vec3f, sNormal: vec3f,
		centerDepth: f32, sDepth: f32,
		centerColor: vec3f, sColor: vec3f,
		kernelW: f32,
		sigmaL: f32, phiNorm: f32, phiDep: f32, phiCol: f32
	) -> f32 {

		let lumW = exp( -abs( centerLum - sLum ) / sigmaL );
		// clamp dot to [0,1]: miss-ray normals decode to (-1,-1,-1) with
		// dot=3 → pow saturates to +inf → inf*0 = NaN. See project_tsl_pitfalls.
		let normW = pow( clamp( dot( centerNormal, sNormal ), 0.0, 1.0 ), phiNorm );
		let depW = exp( -abs( centerDepth - sDepth ) / max( centerDepth * phiDep, 0.001 ) );
		let maxDiff = max( max( abs( centerColor.x - sColor.x ),
			abs( centerColor.y - sColor.y ) ),
			abs( centerColor.z - sColor.z ) );
		let avgLum = max( ( centerLum + sLum ) * 0.5, 0.0001 );
		let colW = exp( -( maxDiff / avgLum ) / max( phiCol, 0.0001 ) );
		return kernelW * lumW * normW * depW * colW;

	}
` );

/**
 * BilateralFilter — 5×5 à-trous wavelet, edge-preserving, multi-iteration.
 *
 * Reads asvgf:demodulated (lighting), filters in demodulated space across
 * `iterations` ping-pong passes with step size 2^i, multiplies by albedo on
 * the final pass to remodulate. φ params are relative tolerances.
 *
 * Publishes: bilateralFiltering:output (modulated)
 * Reads:     asvgf:demodulated (or fallback), pathtracer:normalDepth,
 *            pathtracer:albedo, variance:output
 */
export class BilateralFilter extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'BilateralFiltering', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.inputTextureName = options.inputTextureName || 'asvgf:demodulated';
		this.normalDepthTextureName = options.normalDepthTextureName || 'pathtracer:normalDepth';
		// Mapped (normal/bump-perturbed) normal for the normal edge-stop — geometric
		// normals are flat across a normal-mapped surface so normW can't preserve bump detail.
		this.shadingNormalTextureName = options.shadingNormalTextureName || 'pathtracer:shadingNormal';
		this.albedoTextureName = options.albedoTextureName || 'pathtracer:albedo';
		this.varianceTextureName = options.varianceTextureName || 'variance:output';
		this.iterations = options.iterations ?? 4;

		// All φ are relative tolerances (fractions of mean/depth). Bigger =
		// more permissive blending across edges.
		this.phiColor = uniform( options.phiColor ?? 0.5 );
		this.phiNormal = uniform( options.phiNormal ?? 128.0 );
		this.phiDepth = uniform( options.phiDepth ?? 0.05 );
		this.phiLuminance = uniform( options.phiLuminance ?? 4.0 );
		this.stepSizeU = uniform( 1, 'int' );
		// 1 on the final iteration → multiply by albedo to remodulate.
		this.isLastIterationU = uniform( 0, 'int' );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		this._readTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();
		this._shadingNormalTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._varianceTexNode = new TextureNode();

		const w = options.width || 1;
		const h = options.height || 1;

		// Pre-allocate StorageTextures at max — defensive against three.js #33061
		// (TSL compute pipeline keeps a stale GPUTextureView after setSize()).

		// LinearFilter required for textureLoad codegen on StorageTextures.
		this._storageTexA = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._storageTexA.type = HalfFloatType;
		this._storageTexA.format = RGBAFormat;
		this._storageTexA.minFilter = LinearFilter;
		this._storageTexA.magFilter = LinearFilter;

		this._storageTexB = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._storageTexB.type = HalfFloatType;
		this._storageTexB.format = RGBAFormat;
		this._storageTexB.minFilter = LinearFilter;
		this._storageTexB.magFilter = LinearFilter;

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Active-size RT published downstream; over-allocated storage tex sampled
		// by UV would read the wrong region.
		this._outputTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._compiled = false;

		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildCompute();

	}

	// One compute node per ping-pong write direction.
	_buildCompute() {

		this._computeNodeA = this._buildComputeForDirection( this._storageTexA );
		this._computeNodeB = this._buildComputeForDirection( this._storageTexB );

	}

	_buildComputeForDirection( writeStorageTex ) {

		const readTexNode = this._readTexNode;
		const ndTexNode = this._normalDepthTexNode;
		const snTexNode = this._shadingNormalTexNode;
		const albedoTexNode = this._albedoTexNode;
		const varTexNode = this._varianceTexNode;
		const phiColor = this.phiColor;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const phiLuminance = this.phiLuminance;
		const stepSize = this.stepSizeU;
		const isLastIterationU = this.isLastIterationU;
		const resW = this.resW;
		const resH = this.resH;

		// 5×5 A-trous kernel weights (Gaussian approx, sum = 1.0)
		const kernel = [
			1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
			4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
			6.0 / 256.0, 24.0 / 256.0, 36.0 / 256.0, 24.0 / 256.0, 6.0 / 256.0,
			4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
			1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
		];

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const centerColor = textureLoad( readTexNode, coord ).xyz;
				const centerND = textureLoad( ndTexNode, coord );
				// Normal edge-stop reads the mapped (shading) normal; depth gate stays geometric.
				const centerNormal = textureLoad( snTexNode, coord ).xyz.mul( 2.0 ).sub( 1.0 );
				const centerDepth = centerND.w;
				const centerLum = luminance( centerColor );
				const centerSafeAlbedo = max( textureLoad( albedoTexNode, coord ).xyz, vec3( ALBEDO_EPS ) );
				const centerAlbedoLum = max( luminance( centerSafeAlbedo ), float( ALBEDO_EPS ) ).toVar();

				// sigma_l = phiLum * √variance / albedoLum + ε. Dividing by
				// albedoLum compensates for the 1/albedo noise amplification
				// from demodulation — otherwise dark materials get an
				// under-estimated sigma → over-strict luminance gate → no
				// blending → silhouette dark-outline artifact.
				const variance = textureLoad( varTexNode, coord ).z;
				const sigmaL = phiLuminance
					.mul( sqrt( max( variance, float( 0.0 ) ) ) )
					.div( centerAlbedoLum )
					.add( float( 0.0001 ) );

				const colorSum = vec3( 0.0 ).toVar();
				const weightSum = float( 0.0 ).toVar();

				// 5×5 à-trous kernel (Gaussian-approx, Σ=1)
				for ( let iy = 0; iy < 5; iy ++ ) {

					for ( let ix = 0; ix < 5; ix ++ ) {

						const dx = ix - 2;
						const dy = iy - 2;
						const kw = kernel[ iy * 5 + ix ];

						const sx = gx.add( stepSize.mul( dx ) )
							.clamp( int( 0 ), int( resW ).sub( 1 ) );
						const sy = gy.add( stepSize.mul( dy ) )
							.clamp( int( 0 ), int( resH ).sub( 1 ) );

						const sColor = textureLoad( readTexNode, ivec2( sx, sy ) ).xyz;
						const sND = textureLoad( ndTexNode, ivec2( sx, sy ) );
						const sNormal = textureLoad( snTexNode, ivec2( sx, sy ) ).xyz.mul( 2.0 ).sub( 1.0 );
						const sDepth = sND.w;
						const sLum = luminance( sColor );

						const w = bilateralWeight(
							centerLum, sLum,
							centerNormal, sNormal,
							centerDepth, sDepth,
							centerColor, sColor,
							float( kw ),
							sigmaL, phiNormal, phiDepth, phiColor
						);

						colorSum.addAssign( sColor.mul( w ) );
						weightSum.addAssign( w );

					}

				}

				const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );

				// Remodulate by albedo only on the final iteration so the
				// inner ping-pong stays in demodulated space.
				const isLast = isLastIterationU.equal( int( 1 ) );
				const output = isLast.select( filtered.mul( centerSafeAlbedo ), filtered );

				textureStore(
					writeStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( output, 1.0 )
				).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const inputTex = context.getTexture( this.inputTextureName )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );
		const ndTex = context.getTexture( this.normalDepthTextureName );
		// Fall back to geometric normalDepth if the mapped normal isn't published.
		const snTex = context.getTexture( this.shadingNormalTextureName ) || ndTex;
		const albedoTex = context.getTexture( this.albedoTextureName );
		const varTex = context.getTexture( this.varianceTextureName );

		if ( ! inputTex ) return;

		const img = inputTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			// Compare against an active-size RT, not the fixed-2048 StorageTexture.
			if ( img.width !== this._outputTarget.width ||
				img.height !== this._outputTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// RenderTarget textures — safe to bind before first-compile.
		if ( ndTex ) this._normalDepthTexNode.value = ndTex;
		if ( snTex ) this._shadingNormalTexNode.value = snTex;
		if ( albedoTex ) this._albedoTexNode.value = albedoTex;

		// First-frame compile while StorageTexture-typed nodes still hold
		// EmptyTexture — codegen then emits textureLoad with the level
		// parameter, which the runtime requires for non-zero reads.
		if ( ! this._compiled ) {

			this.renderer.compute( this._computeNodeA );
			this.renderer.compute( this._computeNodeB );
			this._compiled = true;

		}

		if ( varTex ) this._varianceTexNode.value = varTex;

		// À-trous iterations: step size 2^i, ping-pong write direction.
		// Last iteration multiplies by albedo to remodulate.
		let readTex = inputTex;
		let writeNode = this._computeNodeA;
		let nextWriteNode = this._computeNodeB;

		for ( let i = 0; i < this.iterations; i ++ ) {

			this.stepSizeU.value = 1 << i;
			this._readTexNode.value = readTex;
			this.isLastIterationU.value = ( i === this.iterations - 1 ) ? 1 : 0;

			this.renderer.compute( writeNode );

			readTex = ( writeNode === this._computeNodeA )
				? this._storageTexA
				: this._storageTexB;

			const tmp = writeNode;
			writeNode = nextWriteNode;
			nextWriteNode = tmp;

		}

		// Copy the final result out of the over-allocated StorageTexture into
		// the active-size RenderTarget; downstream stages UV-sample the latter.
		this._srcRegion.max.set( this._outputTarget.width, this._outputTarget.height );
		this.renderer.copyTextureToTexture( readTex, this._outputTarget.texture, this._srcRegion );

		context.setTexture( 'bilateralFiltering:output', this._outputTarget.texture );

	}

	// Accepts the same keys as ASVGF presets; unknown keys ignored.
	updateParameters( params ) {

		if ( ! params ) return;
		if ( params.phiColor !== undefined ) this.phiColor.value = params.phiColor;
		if ( params.phiNormal !== undefined ) this.phiNormal.value = params.phiNormal;
		if ( params.phiDepth !== undefined ) this.phiDepth.value = params.phiDepth;
		if ( params.phiLuminance !== undefined ) this.phiLuminance.value = params.phiLuminance;
		if ( params.atrousIterations !== undefined ) this.iterations = params.atrousIterations;

	}

	setSize( width, height ) {

		// StorageTextures stay at their max allocation (see constructor).
		this._outputTarget.setSize( width, height );
		this._outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNodeA.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._computeNodeB.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

	}

	reset() {

		// No temporal state to reset

	}

	dispose() {

		this._computeNodeA?.dispose();
		this._computeNodeB?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		this._outputTarget?.dispose();
		this._readTexNode?.dispose();
		this._normalDepthTexNode?.dispose();
		this._shadingNormalTexNode?.dispose();
		this._albedoTexNode?.dispose();
		this._varianceTexNode?.dispose();

	}

}
