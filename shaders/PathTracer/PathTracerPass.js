import { ShaderMaterial, Vector2, Vector3, Matrix4, RGBAFormat, WebGLRenderTarget,
	FloatType,
	NearestFilter,
	TextureLoader,
	RepeatWrapping,
	LinearFilter,
	Clock
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/Addons.js';
import FragmentShader from '../PathTracer/pathtracer.fs';
import VertexShader from '../PathTracer/pathtracer.vs';
import TriangleSDF from '../../src/TriangleSDF';
import spatioTemporalBlueNoiseImage from '../../public/noise/blue_noise_sequence/64x64_l32_s16.png'; // where file name is width, height, frame cycle, color precision in bits. spatio temporal blue noise image sequence https://tellusim.com/improved-blue-noise/
import blueNoiseImage from '../../public/noise/simple_bluenoise.png'; //simple blue noise image

class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;

		this.name = 'PathTracerPass';

		// Create two render targets for ping-pong rendering
		this.renderTargetA = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter
		} );
		this.renderTargetB = this.renderTargetA.clone();

		// Start with A as current and B as previous
		this.currentRenderTarget = this.renderTargetA;
		this.previousRenderTarget = this.renderTargetB;

		this.name = 'PathTracerPass';
		this.material = new ShaderMaterial( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: 0,
				MAX_DIRECTIONAL_LIGHTS: 0
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				enableEnvironmentLight: { value: true },
				environment: { value: scene.environment },
				useBackground: { value: false },
				environmentIntensity: { value: renderer.environmentIntensity },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focalDistance: { value: 1 },
				aperture: { value: 0.0 },

				directionalLightDirection: { value: scene.getObjectByName( 'directionLight' )?.position.clone().normalize().negate() ?? new Vector3() },
				directionalLightColor: { value: scene.getObjectByName( 'directionLight' )?.color ?? new Vector3() },
				directionalLightIntensity: { value: scene.getObjectByName( 'directionLight' )?.intensity ?? 0 },

				frame: { value: 0 },
				maxFrames: { value: 30 },
				maxBounceCount: { value: 4 },
				numRaysPerPixel: { value: 1 },

				samplingTechnique: { value: 1 }, // 0: PCG, 1: Halton, 2: Sobol, 3: Spatio Temporal Blue Noise, 4: Stratified, 5: Simple Blue Noise
				useAdaptiveSampling: { value: false },
				minSamples: { value: 1 },
				maxSamples: { value: 4 },
				varianceThreshold: { value: 0.001 },

				renderMode: { value: 0 },
				tiles: { value: 4 },
				checkeredFrameInterval: { value: 2 },
				previousFrameTexture: { value: null },

				spatioTemporalBlueNoiseTexture: { value: null },
				spatioTemporalBlueNoiseReolution: { value: new Vector3( 64, 64, 32 ) },

				blueNoiseTexture: { value: null },
				blueNoiseTextureResolution: { value: new Vector2() },

				visMode: { value: 0 },
				debugVisScale: { value: 100 },

				spheres: { value: [] },

				albedoMaps: { value: null },
				albedoMapsTexSize: { value: new Vector2() },

				emissiveMaps: { value: null },
				emissiveMapsTexSize: { value: new Vector2() },

				normalMaps: { value: null },
				normalMapsTexSize: { value: new Vector2() },

				bumpMaps: { value: null },
				bumpMapsTexSize: { value: new Vector2() },

				roughnessMaps: { value: null },
				roughnessMapsTexSize: { value: new Vector2() },

				metalnessMaps: { value: null },
				metalnessMapsTexSize: { value: new Vector2() },

				triangleTexture: { value: null },
				triangleTexSize: { value: new Vector2() },

				bvhTexture: { value: null },
				bvhTexSize: { value: new Vector2() },

				materialTexture: { value: null },
				materialTexSize: { value: new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

		this.fsQuad = new FullScreenQuad( this.material );

		// Create CopyShader material
		this.copyMaterial = new ShaderMaterial( CopyShader );
		this.copyQuad = new FullScreenQuad( this.copyMaterial );

		const loader = new TextureLoader();
		loader.load( spatioTemporalBlueNoiseImage, ( texture ) => {

			texture.minFilter = NearestFilter;
			texture.magFilter = NearestFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.generateMipmaps = false;

			this.material.uniforms.spatioTemporalBlueNoiseTexture = texture;

		} );

		loader.load( blueNoiseImage, ( texture ) => {

			texture.minFilter = NearestFilter;
			texture.magFilter = NearestFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.generateMipmaps = false;

			this.material.uniforms.blueNoiseTexture = texture;
			this.material.uniforms.blueNoiseTextureResolution.value.set( texture.image.width, texture.image.height );

		} );

		this.useDownSampledInteractions = false;
		this.downsampleFactor = 4;
		this.isInteracting = false;
		this.interactionTimeout = null;
		this.interactionDelay = 0.5; // seconds, increased for better debouncing
		this.accumulationPass = null; // Reference to AccumulationPass, to be set later
		this.transitionDuration = 0.01; // Duration of transition in seconds
		this.transitionClock = new Clock( false );
		this.isTransitioning = false;

		this.isComplete = false;

		this.downsampledRenderTarget = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: LinearFilter,
			magFilter: LinearFilter
		} );

		// blend material for smooth transition
		this.blendMaterial = new ShaderMaterial( {
			uniforms: {
				tLowRes: { value: null },
				tHighRes: { value: null },
				blend: { value: 0.0 }
			},
			vertexShader: `
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: `
				uniform sampler2D tLowRes;
				uniform sampler2D tHighRes;
				uniform float blend;
				varying vec2 vUv;
				void main() {
					vec4 lowRes = texture2D(tLowRes, vUv);
					vec4 highRes = texture2D(tHighRes, vUv);
					gl_FragColor = mix(lowRes, highRes, blend);
				}
			`
		} );
		this.blendQuad = new FullScreenQuad( this.blendMaterial );

	}

	build( scene ) {

		this.dispose();

		const sdfs = new TriangleSDF( scene );

		this.material.defines = {
			MAX_SPHERE_COUNT: sdfs.spheres.length,
			MAX_DIRECTIONAL_LIGHTS: sdfs.directionalLights.length
		};
		this.material.uniforms.spheres.value = sdfs.spheres;

		this.material.uniforms.albedoMaps.value = sdfs.albedoTextures;
		this.material.uniforms.albedoMapsTexSize.value = sdfs.albedoTextures ? new Vector2( sdfs.albedoTextures.image.width, sdfs.albedoTextures.image.height ) : new Vector2();
		this.material.uniforms.emissiveMaps.value = sdfs.emissiveTextures;
		this.material.uniforms.emissiveMapsTexSize.value = sdfs.emissiveTextures ? new Vector2( sdfs.emissiveTextures.image.width, sdfs.emissiveTextures.image.height ) : new Vector2();
		this.material.uniforms.normalMaps.value = sdfs.normalTextures;
		this.material.uniforms.normalMapsTexSize.value = sdfs.normalTextures ? new Vector2( sdfs.normalTextures.image.width, sdfs.normalTextures.image.height ) : new Vector2();
		this.material.uniforms.bumpMaps.value = sdfs.bumpTextures;
		this.material.uniforms.bumpMapsTexSize.value = sdfs.bumpTextures ? new Vector2( sdfs.bumpTextures.image.width, sdfs.bumpTextures.image.height ) : new Vector2();
		this.material.uniforms.roughnessMaps.value = sdfs.roughnessTextures;
		this.material.uniforms.roughnessMapsTexSize.value = sdfs.roughnessTextures ? new Vector2( sdfs.roughnessTextures.image.width, sdfs.roughnessTextures.image.height ) : new Vector2();
		this.material.uniforms.metalnessMaps.value = sdfs.metalnessTextures;
		this.material.uniforms.metalnessMapsTexSize.value = sdfs.metalnessTextures ? new Vector2( sdfs.metalnessTextures.image.width, sdfs.metalnessTextures.image.height ) : new Vector2();

		this.material.uniforms.triangleTexture.value = sdfs.triangleTexture;
		this.material.uniforms.triangleTexSize.value = sdfs.triangleTexture ? new Vector2( sdfs.triangleTexture.image.width, sdfs.triangleTexture.image.height ) : new Vector2();
		this.material.uniforms.bvhTexture.value = sdfs.bvhTexture;
		this.material.uniforms.bvhTexSize.value = sdfs.bvhTexture ? new Vector2( sdfs.bvhTexture.image.width, sdfs.bvhTexture.image.height ) : new Vector2();
		this.material.uniforms.materialTexture.value = sdfs.materialTexture;
		this.material.uniforms.materialTexSize.value = sdfs.materialTexture ? new Vector2( sdfs.materialTexture.image.width, sdfs.materialTexture.image.height ) : new Vector2();

	}

	updateLight( dirLight ) {

		this.material.uniforms.directionalLightIntensity.value = dirLight.intensity;
		this.material.uniforms.directionalLightColor.value.copy( dirLight.color );
		this.material.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();

	}

	reset() {

		// Reset accumulated samples
		this.material.uniforms.frame.value = 0;

		if ( this.useDownSampledInteractions ) {

			// Start or restart the debounce timer
			this.startDebounceTimer();

			// Ensure we're in interaction mode
			this.isInteracting = true;
			this.isTransitioning = false;
			this.transitionClock.stop();

		}

		if ( this.accumulationPass ) {

			this.accumulationPass.reset( this.renderer );

		}

		this.isComplete = false;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.material.uniforms.resolution.value.set( width, height );
		this.renderTargetA.setSize( width, height );
		this.renderTargetB.setSize( width, height );
		this.downsampledRenderTarget.setSize( width / this.downsampleFactor, height / this.downsampleFactor );

	}

	startDebounceTimer() {

		if ( ! this.useDownSampledInteractions ) return;

		// Clear any existing timeout
		if ( this.interactionTimeout ) {

			clearTimeout( this.interactionTimeout );

		}

		// Set a new timeout
		this.interactionTimeout = setTimeout( () => {

			this.isInteracting = false;
			this.startTransition();

		}, this.interactionDelay * 1000 );

	}

	startTransition() {

		if ( ! this.useDownSampledInteractions ) return;

		this.isTransitioning = true;
		this.transitionClock.start();
		console.log( 'startTransition' );


	}

	setAccumulationPass( accPass ) {

		this.accumulationPass = accPass;

	}

	dispose() {

		this.material.uniforms.albedoMaps.value?.dispose();
		this.material.uniforms.emissiveMaps.value?.dispose();
		this.material.uniforms.normalMaps.value?.dispose();
		this.material.uniforms.bumpMaps.value?.dispose();
		this.material.uniforms.roughnessMaps.value?.dispose();
		this.material.uniforms.metalnessMaps.value?.dispose();
		this.material.uniforms.triangleTexture.value?.dispose();
		this.material.uniforms.bvhTexture.value?.dispose();
		this.material.uniforms.materialTexture.value?.dispose();
		this.material.dispose();
		this.fsQuad.dispose();
		this.renderTargetA.dispose();
		this.renderTargetB.dispose();
		this.copyMaterial.dispose();
		this.copyQuad.dispose();

	}

	render( renderer, writeBuffer, /*readBuffer*/ ) {

		if ( ! this.enabled || this.isComplete ) return;

		// Update uniforms
		this.material.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.material.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );
		this.material.uniforms.frame.value ++;

		if ( this.material.uniforms.frame.value >= this.material.uniforms.maxFrames.value ) {

			this.isComplete = true;

		}

		// Set the previous frame texture
		this.material.uniforms.previousFrameTexture.value = this.previousRenderTarget.texture;

		if ( this.useDownSampledInteractions ) {

			// Always render both low-res and high-res
			renderer.setRenderTarget( this.downsampledRenderTarget );
			this.material.uniforms.resolution.value.set( this.width / this.downsampleFactor, this.height / this.downsampleFactor );
			this.fsQuad.render( renderer );

			renderer.setRenderTarget( this.currentRenderTarget );
			this.material.uniforms.resolution.value.set( this.width, this.height );
			this.fsQuad.render( renderer );

			if ( this.isTransitioning ) {

				// Blend between low-res and high-res
				const t = Math.min( this.transitionClock.getElapsedTime() / this.transitionDuration, 1 );
				this.blendMaterial.uniforms.tLowRes.value = this.downsampledRenderTarget.texture;
				this.blendMaterial.uniforms.tHighRes.value = this.currentRenderTarget.texture;
				this.blendMaterial.uniforms.blend.value = t;

				renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
				this.blendQuad.render( renderer );

				if ( t === 1 ) {

					this.isTransitioning = false;
					this.isInteracting = false;
					this.transitionClock.stop();

				}

			} else if ( this.isInteracting ) {

				// Use low-res version during interaction and delay
				this.copyMaterial.uniforms.tDiffuse.value = this.downsampledRenderTarget.texture;
				renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
				this.copyQuad.render( renderer );

			} else {

				// Use high-res version when not interacting
				this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;
				renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
				this.copyQuad.render( renderer );

			}

		} else {

			// Original behavior: always render at full resolution
			renderer.setRenderTarget( this.currentRenderTarget );
			this.material.uniforms.resolution.value.set( this.width, this.height );
			this.fsQuad.render( renderer );

			this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;
			renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
			this.copyQuad.render( renderer );

		}

		// Swap render targets for next frame
		[ this.currentRenderTarget, this.previousRenderTarget ] = [ this.previousRenderTarget, this.currentRenderTarget ];

	}

}

export default PathTracerPass;
