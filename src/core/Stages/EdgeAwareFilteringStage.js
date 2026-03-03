import { Fn, vec3, vec4, float, uv, uniform, If, dot, max, min, abs, mix } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

/**
 * WebGPU Edge-Aware Filtering Stage
 *
 * Edge-preserving temporal filtering with progressive edge sharpening.
 * Uses a large directional sampling kernel for edge-guided smoothing,
 * then a smaller kernel for edge-detail refinement.
 *
 * Features:
 *   - Scene-adaptive: aggressive filtering for dynamic, progressive for static
 *   - Edge sharpening increases over iterations
 *   - Fast path during interaction mode (direct copy, no filtering cost)
 *   - Firefly reduction for high-luminance outliers
 *
 * Execution: PER_CYCLE
 *
 * Textures published:  edgeFiltering:output
 * Textures read:       asvgf:output (fallback: pathtracer:color)
 */
export class EdgeAwareFilteringStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'EdgeAwareFiltering', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;

		// Parameters
		this.pixelEdgeSharpness = uniform( options.pixelEdgeSharpness ?? 0.75 );
		this.edgeSharpenSpeed = uniform( options.edgeSharpenSpeed ?? 0.05 );
		this.edgeThreshold = uniform( options.edgeThreshold ?? 1.0 );
		this.iterationCount = uniform( 0.0 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Internal counter
		this._iterations = 0;

		// Input texture node
		this._inputTexNode = new TextureNode();

		// Render target
		const w = options.width || 1;
		const h = options.height || 1;
		this.outputTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._buildMaterial();

	}

	_buildMaterial() {

		const inputTex = this._inputTexNode;
		const sharpness = this.pixelEdgeSharpness;
		const sharpenSpeed = this.edgeSharpenSpeed;
		const threshold = this.edgeThreshold;
		const iterCount = this.iterationCount;
		const resW = this.resW;
		const resH = this.resH;

		const shader = Fn( () => {

			const coord = uv();
			const txW = float( 1.0 ).div( resW );
			const txH = float( 1.0 ).div( resH );

			const center = inputTex.sample( coord ).xyz;
			const centerLum = dot( center, vec3( 0.2126, 0.7152, 0.0722 ) );

			// Progressive edge sharpening factor
			const edgeFactor = sharpness.add( iterCount.mul( sharpenSpeed ) ).clamp( 0.0, 0.95 );

			// Sample 13-pixel cross pattern for edge-aware filtering
			// 4 directions × 3 samples each + centre
			const colorSum = center.toVar();
			const weightSum = float( 1.0 ).toVar();

			// Directions: right, up, left, down, and diagonals
			const dirs = [
				[ 1, 0 ], [ 0, 1 ], [ - 1, 0 ], [ 0, - 1 ],
				[ 1, 1 ], [ - 1, 1 ], [ - 1, - 1 ], [ 1, - 1 ],
			];

			// Sample along each direction at distances 1, 2, 3
			for ( const [ dx, dy ] of dirs ) {

				for ( const dist of [ 1, 2 ] ) {

					const sUV = coord.add( vec3( txW.mul( dx * dist ), txH.mul( dy * dist ), 0 ).xy );
					const sColor = inputTex.sample( sUV ).xyz;
					const sLum = dot( sColor, vec3( 0.2126, 0.7152, 0.0722 ) );

					// Luminance-based edge weight
					const lumDiff = abs( centerLum.sub( sLum ) );
					const edgeWeight = lumDiff.div( max( threshold, float( 0.001 ) ) ).negate().exp();

					// Distance falloff
					const distWeight = float( 1.0 ).div( float( dist ).add( 0.5 ) );

					const w = edgeWeight.mul( distWeight );
					colorSum.addAssign( sColor.mul( w ) );
					weightSum.addAssign( w );

				}

			}

			const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );

			// Blend between filtered and original based on edge sharpening factor
			const finalColor = mix( filtered, center, edgeFactor );

			// Firefly suppression for very high luminance
			const finalLum = dot( finalColor, vec3( 0.2126, 0.7152, 0.0722 ) );
			const clampedColor = finalColor.toVar();
			If( finalLum.greaterThan( 10.0 ), () => {

				clampedColor.assign( finalColor.mul( float( 10.0 ).div( finalLum ) ) );

			} );

			return vec4( clampedColor, 1.0 );

		} );

		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = shader();
		this.material.toneMapped = false;
		this.quad = new QuadMesh( this.material );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Resolve input with fallback chain
		const inputTex = context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'bilateralFiltering:output' )
			|| context.getTexture( 'pathtracer:color' );

		if ( ! inputTex ) return;

		// Fast path during interaction mode — direct copy
		const interactionMode = context.getState( 'interactionMode' );
		if ( interactionMode ) {

			context.setTexture( 'edgeFiltering:output', inputTex );
			return;

		}

		// Auto-size
		const img = inputTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this.outputTarget.width ||
				img.height !== this.outputTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Update input texture
		this._inputTexNode.value = inputTex;

		// Update iteration count for progressive sharpening
		this._iterations ++;
		this.iterationCount.value = this._iterations;

		// Render
		this.renderer.setRenderTarget( this.outputTarget );
		this.quad.render( this.renderer );

		// Publish
		context.setTexture( 'edgeFiltering:output', this.outputTarget.texture );

	}

	setFilteringEnabled( enabled ) {

		this.enabled = enabled;

	}

	updateUniforms( params ) {

		if ( ! params ) return;
		if ( params.pixelEdgeSharpness !== undefined ) this.pixelEdgeSharpness.value = params.pixelEdgeSharpness;
		if ( params.edgeSharpenSpeed !== undefined ) this.edgeSharpenSpeed.value = params.edgeSharpenSpeed;
		if ( params.edgeThreshold !== undefined ) this.edgeThreshold.value = params.edgeThreshold;

	}

	reset() {

		this._iterations = 0;
		this.iterationCount.value = 0;

	}

	setSize( width, height ) {

		this.outputTarget.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

	}

	dispose() {

		this.material?.dispose();
		this.outputTarget?.dispose();

	}

}
