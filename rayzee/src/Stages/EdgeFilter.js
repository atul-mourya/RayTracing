import { Fn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, abs, mix,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';

/**
 * WebGPU Edge-Aware Filtering Stage (Compute Shader)
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
export class EdgeFilter extends RenderStage {

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

		// Output StorageTexture (compute writes here)
		// Pre-allocated at max size — NEVER resize/dispose after this.
		// StorageTexture.setSize() breaks textureStore bind groups (Three.js bug #32969).
		const MAX_STORAGE_SIZE = 2048;
		const w = options.width || 1;
		const h = options.height || 1;

		this._outputStorageTex = new StorageTexture( MAX_STORAGE_SIZE, MAX_STORAGE_SIZE );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = NearestFilter;
		this._outputStorageTex.magFilter = NearestFilter;

		// Reusable Box2 for srcRegion in copyTextureToTexture
		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Output RenderTarget (readable copy for downstream stages)
		this.outputTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 16 );
		this._dispatchY = Math.ceil( h / 16 );

		this._buildCompute();

	}

	_buildCompute() {

		const inputTex = this._inputTexNode;
		const outputStorageTex = this._outputStorageTex;
		const sharpness = this.pixelEdgeSharpness;
		const sharpenSpeed = this.edgeSharpenSpeed;
		const threshold = this.edgeThreshold;
		const iterCount = this.iterationCount;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const center = textureLoad( inputTex, ivec2( gx, gy ) ).xyz;
				const centerLum = dot( center, vec3( 0.2126, 0.7152, 0.0722 ) );

				// Progressive edge sharpening factor
				const edgeFactor = sharpness.add( iterCount.mul( sharpenSpeed ) ).clamp( 0.0, 0.95 );

				// Sample 8-direction cross pattern for edge-aware filtering
				// 8 directions x 2 distances + centre
				const colorSum = center.toVar();
				const weightSum = float( 1.0 ).toVar();

				// Directions: right, up, left, down, and diagonals
				const dirs = [
					[ 1, 0 ], [ 0, 1 ], [ - 1, 0 ], [ 0, - 1 ],
					[ 1, 1 ], [ - 1, 1 ], [ - 1, - 1 ], [ 1, - 1 ],
				];

				// Sample along each direction at distances 1, 2
				for ( const [ dx, dy ] of dirs ) {

					for ( const dist of [ 1, 2 ] ) {

						const sx = gx.add( dx * dist ).clamp( int( 0 ), int( resW ).sub( 1 ) );
						const sy = gy.add( dy * dist ).clamp( int( 0 ), int( resH ).sub( 1 ) );
						const sColor = textureLoad( inputTex, ivec2( sx, sy ) ).xyz;
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

				textureStore(
					outputStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( clampedColor, 1.0 )
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

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

		// Dispatch compute
		this.renderer.compute( this._computeNode );

		// Copy StorageTexture → RenderTarget for downstream readability
		// Use Box2 srcRegion since StorageTexture is pre-allocated at max size
		this._srcRegion.min.set( 0, 0 );
		this._srcRegion.max.set( this.outputTarget.width, this.outputTarget.height );
		this.renderer.copyTextureToTexture( this._outputStorageTex, this.outputTarget.texture, this._srcRegion );

		// Publish RenderTarget texture (NOT StorageTexture)
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

		// Only resize the RenderTarget — StorageTexture stays at max allocation
		// (StorageTexture.setSize() breaks textureStore bind groups, Three.js bug #32969)
		this.outputTarget.setSize( width, height );
		this.outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this.outputTarget?.dispose();

	}

}
