import {
	ShaderMaterial,
	Vector2
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class UpScalerPass extends Pass {

	constructor( width, height, upScaleFactor = 2 ) {

		super();

		this.upScaleFactor = upScaleFactor;

		this.name = 'SpatialDenoiserPass';
		this.upscaleMaterial = new ShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				resolution: { value: new Vector2( width * this.upScaleFactor, height * this.upScaleFactor ) }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
            `,
			fragmentShader: /* glsl */`
				uniform sampler2D tDiffuse;
				uniform vec2 resolution;
				varying vec2 vUv;

				void main() {
					vec2 texelSize = 1.0 / resolution;
					vec2 halfPixelSize = texelSize * 0.5;

					vec2 uv = vUv - halfPixelSize;
					vec4 tl = texture2D(tDiffuse, uv);
					vec4 tr = texture2D(tDiffuse, uv + vec2(texelSize.x, 0.0));
					vec4 bl = texture2D(tDiffuse, uv + vec2(0.0, texelSize.y));
					vec4 br = texture2D(tDiffuse, uv + texelSize);

					vec2 f = fract(uv * resolution);
					vec4 tA = mix(tl, tr, f.x);
					vec4 tB = mix(bl, br, f.x);
					gl_FragColor = mix(tA, tB, f.y);
				}
            `
		} );

		// fragmentShader: `
		// 		uniform sampler2D tDiffuse;
		// 		uniform vec2 resolution;
		// 		uniform vec2 texelSize;
		// 		uniform vec4 scale;
		// 		varying vec2 vUv;

		// 		void main() {
		// 			vec2 uv = vUv * scale.xy + scale.zw;
		// 			vec2 invTexelSize = 1.0 / texelSize;
		// 			vec2 pixelCoord = uv * invTexelSize - 0.5;
		// 			vec2 fracPart = fract(pixelCoord);
		// 			vec2 startTexel = (floor(pixelCoord) + 0.5) * texelSize;

		// 			vec4 tl = texture2D(tDiffuse, startTexel);
		// 			vec4 tr = texture2D(tDiffuse, startTexel + vec2(texelSize.x, 0.0));
		// 			vec4 bl = texture2D(tDiffuse, startTexel + vec2(0.0, texelSize.y));
		// 			vec4 br = texture2D(tDiffuse, startTexel + texelSize);

		// 			vec4 tA = mix(tl, tr, fracPart.x);
		// 			vec4 tB = mix(bl, br, fracPart.x);
		// 			gl_FragColor = mix(tA, tB, fracPart.y);
		// 		}
		// 	`

		this.upscaleQuad = new FullScreenQuad( this.upscaleMaterial );


	}

	setSize( width, height ) {

		this.upscaleMaterial.uniforms.resolution.value.set( width * this.upScaleFactor, height * this.upScaleFactor );

	}

	render( renderer, writeBuffer, readBuffer ) {

		this.upscaleMaterial.uniforms.tDiffuse.value = readBuffer.texture;

		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.upscaleQuad.render( renderer );

		} else {

			renderer.setRenderTarget( writeBuffer );
			this.upscaleQuad.render( renderer );

		}

	}

}
