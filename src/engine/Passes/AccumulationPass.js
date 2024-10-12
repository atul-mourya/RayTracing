import {
	UniformsUtils,
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

export class AccumulationPass extends Pass {

	constructor( scene, width, height ) {

		super();

		this.name = 'AccumulationPass';
		const blendMat = new ShaderMaterial( {
			uniforms: {

				'tDiffuse1': { value: null },
				'tDiffuse2': { value: null },
				'iteration': { value: 0.0 }

			},

			vertexShader: /* glsl */`
        
                varying vec2 vUv;
        
                void main() {
        
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        
                }`,

			fragmentShader: /* glsl */`

                uniform float iteration;
        
                uniform sampler2D tDiffuse1;
                uniform sampler2D tDiffuse2;
        
                varying vec2 vUv;
        
                void main() {
        
                    vec4 texel1 = texture2D( tDiffuse1, vUv );
                    vec4 texel2 = texture2D( tDiffuse2, vUv );

                    float weight = 1.0 / iteration;
                    gl_FragColor = texel1 * ( 1.0 - weight ) + texel2 * weight;
        
                }`
		} );

		this.blendQuad = new FullScreenQuad( blendMat );

		const copyShader = CopyShader;
		const copyUniforms = UniformsUtils.clone( copyShader.uniforms );
		const copyMat = new ShaderMaterial( {
			uniforms: copyUniforms,
			vertexShader: copyShader.vertexShader,
			fragmentShader: copyShader.fragmentShader
		} );

		this.resultQuad = new FullScreenQuad( copyMat );

		this.iteration = 0;
		this.timeElapsed = 0;
		this.lastResetTime = performance.now();

		const params = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			stencilBuffer: false,
			depthBuffer: false,
			generateMipmaps: false,
			type: FloatType,
			antialias: false
		};
		this.prevFrameBuffer = new WebGLRenderTarget( width, height, params );
		this.blendedFrameBuffer = new WebGLRenderTarget( width, height, params );

		this.scene = scene;

	}

	reset( renderer ) {

		this.iteration = 0;
		this.timeElapsed = 0; // Reset timeElapsed
		this.lastResetTime = performance.now(); // Update lastResetTime
		renderer.setRenderTarget( this.prevFrameBuffer );
		renderer.clear();
		renderer.setRenderTarget( this.prevFrameBuffer );
		renderer.clear();

	}

	setSize( width, height ) {

		this.prevFrameBuffer.setSize( width, height );
		this.blendedFrameBuffer.setSize( width, height );

	}

	render( renderer, writeBuffer, readBuffer ) {

		if ( ! this.enabled ) {

			this.resultQuad.material.uniforms[ 'tDiffuse' ].value = readBuffer.texture;

			renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
			this.resultQuad.render( renderer );

			return;

		}

		this.iteration ++;
		const currentTime = performance.now();
		this.timeElapsed = ( currentTime - this.lastResetTime ) / 1000;

		this.blendQuad.material.uniforms[ 'tDiffuse1' ].value = this.prevFrameBuffer.texture; // prev render cycle result
		this.blendQuad.material.uniforms[ 'tDiffuse2' ].value = readBuffer.texture; // current render cycle result
		this.blendQuad.material.uniforms[ 'iteration' ].value = this.iteration;
		renderer.setRenderTarget( this.blendedFrameBuffer );
		this.blendQuad.render( renderer );

		this.resultQuad.material.uniforms[ 'tDiffuse' ].value = this.blendedFrameBuffer.texture; // copy the blended frame to the resultQuad
		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
		this.resultQuad.render( renderer );

		[ this.prevFrameBuffer, this.blendedFrameBuffer ] = [ this.blendedFrameBuffer, this.prevFrameBuffer ];

	}

}

