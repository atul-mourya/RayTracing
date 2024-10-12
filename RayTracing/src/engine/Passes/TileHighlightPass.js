import { ShaderMaterial, UniformsUtils, Vector2, Vector3 } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class TileHighlightPass extends Pass {

	constructor( resolution ) {

		super();

		this.uniforms = UniformsUtils.clone( {
			tDiffuse: { value: null },
			resolution: { value: new Vector2( resolution.x, resolution.y ) },
			frame: { value: 0 },
			tiles: { value: 4 },
			renderMode: { value: 0 },
			highlightColor: { value: new Vector3( 1, 0, 0 ) }, // Red by default
			borderWidthPixels: { value: 2.0 } // Border width in pixels
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
                uniform int frame;
                uniform int tiles;
                uniform int renderMode;
                uniform vec3 highlightColor;
                uniform float borderWidthPixels;
                varying vec2 vUv;

                void main() {
                    vec4 texel = texture2D(tDiffuse, vUv);
                    
                    if (renderMode != 2) {
                        gl_FragColor = texel;
                        return;
                    }

                    int totalTiles = tiles * tiles;
                    int currentTile = frame % totalTiles;
                    
                    vec2 tileSize = vec2(1.0 / float(tiles));
                    vec2 currentTileCoord = vec2(
                        float(currentTile % tiles),
                        float(currentTile / tiles)
                    ) * tileSize;
                    
                    vec2 tilePos = (vUv - currentTileCoord) / tileSize;
                    vec2 borderWidth = (borderWidthPixels / resolution) / tileSize;
                    
                    if (all(greaterThanEqual(tilePos, vec2(0.0))) && all(lessThan(tilePos, vec2(1.0)))) {
                        if (any(lessThan(tilePos, borderWidth)) || any(greaterThan(tilePos, vec2(1.0) - borderWidth))) {
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

	render( renderer, writeBuffer, readBuffer ) {

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
