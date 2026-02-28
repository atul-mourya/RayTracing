import { Fn, wgslFn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform, If, max,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, LinearFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import { luminance } from '../TSL/Common.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Bilateral edge-stopping weight.
 *
 * Combines luminance, normal, depth, and color similarity into
 * a single weight multiplied by the kernel weight.
 */
const bilateralWeight = /*@__PURE__*/ wgslFn( `
	fn bilateralWeight(
		centerLum: f32, sLum: f32,
		centerNormal: vec3f, sNormal: vec3f,
		centerDepth: f32, sDepth: f32,
		centerColor: vec3f, sColor: vec3f,
		kernelW: f32,
		phiLum: f32, phiNorm: f32, phiDep: f32, phiCol: f32
	) -> f32 {

		let lumW = exp( -abs( centerLum - sLum ) * phiLum );
		let normW = pow( max( dot( centerNormal, sNormal ), 0.0 ), phiNorm );
		let depW = exp( -abs( centerDepth - sDepth ) / max( phiDep, 0.001 ) );
		let maxDiff = max( max( abs( centerColor.x - sColor.x ),
			abs( centerColor.y - sColor.y ) ),
			abs( centerColor.z - sColor.z ) );
		let colW = exp( -maxDiff * phiCol );
		return kernelW * lumW * normW * depW * colW;

	}
` );

/**
 * WebGPU Bilateral Filtering Stage (Compute Shader)
 *
 * Edge-aware A-trous wavelet filter for spatial denoising.
 * Runs multiple iterations with increasing step size (2^i),
 * ping-ponging between two StorageTextures.
 *
 * Algorithm:
 *   1. textureLoad center pixel (color + normalDepth)
 *   2. Unrolled 5×5 a-trous kernel with edge-stopping weights
 *   3. Normalize accumulated color
 *   4. textureStore filtered result
 *   5. Repeat for 4 iterations (step sizes 1, 2, 4, 8)
 *
 * Edge-stopping functions:
 *   - Luminance: exp(-|ΔL| * σ_l)
 *   - Normal:    dot(n1,n2)^σ_n
 *   - Depth:     exp(-|Δz| / σ_z)
 *   - Color:     exp(-maxDiff * σ_c)
 *
 * Execution: ALWAYS
 *
 * Textures published:  bilateralFiltering:output
 * Textures read:       configurable color input + pathtracer:normalDepth
 */
export class WebGPUBilateralFilteringStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'BilateralFiltering', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.inputTextureName = options.inputTextureName || 'asvgf:output';
		this.normalDepthTextureName = options.normalDepthTextureName || 'pathtracer:normalDepth';
		this.iterations = options.iterations ?? 4;

		// Edge-stopping parameters
		this.phiColor = uniform( options.phiColor ?? 10.0 );
		this.phiNormal = uniform( options.phiNormal ?? 128.0 );
		this.phiDepth = uniform( options.phiDepth ?? 1.0 );
		this.phiLuminance = uniform( options.phiLuminance ?? 4.0 );
		this.stepSizeU = uniform( 1, 'int' );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture nodes
		this._readTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();

		// Ping-pong StorageTextures
		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter so textureLoad codegen includes required level parameter
		// when _readTexNode.value is later set to a StorageTexture
		this._storageTexA = new StorageTexture( w, h );
		this._storageTexA.type = HalfFloatType;
		this._storageTexA.format = RGBAFormat;
		this._storageTexA.minFilter = LinearFilter;
		this._storageTexA.magFilter = LinearFilter;

		this._storageTexB = new StorageTexture( w, h );
		this._storageTexB.type = HalfFloatType;
		this._storageTexB.format = RGBAFormat;
		this._storageTexB.minFilter = LinearFilter;
		this._storageTexB.magFilter = LinearFilter;

		this._compiled = false;

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildCompute();

	}

	/**
	 * Build two compute nodes — one for each ping-pong write direction.
	 *
	 * _computeNodeA: writes to StorageTexA, reads from _readTexNode
	 * _computeNodeB: writes to StorageTexB, reads from _readTexNode
	 *
	 * Read-side texture wrapped in TextureNode so compile-time type is
	 * regular Texture (avoids Three.js WGSL textureLoad codegen bug).
	 */
	_buildCompute() {

		this._computeNodeA = this._buildComputeForDirection( this._storageTexA );
		this._computeNodeB = this._buildComputeForDirection( this._storageTexB );

	}

	_buildComputeForDirection( writeStorageTex ) {

		const readTexNode = this._readTexNode;
		const ndTexNode = this._normalDepthTexNode;
		const phiColor = this.phiColor;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const phiLuminance = this.phiLuminance;
		const stepSize = this.stepSizeU;
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

				// Centre sample
				const centerColor = textureLoad( readTexNode, coord ).xyz;
				const centerND = textureLoad( ndTexNode, coord );
				const centerNormal = centerND.xyz.mul( 2.0 ).sub( 1.0 );
				const centerDepth = centerND.w;
				const centerLum = luminance( centerColor );

				const colorSum = vec3( 0.0 ).toVar();
				const weightSum = float( 0.0 ).toVar();

				// Unrolled 5×5 a-trous kernel
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
						const sNormal = sND.xyz.mul( 2.0 ).sub( 1.0 );
						const sDepth = sND.w;
						const sLum = luminance( sColor );

						const w = bilateralWeight(
							centerLum, sLum,
							centerNormal, sNormal,
							centerDepth, sDepth,
							centerColor, sColor,
							float( kw ),
							phiLuminance, phiNormal, phiDepth, phiColor
						);

						colorSum.addAssign( sColor.mul( w ) );
						weightSum.addAssign( w );

					}

				}

				const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );

				textureStore(
					writeStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( filtered, 1.0 )
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
			|| context.getTexture( 'pathtracer:color' );
		const ndTex = context.getTexture( this.normalDepthTextureName );

		if ( ! inputTex ) return;

		// Auto-size
		const img = inputTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this._storageTexA.image.width ||
				img.height !== this._storageTexA.image.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Set normalDepth (may be null — shader handles gracefully)
		if ( ndTex ) this._normalDepthTexNode.value = ndTex;

		// Force-compile both compute nodes on first frame while _readTexNode
		// still holds EmptyTexture. This ensures WGSLNodeBuilder.generateTextureLoad()
		// sees isStorageTexture=false and emits the required level parameter.
		if ( ! this._compiled ) {

			this.renderer.compute( this._computeNodeA );
			this.renderer.compute( this._computeNodeB );
			this._compiled = true;

		}

		// Iteration dispatch: ping-pong between StorageTexA and StorageTexB
		let readTex = inputTex;
		let writeNode = this._computeNodeA;
		let nextWriteNode = this._computeNodeB;

		for ( let i = 0; i < this.iterations; i ++ ) {

			this.stepSizeU.value = 1 << i;
			this._readTexNode.value = readTex;

			this.renderer.compute( writeNode );

			// Next iteration reads from what we just wrote
			readTex = ( writeNode === this._computeNodeA )
				? this._storageTexA
				: this._storageTexB;

			// Swap write direction
			const tmp = writeNode;
			writeNode = nextWriteNode;
			nextWriteNode = tmp;

		}

		// Publish final output (last written StorageTexture)
		context.setTexture( 'bilateralFiltering:output', readTex );

	}

	setSize( width, height ) {

		this._storageTexA.setSize( width, height );
		this._storageTexB.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNodeA.setCount( [ this._dispatchX, this._dispatchY, 1 ] );
		this._computeNodeB.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	reset() {

		// No temporal state to reset

	}

	dispose() {

		this._computeNodeA?.dispose();
		this._computeNodeB?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();

	}

}
