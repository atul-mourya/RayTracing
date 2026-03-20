import { Fn, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, min, abs,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Vector3, Box2, Vector2 } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

/**
 * WebGPU Tile Highlight Stage (Compute Shader)
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
		this.tiles = uniform( 4, 'int' ); // tiles per side (e.g. 4 = 4x4 = 16 tiles)
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
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildCompute();

	}

	_buildCompute() {

		const inputTex = this._inputTexNode;
		const outputStorageTex = this._outputStorageTex;
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

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const color = textureLoad( inputTex, ivec2( gx, gy ) ).xyz;
				const result = vec4( color, 1.0 ).toVar();

				// Only draw borders in tiled render mode with valid tile index
				If( renderMode.equal( 1 ).and( tileIndex.greaterThanEqual( 0 ) ), () => {

					// Pixel position (already integer coords from compute)
					const px = float( gx );
					const py = float( gy );

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

				textureStore(
					outputStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

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

		// Dispatch compute
		this.renderer.compute( this._computeNode );

		// Copy StorageTexture → RenderTarget for downstream readability
		// Use Box2 srcRegion since StorageTexture is pre-allocated at max size
		this._srcRegion.min.set( 0, 0 );
		this._srcRegion.max.set( this.outputTarget.width, this.outputTarget.height );
		this.renderer.copyTextureToTexture( this._outputStorageTex, this.outputTarget.texture, this._srcRegion );

		// Publish RenderTarget texture (NOT StorageTexture)
		context.setTexture( 'tileHighlight:output', this.outputTarget.texture );

	}

	setSize( width, height ) {

		// Only resize the RenderTarget — StorageTexture stays at max allocation
		// (StorageTexture.setSize() breaks textureStore bind groups, Three.js bug #32969)
		this.outputTarget.setSize( width, height );
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	reset() {

		// No temporal state

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this.outputTarget?.dispose();

	}

}
