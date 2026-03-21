import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
	ACESFilmicToneMapping, PerspectiveCamera, Scene, EventDispatcher, Vector3,
	DirectionalLight, PointLight, SpotLight, RectAreaLight, Object3D, MathUtils, Color,
	Mesh, CircleGeometry, MeshPhysicalMaterial, TimestampQuery
} from 'three';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { SceneHelpers } from './SceneHelpers.js';
import Stats from 'stats-gl';
import { PathTracingStage } from './Stages/PathTracingStage.js';
import { NormalDepthStage } from './Stages/NormalDepthStage.js';
import { MotionVectorStage } from './Stages/MotionVectorStage.js';
import { ASVGFStage } from './Stages/ASVGFStage.js';
import { VarianceEstimationStage } from './Stages/VarianceEstimationStage.js';
import { BilateralFilteringStage } from './Stages/BilateralFilteringStage.js';
import { AdaptiveSamplingStage } from './Stages/AdaptiveSamplingStage.js';
import { EdgeAwareFilteringStage } from './Stages/EdgeAwareFilteringStage.js';
import { AutoExposureStage } from './Stages/AutoExposureStage.js';
import { TileHighlightStage } from './Stages/TileHighlightStage.js';
import { SSRCStage } from './Stages/SSRCStage.js';
import { DisplayStage } from './Stages/DisplayStage.js';
import { PassPipeline } from './Pipeline/PassPipeline.js';
import { DEFAULT_STATE } from '../Constants.js';
import { updateStats, updateLoading, resetLoading } from './Processor/utils.js';
import BuildTimer from './Processor/BuildTimer.js';
import InteractionManager from './InteractionManager.js';
import { OIDNDenoiser } from './Passes/OIDNDenoiser.js';
import { useStore } from '@/store';
import AssetLoader from './Processor/AssetLoader.js';
import TriangleSDF from './Processor/TriangleSDF.js';


/**
 * WebGPU Path Tracer Application.
 * Full path tracing implementation using WebGPU and TSL.
 *
 * Extends EventDispatcher for event-driven communication with stores/UI.
 */
export class PathTracerApp extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {HTMLCanvasElement} [denoiserCanvas] - Optional canvas for OIDN denoiser output
	 */
	constructor( canvas, denoiserCanvas = null ) {

		super();

		this.canvas = canvas;
		this.denoiserCanvas = denoiserCanvas;

		// Core objects
		this.renderer = null;
		this.camera = null;
		this.scene = null;
		this.controls = null;

		// Mesh scene — holds actual Three.js meshes for raycasting, outlining,
		// and raster fallback. Separate from this.scene (which only holds lights
		// for the path tracer pipeline).
		this.meshScene = null;

		// Scene helpers — lightweight overlay for light visualization
		this.sceneHelpers = null;

		// Asset pipeline
		this.assetLoader = null;
		this.sdf = null;
		this.cameras = [];

		// Stages
		this.pathTracingStage = null;

		// State
		this.isInitialized = false;
		this.pauseRendering = false;
		this.pathTracerEnabled = true;
		this.animationId = null;
		this.needsReset = false;
		this._renderCompleteDispatched = false;
		this.denoiser = null;

		// Stats tracking
		this.lastResetTime = performance.now();
		this.timeElapsed = 0;


		// Resolution settings — canvas dimensions = render dimensions (pixel ratio 1.0)
		this._lastRenderWidth = 0;
		this._lastRenderHeight = 0;
		this._resizeDebounceTimer = null;

		// Settings — PathTracingStage uniforms
		this.maxBounces = DEFAULT_STATE.bounces ?? 4;
		this.samplesPerPixel = DEFAULT_STATE.samplesPerPixel ?? 1;
		this.maxSamples = DEFAULT_STATE.maxSamples ?? 2048;
		this.transmissiveBounces = DEFAULT_STATE.transmissiveBounces ?? 10;
		this.environmentIntensity = DEFAULT_STATE.environmentIntensity ?? 1.0;
		this.backgroundIntensity = DEFAULT_STATE.backgroundIntensity ?? 1.0;
		this.showBackground = DEFAULT_STATE.showBackground ?? true;
		this.transparentBackground = DEFAULT_STATE.transparentBackground ?? false;
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
		this._defaultCameraState = null; // saved when switching away from default

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

		// Query adapter limits so we can request the maximum supported buffer size
		const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! adapter ) {

			throw new Error( 'Failed to get WebGPU adapter' );

		}

		const adapterLimits = adapter.limits;

		// Create and initialize WebGPU renderer
		this.renderer = new WebGPURenderer( {
			canvas: this.canvas,
			alpha: true,
			powerPreference: 'high-performance',
			requiredLimits: {
				maxBufferSize: adapterLimits.maxBufferSize,
				maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
				maxColorAttachmentBytesPerSample: 128,
			}
		} );

		window.renderer = this.renderer; // For debugging
		// this.renderer.inspector = new Inspector();

		await this.renderer.init();

		// Initialize LTC textures required by RectAreaLight in WebGPU renderer
		RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );

		// Exposure is applied in the display shader via TSL uniform, so
		// keep toneMappingExposure at 1.0 to avoid double-application.
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;

		// Canvas dimensions = render dimensions
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		this.renderer.setPixelRatio( 1.0 );

		// Setup camera
		this.camera = new PerspectiveCamera( 65, width / height || 1, 0.01, 1000 );
		this.camera.position.set( 0, 0, 5 );

		// Create scenes — separate light scene (for path tracer) and mesh scene (for raycasting)
		this.scene = new Scene();
		this.meshScene = new Scene();
		this.sceneHelpers = new SceneHelpers();

		// Setup orbit controls
		this.controls = new OrbitControls( this.camera, this.canvas );
		this.controls.screenSpacePanning = true;
		this.controls.zoomToCursor = true;

		// Save initial state so controls.reset() works
		this.controls.saveState();

		// Create asset pipeline — AssetLoader manages the meshScene
		this.sdf = new TriangleSDF();
		this.assetLoader = new AssetLoader( this.meshScene, this.camera, this.controls );
		this.setupFloorPlane();
		this.assetLoader.setFloorPlane( this.floorPlane );

		// Track camera movement for reset
		this.controls.addEventListener( 'change', () => {

			this.needsReset = true;

		} );

		// Create pipeline stages
		this.pathTracingStage = new PathTracingStage( this.renderer, this.scene, this.camera );
		this.normalDepthStage = new NormalDepthStage( this.renderer, {
			pathTracingStage: this.pathTracingStage
		} );
		this.motionVectorStage = new MotionVectorStage( this.renderer, this.camera, {
			pathTracingStage: this.pathTracingStage
		} );
		this.ssrcStage = new SSRCStage( this.renderer, { enabled: false } );
		this.asvgfStage = new ASVGFStage( this.renderer, { enabled: false } );
		this.varianceEstimationStage = new VarianceEstimationStage( this.renderer, { enabled: false } );
		this.bilateralFilteringStage = new BilateralFilteringStage( this.renderer, { enabled: false } );
		this.adaptiveSamplingStage = new AdaptiveSamplingStage( this.renderer, {
			adaptiveSamplingMax: this.adaptiveSamplingMax,
			enabled: this.useAdaptiveSampling,
		} );
		this.edgeAwareFilteringStage = new EdgeAwareFilteringStage( this.renderer, { enabled: false } );
		this.autoExposureStage = new AutoExposureStage( this.renderer, { enabled: DEFAULT_STATE.autoExposure ?? false } );
		this.tileHighlightStage = new TileHighlightStage( this.renderer, { enabled: false } );

		// Outline effect — uses the mesh scene (which holds actual meshes) for
		// depth/mask rasterisation.
		const outlineScene = this.meshScene;
		this.outlineNode = outline( outlineScene, this.camera, {
			selectedObjects: [],
			edgeThickness: uniform( 1.0 ),
			edgeGlow: uniform( 0.0 ),
		} );

		// Fixed-resolution outline: OutlineNode auto-sizes from renderer's
		// drawing buffer each frame, but the renderer runs at path-tracer
		// resolution. Override setSize so the outline always renders at the
		// display's native DPR regardless of path-tracer resolution.
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
			// When auto-exposure is enabled by default, neutralize the manual
			// exposure curve (pow(1,4)=1) so it doesn't stack with auto-exposure's
			// renderer.toneMappingExposure.
			exposure: ( DEFAULT_STATE.autoExposure ) ? 1.0 : this.exposure,
			outlineColorNode
		} );

		// Pipeline orchestration — stage order matters: each reads textures published by prior stages.
		// Stage order matters: each stage reads textures published by prior stages.
		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new PassPipeline( this.renderer, w || 1, h || 1 );
		this.pipeline.addStage( this.pathTracingStage );
		this.pipeline.addStage( this.normalDepthStage );
		this.pipeline.addStage( this.motionVectorStage );
		this.pipeline.addStage( this.ssrcStage );
		this.pipeline.addStage( this.asvgfStage );
		this.pipeline.addStage( this.varianceEstimationStage );
		this.pipeline.addStage( this.bilateralFilteringStage );
		this.pipeline.addStage( this.adaptiveSamplingStage );
		this.pipeline.addStage( this.edgeAwareFilteringStage );
		this.pipeline.addStage( this.autoExposureStage );
		this.pipeline.addStage( this.tileHighlightStage );
		this.pipeline.addStage( this.displayStage );

		// Set initial render dimensions so stage render targets aren't stuck at 1x1
		// (canvas may be hidden initially, so guard against 0)
		const initRenderW = width || 1;
		const initRenderH = height || 1;
		this.pipeline.setSize( initRenderW, initRenderH );
		this._lastRenderWidth = initRenderW;
		this._lastRenderHeight = initRenderH;

		// Initialize interaction manager for click-to-select
		this.interactionManager = new InteractionManager( {
			scene: this.meshScene,
			camera: this.camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracingStage: null,
			floorPlane: this.floorPlane
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

		// Listen for asset loads so drag-drop / menu imports auto-sync.
		// Skip if loadModel/loadExampleModels is already orchestrating the load.
		this._onAssetLoaded = async ( event ) => {

			if ( this._loadingInProgress ) return;

			if ( event.model ) {

				await this.loadSceneData();

			} else if ( event.texture ) {

				const envTexture = this.meshScene.environment;
				if ( envTexture && this.pathTracingStage ) {

					await this.pathTracingStage.environment.setEnvironmentMap( envTexture );

				}

				resetLoading();

			}

			this.pauseRendering = false;
			this.reset();

		};

		this.assetLoader.addEventListener( 'load', this._onAssetLoaded );

		// Capture extracted cameras from model loads
		this.assetLoader.addEventListener( 'modelProcessed', ( event ) => {

			// Build camera list: default camera + any extracted from the model
			this.cameras = [ this.camera, ...( event.cameras || [] ) ];

			// Store floor plane reference for interaction manager
			this.floorPlane = this.assetLoader.floorPlane;
			if ( this.interactionManager ) {

				this.interactionManager.floorPlane = this.floorPlane;

			}

		} );

		// Seed path tracer with minimal empty scene data so it can render
		// the environment background even before a model is loaded.
		// A single degenerate triangle + 1 BVH node + 1 material entry.
		this.pathTracingStage.setTriangleData( new Float32Array( 32 ), 0 );
		this.pathTracingStage.setBVHData( new Float32Array( 16 ) );
		this.pathTracingStage.materialData.setMaterialData( new Float32Array( 16 ) );
		this.pathTracingStage.setupMaterial();

		// Setup stats panel
		this.initStats();

		this.isInitialized = true;

		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

	}

	setupFloorPlane() {

		this.floorPlane = new Mesh(
			new CircleGeometry(),
			new MeshPhysicalMaterial( {
				transparent: false,
				color: 0x303030,
				roughness: 1,
				metalness: 0,
				opacity: 0,
				transmission: 0,
			} )
		);
		this.floorPlane.name = "Ground";
		this.floorPlane.visible = false;
		this.meshScene.add( this.floorPlane );

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

		this.stats.dom.style.display = '';

	}

	/**
	 * Sets up event listeners for interaction manager events.
	 */
	setupInteractionListeners() {

		if ( ! this.interactionManager ) return;

		// Object selection events
		this.interactionManager.addEventListener( 'objectSelected', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();

			this.dispatchEvent( {
				type: 'objectSelected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		this.interactionManager.addEventListener( 'objectDeselected', ( event ) => {

			this.selectObject( null );
			this.refreshFrame();

			this.dispatchEvent( {
				type: 'objectDeselected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		this.interactionManager.addEventListener( 'objectDoubleClicked', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();

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

		// Re-enable orbit controls when focus mode auto-exits after a click
		this.interactionManager.addEventListener( 'focusModeChanged', ( event ) => {

			if ( ! event.enabled && this.controls ) {

				this.controls.enabled = true;

			}

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
			useGBuffer: true,

			// Share the existing GPUDevice so oidn-web registers its TF.js backend on the
			// same device — enabling zero-copy GPU texture inputs.
			backendParams: () => ( {
				device: this.renderer.backend.device,
				adapterInfo: null // Three.js doesn't cache adapterInfo; null is safe
			} ),

			// Return raw GPUTexture handles from the MRT RenderTarget.
			getGPUTextures: () => {

				const pt = this.pathTracingStage;
				if ( ! pt?.storageTextures?.readTarget ) return null;

				const readTextures = pt.storageTextures.getReadTextures();
				const { backend } = this.renderer;
				return {
					color: backend.get( readTextures.color ).texture,
					normal: backend.get( readTextures.normalDepth ).texture,
					albedo: backend.get( readTextures.albedo ).texture
				};

			},

			// Effective exposure multiplier matching DisplayStage's pipeline:
			//  • Manual:       linear exposure with toneMappingExposure = 1.0
			//  • AutoExposure: displayExposure = 1.0, toneMappingExposure = autoValue
			// The tonemapping function receives this as its exposure parameter.
			getExposure: () => this.autoExposureStage?.enabled
				? this.renderer.toneMappingExposure
				: this.exposure,

			// Current Three.js ToneMapping constant so OIDN can match the renderer.
			getToneMapping: () => this.renderer.toneMapping,

			// Whether transparent background is enabled (OIDN needs to preserve alpha)
			getTransparentBackground: () => this.transparentBackground,

			getMRTRenderTarget: () => {

				const pt = this.pathTracingStage;
				return pt?.storageTextures?.readTarget ?? null;

			}
		} );

		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Sync denoiser state with store
		this.denoiser.addEventListener( 'start', () => useStore.getState().setIsDenoising( true ) );
		this.denoiser.addEventListener( 'end', () => useStore.getState().setIsDenoising( false ) );

	}

	/**
	 * Clones Three.js light objects from the mesh scene into the WebGPU light
	 * scene, then updates the PathTracingStage light uniform buffers.
	 */
	_transferSceneLights() {

		// Clear existing lights from WebGPU scene before re-transferring
		// to avoid stale lights accumulating across model loads
		this.scene.getObjectsByProperty( 'isLight', true ).forEach( light => {

			if ( light.target ) this.scene.remove( light.target );
			this.scene.remove( light );

		} );

		const sourceLights = this.meshScene.getObjectsByProperty( 'isLight', true );

		if ( ! sourceLights || sourceLights.length === 0 ) {

			// No scene lights — still call updateLights to process procedural sky sun
			this.updateLights();
			return;

		}

		// Clone each light into the WebGPU scene with world transforms.
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

			// RectAreaLightHelper ignores world scale, so bake it into width/height
			// to keep the helper visualization consistent with the shader data
			if ( cloned.isRectAreaLight ) {

				cloned.width *= cloned.scale.x;
				cloned.height *= cloned.scale.y;
				cloned.scale.set( 1, 1, 1 );

			}

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
		this._syncLightHelpers();

	}

	/**
	 * Builds BVH from meshScene and uploads all scene data to the path tracer stages.
	 *
	 * @returns {boolean} True if data was loaded successfully
	 */
	async loadSceneData() {

		const timer = new BuildTimer( 'loadSceneData' );

		const environmentTexture = this.meshScene.environment;

		// Kick off environment CDF build in parallel with BVH (runs in a Web Worker)
		let cdfPromise = null;
		if ( environmentTexture && environmentTexture.image && environmentTexture.image.data ) {

			timer.start( 'Environment CDF build (worker)' );
			this.pathTracingStage.scene.environment = environmentTexture;
			cdfPromise = this.pathTracingStage.environment.buildEnvironmentCDF()
				.then( () => timer.end( 'Environment CDF build (worker)' ) );

		}

		// Build BVH acceleration structure from the mesh scene
		timer.start( 'BVH build (TriangleSDF)' );
		await this.sdf.buildBVH( this.meshScene );
		timer.end( 'BVH build (TriangleSDF)' );

		// Get raw data from SDF (Float32Arrays for storage buffers)
		const triangleData = this.sdf.triangleData;
		const triangleCount = this.sdf.triangleCount;
		const bvhData = this.sdf.bvhData;
		const materialData = this.sdf.materialData;

		if ( ! triangleData ) {

			console.error( 'PathTracerApp: Failed to get triangle data' );
			return false;

		}

		updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
		await new Promise( r => setTimeout( r, 0 ) ); // yield for UI repaint
		timer.start( 'GPU data transfer' );
		this.pathTracingStage.setTriangleData( triangleData, triangleCount );

		if ( ! bvhData ) {

			console.error( 'PathTracerApp: Failed to get BVH data' );
			return false;

		}

		this.pathTracingStage.setBVHData( bvhData );

		if ( materialData ) {

			this.pathTracingStage.materialData.setMaterialData( materialData );

		} else {

			console.warn( 'PathTracerApp: No material data, using defaults' );

		}

		if ( environmentTexture ) {

			this.pathTracingStage.environment.setEnvironmentTexture( environmentTexture );

		}

		// Transfer material texture arrays (albedo, normal, bump, roughness, metalness, emissive, displacement)
		const materialTextureArrays = {
			albedoMaps: this.sdf.albedoTextures,
			normalMaps: this.sdf.normalTextures,
			bumpMaps: this.sdf.bumpTextures,
			roughnessMaps: this.sdf.roughnessTextures,
			metalnessMaps: this.sdf.metalnessTextures,
			emissiveMaps: this.sdf.emissiveTextures,
			displacementMaps: this.sdf.displacementTextures,
		};
		this.pathTracingStage.materialData.setMaterialTextures( materialTextureArrays );

		// Transfer emissive triangle data (storage buffer)
		if ( this.sdf.emissiveTriangleData ) {

			this.pathTracingStage.setEmissiveTriangleData(
				this.sdf.emissiveTriangleData,
				this.sdf.emissiveTriangleCount,
				this.sdf.emissiveTotalPower,
			);

		}

		// Transfer light BVH data (storage buffer)
		if ( this.sdf.lightBVHNodeData ) {

			this.pathTracingStage.setLightBVHData(
				this.sdf.lightBVHNodeData,
				this.sdf.lightBVHNodeCount,
			);

		}

		// Transfer lights from mesh scene into the WebGPU light scene
		this._transferSceneLights();
		timer.end( 'GPU data transfer' );

		// Setup material with all data
		updateLoading( { status: "Compiling shaders...", progress: 90 } );
		await new Promise( r => setTimeout( r, 0 ) ); // yield for UI repaint
		timer.start( 'Material setup (TSL compile)' );
		this.pathTracingStage.setupMaterial();
		timer.end( 'Material setup (TSL compile)' );

		// Wait for the parallel CDF worker to finish (usually already done by now)
		if ( cdfPromise ) {

			updateLoading( { status: "Finalizing environment map...", progress: 95 } );
			await cdfPromise;

			// Update TSL env texture nodes (CDF storage buffers already populated)
			this.pathTracingStage.environment.applyCDFResults();

		}

		// Apply all settings to stage
		timer.start( 'Apply settings' );
		const pt = this.pathTracingStage;
		pt.setUniform( 'maxBounces', this.maxBounces );
		pt.setUniform( 'samplesPerPixel', this.samplesPerPixel );
		pt.setUniform( 'maxSamples', this.maxSamples );
		pt.setUniform( 'transmissiveBounces', this.transmissiveBounces );
		pt.setUniform( 'environmentIntensity', this.environmentIntensity );
		pt.setUniform( 'backgroundIntensity', this.backgroundIntensity );
		pt.setUniform( 'showBackground', this.showBackground );
		pt.setUniform( 'transparentBackground', this.transparentBackground );
		pt.setUniform( 'enableEnvironment', this.enableEnvironment );
		pt.setUniform( 'globalIlluminationIntensity', this.globalIlluminationIntensity );
		pt.setUniform( 'exposure', this.exposure );
		this.displayStage.setTransparentBackground( this.transparentBackground );

		// Camera & DOF
		pt.setUniform( 'enableDOF', this.enableDOF );
		pt.setUniform( 'focusDistance', this.focusDistance );
		pt.setUniform( 'focalLength', this.focalLength );
		pt.setUniform( 'aperture', this.aperture );

		// Sampling
		pt.setUniform( 'samplingTechnique', this.samplingTechnique );
		pt.setUniform( 'useAdaptiveSampling', this.useAdaptiveSampling );
		pt.setUniform( 'adaptiveSamplingMax', this.adaptiveSamplingMax );
		pt.setUniform( 'fireflyThreshold', this.fireflyThreshold );

		// Emissive
		pt.setUniform( 'enableEmissiveTriangleSampling', this.enableEmissiveTriangleSampling );
		pt.setUniform( 'emissiveBoost', this.emissiveBoost );

		// Debug
		pt.setUniform( 'visMode', this.visMode );
		pt.setUniform( 'debugVisScale', this.debugVisScale );
		timer.end( 'Apply settings' );

		timer.print();

		// Dismiss loading overlay
		resetLoading();

		// Dispatch SceneRebuild so UI components (StatsMeter, Outliner, etc.) update
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		return true;

	}

	/**
	 * Handles window resize events.
	 * Display updates (renderer size, camera aspect) happen immediately.
	 * Render target resizing and convergence reset are debounced so that
	 * dragging the window edge doesn't continuously restart accumulation.
	 */
	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;

		if ( width === 0 || height === 0 ) return;

		// Immediate: update display so the canvas doesn't look distorted
		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

		const renderWidth = width;
		const renderHeight = height;

		// Skip render target resize + reset if dimensions haven't changed
		if ( renderWidth === this._lastRenderWidth && renderHeight === this._lastRenderHeight ) return;

		// Debounce the expensive part: render target resize + convergence reset
		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = setTimeout( () => {

			this._applyRenderResize( renderWidth, renderHeight );

		}, 300 );

	}

	/**
	 * Apply the actual render target resize and trigger convergence reset.
	 * Called after the debounce period or directly for programmatic resolution changes.
	 * @param {number} renderWidth
	 * @param {number} renderHeight
	 */
	_applyRenderResize( renderWidth, renderHeight ) {

		this._lastRenderWidth = renderWidth;
		this._lastRenderHeight = renderHeight;

		// Propagate render dimensions to pipeline stages (adaptive sampling, etc.)
		if ( this.pipeline ) {

			this.pipeline.setSize( renderWidth, renderHeight );

		}

		// Resize denoiser canvas to match render dimensions
		this.denoiser?.setSize( renderWidth, renderHeight );

		this.needsReset = true;

		window.dispatchEvent( new CustomEvent( 'resolution_changed', { detail: { width: renderWidth, height: renderHeight } } ) );

	}

	/**
	 * Updates the canvas display size to match new dimensions.
	 * Canvas dimensions = render dimensions (pixel ratio 1.0).
	 * Called when the user changes canvas width/height via the UI.
	 * @param {number} width - New canvas width in pixels
	 * @param {number} height - New canvas height in pixels
	 */
	setCanvasSize( width, height ) {

		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;

		if ( this.denoiserCanvas ) {

			this.denoiserCanvas.style.width = `${width}px`;
			this.denoiserCanvas.style.height = `${height}px`;

		}

		// Immediate resize — no debounce since this is a deliberate user action
		if ( width === 0 || height === 0 ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

		clearTimeout( this._resizeDebounceTimer );
		this._applyRenderResize( width, height );

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		this.animationId = requestAnimationFrame( () => this.animate() );

		// Skip all rendering while scene data is being loaded or processed
		if ( this._loadingInProgress || this.sdf?.isProcessing ) {

			this.stats?.update();
			return;

		}

		// Update controls
		if ( this.controls ) {

			this.controls.update();

		}

		// Reset accumulation on camera change (soft: preserve ASVGF temporal history)
		if ( this.needsReset ) {

			this.reset( true );
			this.needsReset = false;

		}

		// Update camera matrix
		this.camera.updateMatrixWorld();

		// Raster fallback when path tracer is disabled entirely
		if ( ! this.pathTracerEnabled ) {

			this.renderer.render( this.meshScene, this.camera );
			this._renderHelperOverlay();
			return;

		}

		// Paused — keep the last rendered frame visible
		if ( this.pauseRendering ) return;

		// Render path tracing
		if ( this.pathTracingStage?.isReady ) {

			// Skip rendering and stats updates when render is already complete
			if ( this.pathTracingStage.isComplete && this._renderCompleteDispatched ) {

				// Still allow display-only refresh (e.g. outline on selection change)
				// without re-running path tracer or re-dispatching completion.
				if ( this._needsDisplayRefresh ) {

					this._needsDisplayRefresh = false;
					this.displayStage.render( this.pipeline.context );
					this._renderHelperOverlay();

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
				if ( this.denoiser?.enabled && this.denoiser?.output ) this.denoiser.output.style.display = 'block';
				this.denoiser?.start();
				this.dispatchEvent( { type: 'RenderComplete' } );
				useStore.getState().setIsRenderComplete( true );
				useStore.getState().setIsRendering( false );

			}

		}

		// Render light helpers as overlay on top of current frame
		this._renderHelperOverlay();

		this.stats?.update();

		// Resolve GPU timestamp queries to prevent query pool overflow
		this.renderer.resolveTimestampsAsync?.( TimestampQuery.RENDER );
		this.renderer.resolveTimestampsAsync?.( TimestampQuery.COMPUTE );

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
			console.log( 'PathTracerApp: Paused' );

		}

		if ( this.stats ) this.stats.dom.style.display = 'none';

	}

	/**
	 * Resumes the animation loop.
	 */
	resume() {

		if ( ! this.animationId ) {

			this.animate();
			console.log( 'PathTracerApp: Resumed' );

		}

		if ( this.stats ) this.stats.dom.style.display = '';

	}

	/**
	 * Resets the accumulation buffer.
	 * @param {boolean} soft - When true (camera movement), preserves ASVGF temporal history
	 */
	reset( soft = false ) {

		if ( this.pipeline ) {

			this.pipeline.reset();

			// Hard reset: scene/settings changed — clear ASVGF temporal history
			if ( ! soft ) {

				this.pipeline.eventBus.emit( 'asvgf:reset' );

			}

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
		useStore.getState().setIsRendering( true );

	}

	/**
	 * Sets the maximum number of bounces.
	 */
	setMaxBounces( bounces ) {

		this.maxBounces = bounces;
		this.pathTracingStage?.setUniform( 'maxBounces', bounces );
		this.reset();

	}

	setEnvironmentIntensity( intensity ) {

		this.environmentIntensity = intensity;
		this.pathTracingStage?.setUniform( 'environmentIntensity', intensity );
		this.reset();

	}

	setSamplesPerPixel( samples ) {

		this.samplesPerPixel = samples;
		this.pathTracingStage?.setUniform( 'samplesPerPixel', samples );
		this.reset();

	}

	setMaxSamples( samples ) {

		this.maxSamples = samples;
		this.pathTracingStage?.setUniform( 'maxSamples', samples );

	}

	setTransmissiveBounces( bounces ) {

		this.transmissiveBounces = bounces;
		this.pathTracingStage?.setUniform( 'transmissiveBounces', bounces );
		this.reset();

	}

	setBackgroundIntensity( intensity ) {

		this.backgroundIntensity = intensity;
		this.pathTracingStage?.setUniform( 'backgroundIntensity', intensity );
		this.reset();

	}

	/**
	 * Sets whether to show area light helpers.
	 */
	setShowLightHelper( show ) {

		this.sceneHelpers.visible = show;

		if ( show ) {

			this._syncLightHelpers();

		} else {

			this.sceneHelpers.clear();

		}

	}

	/**
	 * Syncs helpers in sceneHelpers with current scene lights.
	 */
	_syncLightHelpers() {

		if ( ! this.sceneHelpers.visible ) return;

		const lights = this.scene.getObjectsByProperty( 'isLight', true );
		this.sceneHelpers.sync( lights );

	}

	/**
	 * Renders light helpers as overlay. Call after DisplayStage.
	 */
	_renderHelperOverlay() {

		// Ensure light world matrices are up-to-date (this.scene is not rendered
		// by the rasterizer during path tracing, so matrixWorld may be stale).
		this.scene.updateMatrixWorld();
		this.sceneHelpers.render( this.renderer, this.camera );

	}

	setShowBackground( show ) {

		this.showBackground = show;
		this.pathTracingStage?.setUniform( 'showBackground', show );
		this.reset();

	}

	setTransparentBackground( enabled ) {

		this.transparentBackground = enabled;
		this.pathTracingStage?.setUniform( 'transparentBackground', enabled );
		this.displayStage?.setTransparentBackground( enabled );
		this.reset();

	}

	setEnableEnvironment( enable ) {

		this.enableEnvironment = enable;
		this.pathTracingStage?.setUniform( 'enableEnvironment', enable );
		this.reset();

	}

	setGlobalIlluminationIntensity( intensity ) {

		this.globalIlluminationIntensity = intensity;
		this.pathTracingStage?.setUniform( 'globalIlluminationIntensity', intensity );
		this.reset();

	}

	setExposure( exposure ) {

		this.exposure = exposure;
		this.displayStage?.setExposure( exposure );
		this.reset();

	}

	setEnableDOF( enable ) {

		this.enableDOF = enable;
		this.pathTracingStage?.setUniform( 'enableDOF', enable );
		this.reset();

	}

	setFocusDistance( distance ) {

		this.focusDistance = distance;
		this.pathTracingStage?.setUniform( 'focusDistance', distance );
		this.reset();

	}

	setFocalLength( length ) {

		this.focalLength = length;
		this.pathTracingStage?.setUniform( 'focalLength', length );
		this.reset();

	}

	setAperture( aperture ) {

		this.aperture = aperture;
		this.pathTracingStage?.setUniform( 'aperture', aperture );
		this.reset();

	}

	setSamplingTechnique( technique ) {

		this.samplingTechnique = technique;
		this.pathTracingStage?.setUniform( 'samplingTechnique', technique );
		this.reset();

	}

	setUseAdaptiveSampling( use ) {

		this.useAdaptiveSampling = use;
		this.pathTracingStage?.setUniform( 'useAdaptiveSampling', use );
		use ? this.adaptiveSamplingStage?.enable() : this.adaptiveSamplingStage?.disable();

		// AdaptiveSamplingStage reads variance:output from VarianceEstimationStage
		if ( use ) {

			this.varianceEstimationStage?.enable();

		} else if ( ! this.asvgfStage?.enabled ) {

			// Only disable if ASVGF (the other consumer) is also off
			this.varianceEstimationStage?.disable();

		}

		this.reset();

	}

	setAdaptiveSamplingMax( max ) {

		this.adaptiveSamplingMax = max;
		this.pathTracingStage?.setUniform( 'adaptiveSamplingMax', max );
		this.adaptiveSamplingStage?.setAdaptiveSamplingMax( max );
		this.reset();

	}

	setFireflyThreshold( threshold ) {

		this.fireflyThreshold = threshold;
		this.pathTracingStage?.setUniform( 'fireflyThreshold', threshold );
		this.reset();

	}

	setEnableEmissiveTriangleSampling( enable ) {

		this.enableEmissiveTriangleSampling = enable;
		this.pathTracingStage?.setUniform( 'enableEmissiveTriangleSampling', enable );
		this.reset();

	}

	setEmissiveBoost( boost ) {

		this.emissiveBoost = boost;
		this.pathTracingStage?.setUniform( 'emissiveBoost', boost );
		this.reset();

	}

	setVisMode( mode ) {

		this.visMode = mode;
		this.pathTracingStage?.setUniform( 'visMode', mode );
		this.reset();

	}

	setDebugVisScale( scale ) {

		this.debugVisScale = scale;
		this.pathTracingStage?.setUniform( 'debugVisScale', scale );

		this.reset();

	}

	updateMaterialProperty( materialIndex, property, value ) {

		this.pathTracingStage?.materialData.updateMaterialProperty( materialIndex, property, value );

		// Rebuild emissive triangle data when emissive/visibility properties change (only if sampling is enabled)
		const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity', 'visible' ];
		if ( emissiveAffectingProps.includes( property )
			&& this.sdf?.emissiveTriangleBuilder
			&& this.pathTracingStage?.enableEmissiveTriangleSampling?.value ) {

			const mat = this.sdf.materials[ materialIndex ];
			if ( mat ) {

				if ( property === 'emissive' ) {

					mat.emissive = value;

				} else if ( property === 'emissiveIntensity' ) {

					mat.emissiveIntensity = value;

				} else if ( property === 'visible' ) {

					mat.visible = value;

				}

				const changed = this.sdf.emissiveTriangleBuilder.updateMaterialEmissive(
					materialIndex, mat,
					this.sdf.triangleData, this.sdf.materials, this.sdf.triangleCount,
				);

				if ( changed ) {

					const emissiveRawData = this.sdf.emissiveTriangleBuilder.createEmissiveRawData();
					this.pathTracingStage.setEmissiveTriangleData(
						emissiveRawData,
						this.sdf.emissiveTriangleBuilder.emissiveCount,
						this.sdf.emissiveTriangleBuilder.totalEmissivePower,
					);

				}

			}

		}

		this.reset();

	}

	updateTextureTransform( materialIndex, textureName, transform ) {

		this.pathTracingStage?.materialData.updateTextureTransform( materialIndex, textureName, transform );

		this.reset();

	}

	refreshMaterial() {

		this.reset();

	}

	updateMaterial( materialIndex, material ) {

		this.pathTracingStage?.materialData.updateMaterial( materialIndex, material );

	}

	async rebuildMaterials( scene ) {

		await this.pathTracingStage?.rebuildMaterials( scene || this.meshScene );

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
	 * Syncs controls state after model load (AssetLoader updates camera/controls
	 * directly since it shares them with us).
	 */
	_syncControlsAfterLoad() {

		this.controls.saveState();
		this.controls.update();

	}

	// ─── Stub Methods (no-ops until implemented) ──

	/**
	 * Sets aperture scale.
	 */
	setApertureScale( scale ) {

		this.apertureScale = scale;
		// Aperture scale not yet implemented in path tracing stage
		this.reset();

	}

	/**
	 * Sets render mode.
	 * @param {number} mode - 0 = progressive (full-screen), 1 = tiled
	 */
	setRenderMode( mode ) {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.setUniform( 'renderMode', parseInt( mode ) );

		}

	}

	/**
	 * Loads a model, builds BVH, and uploads scene data.
	 * @param {string} url - Model URL
	 */
	async loadModel( url ) {

		this._loadingInProgress = true;

		try {

			await this.assetLoader.loadModel( url );
			this._syncControlsAfterLoad();
			await this.loadSceneData();
			this.reset();
			this.currentCameraIndex = 0;
			this.dispatchEvent( { type: 'ModelLoaded', url } );
			this.dispatchEvent( {
				type: 'CamerasUpdated',
				cameras: this.cameras,
				cameraNames: this.getCameraNames()
			} );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Loads an environment map and rebuilds CDF.
	 * @param {string} url - Environment URL
	 */
	async loadEnvironment( url ) {

		this._loadingInProgress = true;

		try {

			await this.assetLoader.loadEnvironment( url );

			const environmentTexture = this.meshScene.environment;
			if ( environmentTexture && this.pathTracingStage ) {

				await this.pathTracingStage.environment.setEnvironmentMap( environmentTexture );

			}

			this.reset();
			this.dispatchEvent( { type: 'EnvironmentLoaded', url } );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Loads example models by index.
	 * @param {number} index - Example model index
	 */
	async loadExampleModels( index ) {

		this._loadingInProgress = true;

		try {

			await this.assetLoader.loadExampleModels( index );
			this._syncControlsAfterLoad();
			await this.loadSceneData();
			this.reset();
			this.currentCameraIndex = 0;
			this.dispatchEvent( { type: 'ModelLoaded', index } );
			this.dispatchEvent( {
				type: 'CamerasUpdated',
				cameras: this.cameras,
				cameraNames: this.getCameraNames()
			} );

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
	 * Switch to a camera by index.
	 * @param {number} index - Camera index
	 */
	switchCamera( index ) {

		if ( ! this.cameras || this.cameras.length === 0 ) return;

		if ( index < 0 || index >= this.cameras.length ) {

			console.warn( `WebGPU: Invalid camera index ${index}. Using default camera.` );
			index = 0;

		}

		// Save default camera state before switching away from it.
		// this.cameras[0] === this.camera, so copying model-camera
		// properties into this.camera would destroy the default state.
		if ( this.currentCameraIndex === 0 && index !== 0 ) {

			this._defaultCameraState = {
				position: this.camera.position.clone(),
				quaternion: this.camera.quaternion.clone(),
				fov: this.camera.fov,
				near: this.camera.near,
				far: this.camera.far,
				target: this.controls ? this.controls.target.clone() : null,
			};

		}

		this.currentCameraIndex = index;

		if ( index === 0 && this._defaultCameraState ) {

			// Restore the default camera to its state before the switch
			const s = this._defaultCameraState;
			this.camera.position.copy( s.position );
			this.camera.quaternion.copy( s.quaternion );
			this.camera.fov = s.fov;
			this.camera.near = s.near;
			this.camera.far = s.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			if ( this.controls && s.target ) {

				this.controls.target.copy( s.target );
				this.controls.update();

			}

		} else {

			const sourceCamera = this.cameras[ index ];

			// Copy camera properties from the source (world-space transforms
			// were baked into extracted cameras during extraction).
			this.camera.position.copy( sourceCamera.position );
			this.camera.quaternion.copy( sourceCamera.quaternion );
			this.camera.fov = sourceCamera.fov;
			this.camera.near = sourceCamera.near;
			this.camera.far = sourceCamera.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			// Place the orbit target along the camera's forward direction
			// so OrbitControls doesn't overwrite the position on its next update().
			if ( this.controls ) {

				const forward = new Vector3( 0, 0, - 1 ).applyQuaternion( sourceCamera.quaternion );
				const focusDist = this.focusDistance || 5.0;
				this.controls.target.copy( this.camera.position ).addScaledVector( forward, focusDist );

				this.controls.update();

			}

		}

		this.onResize();
		this.reset();
		this.dispatchEvent( { type: 'CameraSwitched', cameraIndex: index } );

	}

	/**
	 * Returns camera names from the app's camera list.
	 * @returns {string[]}
	 */
	getCameraNames() {

		const cameras = this.cameras;
		if ( ! cameras || cameras.length === 0 ) return [ 'Default Camera' ];

		return cameras.map( ( camera, index ) => {

			if ( index === 0 ) {

				return 'Default Camera';

			} else {

				return camera.name || `Camera ${index}`;

			}

		} );

	}

	/**
	 * Adds a light to the scene and updates the path tracer.
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
		this._syncLightHelpers();
		this.reset();

		const descriptor = {
			uuid: light.uuid,
			name: light.name,
			type: light.type,
			intensity: light.intensity,
			color: `#${light.color.getHexString()}`,
			position: [ light.position.x, light.position.y, light.position.z ],
			angle: light.angle
		};

		if ( type === 'RectAreaLight' ) {

			descriptor.width = light.width;
			descriptor.height = light.height;
			const dir = light.getWorldDirection( light.position.clone() );
			descriptor.target = [ light.position.x + dir.x, light.position.y + dir.y, light.position.z + dir.z ];

		}

		return descriptor;

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

		this.sceneHelpers.remove( light );
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

		this.sceneHelpers.clear();
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

			const descriptor = {
				uuid: light.uuid,
				name: light.name,
				type: light.type,
				intensity: light.intensity,
				color: `#${light.color.getHexString()}`,
				position: [ light.position.x, light.position.y, light.position.z ],
				angle: angle
			};

			if ( light.type === 'RectAreaLight' ) {

				descriptor.width = light.width;
				descriptor.height = light.height;
				const dir = light.getWorldDirection( light.position.clone() );
				descriptor.target = [ light.position.x + dir.x, light.position.y + dir.y, light.position.z + dir.z ];

			} else if ( light.type === 'SpotLight' && light.target ) {

				descriptor.target = [ light.target.position.x, light.target.position.y, light.target.position.z ];

			}

			return descriptor;

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

			// Re-render display stage so the WebGPU canvas has valid content
			// (WebGPU canvases expire their texture after each compositor frame)
			if ( canvas === this.renderer.domElement && this.displayStage && this.pipeline?.context ) {

				this.displayStage.render( this.pipeline.context );

			}

			const screenshot = canvas.toDataURL( 'image/png' );
			const link = document.createElement( 'a' );
			link.href = screenshot;
			link.download = 'screenshot.png';
			link.click();

		} catch ( error ) {

			console.error( 'PathTracerApp: Screenshot failed:', error );

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

		this.pathTracerEnabled = val;

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
	 * Sets tile count for tiled rendering.
	 * @param {number} val - Tiles per row/column (e.g., 3 = 3x3 = 9 tiles)
	 */
	setTileCount( val ) {

		if ( this.pathTracingStage?.tileManager ) {

			this.pathTracingStage.tileManager.setTileCount( val );

		}

	}

	setRenderLimitMode( val ) {

		this.renderLimitMode = val;
		if ( this.pathTracingStage?.setRenderLimitMode ) {

			this.pathTracingStage.setRenderLimitMode( val );

		}

	}

	setEnvironmentRotation( val ) {

		this.environmentRotation = val;
		this.pathTracingStage.environment.setEnvironmentRotation( val );

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
	 * Set adaptive sampling parameters on both stages.
	 * @param {Object} params - Parameters to update
	 * @param {number} [params.min] - Min samples (PathTracingStage)
	 * @param {number} [params.threshold] - Variance threshold (AdaptiveSamplingStage)
	 * @param {number} [params.materialBias] - Material bias (AdaptiveSamplingStage)
	 * @param {number} [params.edgeBias] - Edge bias (AdaptiveSamplingStage)
	 * @param {number} [params.convergenceSpeedUp] - Convergence speed (AdaptiveSamplingStage)
	 * @param {number} [params.adaptiveSamplingMax] - Max samples (both stages)
	 */
	setAdaptiveSamplingParameters( params ) {

		if ( params.min !== undefined ) {

			this.pathTracingStage?.setAdaptiveSamplingMin( params.min );

		}

		if ( params.adaptiveSamplingMax !== undefined ) {

			this.setAdaptiveSamplingMax( params.adaptiveSamplingMax );

		}

		this.adaptiveSamplingStage?.setAdaptiveSamplingParameters( params );

	}

	// ── Environment mode helpers ──

	/** Returns envParams from the path tracing stage. */
	getEnvParams() {

		return this.pathTracingStage?.environment?.envParams ?? null;

	}

	/** Returns the current environment texture. */
	getEnvironmentTexture() {

		return this.pathTracingStage?.environment?.environmentTexture ?? null;

	}

	/** Returns the current environment CDF texture — not yet supported. */
	getEnvironmentCDF() {

		return null;

	}

	async generateProceduralSkyTexture() {

		return this.pathTracingStage?.environment.generateProceduralSkyTexture();

	}

	async generateGradientTexture() {

		return this.pathTracingStage?.environment.generateGradientTexture();

	}

	async generateSolidColorTexture() {

		return this.pathTracingStage?.environment.generateSolidColorTexture();

	}

	async setEnvironmentMap( texture ) {

		if ( ! this.pathTracingStage ) {

			console.warn( 'PathTracerApp: PathTracingStage not initialized' );
			return;

		}

		await this.pathTracingStage.environment.setEnvironmentMap( texture );
		this.reset();

	}

	/** Marks the environment texture as needing a GPU re-upload. */
	markEnvironmentNeedsUpdate() {

		const tex = this.pathTracingStage?.environment?.environmentTexture;
		if ( tex ) tex.needsUpdate = true;

	}

	/**
	 * Returns scene statistics from the path tracing stage, or null.
	 * @returns {object|null}
	 */
	getSceneStatistics() {

		try {

			return this.sdf?.getStatistics?.() ?? null;

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

		this.sceneHelpers.clear();

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

		clearTimeout( this._resizeDebounceTimer );
		window.removeEventListener( 'resize', this.resizeHandler );

		this.isInitialized = false;

	}

}

