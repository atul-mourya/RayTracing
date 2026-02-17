import { Fn, vec4, texture, uv, uniform, uniformArray } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import {
	HalfFloatType, RGBAFormat, NearestFilter, LinearFilter, Vector2, Matrix4, Vector3, Color,
	TextureLoader, RepeatWrapping, FloatType, DataTexture, DataArrayTexture
} from 'three';

import { pathTracerMain } from '../TSL/PathTracer.js';
import { samplingTechniqueUniform, blueNoiseTextureNode, blueNoiseTextureSizeUniform } from '../TSL/Random.js';

// Pipeline system
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';

// Managers (renderer-agnostic)
import { TileRenderingManager } from '../../Processor/TileRenderingManager.js';
import { CameraMovementOptimizer } from '../../Processor/CameraMovementOptimizer.js';
import { PathTracerUtils } from '../../Processor/PathTracerUtils.js';

// Scene building
import TriangleSDF from '../../Processor/TriangleSDF';
import { LightDataTransfer } from '../../Processor/LightDataTransfer';

// Environment
import { EquirectHdrInfo } from '../../Processor/EquirectHdrInfo';
import { ProceduralSkyRenderer } from '../../Processor/ProceduralSkyRenderer';
import { SimpleSkyRenderer } from '../../Processor/SimpleSkyRenderer';

// Constants
import { DEFAULT_STATE, TEXTURE_CONSTANTS } from '../../../Constants';

// Blue noise
import blueNoiseImage from '../../../../public/noise/simple_bluenoise.png';

/**
 * Data layout constants
 */
const BVH_VEC4_PER_NODE = 3;
const TRI_VEC4_PER_TRIANGLE = 8;
const PIXELS_PER_MATERIAL = 27;

/**
 * Default render target options
 */
const DEFAULT_RT_OPTIONS = {
	type: HalfFloatType,
	format: RGBAFormat,
	minFilter: NearestFilter,
	magFilter: NearestFilter,
	depthBuffer: false,
	stencilBuffer: false
};

/**
 * Path Tracing Stage for WebGPU.
 *
 * Exact port of WebGL PathTracerStage with full feature parity:
 * - BVH-accelerated ray traversal
 * - GGX/Diffuse BSDF sampling
 * - Environment lighting with importance sampling
 * - Progressive and tiled accumulation
 * - MRT outputs for denoising (normal/depth, albedo)
 * - Camera interaction mode optimization
 * - Event-driven pipeline communication
 *
 * Events emitted:
 * - pathtracer:frameComplete - When a frame finishes rendering
 * - camera:moved - When camera position/orientation changes
 * - tile:changed - When current tile changes (for TileHighlightStage)
 * - asvgf:reset - Request ASVGF to reset temporal data
 * - asvgf:updateParameters - Update ASVGF parameters
 * - asvgf:setTemporal - Enable/disable ASVGF temporal accumulation
 *
 * Textures published to context:
 * - pathtracer:color - Main color output
 * - pathtracer:normalDepth - Normal/depth buffer
 */
export class PathTracingStage extends PipelineStage {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {Scene} scene - Three.js scene
	 * @param {PerspectiveCamera} camera - Three.js camera
	 * @param {Object} options - Configuration options
	 */
	constructor( renderer, scene, camera, options = {} ) {

		super( 'PathTracer', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		const width = options.width || 1920;
		const height = options.height || 1080;

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;

		// Initialize managers
		this.tileManager = new TileRenderingManager( width, height, DEFAULT_STATE.tiles );

		// Scene building
		this.sdfs = new TriangleSDF();
		this.lightDataTransfer = new LightDataTransfer();
		this.equirectHdrInfo = new EquirectHdrInfo();

		// Sky renderers (lazy init)
		this.proceduralSkyRenderer = null;
		this.simpleSkyRenderer = null;

		// State management
		this.accumulationEnabled = true;
		this.isComplete = false;
		this.cameras = [];
		this.compiledFeatures = null;

		// Performance monitoring
		this.performanceMonitor = PathTracerUtils.createPerformanceMonitor();
		this.completionThreshold = 0;
		this.renderLimitMode = 'frames';

		// Initialize data textures
		this._initDataTextures();

		// Initialize render targets
		this._initRenderTargets();

		// Initialize uniforms
		this._initUniforms();

		// Initialize rendering state
		this._initRenderingState();

		// Setup blue noise
		this.setupBlueNoise();

		// Initialize environment parameters
		this._initEnvParams();

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();
		this.environmentRotationMatrix = new Matrix4();

		// Denoising management state
		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;
		this.renderModeChangeTimeout = null;
		this.renderModeChangeDelay = 50;
		this.pendingRenderMode = null;

		// Environment and CDF state
		this.lastCDFValidation = null;
		this.cdfBuildTime = 0;

		// Adaptive sampling state
		this.adaptiveSamplingFrameToggle = false;

		// Track interaction mode state for accumulation
		this.lastInteractionModeState = false;
		this.interactionModeChangeFrame = 0;

		// Track changes for event emission
		this.cameraChanged = false;
		this.tileChanged = false;

		// Update completion threshold
		this.updateCompletionThreshold();

	}

	/**
	 * Initialize data texture references and metadata
	 */
	_initDataTextures() {

		// Triangle data
		this.triangleTexture = null;
		this.triangleTexSize = new Vector2();
		this.triangleCount = 0;

		// BVH data
		this.bvhTexture = null;
		this.bvhTexSize = new Vector2();
		this.bvhNodeCount = 0;

		// Material data
		this.materialTexture = null;
		this.materialTexSize = new Vector2();
		this.materialCount = 0;

		// Environment map
		this.environmentTexture = null;
		this.envTexSize = new Vector2();

		// Environment importance sampling
		this.envMarginalWeights = null;
		this.envConditionalWeights = null;

		// Lights
		this.directionalLightsData = null;
		this.pointLightsData = null;
		this.spotLightsData = null;
		this.areaLightsData = null;

		// Blue noise
		this.blueNoiseTexture = null;

		// Emissive triangles
		this.emissiveTriangleTexture = null;

		// Adaptive sampling
		this.adaptiveSamplingTexture = null;

		// Material texture arrays
		this.albedoMaps = null;
		this.emissiveMaps = null;
		this.normalMaps = null;
		this.bumpMaps = null;
		this.roughnessMaps = null;
		this.metalnessMaps = null;
		this.displacementMaps = null;

		// Spheres
		this.spheres = [];

	}

	/**
	 * Initialize render target state
	 */
	_initRenderTargets() {

		// Ping-pong accumulation targets
		this.renderTargetA = null;
		this.renderTargetB = null;
		this.currentTarget = 0;
		this.renderWidth = 0;
		this.renderHeight = 0;

		// MRT targets for denoising
		this.normalDepthTarget = null;
		this.albedoTarget = null;
		this.enableMRT = true;

	}

	/**
	 * Initialize all uniforms grouped by category
	 */
	_initUniforms() {

		// Frame and sampling
		this.frame = uniform( 0, 'uint' );
		this.maxBounces = uniform( DEFAULT_STATE.bounces, 'int' );
		this.samplesPerPixel = uniform( DEFAULT_STATE.samplesPerPixel, 'int' );
		this.maxSamples = uniform( DEFAULT_STATE.maxSamples, 'int' );
		this.transmissiveBounces = uniform( DEFAULT_STATE.transmissiveBounces, 'int' );
		this.visMode = uniform( DEFAULT_STATE.debugMode, 'int' );
		this.debugVisScale = uniform( DEFAULT_STATE.debugVisScale, 'float' );

		// Accumulation
		this.enableAccumulation = uniform( 1, 'int' );
		this.accumulationAlpha = uniform( 0.0, 'float' );
		this.cameraIsMoving = uniform( 0, 'int' );
		this.hasPreviousAccumulated = uniform( 0, 'int' );

		// Environment
		this.environmentIntensity = uniform( DEFAULT_STATE.environmentIntensity, 'float' );
		this.backgroundIntensity = uniform( DEFAULT_STATE.backgroundIntensity, 'float' );
		this.showBackground = uniform( DEFAULT_STATE.showBackground ? 1 : 0, 'int' );
		this.enableEnvironment = uniform( DEFAULT_STATE.enableEnvironment ? 1 : 0, 'int' );
		this.environmentMatrix = uniform( new Matrix4(), 'mat4' );
		this.useEnvMapIS = uniform( DEFAULT_STATE.useImportanceSampledEnvironment ? 1 : 0, 'int' );
		this.envTotalSum = uniform( 0.0, 'float' );
		this.envResolution = uniform( new Vector2( 1, 1 ), 'vec2' );

		// Sun parameters
		this.sunDirection = uniform( new Vector3( 0, 1, 0 ), 'vec3' );
		this.sunAngularSize = uniform( 0.0087, 'float' );
		this.hasSun = uniform( 0, 'int' );

		// Lighting
		this.globalIlluminationIntensity = uniform( DEFAULT_STATE.globalIlluminationIntensity, 'float' );
		this.exposure = uniform( DEFAULT_STATE.exposure, 'float' );

		// Light counts (uniforms updated when lights change)
		this.numDirectionalLights = uniform( 0, 'int' );
		this.numAreaLights = uniform( 0, 'int' );
		this.numPointLights = uniform( 0, 'int' );
		this.numSpotLights = uniform( 0, 'int' );

		// Light buffer nodes (created lazily from Float32Array data)
		this.directionalLightsBufferNode = uniformArray( new Float32Array( 8 ), 'float' );
		this.areaLightsBufferNode = uniformArray( new Float32Array( 13 ), 'float' );
		this.pointLightsBufferNode = uniformArray( new Float32Array( 7 ), 'float' );
		this.spotLightsBufferNode = uniformArray( new Float32Array( 11 ), 'float' );

		// Camera matrices
		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.cameraViewMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrix = uniform( new Matrix4(), 'mat4' );

		// DOF
		this.enableDOF = uniform( DEFAULT_STATE.enableDOF ? 1 : 0, 'int' );
		this.focusDistance = uniform( DEFAULT_STATE.focusDistance, 'float' );
		this.focalLength = uniform( DEFAULT_STATE.focalLength, 'float' );
		this.aperture = uniform( DEFAULT_STATE.aperture, 'float' );
		this.apertureScale = uniform( 1.0, 'float' );
		this.sceneScale = uniform( 1.0, 'float' );

		// Sampling — use the module-level uniforms from Random.js so TSL sees the same nodes
		this.samplingTechnique = samplingTechniqueUniform;
		this.samplingTechnique.value = DEFAULT_STATE.samplingTechnique;
		this.useAdaptiveSampling = uniform( DEFAULT_STATE.adaptiveSampling ? 1 : 0, 'int' );
		this.adaptiveSamplingMax = uniform( DEFAULT_STATE.adaptiveSamplingMax, 'int' );
		this.fireflyThreshold = uniform( DEFAULT_STATE.fireflyThreshold, 'float' );

		// Emissive
		this.enableEmissiveTriangleSampling = uniform( DEFAULT_STATE.enableEmissiveTriangleSampling ? 1 : 0, 'int' );
		this.emissiveBoost = uniform( DEFAULT_STATE.emissiveBoost, 'float' );
		this.emissiveTriangleTexSize = uniform( new Vector2(), 'vec2' );
		this.emissiveTriangleCount = uniform( 0, 'int' );

		// Render mode
		this.renderMode = uniform( DEFAULT_STATE.renderMode, 'int' );

		// Resolution (for RNG seeding)
		this.resolution = uniform( new Vector2( this.width, this.height ), 'vec2' );

		// Texture size uniforms
		this.triangleTexSizeUniform = uniform( new Vector2( 1, 1 ), 'vec2' );
		this.bvhTexSizeUniform = uniform( new Vector2( 1, 1 ), 'vec2' );
		this.materialTexSizeUniform = uniform( new Vector2( 1, 1 ), 'vec2' );

		// Scene data
		this.totalTriangleCount = uniform( 0, 'int' );

		// Blue noise — use the module-level uniforms from Random.js
		this.blueNoiseTextureSize = blueNoiseTextureSizeUniform;

		this._nameTheUniforms();

	}

	_nameTheUniforms() {

		this.frame.name = 'frame';
		this.maxBounces.name = 'maxBounces';
		this.samplesPerPixel.name = 'samplesPerPixel';
		this.maxSamples.name = 'maxSamples';
		this.transmissiveBounces.name = 'transmissiveBounces';
		this.visMode.name = 'visMode';
		this.debugVisScale.name = 'debugVisScale';
		this.enableAccumulation.name = 'enableAccumulation';
		this.accumulationAlpha.name = 'accumulationAlpha';
		this.cameraIsMoving.name = 'cameraIsMoving';
		this.hasPreviousAccumulated.name = 'hasPreviousAccumulated';
		this.environmentIntensity.name = 'environmentIntensity';
		this.backgroundIntensity.name = 'backgroundIntensity';
		this.showBackground.name = 'showBackground';
		this.enableEnvironment.name = 'enableEnvironment';
		this.environmentMatrix.name = 'environmentMatrix';
		this.useEnvMapIS.name = 'useEnvMapIS';
		this.envTotalSum.name = 'envTotalSum';
		this.envResolution.name = 'envResolution';
		this.sunDirection.name = 'sunDirection';
		this.sunAngularSize.name = 'sunAngularSize';
		this.hasSun.name = 'hasSun';
		this.globalIlluminationIntensity.name = 'globalIlluminationIntensity';
		this.exposure.name = 'exposure';
		this.cameraWorldMatrix.name = 'cameraWorldMatrix';
		this.cameraProjectionMatrixInverse.name = 'cameraProjectionMatrixInverse';
		this.cameraViewMatrix.name = 'cameraViewMatrix';
		this.cameraProjectionMatrix.name = 'cameraProjectionMatrix';
		this.enableDOF.name = 'enableDOF';
		this.focusDistance.name = 'focusDistance';
		this.focalLength.name = 'focalLength';
		this.aperture.name = 'aperture';
		this.apertureScale.name = 'apertureScale';
		this.sceneScale.name = 'sceneScale';
		this.samplingTechnique.name = 'samplingTechnique';
		this.useAdaptiveSampling.name = 'useAdaptiveSampling';
		this.adaptiveSamplingMax.name = 'adaptiveSamplingMax';
		this.fireflyThreshold.name = 'fireflyThreshold';
		this.enableEmissiveTriangleSampling.name = 'enableEmissiveTriangleSampling';
		this.emissiveBoost.name = 'emissiveBoost';
		this.emissiveTriangleTexSize.name = 'emissiveTriangleTexSize';
		this.emissiveTriangleCount.name = 'emissiveTriangleCount';
		this.renderMode.name = 'renderMode';
		this.resolution.name = 'resolution';
		this.triangleTexSizeUniform.name = 'triangleTexSizeUniform';
		this.bvhTexSizeUniform.name = 'bvhTexSizeUniform';
		this.materialTexSizeUniform.name = 'materialTexSizeUniform';
		this.totalTriangleCount.name = 'totalTriangleCount';
		this.blueNoiseTextureSize.name = 'blueNoiseTextureSize';
		this.numDirectionalLights.name = 'numDirectionalLights';
		this.numAreaLights.name = 'numAreaLights';
		this.numPointLights.name = 'numPointLights';
		this.numSpotLights.name = 'numSpotLights';

	}

	/**
	 * Initialize rendering state
	 */
	_initRenderingState() {

		// Materials and quads
		this.accumMaterial = null;
		this.displayMaterial = null;
		this.normalDepthMaterial = null;
		this.albedoMaterial = null;

		this.pathTraceQuad = null;
		this.accumQuad = null;
		this.displayQuad = null;
		this.normalDepthQuad = null;
		this.albedoQuad = null;

		// Texture nodes (for dynamic updates)
		this.prevFrameTexNode = null;
		this.displayTexNode = null;

		// State flags
		this.isReady = false;
		this.frameCount = 0;

	}

	/**
	 * Initialize environment parameters (CPU-side)
	 */
	_initEnvParams() {

		this.envParams = {
			mode: 'hdri',

			// Gradient Sky parameters
			gradientZenithColor: new Color( DEFAULT_STATE.gradientZenithColor ),
			gradientHorizonColor: new Color( DEFAULT_STATE.gradientHorizonColor ),
			gradientGroundColor: new Color( DEFAULT_STATE.gradientGroundColor ),

			// Solid Color Sky parameter
			solidSkyColor: new Color( DEFAULT_STATE.solidSkyColor ),

			// Procedural Sky (Preetham Model) parameters
			skySunDirection: this._calculateInitialSunDirection(),
			skySunIntensity: DEFAULT_STATE.skySunIntensity,
			skyRayleighDensity: DEFAULT_STATE.skyRayleighDensity,
			skyTurbidity: DEFAULT_STATE.skyTurbidity,
			skyMieAnisotropy: DEFAULT_STATE.skyMieAnisotropy,
		};

	}

	_calculateInitialSunDirection() {

		const azimuth = DEFAULT_STATE.skySunAzimuth * ( Math.PI / 180 );
		const elevation = DEFAULT_STATE.skySunElevation * ( Math.PI / 180 );
		return new Vector3(
			Math.cos( elevation ) * Math.sin( azimuth ),
			Math.sin( elevation ),
			Math.cos( elevation ) * Math.cos( azimuth )
		).normalize();

	}

	/**
	 * Initialize camera movement optimizer
	 */
	_initCameraOptimizer() {

		// Create adapter interface for TSL uniforms
		const self = this;
		const materialInterface = {
			uniforms: {
				maxBounceCount: {
					get value() {

						return self.maxBounces.value;

					},
					set value( v ) {

						self.maxBounces.value = v;

					}
				},
				numRaysPerPixel: {
					get value() {

						return self.samplesPerPixel.value;

					},
					set value( v ) {

						self.samplesPerPixel.value = v;

					}
				},
				useAdaptiveSampling: {
					get value() {

						return self.useAdaptiveSampling.value;

					},
					set value( v ) {

						self.useAdaptiveSampling.value = v;

					}
				},
				useEnvMapIS: {
					get value() {

						return self.useEnvMapIS.value;

					},
					set value( v ) {

						self.useEnvMapIS.value = v;

					}
				},
				enableAccumulation: {
					get value() {

						return self.enableAccumulation.value;

					},
					set value( v ) {

						self.enableAccumulation.value = v;

					}
				},
				enableEmissiveTriangleSampling: {
					get value() {

						return self.enableEmissiveTriangleSampling.value;

					},
					set value( v ) {

						self.enableEmissiveTriangleSampling.value = v;

					}
				},
				cameraIsMoving: {
					get value() {

						return self.cameraIsMoving.value;

					},
					set value( v ) {

						self.cameraIsMoving.value = v;

					}
				}
			}
		};

		this.cameraOptimizer = new CameraMovementOptimizer( this.renderer, materialInterface, {
			enabled: DEFAULT_STATE.interactionModeEnabled,
			qualitySettings: {
				maxBounceCount: 1,
				numRaysPerPixel: 1,
				useAdaptiveSampling: false,
				useEnvMapIS: false,
				enableAccumulation: false,
				enableEmissiveTriangleSampling: false,
			},
			onReset: () => this.reset()
		} );

	}

	/**
	 * Setup blue noise texture
	 */
	setupBlueNoise() {

		const loader = new TextureLoader();
		loader.load( blueNoiseImage, ( texture ) => {

			texture.minFilter = NearestFilter;
			texture.magFilter = NearestFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.type = FloatType;
			texture.generateMipmaps = false;

			this.blueNoiseTexture = texture;
			blueNoiseTextureNode.value = texture;
			this.blueNoiseTextureSize.value.set( texture.image.width, texture.image.height );

			console.log( `PathTracingStage: Blue noise loaded ${texture.image.width}x${texture.image.height}` );

		} );

	}

	/**
	 * Setup event listeners for pipeline events
	 */
	setupEventListeners() {

		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

		this.on( 'pipeline:resize', ( data ) => {

			if ( data && data.width && data.height ) {

				this.setSize( data.width, data.height );

			}

		} );

		this.on( 'pathtracer:setCompletionThreshold', ( data ) => {

			if ( data && data.threshold !== undefined ) {

				this.completionThreshold = data.threshold;

			}

		} );

	}

	// ===== PUBLIC API METHODS =====

	/**
	 * Build scene data (BVH, geometry, materials)
	 * @param {Object3D} scene - Three.js scene or object
	 */
	async build( scene ) {

		this.dispose();
		this.scene = scene;

		await this.sdfs.buildBVH( scene );
		this.cameras = this.sdfs.cameras;

		// Inject shader defines based on detected material features
		this.injectMaterialFeatureDefines();

		// Update uniforms with scene data
		this.updateSceneUniforms();
		this.updateLights();

		// Initialize camera optimizer after scene is built
		this._initCameraOptimizer();

		// Setup material now that we have scene data
		this.setupMaterial();

	}

	/**
	 * Update scene uniforms from TriangleSDF data
	 */
	updateSceneUniforms() {

		// Set texture references
		this.setTriangleTexture( this.sdfs.triangleTexture );
		this.setBVHTexture( this.sdfs.bvhTexture );
		this.setMaterialTexture( this.sdfs.materialTexture );

		// Update triangle count
		this.totalTriangleCount.value = this.sdfs.triangleCount || 0;

		// Material texture arrays
		this.albedoMaps = this.sdfs.albedoTextures;
		this.emissiveMaps = this.sdfs.emissiveTextures;
		this.normalMaps = this.sdfs.normalTextures;
		this.bumpMaps = this.sdfs.bumpTextures;
		this.roughnessMaps = this.sdfs.roughnessTextures;
		this.metalnessMaps = this.sdfs.metalnessTextures;
		this.displacementMaps = this.sdfs.displacementTextures;

		// Emissive triangles
		if ( this.sdfs.emissiveTriangleTexture ) {

			this.setEmissiveTriangleTexture( this.sdfs.emissiveTriangleTexture );
			this.setEmissiveTriangleCount( this.sdfs.emissiveTriangleCount || 0 );

			console.log( `[PathTracingStage] Emissive triangle data updated: ${this.sdfs.emissiveTriangleCount} emissives` );

		} else {

			this.emissiveTriangleCount.value = 0;

		}

		// Spheres
		this.spheres = this.sdfs.spheres || [];

	}

	/**
	 * Update lights from scene
	 */
	updateLights() {

		// Process scene lights
		const mockMaterial = {
			uniforms: {
				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null }
			},
			defines: {}
		};

		this.lightDataTransfer.processSceneLights( this.scene, mockMaterial );

		// Store light data
		this.directionalLightsData = mockMaterial.uniforms.directionalLights.value;
		this.pointLightsData = mockMaterial.uniforms.pointLights.value;
		this.spotLightsData = mockMaterial.uniforms.spotLights.value;
		this.areaLightsData = mockMaterial.uniforms.areaLights.value;

		// Add sun as directional light if procedural sky is active
		if ( this.hasSun.value ) {

			const scaledSunIntensity = this.envParams.skySunIntensity * 950.0;

			const sunLight = {
				intensity: scaledSunIntensity,
				color: { r: 1.0, g: 1.0, b: 1.0 },
				userData: {
					angle: this.sunAngularSize.value
				},
				updateMatrixWorld: () => {},
				getWorldPosition: ( target ) => {

					const sunDir = this.sunDirection.value;
					return target.set( sunDir.x, sunDir.y, sunDir.z ).multiplyScalar( 1e10 );

				}
			};

			this.lightDataTransfer.addDirectionalLight( sunLight );
			this.lightDataTransfer.preprocessLights();
			this.lightDataTransfer.updateShaderUniforms( mockMaterial );

			this.directionalLightsData = mockMaterial.uniforms.directionalLights.value;

			console.log( `Sun added as directional light (intensity: ${scaledSunIntensity.toFixed( 2 )})` );

		}

		// Update TSL uniform buffer nodes from raw Float32Array data
		this._updateLightBufferNodes();

	}

	/**
	 * Update TSL uniformArray nodes with current light Float32Array data
	 */
	_updateLightBufferNodes() {

		// Directional lights (8 floats per light)
		if ( this.directionalLightsData && this.directionalLightsData.length > 0 ) {

			this.directionalLightsBufferNode.array = Array.from( this.directionalLightsData );
			this.numDirectionalLights.value = Math.floor( this.directionalLightsData.length / 8 );

		} else {

			this.numDirectionalLights.value = 0;

		}

		// Area lights (13 floats per light)
		if ( this.areaLightsData && this.areaLightsData.length > 0 ) {

			this.areaLightsBufferNode.array = Array.from( this.areaLightsData );
			this.numAreaLights.value = Math.floor( this.areaLightsData.length / 13 );

		} else {

			this.numAreaLights.value = 0;

		}

		// Point lights (7 floats per light)
		if ( this.pointLightsData && this.pointLightsData.length > 0 ) {

			this.pointLightsBufferNode.array = Array.from( this.pointLightsData );
			this.numPointLights.value = Math.floor( this.pointLightsData.length / 7 );

		} else {

			this.numPointLights.value = 0;

		}

		// Spot lights (11 floats per light)
		if ( this.spotLightsData && this.spotLightsData.length > 0 ) {

			this.spotLightsBufferNode.array = Array.from( this.spotLightsData );
			this.numSpotLights.value = Math.floor( this.spotLightsData.length / 11 );

		} else {

			this.numSpotLights.value = 0;

		}

	}

	/**
	 * Re-scan material data texture to detect which features are currently in use
	 * @returns {boolean} True if features changed
	 */
	rescanMaterialFeatures() {

		if ( ! this.materialTexture?.image?.data ) {

			console.warn( '[PathTracingStage] Material texture not available for feature scanning' );
			return false;

		}

		const data = this.materialTexture.image.data;
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const materialCount = this.sdfs.materialCount || 1;

		const newFeatures = {
			hasClearcoat: false,
			hasTransmission: false,
			hasDispersion: false,
			hasIridescence: false,
			hasSheen: false,
			hasTransparency: false,
			hasMultiLobeMaterials: false,
			hasMRTOutputs: true
		};

		for ( let i = 0; i < materialCount; i ++ ) {

			const stride = i * dataLengthPerMaterial;

			const transmission = data[ stride + 9 ];
			const dispersion = data[ stride + 16 ];
			const sheen = data[ stride + 18 ];
			const iridescence = data[ stride + 28 ];
			const clearcoat = data[ stride + 38 ];
			const opacity = data[ stride + 40 ];
			const transparent = data[ stride + 42 ];
			const alphaTest = data[ stride + 43 ];

			if ( clearcoat > 0 ) newFeatures.hasClearcoat = true;
			if ( transmission > 0 ) newFeatures.hasTransmission = true;
			if ( dispersion > 0 ) newFeatures.hasDispersion = true;
			if ( iridescence > 0 ) newFeatures.hasIridescence = true;
			if ( sheen > 0 ) newFeatures.hasSheen = true;
			if ( transparent > 0 || opacity < 1.0 || alphaTest > 0 ) newFeatures.hasTransparency = true;

			const featureCount = [
				clearcoat > 0,
				transmission > 0,
				iridescence > 0,
				sheen > 0
			].filter( Boolean ).length;

			if ( featureCount >= 2 ) {

				newFeatures.hasMultiLobeMaterials = true;

			}

		}

		const oldFeaturesJSON = JSON.stringify( this.sdfs.sceneFeatures );
		const newFeaturesJSON = JSON.stringify( newFeatures );
		const changed = oldFeaturesJSON !== newFeaturesJSON;

		if ( changed ) {

			this.sdfs.sceneFeatures = newFeatures;

		}

		return changed;

	}

	/**
	 * Inject shader preprocessor defines based on detected scene material features
	 */
	injectMaterialFeatureDefines() {

		const features = this.sdfs.sceneFeatures;

		if ( ! features ) {

			console.warn( '[PathTracingStage] No sceneFeatures detected, skipping define injection' );
			return;

		}

		const featuresJSON = JSON.stringify( features );
		const featuresChanged = ! this.compiledFeatures || this.compiledFeatures !== featuresJSON;

		if ( ! featuresChanged ) {

			return;

		}

		// For TSL, we can't inject defines into the shader at runtime
		// Instead, we would need to conditionally generate the shader
		// For now, log the features for debugging
		console.log( '[PathTracingStage] Material features:', features );

		this.compiledFeatures = featuresJSON;

	}

	/**
	 * Reset accumulation
	 * @param {boolean} clearBuffers - Whether to clear render targets
	 */
	reset( clearBuffers = true ) {

		this.frameCount = 0;
		this.frame.value = 0;
		this.hasPreviousAccumulated.value = 0;
		this.currentTarget = 0;

		// Emit event to reset ASVGF
		this.emit( 'asvgf:reset' );

		// Reset tile manager
		this.tileManager.spiralOrder = this.tileManager.generateSpiralOrder( this.tileManager.tiles );

		// Clear targets if requested
		if ( clearBuffers && this.renderTargetA && this.renderTargetB && this.renderer ) {

			const currentRT = this.renderer.getRenderTarget();

			this.renderer.setRenderTarget( this.renderTargetA );
			this.renderer.clear( true, false, false );

			this.renderer.setRenderTarget( this.renderTargetB );
			this.renderer.clear( true, false, false );

			this.renderer.setRenderTarget( currentRT );

		}

		// Update completion threshold
		this.updateCompletionThreshold();
		this.isComplete = false;
		this.performanceMonitor?.reset();

		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;

		if ( clearBuffers ) {

			this.lastInteractionModeState = false;
			this.interactionModeChangeFrame = 0;

		}

	}

	/**
	 * Set tile count for tiled rendering
	 * @param {number} newTileCount
	 */
	setTileCount( newTileCount ) {

		this.tileManager.setTileCount( newTileCount );
		this.updateCompletionThreshold();
		this.reset();

	}

	/**
	 * Set render size
	 * @param {number} width
	 * @param {number} height
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.resolution.value.set( width, height );
		this.tileManager.setSize( width, height );
		this.createRenderTargets( width, height );

	}

	/**
	 * Set accumulation enabled state
	 * @param {boolean} enabled
	 */
	setAccumulationEnabled( enabled ) {

		this.accumulationEnabled = enabled;
		this.enableAccumulation.value = enabled ? 1 : 0;

	}

	// ===== MANAGER DELEGATION METHODS =====

	getCurrentAccumulation() {

		const target = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;
		return target?.texture ?? null;

	}

	getCurrentRawSample() {

		return this.getCurrentAccumulation();

	}

	getMRTTextures() {

		const currentTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;

		return {
			color: currentTarget?.texture ?? null,
			normalDepth: this.normalDepthTarget?.texture ?? null,
			albedo: this.albedoTarget?.texture ?? null
		};

	}

	enterInteractionMode() {

		this.cameraOptimizer?.enterInteractionMode();

	}

	setInteractionModeEnabled( enabled ) {

		this.cameraOptimizer?.setInteractionModeEnabled( enabled );

	}

	// ===== PROPERTY GETTERS =====

	get tiles() {

		return this.tileManager.tiles;

	}

	get interactionMode() {

		return this.cameraOptimizer?.isInInteractionMode() ?? false;

	}

	// ===== TEXTURE SETTERS =====

	/**
	 * Sets the triangle data texture.
	 * @param {DataTexture} triangleTex
	 */
	setTriangleTexture( triangleTex ) {

		if ( ! triangleTex ) return;

		this.triangleTexture = triangleTex;

		const { width, height } = triangleTex.image;
		this.triangleTexSize.set( width, height );
		this.triangleTexSizeUniform.value.set( width, height );

		const totalVec4s = width * height;
		this.triangleCount = Math.floor( totalVec4s / TRI_VEC4_PER_TRIANGLE );

		console.log( `PathTracingStage: ${this.triangleCount} triangles` );

	}

	/**
	 * Sets the BVH data texture.
	 * @param {DataTexture} bvhTex
	 */
	setBVHTexture( bvhTex ) {

		if ( ! bvhTex ) return;

		this.bvhTexture = bvhTex;

		const { width, height } = bvhTex.image;
		this.bvhTexSize.set( width, height );
		this.bvhTexSizeUniform.value.set( width, height );

		const totalVec4s = width * height;
		this.bvhNodeCount = Math.floor( totalVec4s / BVH_VEC4_PER_NODE );

		console.log( `PathTracingStage: ${this.bvhNodeCount} BVH nodes` );

	}

	/**
	 * Sets the material data texture.
	 * @param {DataTexture} materialTex
	 */
	setMaterialTexture( materialTex ) {

		if ( ! materialTex ) return;

		this.materialTexture = materialTex;

		const { width, height } = materialTex.image;
		this.materialTexSize.set( width, height );
		this.materialTexSizeUniform.value.set( width, height );

		const totalPixels = width * height;
		this.materialCount = Math.floor( totalPixels / PIXELS_PER_MATERIAL );

		console.log( `PathTracingStage: ${this.materialCount} materials (${width}x${height})` );

	}

	/**
	 * Sets the environment map texture.
	 * @param {Texture} envTex
	 */
	setEnvironmentTexture( envTex ) {

		if ( ! envTex ) return;

		this.environmentTexture = envTex;
		this.envTexSize.set( envTex.image.width, envTex.image.height );

		console.log( `PathTracingStage: Environment map ${envTex.image.width}x${envTex.image.height}` );

	}

	// ===== RENDER TARGETS =====

	/**
	 * Creates render targets for accumulation.
	 * @param {number} width
	 * @param {number} height
	 */
	createRenderTargets( width, height ) {

		this._disposeRenderTargets();

		this.renderWidth = width;
		this.renderHeight = height;

		// Accumulation targets
		this.renderTargetA = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
		this.renderTargetB = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );

		// MRT targets for denoising
		if ( this.enableMRT ) {

			this.normalDepthTarget = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
			this.albedoTarget = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
			console.log( `PathTracingStage: Created MRT targets (normalDepth, albedo)` );

		}

		// Update resolution uniform
		this.resolution.value.set( width, height );

		console.log( `PathTracingStage: Created ${width}x${height} render targets` );

	}

	/**
	 * Dispose existing render targets
	 */
	_disposeRenderTargets() {

		this.renderTargetA?.dispose();
		this.renderTargetB?.dispose();
		this.normalDepthTarget?.dispose();
		this.albedoTarget?.dispose();

		this.renderTargetA = null;
		this.renderTargetB = null;
		this.normalDepthTarget = null;
		this.albedoTarget = null;

	}

	// ===== MATERIAL SETUP =====

	/**
	 * Creates the path tracing material and quad.
	 * On subsequent calls (after the first), updates texture node values
	 * in-place instead of rebuilding the entire shader to avoid TSL/WGSL
	 * compilation failures from duplicate variable names.
	 */
	setupMaterial() {

		if ( ! this.triangleTexture ) {

			console.error( 'PathTracingStage: Triangle data required' );
			return;

		}

		if ( ! this.bvhTexture ) {

			console.error( 'PathTracingStage: BVH data required' );
			return;

		}

		// If material already exists, update texture nodes in-place
		// instead of rebuilding the shader (avoids TSL recompilation issues)
		if ( this.isReady && this._sceneTextureNodes ) {

			this._updateSceneTextures();
			return;

		}

		this._ensureRenderTargets();

		const textureNodes = this._createTextureNodes();
		const ptOutput = this._createPathTracerOutput( textureNodes );

		this._createPathTraceMaterials( ptOutput );
		this._createDisplayMaterial();

		if ( this.enableMRT ) {

			this._createMRTMaterials( ptOutput );

		}

		this.isReady = true;
		console.log( 'PathTracingStage: Material setup complete' );

	}

	/**
	 * Updates texture node values in-place after a model change.
	 * This avoids rebuilding the entire TSL shader graph which causes
	 * WGSL compilation failures due to variable naming conflicts.
	 */
	_updateSceneTextures() {

		const nodes = this._sceneTextureNodes;

		// Update core scene textures
		if ( this.triangleTexture && nodes.triTex ) {

			nodes.triTex.value = this.triangleTexture;

		}

		if ( this.bvhTexture && nodes.bvhTex ) {

			nodes.bvhTex.value = this.bvhTexture;

		}

		if ( this.materialTexture && nodes.matTex ) {

			nodes.matTex.value = this.materialTexture;

		}

		if ( this.environmentTexture && nodes.envTex ) {

			nodes.envTex.value = this.environmentTexture;

		}

		// Update material texture arrays
		if ( this.albedoMaps && nodes.albedoMapsTex ) nodes.albedoMapsTex.value = this.albedoMaps;
		if ( this.normalMaps && nodes.normalMapsTex ) nodes.normalMapsTex.value = this.normalMaps;
		if ( this.bumpMaps && nodes.bumpMapsTex ) nodes.bumpMapsTex.value = this.bumpMaps;
		if ( this.metalnessMaps && nodes.metalnessMapsTex ) nodes.metalnessMapsTex.value = this.metalnessMaps;
		if ( this.roughnessMaps && nodes.roughnessMapsTex ) nodes.roughnessMapsTex.value = this.roughnessMaps;
		if ( this.emissiveMaps && nodes.emissiveMapsTex ) nodes.emissiveMapsTex.value = this.emissiveMaps;
		if ( this.displacementMaps && nodes.displacementMapsTex ) nodes.displacementMapsTex.value = this.displacementMaps;

		console.log( 'PathTracingStage: Scene textures updated in-place' );

	}

	/**
	 * Ensure render targets exist at correct size
	 */
	_ensureRenderTargets() {

		const canvas = this.renderer.domElement;
		const width = Math.max( 1, canvas.width || this.width );
		const height = Math.max( 1, canvas.height || this.height );

		if ( this.renderWidth !== width || this.renderHeight !== height || ! this.renderTargetA ) {

			this.createRenderTargets( width, height );

		}

	}

	/**
	 * Create texture nodes for shader
	 * @returns {Object} Texture nodes and metadata
	 */
	_createTextureNodes() {

		// TSL requires valid texture instances - use new TextureNode() (default is EmptyTexture)
		const triTex = this.triangleTexture ? texture( this.triangleTexture ) : new TextureNode();
		const bvhTex = this.bvhTexture ? texture( this.bvhTexture ) : new TextureNode();

		const hasMaterials = this.materialTexture !== null;
		const matTex = hasMaterials ? texture( this.materialTexture ) : triTex;
		const matTexSize = hasMaterials ? this.materialTexSizeUniform : this.triangleTexSizeUniform;

		const hasEnv = this.environmentTexture !== null;
		const envTex = hasEnv ? texture( this.environmentTexture ) : triTex;

		// Previous frame texture for accumulation (use new TextureNode() if render target not ready)
		const prevFrameTex = this.renderTargetA?.texture
			? texture( this.renderTargetA.texture )
			: new TextureNode();
		this.prevFrameTexNode = prevFrameTex;

		// Placeholder texture node for optional textures (TSL requires valid texture instances)
		const placeholderTex = new TextureNode();

		// Adaptive sampling texture (use placeholder if not available)
		const hasAdaptiveSampling = this.adaptiveSamplingTexture !== null;
		const adaptiveSamplingTex = hasAdaptiveSampling
			? texture( this.adaptiveSamplingTexture )
			: placeholderTex;

		// Environment importance sampling CDF textures (use placeholder if not available)
		const hasCDF = this.envMarginalWeights !== null && this.envConditionalWeights !== null;
		const marginalCDFTex = hasCDF ? texture( this.envMarginalWeights ) : placeholderTex;
		const conditionalCDFTex = hasCDF ? texture( this.envConditionalWeights ) : placeholderTex;

		// Material texture arrays (DataArrayTexture → texture node)
		// Must use DataArrayTexture placeholder (not regular Texture) so WGSL emits texture_2d_array<f32>
		// CRITICAL: Set LinearFilter so isUnfilterable()=false → textureSample instead of textureLoad
		const dummyArrayTex = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
		dummyArrayTex.minFilter = LinearFilter;
		dummyArrayTex.magFilter = LinearFilter;
		dummyArrayTex.generateMipmaps = false;
		dummyArrayTex.needsUpdate = true;
		const arrayPlaceholder = texture( dummyArrayTex );
		const albedoMapsTex = this.albedoMaps ? texture( this.albedoMaps ) : arrayPlaceholder;
		const normalMapsTex = this.normalMaps ? texture( this.normalMaps ) : arrayPlaceholder;
		const bumpMapsTex = this.bumpMaps ? texture( this.bumpMaps ) : arrayPlaceholder;
		const metalnessMapsTex = this.metalnessMaps ? texture( this.metalnessMaps ) : arrayPlaceholder;
		const roughnessMapsTex = this.roughnessMaps ? texture( this.roughnessMaps ) : arrayPlaceholder;
		const emissiveMapsTex = this.emissiveMaps ? texture( this.emissiveMaps ) : arrayPlaceholder;
		const displacementMapsTex = this.displacementMaps ? texture( this.displacementMaps ) : arrayPlaceholder;

		const result = {
			triTex,
			bvhTex,
			matTex,
			matTexSize,
			envTex,
			prevFrameTex,
			placeholderTex,
			adaptiveSamplingTex,
			marginalCDFTex,
			conditionalCDFTex,
			hasMaterials,
			hasEnv,
			hasAdaptiveSampling,
			hasCDF,
			// Texture arrays
			albedoMapsTex,
			normalMapsTex,
			bumpMapsTex,
			metalnessMapsTex,
			roughnessMapsTex,
			emissiveMapsTex,
			displacementMapsTex,
		};

		// Store references for in-place updates on model change
		this._sceneTextureNodes = result;

		return result;

	}

	/**
	 * Create path tracer output
	 * @param {Object} textureNodes
	 * @returns {Object} Path tracer output nodes
	 */
	_createPathTracerOutput( textureNodes ) {

		const {
			triTex, bvhTex, matTex, matTexSize, envTex, prevFrameTex,
			adaptiveSamplingTex, marginalCDFTex, conditionalCDFTex,
			hasEnv, hasCDF,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex,
			displacementMapsTex,
		} = textureNodes;

		return pathTracerMain( {

			// Frame / resolution
			resolution: this.resolution,
			frame: this.frame,
			samplesPerPixel: this.samplesPerPixel,
			visMode: this.visMode,

			// Camera matrices
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraViewMatrix: this.cameraViewMatrix,
			cameraProjectionMatrix: this.cameraProjectionMatrix,

			// BVH / Scene
			bvhTexture: bvhTex,
			bvhTexSize: this.bvhTexSizeUniform,
			triangleTexture: triTex,
			triangleTexSize: this.triangleTexSizeUniform,
			materialTexture: matTex,
			materialTexSize: matTexSize,

			// Texture arrays
			albedoMaps: albedoMapsTex,
			normalMaps: normalMapsTex,
			bumpMaps: bumpMapsTex,
			metalnessMaps: metalnessMapsTex,
			roughnessMaps: roughnessMapsTex,
			emissiveMaps: emissiveMapsTex,
			displacementMaps: displacementMapsTex,

			// Lights
			directionalLightsBuffer: this.directionalLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			areaLightsBuffer: this.areaLightsBufferNode,
			numAreaLights: this.numAreaLights,
			pointLightsBuffer: this.pointLightsBufferNode,
			numPointLights: this.numPointLights,
			spotLightsBuffer: this.spotLightsBufferNode,
			numSpotLights: this.numSpotLights,

			// Environment
			envTexture: envTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			envMarginalWeights: marginalCDFTex,
			envConditionalWeights: conditionalCDFTex,
			envTotalSum: this.envTotalSum,
			envResolution: this.envResolution,
			enableEnvironmentLight: hasEnv,
			useEnvMapIS: hasCDF,

			// Rendering parameters
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			showBackground: this.showBackground,
			backgroundIntensity: this.backgroundIntensity,
			fireflyThreshold: this.fireflyThreshold,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			totalTriangleCount: this.totalTriangleCount,
			enableEmissiveTriangleSampling: this.enableEmissiveTriangleSampling,

			// Debug
			debugVisScale: this.debugVisScale,

			// Accumulation
			enableAccumulation: this.enableAccumulation,
			hasPreviousAccumulated: this.hasPreviousAccumulated,
			prevAccumTexture: prevFrameTex,
			accumulationAlpha: this.accumulationAlpha,
			cameraIsMoving: this.cameraIsMoving,

			// Adaptive Sampling
			useAdaptiveSampling: this.useAdaptiveSampling,
			adaptiveSamplingTexture: adaptiveSamplingTex,
			adaptiveSamplingMax: this.adaptiveSamplingMax,

			// DOF / Camera lens
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			sceneScale: this.sceneScale,
			apertureScale: this.apertureScale,
		} );

	}

	/**
	 * Create path trace and accumulation materials
	 * @param {Object} ptOutput
	 */
	_createPathTraceMaterials( ptOutput ) {

		this.accumMaterial = new MeshBasicNodeMaterial();
		this.accumMaterial.colorNode = ptOutput.get( 'gColor' );
		this.accumQuad = new QuadMesh( this.accumMaterial );

	}

	/**
	 * Create display material for final output
	 */
	_createDisplayMaterial() {

		// Use new TextureNode() if render target not ready (defensive programming)
		const displayTex = this.renderTargetA?.texture
			? texture( this.renderTargetA.texture )
			: new TextureNode();
		this.displayTexNode = displayTex;

		// Apply exposure in the display shader so it's reactive to uniform changes.
		// The renderer's toneMappingExposure is kept at 1.0 to avoid double-application;
		// ACES tone mapping still applies via material.toneMapped = true.
		const exposureUniform = this.exposure;

		const displayShader = Fn( () => {

			const color = displayTex.sample( uv() );
			const exposedColor = color.xyz.mul( exposureUniform.pow( 4.0 ) );
			return vec4( exposedColor, 1.0 );

		} );

		this.displayMaterial = new MeshBasicNodeMaterial();
		this.displayMaterial.colorNode = displayShader();
		this.displayMaterial.toneMapped = true;
		this.displayQuad = new QuadMesh( this.displayMaterial );

	}

	/**
	 * Create MRT materials for denoising G-buffer
	 * @param {Object} ptOutput
	 */
	_createMRTMaterials( ptOutput ) {

		this.normalDepthMaterial = new MeshBasicNodeMaterial();
		this.normalDepthMaterial.colorNode = ptOutput.get( 'gNormalDepth' );
		this.normalDepthQuad = new QuadMesh( this.normalDepthMaterial );

		this.albedoMaterial = new MeshBasicNodeMaterial();
		this.albedoMaterial.colorNode = ptOutput.get( 'gAlbedo' );
		this.albedoQuad = new QuadMesh( this.albedoMaterial );

		console.log( 'PathTracingStage: MRT shaders created' );

	}

	// ===== CORE RENDER METHOD =====

	/**
	 * Renders the path tracing pass with accumulation.
	 * @param {PipelineContext} context - Pipeline context
	 * @param {RenderTarget} writeBuffer - Output render target
	 */
	render( context, writeBuffer ) {

		if ( ! this.isReady ) return;

		// Early exit conditions
		if ( this.isComplete || this.frameCount >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor?.start();

		const frameValue = this.frameCount;
		const renderMode = this.renderMode.value;

		// Store original rendering parameters for first frame override in tile mode
		let originalMaxBounces = null;
		let originalSamplesPerPixel = null;

		// In tile rendering mode, cap the first frame at 1spp and 1 bounce
		if ( renderMode === 1 && frameValue === 0 ) {

			originalMaxBounces = this.maxBounces.value;
			originalSamplesPerPixel = this.samplesPerPixel.value;
			this.maxBounces.value = 1;
			this.samplesPerPixel.value = 1;

		}

		// Handle resize
		this._handleResize();

		// Handle ASVGF denoising
		this.manageASVGFForRenderMode( renderMode, frameValue );

		// Handle tile rendering
		const tileInfo = this.tileManager.handleTileRendering(
			this.renderer,
			renderMode,
			frameValue,
			null
		);

		// Publish tile state to context
		if ( context ) {

			context.setState( 'tileRenderingComplete', tileInfo.isCompleteCycle );

		}

		// Emit tile:changed event
		if ( tileInfo.tileIndex >= 0 ) {

			const tileBounds = this.tileManager.calculateTileBounds(
				tileInfo.tileIndex,
				this.tileManager.tiles,
				this.width,
				this.height
			);

			this.emit( 'tile:changed', {
				tileIndex: tileInfo.tileIndex,
				tileBounds: tileBounds,
				renderMode: renderMode
			} );

			this.tileChanged = true;

		}

		// Update camera and movement optimization
		this.cameraChanged = this._updateCameraUniforms();
		this.cameraOptimizer?.updateInteractionMode( this.cameraChanged );

		// Update accumulation state
		this._updateAccumulationUniforms( frameValue, renderMode );

		// Update frame uniform
		this.frame.value = frameValue;

		// Get targets
		const { readTarget, writeTarget } = this._getTargets();

		// Update previous frame texture
		if ( this.prevFrameTexNode ) {

			this.prevFrameTexNode.value = readTarget.texture;

		}

		// Render accumulation pass
		this.renderer.setRenderTarget( writeTarget );
		this.accumQuad.render( this.renderer );

		// Render MRT passes on first frame
		if ( this.enableMRT && frameValue === 0 ) {

			this._renderMRTPasses();

		}

		// Update display texture and render to screen
		if ( this.displayTexNode ) {

			this.displayTexNode.value = writeTarget.texture;

		}

		this.renderer.setRenderTarget( null );
		this.displayQuad.render( this.renderer );

		// Publish textures to context
		if ( context ) {

			this._publishTexturesToContext( context );

		}

		// Emit state events
		this._emitStateEvents();

		// Swap targets and increment
		if ( tileInfo.shouldSwapTargets ) {

			this.currentTarget = 1 - this.currentTarget;

		}

		this.frameCount ++;

		// Restore original values
		if ( originalMaxBounces !== null ) {

			this.maxBounces.value = originalMaxBounces;

		}

		if ( originalSamplesPerPixel !== null ) {

			this.samplesPerPixel.value = originalSamplesPerPixel;

		}

		this.performanceMonitor?.end();

	}

	/**
	 * Handle canvas resize
	 */
	_handleResize() {

		const canvas = this.renderer.domElement;
		const { width, height } = canvas;

		if ( width !== this.renderWidth || height !== this.renderHeight ) {

			this.createRenderTargets( width, height );
			this.frameCount = 0;

		}

		this.resolution.value.set( width, height );

	}

	/**
	 * Update camera uniforms
	 * @returns {boolean} True if camera changed
	 */
	_updateCameraUniforms() {

		if ( ! this.lastCameraMatrix.equals( this.camera.matrixWorld ) ||
			! this.lastProjectionMatrix.equals( this.camera.projectionMatrixInverse ) ) {

			this.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.cameraViewMatrix.value.copy( this.camera.matrixWorldInverse );
			this.cameraProjectionMatrix.value.copy( this.camera.projectionMatrix );
			this.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

			this.lastCameraMatrix.copy( this.camera.matrixWorld );
			this.lastProjectionMatrix.copy( this.camera.projectionMatrixInverse );

			return true;

		}

		return false;

	}

	/**
	 * Update accumulation uniforms
	 * @param {number} frameValue
	 * @param {number} renderMode
	 */
	_updateAccumulationUniforms( frameValue, renderMode ) {

		const currentInteractionMode = this.cameraOptimizer?.isInInteractionMode() ?? false;

		if ( currentInteractionMode !== this.lastInteractionModeState ) {

			this.lastInteractionModeState = currentInteractionMode;
			this.interactionModeChangeFrame = frameValue;

			if ( currentInteractionMode ) {

				this.hasPreviousAccumulated.value = 0;

			}

		}

		if ( this.accumulationEnabled ) {

			if ( currentInteractionMode ) {

				this.accumulationAlpha.value = 1.0;
				this.hasPreviousAccumulated.value = 0;

			} else {

				const effectiveFrame = frameValue - this.interactionModeChangeFrame;

				this.accumulationAlpha.value = PathTracerUtils.calculateAccumulationAlpha(
					Math.max( effectiveFrame, 0 ),
					renderMode,
					this.tileManager.totalTilesCache,
					false
				);

				this.hasPreviousAccumulated.value = ( effectiveFrame >= 0 && frameValue > 0 ) ? 1 : 0;

			}

		} else {

			this.accumulationAlpha.value = 1.0;
			this.hasPreviousAccumulated.value = 0;

		}

	}

	/**
	 * Get read and write targets for ping-pong
	 * @returns {Object} { readTarget, writeTarget }
	 */
	_getTargets() {

		const readTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;
		const writeTarget = this.currentTarget === 0 ? this.renderTargetB : this.renderTargetA;

		return { readTarget, writeTarget };

	}

	/**
	 * Render MRT passes for G-buffer
	 */
	_renderMRTPasses() {

		if ( ! this.normalDepthTarget || ! this.albedoTarget ) return;

		this.renderer.setRenderTarget( this.normalDepthTarget );
		this.normalDepthQuad.render( this.renderer );

		this.renderer.setRenderTarget( this.albedoTarget );
		this.albedoQuad.render( this.renderer );

	}

	/**
	 * Publish textures to pipeline context
	 * @param {PipelineContext} context
	 */
	_publishTexturesToContext( context ) {

		const textures = this.getMRTTextures();

		context.setTexture( 'pathtracer:color', textures.color );
		context.setTexture( 'pathtracer:normalDepth', textures.normalDepth );

		context.setState( 'interactionMode', this.cameraOptimizer?.isInInteractionMode() ?? false );
		context.setState( 'renderMode', this.renderMode.value );
		context.setState( 'tiles', this.tileManager.tiles );

	}

	/**
	 * Emit state change events
	 */
	_emitStateEvents() {

		this.emit( 'pathtracer:frameComplete', {
			frame: this.frameCount,
			isComplete: this.isComplete
		} );

		if ( this.cameraChanged ) {

			this.emit( 'camera:moved' );
			this.cameraChanged = false;

		}

	}

	/**
	 * Update completion threshold based on render mode
	 */
	updateCompletionThreshold() {

		const renderMode = this.renderMode.value;
		const maxFrames = this.maxSamples.value;

		if ( this.renderLimitMode === 'time' ) {

			this.completionThreshold = Infinity;

		} else {

			this.completionThreshold = PathTracerUtils.updateCompletionThreshold(
				renderMode,
				maxFrames,
				this.tileManager.totalTilesCache
			);

		}

	}

	setRenderLimitMode( mode ) {

		this.renderLimitMode = mode;
		this.updateCompletionThreshold();

	}

	// ===== ASVGF DENOISING MANAGEMENT =====

	manageASVGFForRenderMode( renderMode, frameValue ) {

		if ( renderMode !== this.lastRenderMode ) {

			if ( this.renderModeChangeTimeout ) {

				clearTimeout( this.renderModeChangeTimeout );

			}

			this.pendingRenderMode = renderMode;

			this.renderModeChangeTimeout = setTimeout( () => {

				if ( this.pendingRenderMode !== null && this.pendingRenderMode !== this.lastRenderMode ) {

					this.lastRenderMode = this.pendingRenderMode;
					this._onRenderModeChanged( this.pendingRenderMode );

				}

				this.renderModeChangeTimeout = null;
				this.pendingRenderMode = null;

			}, this.renderModeChangeDelay );

		}

		if ( renderMode === 1 ) {

			this._handleTiledASVGF( frameValue );

		} else {

			this._handleFullQuadASVGF();

		}

	}

	_onRenderModeChanged( newMode ) {

		if ( newMode === 1 ) {

			this.emit( 'asvgf:updateParameters', {
				enableDebug: false,
				temporalAlpha: 0.15
			} );

		} else {

			this.emit( 'asvgf:updateParameters', {
				temporalAlpha: 0.1,
			} );

		}

		this.emit( 'asvgf:reset' );

	}

	_handleTiledASVGF( frameValue ) {

		const isFirstFrame = frameValue === 0;
		const currentTileIndex = isFirstFrame ? - 1 : ( ( frameValue - 1 ) % this.tileManager.totalTilesCache );
		const isLastTileInSample = currentTileIndex === this.tileManager.totalTilesCache - 1;

		if ( isFirstFrame ) {

			this.emit( 'asvgf:setTemporal', { enabled: true } );

		} else if ( isLastTileInSample ) {

			this.emit( 'asvgf:setTemporal', { enabled: true } );
			this.tileCompletionFrame = frameValue;

		} else {

			this.emit( 'asvgf:setTemporal', { enabled: false } );

		}

	}

	_handleFullQuadASVGF() {

		this.emit( 'asvgf:setTemporal', { enabled: true } );

	}

	// ===== ENVIRONMENT MANAGEMENT =====

	/**
	 * Read pixels from a render target
	 * @param {RenderTarget} renderTarget
	 * @returns {Float32Array}
	 */
	readRenderTargetPixels( renderTarget ) {

		const width = renderTarget.width;
		const height = renderTarget.height;

		const pixels = new Float32Array( width * height * 4 );
		this.renderer.readRenderTargetPixels( renderTarget, 0, 0, width, height, pixels );

		return pixels;

	}

	async buildEnvironmentCDF() {

		if ( ! this.scene.environment ) {

			this.envMarginalWeights = null;
			this.envConditionalWeights = null;
			this.envTotalSum.value = 0.0;
			this.useEnvMapIS.value = 0;
			return;

		}

		try {

			const startTime = performance.now();
			let textureForCDF = this.scene.environment;

			if ( ! this.scene.environment.image || ! this.scene.environment.image.data ) {

				const isProceduralSky = this.proceduralSkyRenderer &&
					this.proceduralSkyRenderer.renderTarget &&
					this.proceduralSkyRenderer.renderTarget.texture === this.scene.environment;

				if ( isProceduralSky ) {

					console.log( 'Reading procedural sky pixels for importance sampling...' );
					const pixels = this.readRenderTargetPixels( this.proceduralSkyRenderer.renderTarget );

					textureForCDF = new DataTexture(
						pixels,
						this.proceduralSkyRenderer.renderTarget.width,
						this.proceduralSkyRenderer.renderTarget.height,
						RGBAFormat,
						FloatType
					);
					textureForCDF.needsUpdate = true;

				} else {

					this.envMarginalWeights = null;
					this.envConditionalWeights = null;
					this.envTotalSum.value = 0.0;
					this.useEnvMapIS.value = 0;
					return;

				}

			}

			this.equirectHdrInfo.updateFrom( textureForCDF );

			if ( textureForCDF !== this.scene.environment ) {

				textureForCDF.dispose();

			}

			this.cdfBuildTime = performance.now() - startTime;

			this.envMarginalWeights = this.equirectHdrInfo.marginalWeights;
			this.envConditionalWeights = this.equirectHdrInfo.conditionalWeights;
			this.envTotalSum.value = this.equirectHdrInfo.totalSum;
			this.useEnvMapIS.value = 1;

			const envMap = this.equirectHdrInfo.map;
			if ( envMap && envMap.image ) {

				this.envResolution.value.set( envMap.image.width, envMap.image.height );

			}

			console.log( `Environment CDF built in ${this.cdfBuildTime.toFixed( 2 )}ms` );

		} catch ( error ) {

			console.error( 'Error building environment CDF:', error );
			this.useEnvMapIS.value = 0;
			this.envTotalSum.value = 0.0;

		}

	}

	async setEnvironmentMap( envMap ) {

		this.scene.environment = envMap;
		this.setEnvironmentTexture( envMap );

		if ( envMap && this.renderer ) {

			this.renderer.initTexture( envMap );

		}

		if ( envMap && this.useEnvMapIS.value ) {

			await this.buildEnvironmentCDF();

		} else if ( ! envMap ) {

			this.envMarginalWeights = null;
			this.envConditionalWeights = null;
			this.envTotalSum.value = 0.0;
			this.useEnvMapIS.value = 0;

		}

		if ( envMap && ! envMap._isGeneratedProcedural ) {

			this.hasSun.value = 0;

		}

		this.reset();

	}

	setEnvironmentRotation( rotationDegrees ) {

		const rotationRadians = rotationDegrees * ( Math.PI / 180 );
		this.environmentRotationMatrix.makeRotationY( rotationRadians );
		this.environmentMatrix.value.copy( this.environmentRotationMatrix );

	}

	async generateGradientTexture() {

		if ( ! this.simpleSkyRenderer ) {

			try {

				this.simpleSkyRenderer = new SimpleSkyRenderer( 512, 256, this.renderer );

			} catch ( error ) {

				console.error( 'Failed to initialize SimpleSkyRenderer:', error );
				return;

			}

		}

		const params = {
			zenithColor: this.envParams.gradientZenithColor,
			horizonColor: this.envParams.gradientHorizonColor,
			groundColor: this.envParams.gradientGroundColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderGradient( params );

			if ( ! texture ) {

				console.error( 'Simple sky renderer returned null texture' );
				return;

			}

			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.hasSun.value = 0;

		} catch ( error ) {

			console.error( 'Error generating gradient sky:', error );

		}

	}

	async generateSolidColorTexture() {

		if ( ! this.simpleSkyRenderer ) {

			try {

				this.simpleSkyRenderer = new SimpleSkyRenderer( 512, 256, this.renderer );

			} catch ( error ) {

				console.error( 'Failed to initialize SimpleSkyRenderer:', error );
				return;

			}

		}

		const params = {
			color: this.envParams.solidSkyColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderSolid( params );

			if ( ! texture ) {

				console.error( 'Simple sky renderer returned null texture' );
				return;

			}

			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.hasSun.value = 0;

		} catch ( error ) {

			console.error( 'Error generating solid color sky:', error );

		}

	}

	async generateProceduralSkyTexture() {

		if ( ! this.proceduralSkyRenderer ) {

			try {

				this.proceduralSkyRenderer = new ProceduralSkyRenderer( 512, 256, this.renderer );

			} catch ( error ) {

				console.error( 'Failed to initialize ProceduralSkyRenderer:', error );
				return;

			}

		}

		const params = {
			sunDirection: this.envParams.skySunDirection.clone(),
			sunIntensity: this.envParams.skySunIntensity * 0.05,
			rayleighDensity: this.envParams.skyRayleighDensity * 2.0,
			mieDensity: this.envParams.skyTurbidity * 0.005,
			mieAnisotropy: this.envParams.skyMieAnisotropy,
			turbidity: this.envParams.skyTurbidity * 2.0,
		};

		try {

			const texture = this.proceduralSkyRenderer.render( params );

			if ( ! texture ) {

				console.error( 'Procedural sky renderer returned null texture' );
				return;

			}

			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );

			this.sunDirection.value.copy( this.envParams.skySunDirection );
			this.sunAngularSize.value = 0.0087;
			this.hasSun.value = 1;

			console.log( `Sun parameters synced: dir=${this.envParams.skySunDirection.toArray().map( v => v.toFixed( 2 ) ).join( ',' )}` );

		} catch ( error ) {

			console.error( 'Error generating procedural sky:', error );

		}

	}

	// ===== MATERIAL MANAGEMENT =====

	updateTextureTransform( materialIndex, textureName, transformMatrix ) {

		if ( ! this.materialTexture ) {

			console.warn( "Material texture not available" );
			return;

		}

		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const data = this.materialTexture.image.data;
		const stride = materialIndex * dataLengthPerMaterial;

		const transformOffsets = {
			'map': 52,
			'normalMap': 60,
			'roughnessMap': 68,
			'metalnessMap': 76,
			'emissiveMap': 84,
			'bumpMap': 92,
			'displacementMap': 100
		};

		const offset = transformOffsets[ textureName ];
		if ( offset === undefined ) {

			console.warn( `Unknown texture name for transform update: ${textureName}` );
			return;

		}

		for ( let i = 0; i < 9; i ++ ) {

			if ( stride + offset + i < data.length ) {

				data[ stride + offset + i ] = transformMatrix[ i ];

			}

		}

		this.materialTexture.needsUpdate = true;
		this.reset();

	}

	updateMaterial( materialIndex, material ) {

		const completeMaterialData = this.sdfs.geometryExtractor.createMaterialObject( material );
		this.updateMaterialDataFromObject( materialIndex, completeMaterialData );

	}

	updateMaterialProperty( materialIndex, property, value ) {

		const data = this.materialTexture.image.data;
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		switch ( property ) {

			case 'color':
				if ( value.r !== undefined ) {

					data[ stride + 0 ] = value.r;
					data[ stride + 1 ] = value.g;
					data[ stride + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 0 ] = value[ 0 ];
					data[ stride + 1 ] = value[ 1 ];
					data[ stride + 2 ] = value[ 2 ];

				}

				break;
			case 'metalness': data[ stride + 3 ] = value; break;
			case 'emissive':
				if ( value.r !== undefined ) {

					data[ stride + 4 ] = value.r;
					data[ stride + 5 ] = value.g;
					data[ stride + 6 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 4 ] = value[ 0 ];
					data[ stride + 5 ] = value[ 1 ];
					data[ stride + 6 ] = value[ 2 ];

				}

				break;
			case 'roughness': data[ stride + 7 ] = value; break;
			case 'ior': data[ stride + 8 ] = value; break;
			case 'transmission': data[ stride + 9 ] = value; break;
			case 'thickness': data[ stride + 10 ] = value; break;
			case 'emissiveIntensity': data[ stride + 11 ] = value; break;
			case 'attenuationColor':
				if ( value.r !== undefined ) {

					data[ stride + 12 ] = value.r;
					data[ stride + 13 ] = value.g;
					data[ stride + 14 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 12 ] = value[ 0 ];
					data[ stride + 13 ] = value[ 1 ];
					data[ stride + 14 ] = value[ 2 ];

				}

				break;
			case 'attenuationDistance': data[ stride + 15 ] = value; break;
			case 'dispersion': data[ stride + 16 ] = value; break;
			case 'visible': data[ stride + 17 ] = value; break;
			case 'sheen': data[ stride + 18 ] = value; break;
			case 'sheenRoughness': data[ stride + 19 ] = value; break;
			case 'sheenColor':
				if ( value.r !== undefined ) {

					data[ stride + 20 ] = value.r;
					data[ stride + 21 ] = value.g;
					data[ stride + 22 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 20 ] = value[ 0 ];
					data[ stride + 21 ] = value[ 1 ];
					data[ stride + 22 ] = value[ 2 ];

				}

				break;
			case 'specularIntensity': data[ stride + 24 ] = value; break;
			case 'specularColor':
				if ( value.r !== undefined ) {

					data[ stride + 25 ] = value.r;
					data[ stride + 26 ] = value.g;
					data[ stride + 27 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 25 ] = value[ 0 ];
					data[ stride + 26 ] = value[ 1 ];
					data[ stride + 27 ] = value[ 2 ];

				}

				break;
			case 'iridescence': data[ stride + 28 ] = value; break;
			case 'iridescenceIOR': data[ stride + 29 ] = value; break;
			case 'iridescenceThicknessRange':
				if ( Array.isArray( value ) ) {

					data[ stride + 30 ] = value[ 0 ];
					data[ stride + 31 ] = value[ 1 ];

				}

				break;
			case 'clearcoat': data[ stride + 38 ] = value; break;
			case 'clearcoatRoughness': data[ stride + 39 ] = value; break;
			case 'opacity': data[ stride + 40 ] = value; break;
			case 'side': data[ stride + 41 ] = value; break;
			case 'transparent': data[ stride + 42 ] = value; break;
			case 'alphaTest': data[ stride + 43 ] = value; break;
			case 'alphaMode': data[ stride + 44 ] = value; break;
			case 'depthWrite': data[ stride + 45 ] = value; break;
			case 'normalScale':
				if ( value.x !== undefined ) {

					data[ stride + 46 ] = value.x;
					data[ stride + 47 ] = value.y;

				} else if ( typeof value === 'number' ) {

					data[ stride + 46 ] = value;
					data[ stride + 47 ] = value;

				}

				break;
			case 'bumpScale': data[ stride + 48 ] = value; break;
			case 'displacementScale': data[ stride + 49 ] = value; break;
			default:
				console.warn( `Unknown material property: ${property}` );
				return;

		}

		this.materialTexture.needsUpdate = true;

		const featureProperties = [ 'transmission', 'clearcoat', 'sheen', 'iridescence', 'dispersion', 'transparent', 'opacity', 'alphaTest' ];
		if ( featureProperties.includes( property ) ) {

			const featuresChanged = this.rescanMaterialFeatures();
			if ( featuresChanged ) {

				this.injectMaterialFeatureDefines();

			}

		}

		this.reset();

	}

	updateMaterialDataFromObject( materialIndex, materialData ) {

		const data = this.materialTexture.image.data;
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		if ( materialData.color ) {

			data[ stride + 0 ] = materialData.color.r ?? materialData.color[ 0 ] ?? 1;
			data[ stride + 1 ] = materialData.color.g ?? materialData.color[ 1 ] ?? 1;
			data[ stride + 2 ] = materialData.color.b ?? materialData.color[ 2 ] ?? 1;

		}

		data[ stride + 3 ] = materialData.metalness ?? 0;

		if ( materialData.emissive ) {

			data[ stride + 4 ] = materialData.emissive.r ?? materialData.emissive[ 0 ] ?? 0;
			data[ stride + 5 ] = materialData.emissive.g ?? materialData.emissive[ 1 ] ?? 0;
			data[ stride + 6 ] = materialData.emissive.b ?? materialData.emissive[ 2 ] ?? 0;

		}

		data[ stride + 7 ] = materialData.roughness ?? 1;
		data[ stride + 8 ] = materialData.ior ?? 1.5;
		data[ stride + 9 ] = materialData.transmission ?? 0;
		data[ stride + 10 ] = materialData.thickness ?? 0.1;
		data[ stride + 11 ] = materialData.emissiveIntensity ?? 1;

		if ( materialData.attenuationColor ) {

			data[ stride + 12 ] = materialData.attenuationColor.r ?? materialData.attenuationColor[ 0 ] ?? 1;
			data[ stride + 13 ] = materialData.attenuationColor.g ?? materialData.attenuationColor[ 1 ] ?? 1;
			data[ stride + 14 ] = materialData.attenuationColor.b ?? materialData.attenuationColor[ 2 ] ?? 1;

		}

		data[ stride + 15 ] = materialData.attenuationDistance ?? Infinity;
		data[ stride + 16 ] = materialData.dispersion ?? 0;
		data[ stride + 17 ] = materialData.visible ?? 1;
		data[ stride + 18 ] = materialData.sheen ?? 0;
		data[ stride + 19 ] = materialData.sheenRoughness ?? 1;

		if ( materialData.sheenColor ) {

			data[ stride + 20 ] = materialData.sheenColor.r ?? materialData.sheenColor[ 0 ] ?? 0;
			data[ stride + 21 ] = materialData.sheenColor.g ?? materialData.sheenColor[ 1 ] ?? 0;
			data[ stride + 22 ] = materialData.sheenColor.b ?? materialData.sheenColor[ 2 ] ?? 0;

		}

		data[ stride + 24 ] = materialData.specularIntensity ?? 1;

		if ( materialData.specularColor ) {

			data[ stride + 25 ] = materialData.specularColor.r ?? materialData.specularColor[ 0 ] ?? 1;
			data[ stride + 26 ] = materialData.specularColor.g ?? materialData.specularColor[ 1 ] ?? 1;
			data[ stride + 27 ] = materialData.specularColor.b ?? materialData.specularColor[ 2 ] ?? 1;

		}

		data[ stride + 28 ] = materialData.iridescence ?? 0;
		data[ stride + 29 ] = materialData.iridescenceIOR ?? 1.3;

		if ( materialData.iridescenceThicknessRange ) {

			data[ stride + 30 ] = materialData.iridescenceThicknessRange[ 0 ] ?? 100;
			data[ stride + 31 ] = materialData.iridescenceThicknessRange[ 1 ] ?? 400;

		}

		data[ stride + 32 ] = materialData.map ?? - 1;
		data[ stride + 33 ] = materialData.normalMap ?? - 1;
		data[ stride + 34 ] = materialData.roughnessMap ?? - 1;
		data[ stride + 35 ] = materialData.metalnessMap ?? - 1;
		data[ stride + 36 ] = materialData.emissiveMap ?? - 1;
		data[ stride + 37 ] = materialData.bumpMap ?? - 1;

		data[ stride + 38 ] = materialData.clearcoat ?? 0;
		data[ stride + 39 ] = materialData.clearcoatRoughness ?? 0;
		data[ stride + 40 ] = materialData.opacity ?? 1;
		data[ stride + 41 ] = materialData.side ?? 0;
		data[ stride + 42 ] = materialData.transparent ?? 0;
		data[ stride + 43 ] = materialData.alphaTest ?? 0;

		data[ stride + 46 ] = materialData.normalScale ?? 1;
		data[ stride + 48 ] = materialData.bumpScale ?? 1;
		data[ stride + 49 ] = materialData.displacementScale ?? 1;
		data[ stride + 50 ] = materialData.displacementMap ?? - 1;

		this.materialTexture.needsUpdate = true;

		const featuresChanged = this.rescanMaterialFeatures();
		if ( featuresChanged ) {

			this.injectMaterialFeatureDefines();

		}

		this.reset();

	}

	updateMaterialDataTexture( materialIndex, property, value ) {

		this.updateMaterialProperty( materialIndex, property, value );

	}

	rebuildMaterialDataTexture( materialIndex, material ) {

		this.updateMaterial( materialIndex, material );

	}

	// ===== UNIFORM SETTERS =====

	setMaxBounces( bounces ) {

		this.maxBounces.value = bounces;

	}

	setSamplesPerPixel( samples ) {

		this.samplesPerPixel.value = samples;

	}

	setMaxSamples( samples ) {

		this.maxSamples.value = samples;

	}

	setTransmissiveBounces( bounces ) {

		this.transmissiveBounces.value = bounces;

	}

	setEnvironmentIntensity( intensity ) {

		this.environmentIntensity.value = intensity;

	}

	setBackgroundIntensity( intensity ) {

		this.backgroundIntensity.value = intensity;

	}

	setShowBackground( show ) {

		this.showBackground.value = show ? 1 : 0;

	}

	setEnableEnvironment( enable ) {

		this.enableEnvironment.value = enable ? 1 : 0;

	}

	setGlobalIlluminationIntensity( intensity ) {

		this.globalIlluminationIntensity.value = intensity;

	}

	setExposure( exposure ) {

		this.exposure.value = exposure;

	}

	setEnvironmentMatrix( matrix ) {

		this.environmentMatrix.value.copy( matrix );

	}

	setEnableAccumulation( enable ) {

		this.enableAccumulation.value = enable ? 1 : 0;

	}

	setAccumulationAlpha( alpha ) {

		this.accumulationAlpha.value = alpha;

	}

	setCameraIsMoving( moving ) {

		this.cameraIsMoving.value = moving ? 1 : 0;

	}

	setHasPreviousAccumulated( has ) {

		this.hasPreviousAccumulated.value = has ? 1 : 0;

	}

	setTotalTriangleCount( count ) {

		this.totalTriangleCount.value = count;

	}

	setVisMode( mode ) {

		this.visMode.value = mode;

	}

	setDebugVisScale( scale ) {

		this.debugVisScale.value = scale;

	}

	setEnableDOF( enable ) {

		this.enableDOF.value = enable ? 1 : 0;

	}

	setFocusDistance( distance ) {

		this.focusDistance.value = distance;

	}

	setFocalLength( length ) {

		this.focalLength.value = length;

	}

	setAperture( aperture ) {

		this.aperture.value = aperture;

	}

	setApertureScale( scale ) {

		this.apertureScale.value = scale;

	}

	setSceneScale( scale ) {

		this.sceneScale.value = scale;

	}

	setSamplingTechnique( technique ) {

		this.samplingTechnique.value = technique;

	}

	setUseAdaptiveSampling( use ) {

		this.useAdaptiveSampling.value = use ? 1 : 0;

	}

	setAdaptiveSamplingMax( max ) {

		this.adaptiveSamplingMax.value = max;

	}

	setFireflyThreshold( threshold ) {

		this.fireflyThreshold.value = threshold;

	}

	setEnableEmissiveTriangleSampling( enable ) {

		this.enableEmissiveTriangleSampling.value = enable ? 1 : 0;

	}

	setEmissiveBoost( boost ) {

		this.emissiveBoost.value = boost;

	}

	setEmissiveTriangleCount( count ) {

		this.emissiveTriangleCount.value = count;

	}

	setUseEnvMapIS( use ) {

		this.useEnvMapIS.value = use ? 1 : 0;

	}

	setEnvMarginalWeights( tex ) {

		this.envMarginalWeights = tex;

	}

	setEnvConditionalWeights( tex ) {

		this.envConditionalWeights = tex;

	}

	setEnvTotalSum( sum ) {

		this.envTotalSum.value = sum;

	}

	setEnvResolution( width, height ) {

		this.envResolution.value.set( width, height );

	}

	setSunDirection( direction ) {

		this.sunDirection.value.copy( direction );

	}

	setSunAngularSize( size ) {

		this.sunAngularSize.value = size;

	}

	setHasSun( hasSun ) {

		this.hasSun.value = hasSun ? 1 : 0;

	}

	setDirectionalLights( lights ) {

		this.directionalLightsData = lights;

	}

	setPointLights( lights ) {

		this.pointLightsData = lights;

	}

	setSpotLights( lights ) {

		this.spotLightsData = lights;

	}

	setAreaLights( lights ) {

		this.areaLightsData = lights;

	}

	setBlueNoiseTexture( tex ) {

		this.blueNoiseTexture = tex;
		// Update the shared Random.js texture node so TSL shader graph uses the real texture
		if ( tex ) blueNoiseTextureNode.value = tex;
		if ( tex?.image ) {

			this.blueNoiseTextureSize.value.set( tex.image.width, tex.image.height );

		}

	}

	setEmissiveTriangleTexture( tex ) {

		this.emissiveTriangleTexture = tex;
		if ( tex?.image ) {

			this.emissiveTriangleTexSize.value.set( tex.image.width, tex.image.height );

		}

	}

	setAdaptiveSamplingTexture( tex ) {

		this.adaptiveSamplingTexture = tex;

	}

	setMaterialTextures( textures ) {

		if ( textures.albedoMaps ) this.albedoMaps = textures.albedoMaps;
		if ( textures.emissiveMaps ) this.emissiveMaps = textures.emissiveMaps;
		if ( textures.normalMaps ) this.normalMaps = textures.normalMaps;
		if ( textures.bumpMaps ) this.bumpMaps = textures.bumpMaps;
		if ( textures.roughnessMaps ) this.roughnessMaps = textures.roughnessMaps;
		if ( textures.metalnessMaps ) this.metalnessMaps = textures.metalnessMaps;
		if ( textures.displacementMaps ) this.displacementMaps = textures.displacementMaps;

	}

	setRenderMode( mode ) {

		this.renderMode.value = mode;

	}

	setSpheres( spheres ) {

		this.spheres = spheres;

	}

	// ===== UTILITY METHODS =====

	updateUniforms( updates ) {

		let hasChanges = false;

		for ( const [ key, value ] of Object.entries( updates ) ) {

			if ( this[ key ] && this[ key ].value !== undefined ) {

				if ( this[ key ].value !== value ) {

					this[ key ].value = value;
					hasChanges = true;

				}

			}

		}

		if ( hasChanges ) {

			this.reset();

		}

	}

	async rebuildMaterials( scene ) {

		if ( ! this.sdfs ) {

			throw new Error( "Scene not built yet. Call build() first." );

		}

		try {

			console.log( 'PathTracingStage: Starting material rebuild...' );

			await this.sdfs.rebuildMaterials( scene );
			this.updateSceneUniforms();
			this.updateLights();
			this.reset();

			console.log( 'PathTracingStage materials rebuilt successfully' );

		} catch ( error ) {

			console.error( 'Error rebuilding PathTracingStage materials:', error );

			try {

				console.warn( 'Attempting recovery by resetting path tracer...' );
				this.reset();

			} catch ( recoveryError ) {

				console.error( 'Recovery failed:', recoveryError );

			}

			throw error;

		}

	}

	// ===== DISPOSE =====

	/**
	 * Disposes of GPU resources.
	 */
	dispose() {

		// Clean up scissor state
		if ( this.tileManager?.scissorEnabled ) {

			this.tileManager.disableScissor( this.renderer );

		}

		// Clear timeouts
		if ( this.renderModeChangeTimeout ) {

			clearTimeout( this.renderModeChangeTimeout );
			this.renderModeChangeTimeout = null;

		}

		// Dispose managers
		this.tileManager?.dispose();
		this.cameraOptimizer?.dispose();

		// Dispose materials
		this.accumMaterial?.dispose();
		this.displayMaterial?.dispose();
		this.normalDepthMaterial?.dispose();
		this.albedoMaterial?.dispose();

		// Dispose render targets
		this._disposeRenderTargets();

		// Dispose textures
		this.blueNoiseTexture?.dispose();
		this.placeholderTexture?.dispose();

		// Clear texture references
		this.triangleTexture = null;
		this.bvhTexture = null;
		this.materialTexture = null;
		this.environmentTexture = null;
		this.placeholderTexture = null;

		// Dispose environment
		this.equirectHdrInfo?.dispose();
		this.proceduralSkyRenderer?.dispose?.();
		this.simpleSkyRenderer?.dispose?.();

		// Clear texture nodes
		this.prevFrameTexNode = null;
		this.displayTexNode = null;

		this.isReady = false;

	}

}
