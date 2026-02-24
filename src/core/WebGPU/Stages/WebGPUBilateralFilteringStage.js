import { Fn, vec2, vec3, vec4, float, uv, uniform, int, dot, max, abs, normalize, Loop, If } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';

/**
 * WebGPU Bilateral Filtering Stage
 *
 * Edge-aware A-trous wavelet filter for spatial denoising.
 * Runs multiple iterations with increasing step size (2^i),
 * ping-ponging between two render targets.
 *
 * Edge-stopping functions:
 *   - Luminance: exp(-|ΔL| / σ_l)
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
		this.stepSizeU = uniform( 1.0 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture nodes
		this._colorTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();

		// Render targets (ping-pong)
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

		this.filterTargetA = new RenderTarget( w, h, rtOpts );
		this.filterTargetB = new RenderTarget( w, h, rtOpts );
		this.outputTarget = new RenderTarget( w, h, rtOpts );

		this._buildMaterial();

	}

	_buildMaterial() {

		const colorTex = this._colorTexNode;
		const ndTex = this._normalDepthTexNode;
		const phiColor = this.phiColor;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const phiLuminance = this.phiLuminance;
		const stepSize = this.stepSizeU;
		const resW = this.resW;
		const resH = this.resH;

		// 5x5 A-trous kernel weights (Gaussian approx)
		const kernel = [
			1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
			4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
			6.0 / 256.0, 24.0 / 256.0, 36.0 / 256.0, 24.0 / 256.0, 6.0 / 256.0,
			4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
			1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
		];

		const shader = Fn( () => {

			const coord = uv();
			const txW = float( 1.0 ).div( resW );
			const txH = float( 1.0 ).div( resH );

			// Centre sample
			const centerColor = colorTex.sample( coord ).xyz;
			const centerND = ndTex.sample( coord );
			const centerNormal = centerND.xyz.mul( 2.0 ).sub( 1.0 );
			const centerDepth = centerND.w;
			const centerLum = dot( centerColor, vec3( 0.2126, 0.7152, 0.0722 ) );

			const colorSum = vec3( 0.0 ).toVar();
			const weightSum = float( 0.0 ).toVar();

			// Unrolled 5x5 kernel
			for ( let iy = 0; iy < 5; iy ++ ) {

				for ( let ix = 0; ix < 5; ix ++ ) {

					const dx = ix - 2;
					const dy = iy - 2;
					const kw = kernel[ iy * 5 + ix ];

					const offsetUV = coord.add( vec2(
						txW.mul( float( dx ) ).mul( stepSize ),
						txH.mul( float( dy ) ).mul( stepSize )
					) );

					const sColor = colorTex.sample( offsetUV ).xyz;
					const sND = ndTex.sample( offsetUV );
					const sNormal = sND.xyz.mul( 2.0 ).sub( 1.0 );
					const sDepth = sND.w;
					const sLum = dot( sColor, vec3( 0.2126, 0.7152, 0.0722 ) );

					// Edge-stopping weights
					const lumDiff = abs( centerLum.sub( sLum ) );
					const lumWeight = lumDiff.negate().mul( phiLuminance ).exp();

					const nDot = max( dot( centerNormal, sNormal ), float( 0.0 ) );
					const normalWeight = nDot.pow( phiNormal );

					const dDiff = abs( centerDepth.sub( sDepth ) );
					const depthWeight = dDiff.negate().div( max( phiDepth, float( 0.001 ) ) ).exp();

					const colorDiff = max(
						max( abs( centerColor.x.sub( sColor.x ) ),
							abs( centerColor.y.sub( sColor.y ) ) ),
						abs( centerColor.z.sub( sColor.z ) )
					);
					const colorWeight = colorDiff.negate().mul( phiColor ).exp();

					const w = float( kw )
						.mul( lumWeight )
						.mul( normalWeight )
						.mul( depthWeight )
						.mul( colorWeight );

					colorSum.addAssign( sColor.mul( w ) );
					weightSum.addAssign( w );

				}

			}

			const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );
			return vec4( filtered, 1.0 );

		} );

		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = shader();
		this.material.toneMapped = false;
		this.quad = new QuadMesh( this.material );

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

			if ( img.width !== this.filterTargetA.width ||
				img.height !== this.filterTargetA.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Set normalDepth (may be null — shader handles gracefully)
		if ( ndTex ) this._normalDepthTexNode.value = ndTex;

		let readTex = inputTex;
		let writeTarget = this.filterTargetA;
		let readTarget = this.filterTargetB;

		for ( let i = 0; i < this.iterations; i ++ ) {

			this.stepSizeU.value = Math.pow( 2, i );
			this._colorTexNode.value = readTex;

			this.renderer.setRenderTarget( writeTarget );
			this.quad.render( this.renderer );

			readTex = writeTarget.texture;

			// Swap ping-pong
			const tmp = writeTarget;
			writeTarget = readTarget;
			readTarget = tmp;

		}

		// Final result is in readTarget (last written)
		// Copy to output for consistent naming
		context.setTexture( 'bilateralFiltering:output', readTex );

	}

	setSize( width, height ) {

		this.filterTargetA.setSize( width, height );
		this.filterTargetB.setSize( width, height );
		this.outputTarget.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

	}

	reset() {

		// No temporal state to reset

	}

	dispose() {

		this.material?.dispose();
		this.filterTargetA?.dispose();
		this.filterTargetB?.dispose();
		this.outputTarget?.dispose();

	}

}
