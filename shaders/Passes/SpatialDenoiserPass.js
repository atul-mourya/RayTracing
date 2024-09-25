import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

class SpatialDenoiserPass extends Pass {

	constructor( width, height, kernelSize = 1 ) {

		super();

		this.name = 'SpatialDenoiserPass';
		const denoiseMat = new ShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				resolution: { value: new Vector2( width, height ) },
				kernelSize: { value: kernelSize }
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
                uniform float kernelSize;
                varying vec2 vUv;

                void main() {
                    vec2 texelSize = 1.0 / resolution;
                    vec3 result = vec3(0.0);
                    float totalWeight = 0.0;

                    for (float x = -kernelSize; x <= kernelSize; x += 1.0) {
                        for (float y = -kernelSize; y <= kernelSize; y += 1.0) {
                            vec2 offset = vec2(x, y) * texelSize;
                            vec3 neighborColor = texture2D(tDiffuse, vUv + offset).rgb;
                            
                            // Simple Gaussian weight
                            float weight = exp(-(x*x + y*y) / (2.0 * kernelSize * kernelSize));
                            
                            result += neighborColor * weight;
                            totalWeight += weight;
                        }
                    }

                    gl_FragColor = vec4(result / totalWeight, 1.0);
                }
            `
		} );

		this.denoiseQuad = new FullScreenQuad( denoiseMat );
		this.renderTarget = new WebGLRenderTarget( width, height, {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			type: FloatType
		} );

	}

	setSize( width, height ) {

		this.renderTarget.setSize( width, height );
		this.denoiseQuad.material.uniforms.resolution.value.set( width, height );

	}

	render( renderer, writeBuffer, readBuffer ) {

		this.denoiseQuad.material.uniforms.tDiffuse.value = readBuffer.texture;

		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.denoiseQuad.render( renderer );

		} else {

			renderer.setRenderTarget( this.renderTarget );
			this.denoiseQuad.render( renderer );
			renderer.setRenderTarget( writeBuffer );
			this.denoiseQuad.material.uniforms.tDiffuse.value = this.renderTarget.texture;
			this.denoiseQuad.render( renderer );

		}

	}

}

export default SpatialDenoiserPass;
