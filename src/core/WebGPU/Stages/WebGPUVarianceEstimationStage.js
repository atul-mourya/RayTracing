import { Fn, vec3, vec4, float, uv, uniform, If, dot, max } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';

/**
 * WebGPU Variance Estimation Stage
 *
 * Computes temporal and spatial variance from the path tracer output.
 * Used by AdaptiveSamplingStage for sampling guidance and by
 * BilateralFilteringStage for variance-guided filtering.
 *
 * Algorithm:
 *   1. Compute luminance of current pixel
 *   2. Temporal accumulation of first and second moments
 *   3. Temporal variance = E[X²] - E[X]²
 *   4. Spatial variance from 3x3 neighbourhood
 *
 * Output format (RGBA HalfFloat):
 *   R — mean luminance
 *   G — second moment (mean of squared luminance)
 *   B — temporal variance
 *   A — spatial variance
 *
 * Execution: ALWAYS
 *
 * Textures published:  variance:output
 * Textures read:       configurable (default pathtracer:color)
 */
export class WebGPUVarianceEstimationStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'VarianceEstimation', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.inputTextureName = options.inputTextureName || 'pathtracer:color';

		// Parameters
		this.varianceBoost = uniform( options.varianceBoost ?? 1.0 );
		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.1 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture node
		this._colorTexNode = new TextureNode();
		this._prevMomentsTexNode = new TextureNode();

		// Render targets (ping-pong for temporal moments)
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

		this.momentsTargetA = new RenderTarget( w, h, rtOpts );
		this.momentsTargetB = new RenderTarget( w, h, rtOpts );
		this.currentMoments = 0; // 0 = write A, read B; 1 = write B, read A

		this._buildMaterial();

	}

	_buildMaterial() {

		const colorTex = this._colorTexNode;
		const prevMomentsTex = this._prevMomentsTexNode;
		const varianceBoost = this.varianceBoost;
		const alpha = this.temporalAlpha;
		const resW = this.resW;
		const resH = this.resH;

		const shader = Fn( () => {

			const coord = uv();
			const color = colorTex.sample( coord ).xyz;
			const lum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );

			// Previous moments
			const prevMoments = prevMomentsTex.sample( coord );
			const prevMean = prevMoments.x;
			const prevMeanSq = prevMoments.y;

			// Temporal accumulation of moments
			const newMean = prevMean.add( lum.sub( prevMean ).mul( alpha ) );
			const newMeanSq = prevMeanSq.add( lum.mul( lum ).sub( prevMeanSq ).mul( alpha ) );

			// Temporal variance = E[X²] - E[X]²
			const temporalVariance = max( newMeanSq.sub( newMean.mul( newMean ) ), float( 0.0 ) );

			// Spatial variance (3x3 neighbourhood)
			const txW = float( 1.0 ).div( resW );
			const txH = float( 1.0 ).div( resH );
			const spatMean = float( 0.0 ).toVar();
			const spatMeanSq = float( 0.0 ).toVar();

			const offsets = [
				[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ],
				[ - 1, 0 ], [ 0, 0 ], [ 1, 0 ],
				[ - 1, 1 ], [ 0, 1 ], [ 1, 1 ],
			];

			for ( const [ dx, dy ] of offsets ) {

				const sUV = coord.add( vec3( txW.mul( dx ), txH.mul( dy ), 0 ).xy );
				const sColor = colorTex.sample( sUV ).xyz;
				const sLum = dot( sColor, vec3( 0.2126, 0.7152, 0.0722 ) );
				spatMean.addAssign( sLum );
				spatMeanSq.addAssign( sLum.mul( sLum ) );

			}

			spatMean.divAssign( 9.0 );
			spatMeanSq.divAssign( 9.0 );
			const spatialVariance = max( spatMeanSq.sub( spatMean.mul( spatMean ) ), float( 0.0 ) );

			return vec4(
				newMean,
				newMeanSq,
				temporalVariance.mul( varianceBoost ),
				spatialVariance.mul( varianceBoost )
			);

		} );

		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = shader();
		this.material.toneMapped = false;
		this.quad = new QuadMesh( this.material );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( this.inputTextureName );
		if ( ! colorTex ) return;

		// Auto-size
		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this.momentsTargetA.width ||
				img.height !== this.momentsTargetA.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Ping-pong
		const writeTarget = this.currentMoments === 0 ? this.momentsTargetA : this.momentsTargetB;
		const readTarget = this.currentMoments === 0 ? this.momentsTargetB : this.momentsTargetA;

		this._colorTexNode.value = colorTex;
		this._prevMomentsTexNode.value = readTarget.texture;

		this.renderer.setRenderTarget( writeTarget );
		this.quad.render( this.renderer );

		// Swap
		this.currentMoments = 1 - this.currentMoments;

		// Publish
		context.setTexture( 'variance:output', writeTarget.texture );

	}

	reset() {

		this.currentMoments = 0;

	}

	setSize( width, height ) {

		this.momentsTargetA.setSize( width, height );
		this.momentsTargetB.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

	}

	dispose() {

		this.material?.dispose();
		this.momentsTargetA?.dispose();
		this.momentsTargetB?.dispose();

	}

}
