import { ShaderMaterial, UniformsUtils, Vector2, Vector3, Vector4 } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage } from '../Pipeline/PipelineStage.js';

/**
 * TileHighlightStage - Draws borders around tiles during tiled rendering
 *
 * Refactored from TileHighlightPass to use the new pipeline architecture.
 *
 * Key changes from TileHighlightPass:
 * - Extends PipelineStage instead of Pass
 * - Listens to 'tile:changed' event instead of setCurrentTileBounds()
 * - Reads input texture from context instead of readBuffer parameter
 * - Updates state from context automatically
 *
 * Events listened to:
 * - tile:changed - Updates tile bounds and index
 * - pipeline:resize - Updates resolution
 */
export class TileHighlightStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'TileHighlight', options );

		const resolution = options.resolution || { x: 1920, y: 1080 };

		this.uniforms = UniformsUtils.clone( {
			tDiffuse: { value: null },
			resolution: { value: new Vector2( resolution.x, resolution.y ) },
			tileIndex: { value: - 1 },
			tiles: { value: options.tiles || 4 },
			renderMode: { value: 0 },
			highlightColor: { value: options.highlightColor || new Vector3( 1, 0, 0 ) }, // Red by default
			borderWidthPixels: { value: options.borderWidthPixels || 2.0 }, // Border width in pixels
			currentTileBounds: { value: new Vector4( 0, 0, 0, 0 ) } // x, y, width, height
		} );

		this.material = new ShaderMaterial( {
			uniforms: this.uniforms,
			vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
			fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform vec2 resolution;
                uniform int tileIndex;
                uniform int tiles;
                uniform int renderMode;
                uniform vec3 highlightColor;
                uniform float borderWidthPixels;
                uniform vec4 currentTileBounds; // x, y, width, height in pixels (top-left origin)
                varying vec2 vUv;

                void main() {
                    vec4 texel = texture2D(tDiffuse, vUv);

                    // Only show highlights in tiled rendering mode and when a valid tile is being rendered
                    if (renderMode != 1 || tileIndex < 0) {
                        gl_FragColor = texel;
                        return;
                    }

                    // Convert UV to pixel coordinates (WebGL uses bottom-left origin)
                    vec2 pixelCoord = vUv * resolution;

                    // Convert tile bounds from top-left origin to bottom-left origin to match WebGL
                    // Original bounds: (x, y, width, height) with (0,0) at top-left
                    // WebGL coords: (0,0) at bottom-left
                    float tileLeft = currentTileBounds.x;
                    float tileBottom = resolution.y - (currentTileBounds.y + currentTileBounds.w); // Flip Y
                    float tileRight = currentTileBounds.x + currentTileBounds.z;
                    float tileTop = resolution.y - currentTileBounds.y; // Flip Y

                    // Check if we're within the current tile bounds (using WebGL coordinates)
                    bool inTileX = pixelCoord.x >= tileLeft && pixelCoord.x < tileRight;
                    bool inTileY = pixelCoord.y >= tileBottom && pixelCoord.y < tileTop;

                    if (inTileX && inTileY) {
                        // We're inside the current tile, check if we're on the border
                        vec2 distanceFromEdge = min(
                            vec2(pixelCoord.x - tileLeft, pixelCoord.y - tileBottom),  // Distance from left/bottom edge
                            vec2(tileRight - pixelCoord.x, tileTop - pixelCoord.y)     // Distance from right/top edge
                        );

                        float minDistance = min(distanceFromEdge.x, distanceFromEdge.y);

                        if (minDistance < borderWidthPixels) {
                            gl_FragColor = vec4(highlightColor, 1.0);
                        } else {
                            gl_FragColor = texel;
                        }
                    } else {
                        gl_FragColor = texel;
                    }
                }
            `
		} );

		this.fsQuad = new FullScreenQuad( this.material );

		// Store renderer reference (will be set during initialization if needed)
		this.renderer = options.renderer || null;

		// Pass properties
		this.renderToScreen = false; // Will be set by EffectComposer
		this.clear = false; // Don't clear buffer - we're compositing

	}

	/**
	 * Setup event listeners for pipeline events
	 */
	setupEventListeners() {

		// Listen for tile changes
		this.on( 'tile:changed', ( data ) => {

			if ( data && data.tileBounds ) {

				this.setCurrentTileBounds( data.tileBounds );
				this.uniforms.tileIndex.value = data.tileIndex !== undefined ? data.tileIndex : - 1;
				this.uniforms.renderMode.value = data.renderMode !== undefined ? data.renderMode : 0;

			}

		} );

		// Listen for render mode changes
		this.on( 'renderMode:changed', ( data ) => {

			if ( data && data.mode !== undefined ) {

				this.uniforms.renderMode.value = data.mode;

			}

		} );

	}

	/**
	 * Update the current tile bounds for highlighting
	 * @param {Object} bounds - Tile bounds {x, y, width, height} in top-left coordinate system
	 */
	setCurrentTileBounds( bounds ) {

		this.uniforms.currentTileBounds.value.set(
			bounds.x,
			bounds.y,
			bounds.width,
			bounds.height
		);

	}

	/**
	 * Main render method - called by pipeline each frame
	 * @param {PipelineContext} context - Pipeline context
	 * @param {THREE.WebGLRenderTarget} writeBuffer - Output buffer
	 */
	render( context, writeBuffer ) {

		if ( ! this.enabled ) return;

		// Get renderer from context or use stored reference
		const renderer = this.renderer || context.renderer;

		if ( ! renderer ) {

			this.warn( 'No renderer available' );
			return;

		}

		// Read input texture from context
		// TileHighlightStage should render AFTER all other passes
		// So it reads from the last enabled filter stage
		// Priority: EdgeFiltering > ASVGF > PathTracer
		let inputTexture = context.getTexture( 'edgeFiltering:output' );
		if ( ! inputTexture ) {

			inputTexture = context.getTexture( 'asvgf:output' );

		}

		if ( ! inputTexture ) {

			inputTexture = context.getTexture( 'pathtracer:color' );

		}

		if ( ! inputTexture ) {

			this.warn( 'No input texture available in context' );
			return;

		}

		this.uniforms.tDiffuse.value = inputTexture;

		// Update state from context
		const renderMode = context.getState( 'renderMode' );
		if ( renderMode !== undefined ) {

			this.uniforms.renderMode.value = renderMode;

		}

		const tiles = context.getState( 'tiles' );
		if ( tiles !== undefined ) {

			this.uniforms.tiles.value = tiles;

		}

		// Render to writeBuffer or screen
		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		} else if ( writeBuffer ) {

			renderer.setRenderTarget( writeBuffer );
			if ( this.clear ) renderer.clear();
			this.fsQuad.render( renderer );

		}

	}

	/**
	 * Resize handler
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setSize( width, height ) {

		this.uniforms.resolution.value.set( width, height );

	}

	/**
	 * Dispose resources
	 */
	dispose() {

		if ( this.material ) {

			this.material.dispose();

		}

		if ( this.fsQuad ) {

			this.fsQuad.dispose();

		}

	}

	// ===== PUBLIC API (for compatibility with existing code) =====

	/**
	 * Set highlight color
	 * @param {THREE.Vector3|Array} color - RGB color
	 */
	setHighlightColor( color ) {

		if ( Array.isArray( color ) ) {

			this.uniforms.highlightColor.value.set( color[ 0 ], color[ 1 ], color[ 2 ] );

		} else {

			this.uniforms.highlightColor.value.copy( color );

		}

	}

	/**
	 * Set border width in pixels
	 * @param {number} width - Border width
	 */
	setBorderWidth( width ) {

		this.uniforms.borderWidthPixels.value = width;

	}

	/**
	 * Set number of tiles
	 * @param {number} tiles - Tiles per side
	 */
	setTiles( tiles ) {

		this.uniforms.tiles.value = tiles;

	}

}
