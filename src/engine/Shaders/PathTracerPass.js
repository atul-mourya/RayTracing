import {
	ShaderMaterial, Vector2, Vector3, Matrix4, RGBAFormat, WebGLRenderTarget,
	FloatType,
	NearestFilter,
	TextureLoader,
	RepeatWrapping,
	LinearFilter,
	Clock,
	HalfFloatType,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';
import TriangleSDF from '../Processor/TriangleSDF';
import { EquirectHdrInfoUniform } from '../Processor/EquirectHdrInfoUniform';
import spatioTemporalBlueNoiseImage from '../../../public/noise/blue_noise_sequence/64x64_l32_s16.png'; // where file name is width, height, frame cycle, color precision in bits. spatio temporal blue noise image sequence https://tellusim.com/improved-blue-noise/
import blueNoiseImage from '../../../public/noise/simple_bluenoise3.png'; //simple blue noise image
import { DEFAULT_STATE } from '../Processor/Constants';

export class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;

		this.name = 'PathTracerPass';

		// Create two render targets for ping-pong rendering
		this.renderTargetA = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: HalfFloatType,
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
				MAX_DIRECTIONAL_LIGHTS: 0,
				MAX_POINT_LIGHTS: 0,
				MAX_SPOT_LIGHTS: 0,
				MAX_AREA_LIGHTS: 0
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				enableEnvironmentLight: { value: DEFAULT_STATE.enableEnvironment },
				environment: { value: scene.environment },
				showBackground: { value: DEFAULT_STATE.showBackground },
				environmentIntensity: { value: DEFAULT_STATE.environmentIntensity },
				envMapInfo: { value: new EquirectHdrInfoUniform() },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focusDistance: { value: DEFAULT_STATE.focusDistance }, // Subject 3 meters away
				focalLength: { value: DEFAULT_STATE.focalLength }, // 2mm lens
				aperture: { value: DEFAULT_STATE.aperture }, // f/2.8 aperture

				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null },

				frame: { value: 0 },
				maxFrames: { value: DEFAULT_STATE.maxSamples },
				maxBounceCount: { value: DEFAULT_STATE.bounces },
				numRaysPerPixel: { value: DEFAULT_STATE.samplesPerPixel },

				samplingTechnique: { value: DEFAULT_STATE.samplingTechnique }, // 0: PCG, 1: Halton, 2: Sobol, 3: Spatio Temporal Blue Noise, 4: Stratified, 5: Simple Blue Noise
				useAdaptiveSampling: { value: DEFAULT_STATE.adaptiveSampling },
				adaptiveSamplingMin: { value: DEFAULT_STATE.adaptiveSamplingMin },
				adaptiveSamplingMax: { value: DEFAULT_STATE.adaptiveSamplingMax },
				adaptiveSamplingVarianceThreshold: { value: DEFAULT_STATE.adaptiveSamplingVarianceThreshold },

				renderMode: { value: DEFAULT_STATE.renderMode },
				tiles: { value: DEFAULT_STATE.tiles },
				checkeredFrameInterval: { value: DEFAULT_STATE.checkeredSize },
				previousFrameTexture: { value: null },

				spatioTemporalBlueNoiseTexture: { value: null },
				spatioTemporalBlueNoiseReolution: { value: new Vector3( 64, 64, 32 ) },

				blueNoiseTexture: { value: null },

				visMode: { value: DEFAULT_STATE.debugMode },
				debugVisScale: { value: DEFAULT_STATE.debugVisScale },

				spheres: { value: [] },

				albedoMaps: { value: null },
				emissiveMaps: { value: null },
				normalMaps: { value: null },
				bumpMaps: { value: null },
				roughnessMaps: { value: null },
				metalnessMaps: { value: null },

				triangleTexture: { value: null },
				triangleTexSize: { value: new Vector2() },

				bvhTexture: { value: null },
				bvhTexSize: { value: new Vector2() },

				materialTexture: { value: null },
				materialTexSize: { value: new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader,

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
			MAX_DIRECTIONAL_LIGHTS: 0,
			MAX_POINT_LIGHTS: 0,
			MAX_SPOT_LIGHTS: 0
		  };

		// Update sphere uniforms
		this.material.uniforms.spheres.value = sdfs.spheres;

		// Update environment uniforms
		this.material.uniforms.envMapInfo.value.updateFrom( scene.environment );

		// Update texture uniforms
		this.material.uniforms.albedoMaps.value = sdfs.albedoTextures;
		this.material.uniforms.emissiveMaps.value = sdfs.emissiveTextures;
		this.material.uniforms.normalMaps.value = sdfs.normalTextures;
		this.material.uniforms.bumpMaps.value = sdfs.bumpTextures;
		this.material.uniforms.roughnessMaps.value = sdfs.roughnessTextures;
		this.material.uniforms.metalnessMaps.value = sdfs.metalnessTextures;

		// Update geometry uniforms
		this.material.uniforms.triangleTexture.value = sdfs.triangleTexture;
		this.material.uniforms.triangleTexSize.value = sdfs.triangleTexture
			? new Vector2( sdfs.triangleTexture.image.width, sdfs.triangleTexture.image.height )
			: new Vector2();
		this.material.uniforms.bvhTexture.value = sdfs.bvhTexture;
		this.material.uniforms.bvhTexSize.value = sdfs.bvhTexture
			? new Vector2( sdfs.bvhTexture.image.width, sdfs.bvhTexture.image.height )
			: new Vector2();
		this.material.uniforms.materialTexture.value = sdfs.materialTexture;
		this.material.uniforms.materialTexSize.value = sdfs.materialTexture
			? new Vector2( sdfs.materialTexture.image.width, sdfs.materialTexture.image.height )
			: new Vector2();

		// Update light uniforms
		this.updateLights();

	}

	updateLights() {

		const directionalLights = [];
		const pointLights = [];
		const spotLights = [];
		const areaLights = [];

		this.scene.traverse( ( object ) => {

			if ( object.isDirectionalLight ) {

				const direction = object.position.clone();
				directionalLights.push( direction.x, direction.y, direction.z );
				directionalLights.push( object.color.r, object.color.g, object.color.b );
				directionalLights.push( object.intensity );

			} else if ( object.isPointLight ) {

				pointLights.push( {
					position: object.position.clone(),
					color: object.color.clone(),
					intensity: object.intensity,
					distance: object.distance,
					decay: object.decay
				} );

			} else if ( object.isSpotLight ) {

				spotLights.push( {
					position: object.position.clone(),
					direction: object.target.position.clone().sub( object.position ),
					color: object.color.clone(),
					intensity: object.intensity,
					distance: object.distance,
					decay: object.decay,
					coneCos: Math.cos( object.angle ),
					penumbraCos: Math.cos( object.angle * ( 1 - object.penumbra ) )
				} );

			} else if ( object.isRectAreaLight ) {

				const width = object.width;
				const height = object.height;
				const halfWidth = width / 2;
				const halfHeight = height / 2;

				// Calculate the light's local axes
				const forward = new Vector3(0, 0, -1);
				const up = new Vector3(0, 1, 0);
				const right = new Vector3(1, 0, 0);
	
				forward.applyQuaternion(object.quaternion);
				up.applyQuaternion(object.quaternion);
				right.applyQuaternion(object.quaternion);
	
				const u = right.multiplyScalar(halfWidth);
				const v = up.multiplyScalar(halfHeight);

				areaLights.push( object.position.x, object.position.y, object.position.z );
				areaLights.push( u.x, u.y, u.z );
				areaLights.push( v.x, v.y, v.z );
				areaLights.push( object.color.r, object.color.g, object.color.b );
				areaLights.push( object.intensity );
				
			}

		} );

		this.material.defines.MAX_DIRECTIONAL_LIGHTS = directionalLights.length;
		this.material.defines.MAX_POINT_LIGHTS = pointLights.length;
		this.material.defines.MAX_SPOT_LIGHTS = spotLights.length;   
		this.material.defines.MAX_AREA_LIGHTS = areaLights.length;

		this.material.uniforms.directionalLights.value = directionalLights;
		this.material.uniforms.pointLights.value = pointLights;
		this.material.uniforms.spotLights.value = spotLights;
		this.material.uniforms.areaLights.value = areaLights;

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

