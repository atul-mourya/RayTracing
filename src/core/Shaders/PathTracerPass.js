import {
	ShaderMaterial, Vector2, Vector3, Matrix4, RGBAFormat, WebGLRenderTarget,
	FloatType,
	NearestFilter,
	TextureLoader,
	RepeatWrapping,
	LinearFilter,
	Clock,
	RawShaderMaterial,
	GLSL3,
	LinearSRGBColorSpace
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LightDataTransfer } from '../Processor/LightDataTransfer';
import { CopyShader } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';
import TriangleSDF from '../Processor/TriangleSDF';
import spatioTemporalBlueNoiseImage from '../../../public/noise/blue_noise_sequence/64x64_l32_s16.png'; // where file name is width, height, frame cycle, color precision in bits. spatio temporal blue noise image sequence https://tellusim.com/improved-blue-noise/
import blueNoiseImage from '../../../public/noise/simple_bluenoise.png'; //simple blue noise image
import { DEFAULT_STATE } from '../Processor/Constants';

export class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;
		this.tiles = DEFAULT_STATE.tiles;
		this.cameras = [];
		this.sdfs = null;
		this.sdfs = new TriangleSDF();
		this.lightDataTransfer = new LightDataTransfer();

		this.name = 'PathTracerPass';

		// Create two render targets for ping-pong rendering
		this.renderTargetA = new WebGLRenderTarget( width, height, {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			type: FloatType,
			colorSpace: LinearSRGBColorSpace,
			depthBuffer: false,
		} );
		this.renderTargetB = this.renderTargetA.clone();

		// Start with A as current and B as previous
		this.currentRenderTarget = this.renderTargetA;
		this.previousRenderTarget = this.renderTargetB;

		this.name = 'PathTracerPass';
		this.material = new RawShaderMaterial( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: 0,
				MAX_DIRECTIONAL_LIGHTS: 0,
				MAX_AREA_LIGHTS: 0
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				exposure: { value: DEFAULT_STATE.exposure },
				enableEnvironmentLight: { value: DEFAULT_STATE.enableEnvironment },
				environment: { value: scene.environment },
				backgroundIntensity: { value: DEFAULT_STATE.backgroundIntensity }, // Add backgroundIntensity uniform
				showBackground: { value: DEFAULT_STATE.showBackground },
				environmentIntensity: { value: DEFAULT_STATE.environmentIntensity },
				globalIlluminationIntensity: { value: DEFAULT_STATE.globalIlluminationIntensity * Math.PI }, // Convert from lux to lumens

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focusDistance: { value: DEFAULT_STATE.focusDistance }, // Subject 3 meters away
				focalLength: { value: DEFAULT_STATE.focalLength }, // 2mm lens
				aperture: { value: DEFAULT_STATE.aperture }, // f/2.8 aperture
				apertureScale: { value: 1.0 },

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
				adaptiveSamplingTexture: { value: null },
				fireflyThreshold: { value: DEFAULT_STATE.fireflyThreshold },

				renderMode: { value: DEFAULT_STATE.renderMode },
				tiles: { value: this.tiles },
				previousFrameTexture: { value: null },
				accumulatedFrameTexture: { value: null },

				spatioTemporalBlueNoiseTexture: { value: null },
				spatioTemporalBlueNoiseResolution: { value: new Vector3( 64, 64, 32 ) },

				blueNoiseTexture: { value: null },
				blueNoiseTextureSize: { value: new Vector2() },

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
				bvhTexture: { value: null },
				materialTexture: { value: null },

				triangleTexSize: { value: new Vector2() },
				bvhTexSize: { value: new Vector2() },
				materialTexSize: { value: new Vector2() }

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader,
			glslVersion: GLSL3,

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

			this.material.uniforms.spatioTemporalBlueNoiseTexture.value = texture;
			this.material.needsUpdate = true;

		} );

		loader.load( blueNoiseImage, ( texture ) => {

			texture.minFilter = LinearFilter;
			texture.magFilter = LinearFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.type = FloatType;
			texture.generateMipmaps = false;

			this.material.uniforms.blueNoiseTexture.value = texture;
			this.material.uniforms.blueNoiseTextureSize.value = new Vector2( texture.image.width, texture.image.height );
			this.material.needsUpdate = true;

		} );

		this.useDownSampledInteractions = DEFAULT_STATE.downSampledMovement;
		this.downsampleFactor = 4;
		this.isInteracting = false;
		this.interactionTimeout = null;
		this.interactionDelay = 0.01; // seconds, increased for better debouncing
		this.accumulationPass = null; // Reference to AccumulationPass, to be set later
		this.adaptiveSamplingPass = null; // Reference to AdaptiveSamplingPass, to be set later
		this.transitionDuration = 0.00; // Duration of transition in seconds
		this.transitionClock = new Clock( false );
		this.isTransitioning = false;

		this.isComplete = false;

		this.downsampledRenderTarget = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
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

	async build( scene ) {

		this.dispose();

		await this.sdfs.buildBVH( scene );
		this.cameras = this.sdfs.cameras;

		this.material.defines.MAX_SPHERE_COUNT = this.sdfs.spheres.length;

		// Update sphere uniforms
		this.material.uniforms.spheres.value = this.sdfs.spheres;

		// Update texture uniforms
		this.material.uniforms.albedoMaps.value = this.sdfs.albedoTextures;
		this.material.uniforms.emissiveMaps.value = this.sdfs.emissiveTextures;
		this.material.uniforms.normalMaps.value = this.sdfs.normalTextures;
		this.material.uniforms.bumpMaps.value = this.sdfs.bumpTextures;
		this.material.uniforms.roughnessMaps.value = this.sdfs.roughnessTextures;
		this.material.uniforms.metalnessMaps.value = this.sdfs.metalnessTextures;

		// Update geometry uniforms
		this.material.uniforms.triangleTexture.value = this.sdfs.triangleTexture;
		this.material.uniforms.bvhTexture.value = this.sdfs.bvhTexture;
		this.material.uniforms.materialTexture.value = this.sdfs.materialTexture;

		// Update texture sizes
		this.material.uniforms.triangleTexSize.value.set( this.sdfs.triangleTexture.image.width, this.sdfs.triangleTexture.image.height );
		this.material.uniforms.bvhTexSize.value.set( this.sdfs.bvhTexture.image.width, this.sdfs.bvhTexture.image.height );
		this.material.uniforms.materialTexSize.value.set( this.sdfs.materialTexture.image.width, this.sdfs.materialTexture.image.height );

		// Update light uniforms
		this.updateLights();

	}

	updateLights() {

		this.lightDataTransfer.processSceneLights( this.scene, this.material );

	}

	updateMaterialDataTexture( materialIndex, property, value ) {

		const data = this.material.uniforms.materialTexture.value.image.data;
		const stride = materialIndex * 96; // 24 pixels * 4 components per pixel

		switch ( property ) {

			case 'color': 				data.set( [ value.r, value.g, value.b ], stride + 0 ); break;
			case 'metalness': 			data[ stride + 3 ] = value; break;
			case 'emissive': 			data.set( [ value.r, value.g, value.b ], stride + 4 ); break;
			case 'roughness': 			data[ stride + 7 ] = value; break;
			case 'ior': 				data[ stride + 8 ] = value; break;
			case 'transmission': 		data[ stride + 9 ] = value; break;
			case 'thickness': 			data[ stride + 10 ] = value; break;
			case 'emissiveIntensity': 	data[ stride + 11 ] = value; break;
			case 'attenuationColor': 	data.set( [ value.r, value.g, value.b ], stride + 12 ); break;
			case 'attenuationDistance': data[ stride + 15 ] = value; break;
			case 'dispersion': 			data[ stride + 16 ] = value; break;
			case 'visible': 			data[ stride + 17 ] = value; break;
			case 'sheen': 				data[ stride + 18 ] = value; break;
			case 'sheenRoughness': 		data[ stride + 19 ] = value; break;
			case 'sheenColor': 			data.set( [ value.r, value.g, value.b ], stride + 20 ); break;
			case 'specularIntensity': 	data[ stride + 24 ] = value; break;
			case 'specularColor': 		data.set( [ value.r, value.g, value.b ], stride + 25 ); break;
			case 'iridescence': 		data[ stride + 28 ] = value; break;
			case 'iridescenceIOR': 		data[ stride + 29 ] = value; break;
			case 'iridescenceThicknessRange':
				data[ stride + 30 ] = value[ 0 ];
				data[ stride + 31 ] = value[ 1 ];
				break;
			case 'clearcoat': 			data[ stride + 38 ] = value; break;
			case 'clearcoatRoughness': 	data[ stride + 39 ] = value; break;
			case 'opacity': 			data[ stride + 40 ] = value; break;
			case 'side': 				data[ stride + 41 ] = value; break;
			case 'transparent': 		data[ stride + 42 ] = value; break;
			case 'alphaTest': 			data[ stride + 43 ] = value; break;

		}

		this.material.uniforms.materialTexture.value.needsUpdate = true;
		this.reset();

	}

	rebuildMaterialDataTexture( materialIndex, material ) {

		let materialData = this.sdfs.geometryExtractor.createMaterialObject( material );

		// itarate over materialData and update the materialTexture
		for ( const property in materialData ) {

			this.updateMaterialDataTexture( materialIndex, property, materialData[ property ] );

		}

	}


	reset() {

		// Reset accumulated samples
		this.material.uniforms.frame.value = 0;
		this.renderer.setRenderTarget( this.previousRenderTarget );
		this.renderer.clear();

		if ( this.material.uniforms.frame.value === 0 && this.material.uniforms.renderMode.value === 1 ) {

			this.material.uniforms.tiles.value = 1;

		}

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

	setAdaptiveSamplingPass( asPass ) {

		this.adaptiveSamplingPass = asPass;

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

	render( renderer, writeBuffer ) {

		if ( ! this.enabled || this.isComplete ) return;

		// 1. Early completion check and frame update
		this.material.uniforms.frame.value ++;
		const frameValue = this.material.uniforms.frame.value;
		const renderMode = this.material.uniforms.renderMode.value;

		if ( ( renderMode === 1 && frameValue >= Math.pow( this.tiles, 2 ) * this.material.uniforms.maxFrames.value ) ||
			( renderMode !== 1 && frameValue >= this.material.uniforms.maxFrames.value ) ) {

			this.isComplete = true;
			return;

		}

		// 2. Update essential uniforms once
		const uniforms = this.material.uniforms;
		uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );
		uniforms.previousFrameTexture.value = this.previousRenderTarget.texture;
		uniforms.accumulatedFrameTexture.value = this.accumulationPass?.blendedFrameBuffer.texture || null;
		uniforms.adaptiveSamplingTexture.value = this.adaptiveSamplingPass?.renderTarget.texture || null;

		// 3. Update adaptive sampling if enabled
		if ( this.adaptiveSamplingPass?.enabled ) {

			this.adaptiveSamplingPass.setTextures(
				uniforms.previousFrameTexture.value,
				uniforms.accumulatedFrameTexture.value
			);

		}

		// 4. Handle rendering based on interaction mode
		if ( this.useDownSampledInteractions ) {

			this._handleInteractiveRendering( renderer, writeBuffer );

		} else {

			this._handleStandardRendering( renderer, writeBuffer );

		}

		// 5. Final updates
		uniforms.tiles.value = this.tiles;
		[ this.currentRenderTarget, this.previousRenderTarget ] = [ this.previousRenderTarget, this.currentRenderTarget ];

	}

	// Private method to handle interactive rendering
	_handleInteractiveRendering( renderer, writeBuffer ) {

		const finalTarget = this.renderToScreen ? null : writeBuffer;

		if ( this.isTransitioning ) {

			this._renderTransition( renderer, finalTarget );

		} else if ( this.isInteracting ) {

			this._renderLowRes( renderer, finalTarget );

		} else {

			this._renderHighRes( renderer, finalTarget );

		}

	}

	// Private method to handle standard rendering
	_handleStandardRendering( renderer, writeBuffer ) {

		const uniforms = this.material.uniforms;

		// Render at full resolution
		renderer.setRenderTarget( this.currentRenderTarget );
		uniforms.resolution.value.set( this.width, this.height );
		this.fsQuad.render( renderer );

		// Copy to output
		this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;
		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
		this.copyQuad.render( renderer );

	}

	// Private method to handle transition rendering
	_renderTransition( renderer, finalTarget ) {

		// Render low-res
		renderer.setRenderTarget( this.downsampledRenderTarget );
		this.material.uniforms.resolution.value.set(
			this.width / this.downsampleFactor,
			this.height / this.downsampleFactor
		);
		this.fsQuad.render( renderer );

		// Render high-res
		renderer.setRenderTarget( this.currentRenderTarget );
		this.material.uniforms.resolution.value.set( this.width, this.height );
		this.fsQuad.render( renderer );

		// Blend between resolutions
		const t = Math.min( this.transitionClock.getElapsedTime() / this.transitionDuration, 1 );
		const blendUniforms = this.blendMaterial.uniforms;
		blendUniforms.tLowRes.value = this.downsampledRenderTarget.texture;
		blendUniforms.tHighRes.value = this.currentRenderTarget.texture;
		blendUniforms.blend.value = t;

		renderer.setRenderTarget( finalTarget );
		this.blendQuad.render( renderer );

		if ( t === 1 ) {

			this.isTransitioning = false;
			this.isInteracting = false;
			this.transitionClock.stop();

		}

	}

	// Private method to handle low-res rendering
	_renderLowRes( renderer, finalTarget ) {

		renderer.setRenderTarget( this.downsampledRenderTarget );
		this.material.uniforms.resolution.value.set(
			this.width / this.downsampleFactor,
			this.height / this.downsampleFactor
		);
		this.fsQuad.render( renderer );

		this.copyMaterial.uniforms.tDiffuse.value = this.downsampledRenderTarget.texture;
		renderer.setRenderTarget( finalTarget );
		this.copyQuad.render( renderer );

	}

	// Private method to handle high-res rendering
	_renderHighRes( renderer, finalTarget ) {

		renderer.setRenderTarget( this.currentRenderTarget );
		this.material.uniforms.resolution.value.set( this.width, this.height );
		this.fsQuad.render( renderer );

		this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;
		renderer.setRenderTarget( finalTarget );
		this.copyQuad.render( renderer );

	}

}

