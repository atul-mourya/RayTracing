import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

class LygiaSmartDenoiserPass extends Pass {

	constructor( width, height, sigma = 1.0, kSigma = 1.0, threshold = 0.1 ) {

		super();

		this.name = 'LygiaSmartDenoiserPass';
		const denoiseMat = new ShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null },
				resolution: { value: new Vector2( width, height ) },
				sigma: { value: sigma },
				kSigma: { value: kSigma },
				threshold: { value: threshold }
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
                uniform float sigma;
                uniform float kSigma;
                uniform float threshold;
                varying vec2 vUv;

                #define SMARTDENOISE_TYPE vec4
                #define SMARTDENOISE_SAMPLER_FNC(TEX, UV) texture2D(TEX, UV)
                #define SAMPLER_FNC(TEX, UV) texture2D(TEX, UV)

                const float INV_SQRT_OF_2PI = 0.39894228040143267793994605993439;
                const float INV_PI = 0.31830988618379067153776752674503;

                vec4 smartDeNoise(sampler2D tex, vec2 uv, vec2 pixel, float sigma, float kSigma, float threshold) {
                    float radius = floor(kSigma*sigma + 0.5);
                    float radQ = radius * radius;
                    
                    float invSigmaQx2 = 0.5 / (sigma * sigma);      // 1.0 / (sigma^2 * 2.0)
                    float invSigmaQx2PI = INV_PI * invSigmaQx2;    // 1.0 / (sqrt(PI) * sigma)
                    
                    float invThresholdSqx2 = 0.5 / (threshold * threshold);  // 1.0 / (sigma^2 * 2.0)
                    float invThresholdSqrt2PI = INV_SQRT_OF_2PI / threshold;   // 1.0 / (sqrt(2*PI) * sigma)
                    
                    vec4 centrPx = texture2D(tex, uv);
                    
                    float zBuff = 0.0;
                    vec4 aBuff = vec4(0.0);
                    for(float x=-radius; x <= radius; x++) {
                        float pt = sqrt(radQ-x*x);
                        for(float y=-pt; y <= pt; y++) {
                            vec2 d = vec2(x,y);
                            float blurFactor = exp( -dot(d , d) * invSigmaQx2 ) * invSigmaQx2PI; 
                            vec4 walkPx = texture2D(tex,uv+d*pixel);
                            vec4 dC = walkPx-centrPx;
                            float deltaFactor = exp( -dot(dC, dC) * invThresholdSqx2) * invThresholdSqrt2PI * blurFactor;
                            zBuff += deltaFactor;
                            aBuff += deltaFactor*walkPx;
                        }
                    }
                    return aBuff/zBuff;
                }

                void main() {
                    vec2 pixel = 1.0 / resolution;
                    gl_FragColor = smartDeNoise(tDiffuse, vUv, pixel, sigma, kSigma, threshold);
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

export default LygiaSmartDenoiserPass;
