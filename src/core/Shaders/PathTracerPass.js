import {
	ShaderMaterial, Vector2, Matrix4, WebGLRenderTarget,
	FloatType,
	NearestFilter,
	TextureLoader,
	RepeatWrapping,
	GLSL3,
	LinearSRGBColorSpace,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LightDataTransfer } from '../Processor/LightDataTransfer';
import { CopyShader } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';
import TriangleSDF from '../Processor/TriangleSDF';
import { EnvironmentCDFBuilder } from '../Processor/EnvironmentCDFBuilder';
import blueNoiseImage from '../../../public/noise/simple_bluenoise.png'; //simple blue noise image
import { DEFAULT_STATE } from '../../Constants';

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
		this.environmentCDFBuilder = new EnvironmentCDFBuilder( renderer );

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
		this.material = new ShaderMaterial( {

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
				environmentRotation: { value: DEFAULT_STATE.environmentRotation || 0.0 },
				useEnvMapIS: { value: true },
				envCDF: { value: null },
				envCDFSize: { value: new Vector2() },
				globalIlluminationIntensity: { value: DEFAULT_STATE.globalIlluminationIntensity * Math.PI }, // Convert from lux to lumens

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focusDistance: { value: DEFAULT_STATE.focusDistance }, // Subject 3 meters away
				focalLength: { value: DEFAULT_STATE.focalLength }, // 2mm lens
				aperture: { value: DEFAULT_STATE.aperture }, // f/2.8 aperture
				apertureScale: { value: 2.0 },

				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null },

				frame: { value: 0 },
				maxFrames: { value: DEFAULT_STATE.maxSamples },
				maxBounceCount: { value: DEFAULT_STATE.bounces },
				numRaysPerPixel: { value: DEFAULT_STATE.samplesPerPixel },
				transmissiveBounces: { value: 8 },

				samplingTechnique: { value: DEFAULT_STATE.samplingTechnique }, // 0: PCG, 1: Halton, 2: Sobol, 3: Simple Blue Noise
				useAdaptiveSampling: { value: DEFAULT_STATE.adaptiveSampling },
				adaptiveSamplingTexture: { value: null },
				adaptiveSamplingMax: { value: DEFAULT_STATE.adaptiveSamplingMax },
				fireflyThreshold: { value: DEFAULT_STATE.fireflyThreshold },

				renderMode: { value: DEFAULT_STATE.renderMode },
				tiles: { value: this.tiles },
				previousFrameTexture: { value: null },
				accumulatedFrameTexture: { value: null },

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
				materialTexSize: { value: new Vector2() },

				useEnvMipMap: { value: true }, // Enable quality-based mip level selection
				envSamplingBias: { value: 1.2 }, // Bias toward bright areas (0.5-2.0)
				maxEnvSamplingBounce: { value: 3 }, // Beyond this bounce, use simplified sampling

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
		loader.load( blueNoiseImage, ( texture ) => {

			texture.minFilter = NearestFilter;
			texture.magFilter = NearestFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.type = FloatType;
			texture.generateMipmaps = false;

			this.material.uniforms.blueNoiseTexture.value = texture;
			this.material.uniforms.blueNoiseTextureSize.value = new Vector2( texture.image.width, texture.image.height );
			this.material.needsUpdate = true;

		} );

		this.isComplete = false;
		this.accumulationPass = null;
		this.adaptiveSamplingPass = null;

		// Performance optimization during interaction
		this.interactionMode = false;
		this.interactionModeEnabled = DEFAULT_STATE.interactionModeEnabled; // Add this line
		this.interactionTimeout = null;
		this.interactionDelay = 100; // delay before restoring quality
		this.originalValues = {}; // Store original uniform values

		this.uniformsDirty = {
			camera: true,
			lights: true,
			environment: true,
			settings: true
		};

		// Pre-calculate completion thresholds
		this.completionThreshold = 0;
		this.updateCompletionThreshold();

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();

		// Enhanced interaction mode settings
		this.interactionQualitySettings = {
			maxBounceCount: 1,
			numRaysPerPixel: 1,
			useAdaptiveSampling: false,
			useEnvMapIS: false,
			pixelRatio: 0.25,
		};

	}

	async buildEnvironmentCDF() {

		if ( ! this.scene.environment ) return;

		const result = await this.environmentCDFBuilder.buildEnvironmentCDF( this.scene.environment );

		if ( result ) {

			this.material.uniforms.envCDF.value = result.cdfTexture;
			this.material.uniforms.envCDFSize.value.set( result.cdfSize.width, result.cdfSize.height );
			this.material.uniforms.useEnvMapIS.value = true;

		} else {

			this.material.uniforms.useEnvMapIS.value = false;

		}

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

	setEnvironmentMap( envMap ) {

		this.scene.environment = envMap;
		this.material.uniforms.environment.value = envMap;
		if ( envMap ) {

			this.buildEnvironmentCDF();

		} else {

			this.material.uniforms.useEnvMapIS.value = false;

		}

	}

	setAdaptiveSamplingParameters( params ) {

		if ( params.min !== undefined ) {

			this.adaptiveSamplingPass.adaptiveSamplingMin = params.min;
			this.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMin.value = params.min;

		}

		if ( params.max !== undefined ) {

			this.adaptiveSamplingPass.adaptiveSamplingMax = params.max;
			this.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMax.value = params.max;
			this.material.uniforms.adaptiveSamplingMax.value = params.max;

		}

		if ( params.threshold !== undefined ) {

			this.adaptiveSamplingPass.adaptiveSamplingVarianceThreshold = params.threshold;
			this.adaptiveSamplingPass.material.uniforms.adaptiveSamplingVarianceThreshold.value = params.threshold;

		}

		if ( params.temporalWeight !== undefined ) {

			this.adaptiveSamplingPass.material.uniforms.temporalWeight.value = params.temporalWeight;

		}

		if ( params.convergenceBoost !== undefined ) {

			this.adaptiveSamplingPass.setConvergenceBoost( params.convergenceBoost );

		}

		this.reset();

	}

	getAdaptiveSamplingStats() {

		// This method could be used to get statistics about the adaptive sampling
		return {
			enabled: this.material.uniforms.useAdaptiveSampling.value,
			min: this.adaptiveSamplingPass.adaptiveSamplingMin,
			max: this.adaptiveSamplingPass.adaptiveSamplingMax,
			threshold: this.adaptiveSamplingPass.adaptiveSamplingVarianceThreshold,
			frameNumber: this.adaptiveSamplingPass.material.uniforms.frameNumber.value
		};

	}

	reset() {

		// Only clear if we actually have accumulated samples
		if ( this.material.uniforms.frame.value > 0 ) {

			this.material.uniforms.frame.value = 0;
			this.renderer.setRenderTarget( this.previousRenderTarget );
			this.renderer.clear();

			// Update completion threshold if render mode changed
			this.updateCompletionThreshold();

			if ( this.material.uniforms.renderMode.value === 1 ) {

				this.material.uniforms.tiles.value = 1;

			}

			this.accumulationPass?.reset( this.renderer );
			this.isComplete = false;

		}

	}

	updateCompletionThreshold() {

		const renderMode = this.material.uniforms.renderMode.value;
		const maxFrames = this.material.uniforms.maxFrames.value;

		this.completionThreshold = renderMode === 1
			? Math.pow( this.tiles, 2 ) * maxFrames
			: maxFrames;

	}

	// Track camera changes for dirty flags
	updateCameraUniforms() {

		// Check if camera actually moved
		if ( ! this.lastCameraMatrix.equals( this.camera.matrixWorld ) ||
            ! this.lastProjectionMatrix.equals( this.camera.projectionMatrixInverse ) ) {

			this.material.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.material.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

			// Cache current matrices
			this.lastCameraMatrix.copy( this.camera.matrixWorld );
			this.lastProjectionMatrix.copy( this.camera.projectionMatrixInverse );

			this.uniformsDirty.camera = false;
			return true; // Camera changed

		}

		return false; // No change

	}

	enterInteractionMode() {

		// Check if interaction mode is enabled globally
		if ( ! this.interactionModeEnabled ) return;

		if ( this.interactionMode ) {

			// Already in interaction mode, just clear the timeout
			clearTimeout( this.interactionTimeout );

		} else {

			// Enter interaction mode and save original values
			this.interactionMode = true;
			this.originalValues = {}; // Reset stored values

			// Store and apply all interaction settings
			Object.keys( this.interactionQualitySettings ).forEach( key => {

				if ( this.material.uniforms[ key ] ) {

					this.originalValues[ key ] = this.material.uniforms[ key ].value;
					this.material.uniforms[ key ].value = this.interactionQualitySettings[ key ];

				}

			} );

			// Store and reduce pixel ratio
			this.originalValues.dpr = this.renderer.getPixelRatio();
			this.renderer.setPixelRatio( this.interactionQualitySettings.pixelRatio );

		}

		// Set timeout to exit interaction mode
		this.interactionTimeout = setTimeout( () => {

			this.exitInteractionMode();

		}, this.interactionDelay );

	}

	exitInteractionMode() {

		if ( ! this.interactionMode ) return;

		// Restore original values
		Object.keys( this.originalValues ).forEach( key => {

			if ( this.material.uniforms[ key ] ) {

				this.material.uniforms[ key ].value = this.originalValues[ key ];

			}

		} );

		this.renderer.setPixelRatio( this.originalValues.dpr );

		this.interactionMode = false;
		this.reset(); // Reset the render to use the new values

	}

	setInteractionQuality( settingsObject ) {

		// Update interaction quality settings
		Object.assign( this.interactionQualitySettings, settingsObject );

	}

	// Add a method to toggle interaction mode
	setInteractionModeEnabled( enabled ) {

		this.interactionModeEnabled = enabled;

		// If turning off while in interaction mode, exit immediately
		if ( ! enabled && this.interactionMode ) {

			clearTimeout( this.interactionTimeout );
			this.exitInteractionMode();

		}

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.material.uniforms.resolution.value.set( width, height );
		this.renderTargetA.setSize( width, height );
		this.renderTargetB.setSize( width, height );

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

		// 1. Early completion check with pre-calculated threshold
		this.material.uniforms.frame.value ++;
		const frameValue = this.material.uniforms.frame.value;

		if ( frameValue >= this.completionThreshold ) {

			this.isComplete = true;
			return;

		}

		// 2. Only update uniforms that have changed
		const uniforms = this.material.uniforms;

		// Update camera only if it moved
		this.updateCameraUniforms();

		// Update frame-dependent uniforms (these always change)
		uniforms.previousFrameTexture.value = this.previousRenderTarget.texture;

		// Update accumulation pass texture only if it exists and changed
		const accumulatedTexture = this.accumulationPass?.currentAccumulation.texture;
		if ( uniforms.accumulatedFrameTexture.value !== accumulatedTexture ) {

			uniforms.accumulatedFrameTexture.value = accumulatedTexture;

		}

		// 3. Adaptive sampling optimization - skip during interaction
		if ( this.adaptiveSamplingPass?.enabled && ! this.interactionMode ) {

			// Only update adaptive sampling every few frames
			if ( frameValue % 4 === 0 ) {

				uniforms.adaptiveSamplingTexture.value = this.adaptiveSamplingPass.renderTarget.texture;
				uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingPass.adaptiveSamplingMax;

				this.adaptiveSamplingPass.setTextures(
					uniforms.previousFrameTexture.value,
					uniforms.accumulatedFrameTexture.value
				);

			}

		} else if ( this.interactionMode ) {

			// Disable adaptive sampling during interaction
			uniforms.adaptiveSamplingTexture.value = null;

		}

		// 4. Optimized resolution update (avoid if unchanged)
		if ( uniforms.resolution.value.x !== this.width ||
            uniforms.resolution.value.y !== this.height ) {

			uniforms.resolution.value.set( this.width, this.height );

		}

		// 5. Render to target
		renderer.setRenderTarget( this.currentRenderTarget );
		this.fsQuad.render( renderer );

		// 6. Copy to output
		this.copyMaterial.uniforms.tDiffuse.value = this.currentRenderTarget.texture;
		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
		this.copyQuad.render( renderer );

		// 7. Update tiles only when needed (not every frame)
		if ( uniforms.renderMode.value === 1 && uniforms.tiles.value !== this.tiles ) {

			uniforms.tiles.value = this.tiles;

		}

		// 8. Swap render targets (ping-pong)
		[ this.currentRenderTarget, this.previousRenderTarget ] =
            [ this.previousRenderTarget, this.currentRenderTarget ];

	}

	updateUniforms( updates ) {

		let needsReset = false;

		Object.entries( updates ).forEach( ( [ key, value ] ) => {

			if ( this.material.uniforms[ key ] &&
                this.material.uniforms[ key ].value !== value ) {

				this.material.uniforms[ key ].value = value;
				needsReset = true;

			}

		} );

		if ( needsReset ) {

			this.reset();

		}

	}

}

