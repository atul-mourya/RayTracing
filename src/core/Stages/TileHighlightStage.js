import { Fn, vec3, vec4, float, uv, uniform, If, max, min, abs } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Vector3, Vector4 } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

/**
 * WebGPU Tile Highlight Stage
 *
 * Draws coloured borders around the current tile during tiled rendering.
 * Reads the final composited output and overlays tile borders.
 *
 * Execution: ALWAYS
 *
 * Events listened:
 *   tile:changed       — update tile bounds + index
 *   renderMode:changed — update render mode
 *
 * Textures published:  tileHighlight:output
 * Textures read:       edgeFiltering:output > asvgf:output > pathtracer:color
 */
export class TileHighlightStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'TileHighlight', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// Uniforms
		this.tileIndex = uniform( - 1, 'int' );
		this.tiles = uniform( 4, 'int' ); // tiles per side (e.g. 4 = 4×4 = 16 tiles)
		this.renderMode = uniform( 0, 'int' ); // 0 = progressive, 1 = tiled
		this.highlightColor = uniform( new Vector3( 0.2, 0.8, 1.0 ) );
		this.borderWidth = uniform( 2.0 );
		this.tileBoundsX = uniform( 0.0 );
		this.tileBoundsY = uniform( 0.0 );
		this.tileBoundsW = uniform( 1.0 );
		this.tileBoundsH = uniform( 1.0 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture node
		this._inputTexNode = new TextureNode();

		// Render target
		this.outputTarget = new RenderTarget(
			options.width || 1, options.height || 1, {
				type: HalfFloatType,
				format: RGBAFormat,
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				depthBuffer: false,
				stencilBuffer: false
			}
		);

		this._buildMaterial();

	}

	_buildMaterial() {

		const inputTex = this._inputTexNode;
		const renderMode = this.renderMode;
		const tileIndex = this.tileIndex;
		const borderWidth = this.borderWidth;
		const highlightColor = this.highlightColor;
		const boundsX = this.tileBoundsX;
		const boundsY = this.tileBoundsY;
		const boundsW = this.tileBoundsW;
		const boundsH = this.tileBoundsH;
		const resW = this.resW;
		const resH = this.resH;

		const shader = Fn( () => {

			const coord = uv();
			const color = inputTex.sample( coord ).xyz;
			const result = vec4( color, 1.0 ).toVar();

			// Only draw borders in tiled render mode with valid tile index
			If( renderMode.equal( 1 ).and( tileIndex.greaterThanEqual( 0 ) ), () => {

				// Pixel position
				const px = coord.x.mul( resW );
				const py = coord.y.mul( resH );

				// Tile bounds in pixel space
				// NormalDepthStage & PathTracer use top-left origin; GPU uses bottom-left
				// Convert: y_gpu = resH - (boundsY + boundsH)
				const tileLeft = boundsX;
				const tileBottom = resH.sub( boundsY.add( boundsH ) );
				const tileRight = boundsX.add( boundsW );
				const tileTop = resH.sub( boundsY );

				// Check if pixel is within tile bounds
				const inTile = px.greaterThanEqual( tileLeft )
					.and( px.lessThanEqual( tileRight ) )
					.and( py.greaterThanEqual( tileBottom ) )
					.and( py.lessThanEqual( tileTop ) );

				If( inTile, () => {

					// Distance to nearest edge
					const dLeft = abs( px.sub( tileLeft ) );
					const dRight = abs( px.sub( tileRight ) );
					const dBottom = abs( py.sub( tileBottom ) );
					const dTop = abs( py.sub( tileTop ) );

					const minDist = min( min( dLeft, dRight ), min( dBottom, dTop ) );

					// Draw border
					If( minDist.lessThan( borderWidth ), () => {

						result.assign( vec4( highlightColor, 1.0 ) );

					} );

				} );

			} );

			return result;

		} );

		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = shader();
		this.material.toneMapped = false;
		this.quad = new QuadMesh( this.material );

	}

	setupEventListeners() {

		this.on( 'tile:changed', ( data ) => {

			if ( ! data ) return;
			if ( data.tileIndex !== undefined ) this.tileIndex.value = data.tileIndex;
			if ( data.tiles !== undefined ) this.tiles.value = data.tiles;
			if ( data.bounds ) {

				this.tileBoundsX.value = data.bounds.x || 0;
				this.tileBoundsY.value = data.bounds.y || 0;
				this.tileBoundsW.value = data.bounds.width || 0;
				this.tileBoundsH.value = data.bounds.height || 0;

			}

		} );

		this.on( 'renderMode:changed', ( data ) => {

			if ( data && data.renderMode !== undefined ) {

				this.renderMode.value = data.renderMode;

			}

		} );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Resolve input with fallback chain
		const inputTex = context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );

		if ( ! inputTex ) return;

		// If not in tiled mode, pass through
		if ( this.renderMode.value !== 1 || this.tileIndex.value < 0 ) {

			context.setTexture( 'tileHighlight:output', inputTex );
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

		this._inputTexNode.value = inputTex;

		this.renderer.setRenderTarget( this.outputTarget );
		this.quad.render( this.renderer );

		context.setTexture( 'tileHighlight:output', this.outputTarget.texture );

	}

	setSize( width, height ) {

		this.outputTarget.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

	}

	reset() {

		// No temporal state

	}

	dispose() {

		this.material?.dispose();
		this.outputTarget?.dispose();

	}

}
