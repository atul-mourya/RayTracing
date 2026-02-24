import { WebGPURenderer } from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
	ACESFilmicToneMapping, PerspectiveCamera, Scene, EventDispatcher,
	DirectionalLight, PointLight, SpotLight, RectAreaLight, Object3D, MathUtils, Color
} from 'three';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import Stats from 'stats-gl';
import { PathTracingStage } from './Stages/PathTracingStage.js';
import { NormalDepthStage } from './Stages/NormalDepthStage.js';
import { WebGPUMotionVectorStage } from './Stages/WebGPUMotionVectorStage.js';
import { WebGPUASVGFStage } from './Stages/WebGPUASVGFStage.js';
import { WebGPUVarianceEstimationStage } from './Stages/WebGPUVarianceEstimationStage.js';
import { WebGPUBilateralFilteringStage } from './Stages/WebGPUBilateralFilteringStage.js';
import { AdaptiveSamplingStage } from './Stages/AdaptiveSamplingStage.js';
import { WebGPUEdgeAwareFilteringStage } from './Stages/WebGPUEdgeAwareFilteringStage.js';
import { WebGPUAutoExposureStage } from './Stages/WebGPUAutoExposureStage.js';
import { WebGPUTileHighlightStage } from './Stages/WebGPUTileHighlightStage.js';
import { DisplayStage } from './Stages/DisplayStage.js';
import { PassPipeline } from '../Pipeline/PassPipeline.js';
import { DataTransfer } from './DataTransfer.js';
import { DEFAULT_STATE } from '../../Constants.js';
import { WebGPUFeatures } from './WebGPUFeatures.js';
import { updateStats } from '../Processor/utils.js';
import InteractionManager from '../InteractionManager.js';
import { OIDNDenoiser } from '../Passes/OIDNDenoiser.js';
import { useStore } from '@/store';

// Resolution index to pixel values mapping (same as main app)
const TARGET_RESOLUTIONS = { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 };

/**
 * WebGPU Path Tracer Application.
 * Full path tracing implementation using WebGPU and TSL.
 *
 * Extends EventDispatcher for event-driven communication with stores/UI,
 * matching the same interface contract as the WebGL PathTracerApp.
 *
 * Can be initialized standalone or with a reference to an existing
 * PathTracerApp to share scene data.
 */
export class WebGPUPathTracerApp extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {PathTracerApp} existingApp - Optional existing app for data sharing
	 */
	constructor( canvas, denoiserCanvas = null, existingApp = null ) {

		super();

		this.canvas = canvas;
		this.denoiserCanvas = denoiserCanvas;
		this.existingApp = existingApp;

		// Expose the WebGL app's assetLoader so UI code (drag-drop, menu bar)
		// can load assets regardless of which backend is active
		this.assetLoader = existingApp?.assetLoader || null;

		// Core objects
		this.renderer = null;
		this.camera = null;
		this.scene = null;
		this.controls = null;

		// Stages
		this.pathTracingStage = null;

		// State
		this.isInitialized = false;
		this.pauseRendering = false;
		this.animationId = null;
		this.needsReset = false;
		this._renderCompleteDispatched = false;
		this.denoiser = null;

		// Stats tracking
		this.lastResetTime = performance.now();
		this.timeElapsed = 0;

		// Feature support map — sourced from centralized WebGPU feature registry
		this._supportedFeatures = { ...WebGPUFeatures };

		// Resolution settings
		this.targetResolution = existingApp?.targetResolution ?? DEFAULT_STATE.resolution ?? 3;

		// Settings - matching WebGL PathTracerStage uniforms
		this.maxBounces = DEFAULT_STATE.bounces ?? 4;
		this.samplesPerPixel = DEFAULT_STATE.samplesPerPixel ?? 1;
		this.maxSamples = DEFAULT_STATE.maxSamples ?? 2048;
		this.transmissiveBounces = DEFAULT_STATE.transmissiveBounces ?? 10;
		this.environmentIntensity = DEFAULT_STATE.environmentIntensity ?? 1.0;
		this.backgroundIntensity = DEFAULT_STATE.backgroundIntensity ?? 1.0;
		this.showBackground = DEFAULT_STATE.showBackground ?? true;
		this.enableEnvironment = DEFAULT_STATE.enableEnvironment ?? true;
		this.globalIlluminationIntensity = DEFAULT_STATE.globalIlluminationIntensity ?? 1.0;
		this.exposure = DEFAULT_STATE.exposure ?? 1.0;

		// Camera & DOF settings
		this.enableDOF = DEFAULT_STATE.enableDOF ?? false;
		this.focusDistance = DEFAULT_STATE.focusDistance ?? 5.0;
		this.focalLength = DEFAULT_STATE.focalLength ?? 50.0;
		this.aperture = DEFAULT_STATE.aperture ?? 0.0;
		this.apertureScale = 1.0;
		this.currentCameraIndex = 0;

		// Sampling settings
		this.samplingTechnique = DEFAULT_STATE.samplingTechnique ?? 0;
		this.useAdaptiveSampling = DEFAULT_STATE.adaptiveSampling ?? false;
		this.adaptiveSamplingMax = DEFAULT_STATE.adaptiveSamplingMax ?? 32;
		this.fireflyThreshold = DEFAULT_STATE.fireflyThreshold ?? 10.0;

		// Emissive settings
		this.enableEmissiveTriangleSampling = DEFAULT_STATE.enableEmissiveTriangleSampling ?? true;
		this.emissiveBoost = DEFAULT_STATE.emissiveBoost ?? 1.0;

		// Debug settings
		this.visMode = DEFAULT_STATE.debugMode ?? 0;
		this.debugVisScale = DEFAULT_STATE.debugVisScale ?? 1.0;

		// Render limit settings
		this.renderLimitMode = DEFAULT_STATE.renderLimitMode;
		this.renderTimeLimit = DEFAULT_STATE.renderTimeLimit;

	}

	/**
	 * Initializes the WebGPU renderer and related objects.
	 */
	async init() {

		// Check WebGPU support
		if ( ! navigator.gpu ) {

			throw new Error( 'WebGPU is not supported in this browser' );

		}

		// Create and initialize WebGPU renderer
		this.renderer = new WebGPURenderer( {
			canvas: this.canvas,
			powerPreference: 'high-performance',
			requiredLimits: {
				maxBufferSize: 512 * 1024 * 1024,
				maxStorageBufferBindingSize: 512 * 1024 * 1024,
			}
		} );

		window.renderer = this.renderer; // For debugging
		// this.renderer.inspector = new Inspector();

		await this.renderer.init();

		// Set tone mapping to match WebGL renderer
		// Exposure is applied in the display shader via TSL uniform, so
		// keep toneMappingExposure at 1.0 to avoid double-application.
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;

		// Calculate pixel ratio
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		const targetRes = TARGET_RESOLUTIONS[ this.targetResolution ] || 512;
		const shortestDim = Math.min( width, height ) || 512;
		this.renderer.setPixelRatio( targetRes / shortestDim );

		// Setup camera
		if ( this.existingApp?.camera ) {

			this.camera = this.existingApp.camera.clone();
			DataTransfer.copyCameraSettings( this.existingApp, this.camera );

		} else {

			this.camera = new PerspectiveCamera( 65, 1, 0.01, 1000 );
			this.camera.position.set( 0, 0, 5 );

		}

		// Create scene
		this.scene = new Scene();

		// Setup orbit controls
		this.controls = new OrbitControls( this.camera, this.canvas );
		// this.controls.enableDamping = true;
		// this.controls.dampingFactor = 0.05;
		this.controls.screenSpacePanning = true;

		// Sync controls target from existing WebGL app (the default model
		// was already loaded and centered during WebGL init, but the new
		// OrbitControls defaults its target to the origin)
		if ( this.existingApp?.controls?.target ) {

			this.controls.target.copy( this.existingApp.controls.target );
			this.controls.maxDistance = this.existingApp.controls.maxDistance;

		}

		// Save initial state so controls.reset() works
		this.controls.saveState();

		// Track camera movement for reset
		this.controls.addEventListener( 'change', () => {

			this.needsReset = true;

		} );

		// Create pipeline stages
		this.pathTracingStage = new PathTracingStage( this.renderer, this.scene, this.camera );
		this.normalDepthStage = new NormalDepthStage( this.renderer, {
			pathTracingStage: this.pathTracingStage
		} );
		this.motionVectorStage = new WebGPUMotionVectorStage( this.renderer, this.camera, {
			pathTracingStage: this.pathTracingStage
		} );
		this.asvgfStage = new WebGPUASVGFStage( this.renderer, { enabled: false } );
		this.varianceEstimationStage = new WebGPUVarianceEstimationStage( this.renderer, { enabled: false } );
		this.bilateralFilteringStage = new WebGPUBilateralFilteringStage( this.renderer, { enabled: false } );
		this.adaptiveSamplingStage = new AdaptiveSamplingStage( this.renderer, {
			adaptiveSamplingMax: this.adaptiveSamplingMax,
			enabled: this.useAdaptiveSampling,
		} );
		this.edgeFilteringStage = new WebGPUEdgeAwareFilteringStage( this.renderer, { enabled: false } );
		this.autoExposureStage = new WebGPUAutoExposureStage( this.renderer, { enabled: false } );
		this.tileHighlightStage = new WebGPUTileHighlightStage( this.renderer, { enabled: false } );

		// Outline effect — uses the WebGL scene (which holds actual meshes) for
		// depth/mask rasterisation, matching WebGL OutlinePass defaults exactly.
		const outlineScene = this.existingApp?.scene || this.scene;
		this.outlineNode = outline( outlineScene, this.camera, {
			selectedObjects: [],
			edgeThickness: uniform( 1.0 ),
			edgeGlow: uniform( 0.0 ),
		} );

		// Fixed-resolution outline: OutlineNode auto-sizes from renderer's
		// drawing buffer each frame, but the renderer runs at path-tracer
		// resolution. Override setSize so the outline always renders at the
		// display's native DPR — matching WebGL's updateFixedPassResolution().
		const outlineCanvas = this.canvas;
		const outlineSetSize = this.outlineNode.setSize.bind( this.outlineNode );
		this.outlineNode.setSize = () => {

			const dpr = window.devicePixelRatio;
			outlineSetSize(
				Math.round( outlineCanvas.clientWidth * dpr ),
				Math.round( outlineCanvas.clientHeight * dpr )
			);

		};

		const edgeStrength = uniform( 3.0 );
		const visibleEdgeColor = uniform( new Color( 0xffffff ) );
		const hiddenEdgeColor = uniform( new Color( 0x190a05 ) );
		const { visibleEdge, hiddenEdge } = this.outlineNode;
		const outlineColorNode = visibleEdge.mul( visibleEdgeColor )
			.add( hiddenEdge.mul( hiddenEdgeColor ) )
			.mul( edgeStrength );

		this.displayStage = new DisplayStage( this.renderer, {
			exposure: this.exposure,
			outlineColorNode
		} );

		// Expose stages with WebGL-compatible property names so store handlers work
		this.asvgfPass = this.asvgfStage;
		this.varianceEstimationPass = this.varianceEstimationStage;
		this.bilateralFilteringPass = this.bilateralFilteringStage;
		this.edgeAwareFilterPass = this.edgeFilteringStage;
		this.autoExposurePass = this.autoExposureStage;
		this.tileHighlightPass = this.tileHighlightStage;

		// Pipeline orchestration (reuses WebGL's PassPipeline — it's renderer-agnostic)
		// Stage order matters: each stage reads textures published by prior stages.
		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new PassPipeline( this.renderer, w || 1, h || 1 );
		this.pipeline.addStage( this.pathTracingStage );
		this.pipeline.addStage( this.normalDepthStage );
		this.pipeline.addStage( this.motionVectorStage );
		this.pipeline.addStage( this.asvgfStage );
		this.pipeline.addStage( this.varianceEstimationStage );
		this.pipeline.addStage( this.bilateralFilteringStage );
		this.pipeline.addStage( this.adaptiveSamplingStage );
		this.pipeline.addStage( this.edgeFilteringStage );
		this.pipeline.addStage( this.autoExposureStage );
		this.pipeline.addStage( this.tileHighlightStage );
		this.pipeline.addStage( this.displayStage );

		// Set initial render dimensions so stage render targets aren't stuck at 1x1
		// (canvas may be hidden initially in dual-canvas model, so guard against 0)
		const initRenderW = Math.round( width * ( targetRes / shortestDim ) ) || 1;
		const initRenderH = Math.round( height * ( targetRes / shortestDim ) ) || 1;
		this.pipeline.setSize( initRenderW, initRenderH );

		// Initialize interaction manager for click-to-select
		// Use the WebGL app's scene for raycasting (WebGPU scene doesn't contain mesh objects)
		const raycastScene = this.existingApp?.scene || this.scene;
		this.interactionManager = new InteractionManager( {
			scene: raycastScene,
			camera: this.camera,
			canvas: this.canvas,
			assetLoader: this.existingApp?.assetLoader || null,
			pathTracingPass: null,
			floorPlane: this.existingApp?.floorPlane || null
		} );
		this.setupInteractionListeners();

		// Set up auto-exposure event listener to update store in real-time
		this.setupAutoExposureListener();

		// Initialize OIDN denoiser
		this._setupDenoiser();

		// Handle resize
		this.onResize();
		this.resizeHandler = () => this.onResize();
		window.addEventListener( 'resize', this.resizeHandler );

		// Listen for asset loads on the shared assetLoader so that when a model
		// or environment is loaded (via drag-drop, menu, URL import, etc.) while
		// WebGPU is active, we automatically sync the new data from WebGL.
		if ( this.assetLoader ) {

			this._onAssetLoaded = async ( event ) => {

				// Skip if loadModel/loadExampleModels is already handling
				// this load (they await the WebGL load and sync afterwards)
				if ( this._loadingInProgress ) return;

				// Model load — sync camera framing and full scene data
				if ( event.model ) {

					console.log( '[WebGPU] Model loaded in WebGL, syncing scene data...' );
					this.syncCameraFromWebGL();
					await this.loadSceneData();

				} else if ( event.texture ) {

					// Environment load — re-transfer texture and rebuild CDF
					console.log( '[WebGPU] Environment loaded in WebGL, syncing...' );
					const environmentTexture = DataTransfer.getEnvironmentTexture( this.existingApp );
					if ( environmentTexture && this.pathTracingStage ) {

						await this.pathTracingStage.setEnvironmentMap( environmentTexture );

					}

				}

				this.pauseRendering = false;
				this.reset();

			};

			this.assetLoader.addEventListener( 'load', this._onAssetLoaded );

		}

		// Setup stats panel
		this.initStats();

		this.isInitialized = true;

		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

	}

	initStats() {

		this.stats = new Stats( { horizontal: true, trackGPU: true } );
		this.stats.dom.style.position = 'absolute';
		this.stats.dom.style.top = 'unset';
		this.stats.dom.style.bottom = '48px';

		this.stats.init( this.renderer );
		this.canvas.parentElement.parentElement.parentElement.appendChild( this.stats.dom );

		const foregroundColor = '#ffffff';
		const backgroundColor = '#1e293b';

		const gradient = this.stats.fpsPanel.context.createLinearGradient( 0, this.stats.fpsPanel.GRAPH_Y, 0, this.stats.fpsPanel.GRAPH_Y + this.stats.fpsPanel.GRAPH_HEIGHT );
		gradient.addColorStop( 0, foregroundColor );

		this.stats.fpsPanel.fg = this.stats.msPanel.fg = foregroundColor;
		this.stats.fpsPanel.bg = this.stats.msPanel.bg = backgroundColor;
		this.stats.fpsPanel.gradient = this.stats.msPanel.gradient = gradient;

		if ( this.stats.gpuPanel ) {

			this.stats.gpuPanel.fg = foregroundColor;
			this.stats.gpuPanel.bg = backgroundColor;
			this.stats.gpuPanel.gradient = gradient;

		}

		// WebGPU starts hidden since WebGL is the default backend
		this.stats.dom.style.display = 'none';

	}

	/**
	 * Sets up event listeners for interaction manager events.
	 */
	setupInteractionListeners() {

		if ( ! this.interactionManager ) return;

		// Object selection events
		this.interactionManager.addEventListener( 'objectSelected', ( event ) => {

			this.selectObject( event.object );
			this.reset();

			this.dispatchEvent( {
				type: 'objectSelected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		this.interactionManager.addEventListener( 'objectDeselected', ( event ) => {

			this.selectObject( null );
			this.reset();

			this.dispatchEvent( {
				type: 'objectDeselected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		this.interactionManager.addEventListener( 'objectDoubleClicked', ( event ) => {

			this.selectObject( event.object );
			this.reset();

			useStore.getState().setActiveTab( 'material' );

			this.dispatchEvent( {
				type: 'objectDoubleClicked',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		// Focus mode events
		this.interactionManager.addEventListener( 'focusChanged', ( event ) => {

			this.setFocusDistance( event.worldDistance );

			this.dispatchEvent( {
				type: 'focusChanged',
				distance: event.distance
			} );

		} );

	}

	/**
	 * Set up event listener for auto-exposure updates.
	 * Updates the store when exposure values change for UI display,
	 * and applies the computed exposure to renderer.toneMappingExposure.
	 */
	setupAutoExposureListener() {

		if ( ! this.autoExposureStage ) return;

		import( '@/store' ).then( ( { usePathTracerStore } ) => {

			this.autoExposureStage.on( 'autoexposure:updated', ( data ) => {

				const { exposure, luminance } = data;

				usePathTracerStore.getState().setCurrentAutoExposure( exposure );
				usePathTracerStore.getState().setCurrentAvgLuminance( luminance );

			} );

		} );

	}

	/**
	 * Initializes the OIDN denoiser for the WebGPU backend.
	 */
	_setupDenoiser() {

		if ( ! this.denoiserCanvas ) return;

		this.denoiser = new OIDNDenoiser( this.denoiserCanvas, this.renderer, this.scene, this.camera, {
			...DEFAULT_STATE,
			// MRT albedo rendering is not yet enabled in WebGPU PathTracingStage
			// (enableMRT = false due to WGSL compilation issues), so disable G-buffer
			// for OIDN. When MRT is re-enabled, flip this to true.
			useGBuffer: false,
			extractGBufferData: async ( width, height ) => {

				const albedoRT = this.pathTracingStage?.albedoTarget;
				const normalRT = this.normalDepthStage?.renderTarget;
				if ( ! albedoRT || ! normalRT ) return null;

				const [ albedoPixels, normalPixels ] = await Promise.all( [
					this.renderer.readRenderTargetPixelsAsync( albedoRT, 0, 0, width, height ),
					this.renderer.readRenderTargetPixelsAsync( normalRT, 0, 0, width, height )
				] );

				const pixelCount = width * height * 4;
				const albedoData = new ImageData( width, height );
				const normalData = new ImageData( width, height );

				for ( let i = 0; i < pixelCount; i += 4 ) {

					// Albedo: Float32 [0,1] → Uint8 [0,255]
					albedoData.data[ i ] = Math.min( albedoPixels[ i ] * 255, 255 ) | 0;
					albedoData.data[ i + 1 ] = Math.min( albedoPixels[ i + 1 ] * 255, 255 ) | 0;
					albedoData.data[ i + 2 ] = Math.min( albedoPixels[ i + 2 ] * 255, 255 ) | 0;
					albedoData.data[ i + 3 ] = 255;

					// Normals: stored as (N * 0.5 + 0.5), decode to match WebGL encoding
					normalData.data[ i ] = ( normalPixels[ i ] * 255 - 127.5 ) | 0;
					normalData.data[ i + 1 ] = ( normalPixels[ i + 1 ] * 255 - 127.5 ) | 0;
					normalData.data[ i + 2 ] = ( normalPixels[ i + 2 ] * 255 - 127.5 ) | 0;
					normalData.data[ i + 3 ] = 255;

				}

				return { albedo: albedoData, normal: normalData };

			}
		} );

		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Sync denoiser state with store
		this.denoiser.addEventListener( 'start', () => useStore.getState().setIsDenoising( true ) );
		this.denoiser.addEventListener( 'end', () => useStore.getState().setIsDenoising( false ) );

	}

	/**
	 * Clones Three.js light objects from the WebGL scene into the WebGPU scene,
	 * then updates the PathTracingStage light uniform buffers.
	 */
	_transferSceneLights() {

		if ( ! this.existingApp ) return;

		const sourceLights = DataTransfer.getSceneLights( this.existingApp );

		if ( sourceLights.length === 0 ) {

			// No scene lights — still call updateLights to process procedural sky sun
			this.updateLights();
			return;

		}

		// Clone each light into the WebGPU scene with world transforms
		// Lights may be nested in the model hierarchy (e.g. children of placeholder meshes),
		// so we must bake their world transform before adding to scene root.
		for ( const light of sourceLights ) {

			const cloned = light.clone();

			// Ensure source matrixWorld is up to date
			light.updateWorldMatrix( true, false );

			// Bake world transform into the clone (since it goes to scene root)
			light.getWorldPosition( cloned.position );
			light.getWorldQuaternion( cloned.quaternion );
			light.getWorldScale( cloned.scale );

			// SpotLights need their target transferred with world position
			if ( light.isSpotLight && light.target ) {

				const clonedTarget = new Object3D();
				light.target.updateWorldMatrix( true, false );
				light.target.getWorldPosition( clonedTarget.position );
				this.scene.add( clonedTarget );
				cloned.target = clonedTarget;

			}

			this.scene.add( cloned );

		}

		// Process the cloned lights into uniform buffer arrays
		this.updateLights();

		console.log( `[WebGPUPathTracerApp] Transferred ${sourceLights.length} lights from WebGL scene` );

	}

	/**
	 * Loads scene data from the existing PathTracerApp.
	 *
	 * @returns {boolean} True if data was loaded successfully
	 */
	async loadSceneData() {

		if ( ! this.existingApp ) {

			console.warn( 'WebGPUPathTracerApp: No existing app to load data from' );
			return false;

		}

		// Get raw data for storage buffers
		const triangleRawData = DataTransfer.getTriangleRawData( this.existingApp );
		const bvhRawData = DataTransfer.getBVHRawData( this.existingApp );
		const materialRawData = DataTransfer.getMaterialRawData( this.existingApp );
		const environmentTexture = DataTransfer.getEnvironmentTexture( this.existingApp );

		if ( ! triangleRawData ) {

			console.error( 'WebGPUPathTracerApp: Failed to get triangle data' );
			return false;

		}

		// Set data (all storage buffers)
		this.pathTracingStage.setTriangleData( triangleRawData.triangleData, triangleRawData.triangleCount );

		if ( ! bvhRawData ) {

			console.error( 'WebGPUPathTracerApp: Failed to get BVH data' );
			return false;

		}

		this.pathTracingStage.setBVHData( bvhRawData );

		if ( materialRawData ) {

			this.pathTracingStage.setMaterialData( materialRawData );

		} else {

			console.warn( 'WebGPUPathTracerApp: No material data, using defaults' );

		}

		if ( environmentTexture ) {

			this.pathTracingStage.setEnvironmentTexture( environmentTexture );

		}

		// Transfer material texture arrays (albedo, normal, bump, roughness, metalness, emissive, displacement)
		const materialTextureArrays = DataTransfer.getMaterialTextureArrays( this.existingApp );
		this.pathTracingStage.setMaterialTextures( materialTextureArrays );
		console.log( '[WebGPUPathTracerApp] Material texture arrays:', Object.fromEntries(
			Object.entries( materialTextureArrays ).map( ( [ k, v ] ) => [ k, !! v ] )
		) );

		// Transfer emissive triangle data (storage buffer)
		const emissiveData = DataTransfer.getEmissiveTriangleData( this.existingApp );
		if ( emissiveData.emissiveTriangleData ) {

			this.pathTracingStage.setEmissiveTriangleData(
				emissiveData.emissiveTriangleData,
				emissiveData.emissiveTriangleCount,
			);

		}

		// Transfer lights from WebGL scene into the WebGPU scene
		this._transferSceneLights();

		// Setup material with all data
		this.pathTracingStage.setupMaterial();

		// Build environment CDF for importance sampling AFTER material setup
		// so the shader is compiled with uniform-based useEnvMapIS that can be
		// dynamically enabled once CDF data is ready
		if ( environmentTexture ) {

			await this.pathTracingStage.setEnvironmentMap( environmentTexture );

		}

		// Apply all settings to stage
		this.pathTracingStage.setMaxBounces( this.maxBounces );
		this.pathTracingStage.setSamplesPerPixel( this.samplesPerPixel );
		this.pathTracingStage.setMaxSamples( this.maxSamples );
		this.pathTracingStage.setTransmissiveBounces( this.transmissiveBounces );
		this.pathTracingStage.setEnvironmentIntensity( this.environmentIntensity );
		this.pathTracingStage.setBackgroundIntensity( this.backgroundIntensity );
		this.pathTracingStage.setShowBackground( this.showBackground );
		this.pathTracingStage.setEnableEnvironment( this.enableEnvironment );
		this.pathTracingStage.setGlobalIlluminationIntensity( this.globalIlluminationIntensity );
		this.pathTracingStage.setExposure( this.exposure );

		// Camera & DOF
		this.pathTracingStage.setEnableDOF( this.enableDOF );
		this.pathTracingStage.setFocusDistance( this.focusDistance );
		this.pathTracingStage.setFocalLength( this.focalLength );
		this.pathTracingStage.setAperture( this.aperture );

		// Sampling
		this.pathTracingStage.setSamplingTechnique( this.samplingTechnique );
		this.pathTracingStage.setUseAdaptiveSampling( this.useAdaptiveSampling );
		this.pathTracingStage.setAdaptiveSamplingMax( this.adaptiveSamplingMax );
		this.pathTracingStage.setFireflyThreshold( this.fireflyThreshold );

		// Emissive
		this.pathTracingStage.setEnableEmissiveTriangleSampling( this.enableEmissiveTriangleSampling );
		this.pathTracingStage.setEmissiveBoost( this.emissiveBoost );

		// Debug
		this.pathTracingStage.setVisMode( this.visMode );
		this.pathTracingStage.setDebugVisScale( this.debugVisScale );

		// Dispatch SceneRebuild so UI components (StatsMeter, Outliner, etc.) update
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		return true;

	}

	/**
	 * Handles window resize events.
	 */
	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;

		if ( width === 0 || height === 0 ) return;

		// Recalculate pixel ratio
		const targetRes = TARGET_RESOLUTIONS[ this.targetResolution ] || 512;
		const shortestDim = Math.min( width, height ) || 512;
		this.renderer.setPixelRatio( targetRes / shortestDim );

		this.renderer.setSize( width, height, false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

		this.needsReset = true;

		// Notify UI of resolution change (matches WebGL behavior)
		const renderWidth = Math.round( width * ( targetRes / shortestDim ) );
		const renderHeight = Math.round( height * ( targetRes / shortestDim ) );

		// Propagate render dimensions to pipeline stages (adaptive sampling, etc.)
		if ( this.pipeline ) {

			this.pipeline.setSize( renderWidth, renderHeight );

		}

		// Resize denoiser canvas to match render dimensions
		this.denoiser?.setSize( renderWidth, renderHeight );

		window.dispatchEvent( new CustomEvent( 'resolution_changed', { detail: { width: renderWidth, height: renderHeight } } ) );

	}

	/**
	 * Update resolution using a calculated pixel ratio value.
	 * Matches WebGL interface: updateResolution(pixelRatio, resolutionIndex)
	 * @param {number} value - The pixel ratio to set (used directly)
	 * @param {number} [targetResolutionIndex] - Optional resolution index (0-4) to store for resize recalculation
	 */
	updateResolution( value, targetResolutionIndex ) {

		if ( targetResolutionIndex !== undefined ) {

			this.targetResolution = targetResolutionIndex;

		}

		this.onResize();

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		this.animationId = requestAnimationFrame( () => this.animate() );

		// Update controls
		if ( this.controls ) {

			this.controls.update();

		}

		// Reset accumulation on camera change
		if ( this.needsReset ) {

			this.reset();
			this.needsReset = false;

		}

		// Update camera matrix
		this.camera.updateMatrixWorld();

		// Check if path tracing is enabled (pauseRendering = !enablePathTracer)
		const enablePathTracer = ! this.pauseRendering;

		if ( enablePathTracer ) {

			// Render path tracing
			if ( this.pathTracingStage?.isReady ) {

				// Skip rendering and stats updates when render is already complete
				if ( this.pathTracingStage.isComplete && this._renderCompleteDispatched ) {

					// Still allow display-only refresh (e.g. outline on selection change)
					// without re-running path tracer or re-dispatching completion.
					if ( this._needsDisplayRefresh ) {

						this._needsDisplayRefresh = false;
						this.displayStage.render( this.pipeline.context );

					}

					return;

				}

				this.pipeline.render();

				const frameCount = this.pathTracingStage.frameCount || 0;

				// Only update time while rendering is in progress
				if ( ! this.pathTracingStage.isComplete ) {

					const currentTime = performance.now();
					this.timeElapsed = ( currentTime - this.lastResetTime ) / 1000;

				}

				updateStats( {
					timeElapsed: this.timeElapsed,
					samples: frameCount
				} );

				// Check if time limit reached and force completion
				if ( this.renderLimitMode === 'time' && this.renderTimeLimit > 0 && this.timeElapsed >= this.renderTimeLimit ) {

					this.pathTracingStage.isComplete = true;

				}

				// Check for render completion (use stage's own isComplete flag)
				if ( this.pathTracingStage.isComplete && ! this._renderCompleteDispatched ) {

					this._renderCompleteDispatched = true;
					if ( this.denoiser?.output ) this.denoiser.output.style.display = 'block';
					this.denoiser?.start();
					this.dispatchEvent( { type: 'RenderComplete' } );
					useStore.getState().setIsRenderComplete( true );

				}

			}

		} else {

			// Traditional rasterization when path tracer is disabled
			// Similar to WebGL's RenderPass behavior
			this.renderer.render( this.scene, this.camera );

		}

		this.stats?.update();

		// Resolve GPU timestamp queries to prevent query pool overflow
		this.renderer.resolveTimestampsAsync?.();

	}

	/**
	 * Stops the animation loop.
	 */
	stopAnimation() {

		if ( this.animationId ) {

			cancelAnimationFrame( this.animationId );
			this.animationId = null;

		}

	}

	/**
	 * Pauses the animation loop.
	 */
	pause() {

		if ( this.animationId ) {

			cancelAnimationFrame( this.animationId );
			this.animationId = null;
			console.log( 'WebGPUPathTracerApp: Paused' );

		}

		if ( this.stats ) this.stats.dom.style.display = 'none';

	}

	/**
	 * Resumes the animation loop.
	 */
	resume() {

		if ( ! this.animationId ) {

			this.animate();
			console.log( 'WebGPUPathTracerApp: Resumed' );

		}

		if ( this.stats ) this.stats.dom.style.display = '';

	}

	/**
	 * Resets the accumulation buffer.
	 */
	reset() {

		if ( this.pipeline ) {

			this.pipeline.reset();

		}

		// Restore main canvas visibility and hide denoiser overlay
		this.canvas.style.opacity = '1';
		if ( this.denoiser ) {

			if ( this.denoiser.enabled ) this.denoiser.abort();
			if ( this.denoiser.output ) this.denoiser.output.style.display = 'none';

		}

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this._renderCompleteDispatched = false;
		this.dispatchEvent( { type: 'RenderReset' } );
		useStore.getState().setIsRenderComplete( false );

	}

	/**
	 * Sets the maximum number of bounces.
	 */
	setMaxBounces( bounces ) {

		this.maxBounces = bounces;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setMaxBounces( bounces );

		}

		this.reset();

	}

	/**
	 * Sets the environment intensity.
	 */
	setEnvironmentIntensity( intensity ) {

		this.environmentIntensity = intensity;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setEnvironmentIntensity( intensity );

		}

		this.reset();

	}

	/**
	 * Sets samples per pixel.
	 */
	setSamplesPerPixel( samples ) {

		this.samplesPerPixel = samples;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setSamplesPerPixel( samples );

		}

		this.reset();

	}

	/**
	 * Sets maximum samples.
	 */
	setMaxSamples( samples ) {

		this.maxSamples = samples;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setMaxSamples( samples );

		}

	}

	/**
	 * Sets transmissive bounces.
	 */
	setTransmissiveBounces( bounces ) {

		this.transmissiveBounces = bounces;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setTransmissiveBounces( bounces );

		}

		this.reset();

	}

	/**
	 * Sets background intensity.
	 */
	setBackgroundIntensity( intensity ) {

		this.backgroundIntensity = intensity;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setBackgroundIntensity( intensity );

		}

		this.reset();

	}

	/**
	 * Sets whether to show background.
	 */
	setShowBackground( show ) {

		this.showBackground = show;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setShowBackground( show );

		}

		this.reset();

	}

	/**
	 * Sets whether environment lighting is enabled.
	 */
	setEnableEnvironment( enable ) {

		this.enableEnvironment = enable;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setEnableEnvironment( enable );

		}

		this.reset();

	}

	/**
	 * Sets global illumination intensity.
	 */
	setGlobalIlluminationIntensity( intensity ) {

		this.globalIlluminationIntensity = intensity;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setGlobalIlluminationIntensity( intensity );

		}

		this.reset();

	}

	/**
	 * Sets exposure.
	 */
	setExposure( exposure ) {

		this.exposure = exposure;

		// Exposure is applied by DisplayStage via TSL uniform
		// (pow(exposure, 4.0) curve matching WebGL). renderer.toneMappingExposure
		// is kept at 1.0 to avoid doubling.
		if ( this.displayStage ) {

			this.displayStage.setExposure( exposure );

		}

		this.reset();

	}

	/**
	 * Enables/disables depth of field.
	 */
	setEnableDOF( enable ) {

		this.enableDOF = enable;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setEnableDOF( enable );

		}

		this.reset();

	}

	/**
	 * Sets focus distance.
	 */
	setFocusDistance( distance ) {

		this.focusDistance = distance;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setFocusDistance( distance );

		}

		this.reset();

	}

	/**
	 * Sets focal length.
	 */
	setFocalLength( length ) {

		this.focalLength = length;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setFocalLength( length );

		}

		this.reset();

	}

	/**
	 * Sets aperture size.
	 */
	setAperture( aperture ) {

		this.aperture = aperture;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setAperture( aperture );

		}

		this.reset();

	}

	/**
	 * Sets sampling technique.
	 */
	setSamplingTechnique( technique ) {

		this.samplingTechnique = technique;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setSamplingTechnique( technique );

		}

		this.reset();

	}

	/**
	 * Compatibility alias for store access.
	 * The store calls `app.adaptiveSamplingPass?.toggleHelper(val)`.
	 */
	get adaptiveSamplingPass() {

		return this.adaptiveSamplingStage;

	}

	/**
	 * Enables/disables adaptive sampling.
	 */
	setUseAdaptiveSampling( use ) {

		this.useAdaptiveSampling = use;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setUseAdaptiveSampling( use );

		}

		// Enable/disable the variance computation stage
		if ( this.adaptiveSamplingStage ) {

			use ? this.adaptiveSamplingStage.enable() : this.adaptiveSamplingStage.disable();

		}

		this.reset();

	}

	/**
	 * Sets adaptive sampling maximum.
	 */
	setAdaptiveSamplingMax( max ) {

		this.adaptiveSamplingMax = max;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setAdaptiveSamplingMax( max );

		}

		if ( this.adaptiveSamplingStage ) {

			this.adaptiveSamplingStage.setAdaptiveSamplingMax( max );

		}

		this.reset();

	}

	/**
	 * Sets firefly threshold.
	 */
	setFireflyThreshold( threshold ) {

		this.fireflyThreshold = threshold;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setFireflyThreshold( threshold );

		}

		this.reset();

	}

	/**
	 * Enables/disables emissive triangle sampling.
	 */
	setEnableEmissiveTriangleSampling( enable ) {

		this.enableEmissiveTriangleSampling = enable;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setEnableEmissiveTriangleSampling( enable );

		}

		this.reset();

	}

	/**
	 * Sets emissive boost factor.
	 */
	setEmissiveBoost( boost ) {

		this.emissiveBoost = boost;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setEmissiveBoost( boost );

		}

		this.reset();

	}

	/**
	 * Sets visualization/debug mode.
	 */
	setVisMode( mode ) {

		this.visMode = mode;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setVisMode( mode );

		}

		this.reset();

	}

	/**
	 * Sets debug visualization scale.
	 */
	setDebugVisScale( scale ) {

		this.debugVisScale = scale;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setDebugVisScale( scale );

		}

		this.reset();

	}

	/**
	 * Updates a material property in the path tracer.
	 */
	updateMaterialProperty( materialIndex, property, value ) {

		if ( typeof this.pathTracingStage?.updateMaterialProperty === 'function' ) {

			this.pathTracingStage.updateMaterialProperty( materialIndex, property, value );

		}

	}

	/**
	 * Updates texture transform data in the path tracer.
	 */
	updateTextureTransform( materialIndex, textureName, transform ) {

		if ( typeof this.pathTracingStage?.updateTextureTransform === 'function' ) {

			this.pathTracingStage.updateTextureTransform( materialIndex, textureName, transform );

		}

	}

	/**
	 * Marks the path tracer material as needing recompilation.
	 */
	refreshMaterial() {

		// WebGPU uses TSL nodes, no manual material refresh needed
		this.reset();

	}

	/**
	 * Updates a complete material on the path tracer.
	 */
	updateMaterial( materialIndex, material ) {

		if ( typeof this.pathTracingStage?.updateMaterialProperty === 'function' ) {

			// Delegate to stage - it handles per-property updates
			this.pathTracingStage.updateMaterialProperty( materialIndex, 'color', material.color );
			this.pathTracingStage.updateMaterialProperty( materialIndex, 'roughness', material.roughness );
			this.pathTracingStage.updateMaterialProperty( materialIndex, 'metalness', material.metalness );

		}

	}

	/**
	 * Rebuilds all materials from the scene.
	 */
	async rebuildMaterials( scene ) {

		// WebGPU material rebuild - no-op for now
		console.warn( 'WebGPU rebuildMaterials not yet implemented' );

	}

	/**
	 * Returns whether the render is complete.
	 */
	isComplete() {

		return this.pathTracingStage?.isComplete ?? false;

	}

	/**
	 * Gets the current frame count.
	 */
	getFrameCount() {

		return this.pathTracingStage?.frameCount || 0;

	}

	/**
	 * Gets the camera for external manipulation.
	 */
	getCamera() {

		return this.camera;

	}

	/**
	 * Gets the controls for external manipulation.
	 */
	getControls() {

		return this.controls;

	}

	/**
	 * Syncs camera position, projection, and orbit controls target
	 * from the WebGL app after model loading.
	 */
	syncCameraFromWebGL() {

		const sourceApp = this.existingApp;
		if ( ! sourceApp?.camera || ! this.camera ) return;

		DataTransfer.copyCameraSettings( sourceApp, this.camera );

		if ( sourceApp.controls?.target && this.controls?.target ) {

			this.controls.target.copy( sourceApp.controls.target );
			this.controls.maxDistance = sourceApp.controls.maxDistance;
			this.controls.saveState();
			this.controls.update();

		}

	}

	/**
	 * Checks if this backend supports a given feature.
	 * @param {string} featureName
	 * @returns {boolean}
	 */
	supportsFeature( featureName ) {

		return this._supportedFeatures[ featureName ] ?? false;

	}

	// ─── Missing Interface Methods (no-ops until WebGPU supports them) ──

	/**
	 * Sets aperture scale.
	 */
	setApertureScale( scale ) {

		this.apertureScale = scale;
		// WebGPU stage does not yet support aperture scale
		this.reset();

	}

	/**
	 * Sets render mode.
	 */
	setRenderMode( /* mode */ ) {

		// Not implemented in WebGPU yet

	}

	/**
	 * Loads a model by delegating to the WebGL app's asset pipeline,
	 * then transferring the processed data via DataTransfer.
	 * @param {string} url - Model URL
	 */
	async loadModel( url ) {

		if ( ! this.existingApp?.assetLoader ) {

			console.warn( 'WebGPUPathTracerApp: No WebGL app available for asset loading' );
			return;

		}

		this._loadingInProgress = true;

		try {

			await this.existingApp.assetLoader.loadModel( url );
			this.syncCameraFromWebGL();
			await this.loadSceneData();
			this.reset();
			this.dispatchEvent( { type: 'ModelLoaded', url } );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Loads an environment map by delegating to the WebGL app's asset pipeline.
	 * @param {string} url - Environment URL
	 */
	async loadEnvironment( url ) {

		if ( ! this.existingApp?.assetLoader ) {

			console.warn( 'WebGPUPathTracerApp: No WebGL app available for environment loading' );
			return;

		}

		await this.existingApp.loadEnvironment( url );
		// Re-transfer environment texture and rebuild CDF
		const environmentTexture = DataTransfer.getEnvironmentTexture( this.existingApp );
		if ( environmentTexture && this.pathTracingStage ) {

			await this.pathTracingStage.setEnvironmentMap( environmentTexture );

		}

		this.reset();
		this.dispatchEvent( { type: 'EnvironmentLoaded', url } );

	}

	/**
	 * Loads example models by delegating to the WebGL app.
	 * @param {number} index - Example model index
	 */
	async loadExampleModels( index ) {

		if ( ! this.existingApp ) {

			console.warn( 'WebGPUPathTracerApp: No WebGL app available for example model loading' );
			return;

		}

		this._loadingInProgress = true;

		try {

			await this.existingApp.loadExampleModels( index );
			this.syncCameraFromWebGL();
			await this.loadSceneData();
			this.reset();
			this.dispatchEvent( { type: 'ModelLoaded', index } );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Selects an object for highlighting (outline effect + UI).
	 */
	selectObject( object ) {

		if ( this.outlineNode ) {

			this.outlineNode.selectedObjects = object ? [ object ] : [];

		}

		useStore.getState().setSelectedObject( object || null );

	}

	/**
	 * Toggles focus mode for click-to-focus DOF.
	 */
	toggleFocusMode() {

		if ( ! this.interactionManager ) return false;
		const enabled = this.interactionManager.toggleFocusMode();
		if ( this.controls ) {

			this.controls.enabled = ! enabled;

		}

		return enabled;

	}

	/**
	 * Toggles select mode for click-to-select objects.
	 */
	toggleSelectMode() {

		if ( ! this.interactionManager ) return false;
		return this.interactionManager.toggleSelectMode();

	}

	/**
	 * Disables select mode.
	 */
	disableSelectMode() {

		this.interactionManager?.disableSelectMode();

	}

	/**
	 * @stub
	 */
	switchCamera() {}

	/**
	 * @stub
	 */
	getCameraNames() {

		return [];

	}

	/**
	 * Adds a light to the WebGPU scene and updates the path tracer.
	 * Mirrors the WebGL PathTracerApp.addLight() API.
	 *
	 * @param {string} type - Light type: 'DirectionalLight', 'PointLight', 'SpotLight', 'RectAreaLight'
	 * @returns {Object|null} Light descriptor or null if type is invalid
	 */
	addLight( type ) {

		const defaults = {
			DirectionalLight: { position: [ 1, 1, 1 ], intensity: 1.0, color: '#ffffff' },
			PointLight: { position: [ 0, 2, 0 ], intensity: 100, color: '#ffffff' },
			SpotLight: { position: [ 0, 1, 0 ], intensity: 300, color: '#ffffff', angle: 15 },
			RectAreaLight: { position: [ 0, 2, 0 ], intensity: 500, color: '#ffffff', width: 2, height: 2 }
		};

		const props = defaults[ type ];
		if ( ! props ) return null;

		let light;

		if ( type === 'DirectionalLight' ) {

			light = new DirectionalLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'PointLight' ) {

			light = new PointLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'SpotLight' ) {

			light = new SpotLight( props.color, props.intensity );
			light.position.fromArray( props.position );
			light.angle = MathUtils.degToRad( props.angle );
			const target = new Object3D();
			this.scene.add( target );
			light.target = target;

		} else if ( type === 'RectAreaLight' ) {

			light = new RectAreaLight( props.color, props.intensity, props.width, props.height );
			light.position.fromArray( props.position );
			light.lookAt( 0, 0, 0 );

		}

		const count = this.scene.getObjectsByProperty( 'isLight', true ).length;
		light.name = `${type.replace( 'Light', '' )} ${count + 1}`;
		this.scene.add( light );
		this.updateLights();
		this.reset();

		return {
			uuid: light.uuid,
			name: light.name,
			type: light.type,
			intensity: light.intensity,
			color: `#${light.color.getHexString()}`,
			position: [ light.position.x, light.position.y, light.position.z ],
			angle: light.angle
		};

	}

	/**
	 * Removes a light from the WebGPU scene by UUID.
	 *
	 * @param {string} uuid - UUID of the light to remove
	 * @returns {boolean} True if light was found and removed
	 */
	removeLight( uuid ) {

		const light = this.scene.getObjectByProperty( 'uuid', uuid );
		if ( ! light || ! light.isLight ) return false;

		if ( light.target ) light.target.removeFromParent();
		light.removeFromParent();
		this.updateLights();
		this.reset();
		return true;

	}

	/**
	 * Removes all lights from the WebGPU scene.
	 */
	clearLights() {

		this.scene.getObjectsByProperty( 'isLight', true ).forEach( light => {

			if ( light.target ) this.scene.remove( light.target );
			this.scene.remove( light );

		} );
		this.updateLights();
		this.reset();

	}

	/**
	 * Returns descriptors for all lights in the WebGPU scene.
	 *
	 * @returns {Array<Object>} Array of light descriptor objects
	 */
	getLights() {

		return this.scene.getObjectsByProperty( 'isLight', true ).map( light => {

			let angle = 0;
			if ( light.type === 'DirectionalLight' && light.angle !== undefined ) {

				angle = MathUtils.radToDeg( light.angle );

			} else if ( light.type === 'SpotLight' ) {

				if ( light.angle !== undefined ) {

					angle = MathUtils.radToDeg( light.angle );

				}

			}

			return {
				uuid: light.uuid,
				name: light.name,
				type: light.type,
				intensity: light.intensity,
				color: `#${light.color.getHexString()}`,
				position: [ light.position.x, light.position.y, light.position.z ],
				angle: angle
			};

		} );

	}

	/**
	 * Reprocesses all scene lights and updates the path tracer uniform buffers.
	 * Called after any light addition, removal, or property change.
	 */
	updateLights() {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.updateLights();

		}

	}

	/**
	 * Takes a screenshot of the current render and downloads it.
	 */
	takeScreenshot() {

		if ( ! this.renderer?.domElement ) return;

		try {

			// Use denoised output if OIDN is enabled and render is complete
			const canvas = this.denoiser?.enabled && this.denoiser.output && this.pathTracingStage?.isComplete
				? this.denoiser.output
				: this.renderer.domElement;

			const screenshot = canvas.toDataURL( 'image/png' );
			const link = document.createElement( 'a' );
			link.href = screenshot;
			link.download = 'screenshot.png';
			link.click();

		} catch ( error ) {

			console.error( 'WebGPUPathTracerApp: Screenshot failed:', error );

		}

	}

	/**
	 * Requests a display-only refresh (e.g. after outline selection change).
	 * In the completed state the path tracer is NOT re-run; only the
	 * DisplayStage re-renders so the outline updates on screen.
	 */
	refreshFrame() {

		this._needsDisplayRefresh = true;

	}

	/**
	 * Enables/disables the path tracer.
	 * @param {boolean} val
	 */
	setPathTracerEnabled( val ) {

		this.pauseRendering = ! val;

	}

	/**
	 * Enables/disables accumulation.
	 * @param {boolean} val
	 */
	setAccumulationEnabled( val ) {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.setAccumulationEnabled( val );

		}

	}

	/**
	 * @stub
	 */
	setTileCount( /* val */ ) {}

	setRenderLimitMode( val ) {

		this.renderLimitMode = val;
		if ( this.pathTracingStage?.setRenderLimitMode ) {

			this.pathTracingStage.setRenderLimitMode( val );

		}

	}

	setEnvironmentRotation( val ) {

		this.environmentRotation = val;
		this.pathTracingStage.setEnvironmentRotation( val );

	}

	/**
	 * Enables/disables interaction mode (quality reduction during camera movement).
	 * @param {boolean} val
	 */
	setInteractionModeEnabled( val ) {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.setInteractionModeEnabled( val );

		}

	}

	/**
	 * @stub
	 */
	setAdaptiveSamplingParameters( /* params */ ) {}

	// ── Environment mode helpers (stubs — WebGPU does not yet support procedural sky) ──

	/** Returns envParams — not supported in WebGPU yet. */
	getEnvParams() {

		return null;

	}

	/** Returns the current environment texture — not supported. */
	getEnvironmentTexture() {

		return null;

	}

	/** Returns the current environment CDF texture — not supported. */
	getEnvironmentCDF() {

		return null;

	}

	/** @stub */
	async generateProceduralSkyTexture() {

		console.warn( 'WebGPUPathTracerApp: Procedural sky not supported' );

	}

	/** @stub */
	async generateGradientTexture() {

		console.warn( 'WebGPUPathTracerApp: Gradient sky not supported' );

	}

	/** @stub */
	async generateSolidColorTexture() {

		console.warn( 'WebGPUPathTracerApp: Solid color sky not supported' );

	}

	async setEnvironmentMap( texture ) {

		if ( ! this.pathTracingStage ) {

			console.warn( 'WebGPUPathTracerApp: PathTracingStage not initialized' );
			return;

		}

		await this.pathTracingStage.setEnvironmentMap( texture );
		this.reset();

	}

	/** @stub */
	markEnvironmentNeedsUpdate() {}

	/**
	 * Returns scene statistics from the path tracing stage, or null.
	 * In shared-data mode, the WebGPU stage's sdfs is empty (data is
	 * transferred via textures, not built locally), so fall back to the
	 * existing WebGL app's statistics.
	 * @returns {object|null}
	 */
	getSceneStatistics() {

		try {

			const localStats = this.pathTracingStage?.sdfs?.getStatistics?.();
			if ( localStats?.triangleCount > 0 ) return localStats;

			// Fall back to the WebGL app that owns the scene data
			return this.existingApp?.getSceneStatistics?.() ?? null;

		} catch {

			return null;

		}

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		this.stopAnimation();

		if ( this.assetLoader && this._onAssetLoaded ) {

			this.assetLoader.removeEventListener( 'load', this._onAssetLoaded );

		}

		if ( this.outlineNode ) {

			this.outlineNode.dispose();
			this.outlineNode = null;

		}

		if ( this.denoiser ) {

			this.denoiser.dispose();
			this.denoiser = null;

		}

		if ( this.pipeline ) {

			this.pipeline.dispose();

		}

		if ( this.interactionManager ) {

			this.interactionManager.dispose();

		}

		if ( this.controls ) {

			this.controls.dispose();

		}

		if ( this.renderer ) {

			this.renderer.dispose();

		}

		if ( this.stats ) {

			this.stats.dom.remove();
			this.stats = null;

		}

		window.removeEventListener( 'resize', this.resizeHandler );

		this.isInitialized = false;

	}

}

