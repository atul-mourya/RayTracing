import { ShaderMaterial, UniformsUtils, Vector2, Vector3, Vector4 } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class TileHighlightPass extends Pass {

	constructor( resolution ) {

		super();

		this.uniforms = UniformsUtils.clone( {
			tDiffuse: { value: null },
			resolution: { value: new Vector2( resolution.x, resolution.y ) },
			tileIndex: { value: - 1 },
			tiles: { value: 4 },
			renderMode: { value: 0 },
			highlightColor: { value: new Vector3( 1, 0, 0 ) }, // Red by default
			borderWidthPixels: { value: 2.0 }, // Border width in pixels
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

	render( renderer, writeBuffer, readBuffer ) {

		if ( this.enabled === false ) return;

		this.uniforms.tDiffuse.value = readBuffer.texture;
		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		} else {

			renderer.setRenderTarget( writeBuffer );
			if ( this.clear ) renderer.clear();
			this.fsQuad.render( renderer );

		}

	}

	setSize( width, height ) {

		this.uniforms.resolution.value.set( width, height );

	}

}
