import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import {
	ACESFilmicToneMapping, PerspectiveCamera, Scene, EventDispatcher,
	Mesh, CircleGeometry, MeshPhysicalMaterial, TimestampQuery
} from 'three';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SceneHelpers } from './SceneHelpers.js';
import Stats from 'stats-gl';
import { PathTracer } from './Stages/PathTracer.js';
import { NormalDepth } from './Stages/NormalDepth.js';
import { MotionVector } from './Stages/MotionVector.js';
import { ASVGF } from './Stages/ASVGF.js';
import { Variance } from './Stages/Variance.js';
import { BilateralFilter } from './Stages/BilateralFilter.js';
import { AdaptiveSampling } from './Stages/AdaptiveSampling.js';
import { EdgeFilter } from './Stages/EdgeFilter.js';
import { AutoExposure } from './Stages/AutoExposure.js';
import { SSRC } from './Stages/SSRC.js';
import { Display } from './Stages/Display.js';
import { RenderPipeline } from './Pipeline/RenderPipeline.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, FINAL_RENDER_CONFIG, PREVIEW_RENDER_CONFIG } from './EngineDefaults.js';
import { updateStats, updateLoading, resetLoading, setStatusCallback, getDisplaySamples } from './Processor/utils.js';
import { BuildTimer } from './Processor/BuildTimer.js';
import { InteractionManager } from './managers/InteractionManager.js';
import { EngineEvents } from './EngineEvents.js';
import { AssetLoader } from './Processor/AssetLoader.js';
import { SceneProcessor } from './Processor/SceneProcessor.js';

// Managers
import { RenderSettings } from './RenderSettings.js';
import { CameraManager } from './managers/CameraManager.js';
import { LightManager } from './managers/LightManager.js';
import { DenoisingManager } from './managers/DenoisingManager.js';
import { OverlayManager } from './managers/OverlayManager.js';
import { AnimationManager } from './managers/AnimationManager.js';
import { TransformManager } from './managers/TransformManager.js';
import { TileHelper } from './managers/helpers/TileHelper.js';
import { OutlineHelper } from './managers/helpers/OutlineHelper.js';


/**
 * WebGPU Path Tracer Application.
 *
 * Thin facade that delegates to focused managers:
 * - {@link RenderSettings} — single source of truth for all render parameters
 * - {@link CameraManager} — camera switching, auto-focus, DOF
 * - {@link LightManager} — light CRUD, helpers, GPU transfer
 * - {@link DenoisingManager} — denoiser strategy, OIDN, AI upscaler
 *
 * Extends EventDispatcher for event-driven communication with stores/UI.
 */
export class PathTracerApp extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {HTMLCanvasElement} [denoiserCanvas] - Optional canvas for OIDN denoiser output
	 * @param {Object} [options] - Engine options
	 * @param {boolean} [options.autoResize=true] - Automatically listen for window resize events
	 * @param {HTMLElement} [options.statsContainer] - DOM element to append the stats panel to (defaults to document.body)
	 */
	constructor( canvas, denoiserCanvas = null, options = {} ) {

		super();

		this.canvas = canvas;
		this.denoiserCanvas = denoiserCanvas;
		this._autoResize = options.autoResize !== false;
		this._statsContainer = options.statsContainer || null;

		// ── Settings (single source of truth for all render parameters) ──
		this.settings = new RenderSettings( DEFAULT_STATE );

		// ── Core objects (populated in init) ──
		this.renderer = null;
		this._camera = null;
		this.scene = null;
		this.meshScene = null;
		this._sceneHelpers = null;
		this._controls = null;

		// ── Asset pipeline ──
		this.assetLoader = null;
		this._sdf = null;
		this.animationManager = new AnimationManager();
		this._animRefitInFlight = false;

		// ── Pipeline & stages ──
		this.pipeline = null;

		/**
		 * Named access to all pipeline stages.
		 * Advanced consumers can reach into stages for fine-grained control.
		 * @type {Object}
		 */
		this.stages = {};

		// ── Managers (populated in init) ──
		this.cameraManager = null;
		this.lightManager = null;
		this.denoisingManager = null;
		this.overlayManager = null;

		// ── State ──
		this.isInitialized = false;
		this.pauseRendering = false;
		this.pathTracerEnabled = true;
		this.animationId = null;
		this.needsReset = false;
		this._renderCompleteDispatched = false;
		this._loadingInProgress = false;
		this._needsDisplayRefresh = false;
		this._paused = false;

		// Stats tracking
		this.lastResetTime = performance.now();
		this.timeElapsed = 0;

		// Resolution state
		this._lastRenderWidth = 0;
		this._lastRenderHeight = 0;
		this._resizeDebounceTimer = null;

	}

	// ═══════════════════════════════════════════════════════════════
	// Settings API — unified parameter access
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Sets a render parameter. Replaces all individual setXxx() methods.
	 * @param {string} key   - Setting key (e.g. 'maxBounces', 'exposure')
	 * @param {*}      value - New value
	 * @param {Object}  [options]
	 * @param {boolean} [options.reset]  - Override default reset behavior
	 * @param {boolean} [options.silent] - Suppress settingChanged event
	 */
	set( key, value, options ) {

		this.settings.set( key, value, options );

	}

	/**
	 * Batch-update multiple settings. Only resets once.
	 * @param {Object} updates - Key/value pairs
	 * @param {Object} [options]
	 */
	setMany( updates, options ) {

		this.settings.setMany( updates, options );

	}

	/**
	 * Reads the current value of a setting.
	 * @param {string} key
	 * @returns {*}
	 */
	get( key ) {

		return this.settings.get( key );

	}

	/**
	 * Returns a snapshot of all current settings.
	 * @returns {Object}
	 */
	getAll() {

		return this.settings.getAll();

	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Initializes the WebGPU renderer, pipeline stages, and managers.
	 */
	async init() {

		// Wire loading/stats utilities to dispatch events through this app instance
		setStatusCallback( ( event ) => this.dispatchEvent( event ) );

		// Check WebGPU support
		if ( ! navigator.gpu ) {

			throw new Error( 'WebGPU is not supported in this browser' );

		}

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

		await this.renderer.init();

		// Initialize LTC textures required by RectAreaLight in WebGPU renderer
		RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );

		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		this.renderer.setPixelRatio( 1.0 );

		// Setup camera
		this._camera = new PerspectiveCamera( 60, width / height || 1, 0.01, 1000 );
		this._camera.position.set( 0, 0, 5 );

		// Create scenes
		this.scene = new Scene();
		this.meshScene = new Scene();
		this._sceneHelpers = new SceneHelpers();

		// Setup orbit controls
		this._controls = new OrbitControls( this._camera, this.canvas );
		this._controls.screenSpacePanning = true;
		this._controls.zoomToCursor = true;
		this._controls.saveState();

		// Asset pipeline
		this._sdf = new SceneProcessor();
		this.assetLoader = new AssetLoader( this.meshScene, this._camera, this._controls );
		this._setupFloorPlane();
		this.assetLoader.setFloorPlane( this._floorPlane );

		// Track camera movement for reset
		this._controls.addEventListener( 'change', () => {

			this.needsReset = true;
			this.wake();

		} );

		// ── Create pipeline stages ──
		this._createStages();

		// ── Pipeline orchestration ──
		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new RenderPipeline( this.renderer, w || 1, h || 1 );
		this.pipeline.addStage( this.stages.pathTracer );
		this.pipeline.addStage( this.stages.normalDepth );
		this.pipeline.addStage( this.stages.motionVector );
		this.pipeline.addStage( this.stages.ssrc );
		this.pipeline.addStage( this.stages.asvgf );
		this.pipeline.addStage( this.stages.variance );
		this.pipeline.addStage( this.stages.bilateralFilter );
		this.pipeline.addStage( this.stages.adaptiveSampling );
		this.pipeline.addStage( this.stages.edgeFilter );
		this.pipeline.addStage( this.stages.autoExposure );
		this.pipeline.addStage( this.stages.display );

		// Set initial render dimensions
		const initRenderW = width || 1;
		const initRenderH = height || 1;
		this.pipeline.setSize( initRenderW, initRenderH );
		this._lastRenderWidth = initRenderW;
		this._lastRenderHeight = initRenderH;

		// ── Interaction manager ──
		this._interactionManager = new InteractionManager( {
			scene: this.meshScene,
			camera: this._camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracer: null,
			floorPlane: this._floorPlane
		} );
		this._setupInteractionListeners();

		// ── Managers ──
		this.cameraManager = new CameraManager( this._camera, this._controls, this._interactionManager );
		this.lightManager = new LightManager( this.scene, this._sceneHelpers, this.stages.pathTracer );
		this._setupDenoisingManager();
		this._setupOverlayManager();

		// ── Transform controls ──
		this._transformManager = new TransformManager( {
			camera: this._camera,
			canvas: this.canvas,
			orbitControls: this._controls,
			app: this,
		} );

		// Wire CameraManager events → app events
		this.cameraManager.addEventListener( 'CameraSwitched', ( e ) => this.dispatchEvent( e ) );
		this.cameraManager.addEventListener( EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => this.dispatchEvent( e ) );

		// Wire DenoisingManager events → app events
		this._forwardEvents( this.denoisingManager, [
			EngineEvents.DENOISING_START, EngineEvents.DENOISING_END,
			EngineEvents.UPSCALING_START, EngineEvents.UPSCALING_PROGRESS, EngineEvents.UPSCALING_END,
			'resolution_changed',
		] );

		// Set up auto-exposure event listener
		this._setupAutoExposureListener();

		// ── Stable auto-focus context (avoid per-frame allocation) ──
		this._autoFocusContext = {
			meshScene: this.meshScene,
			assetLoader: this.assetLoader,
			floorPlane: this._floorPlane,
			get currentFocusDistance() {

				return null;

			}, // replaced below
			pathTracer: this.stages.pathTracer,
			setFocusDistance: ( d ) => this.settings.set( 'focusDistance', d, { silent: true } ),
			softReset: () => this.reset( true ),
			hardReset: () => this.reset(),
		};

		// Use a getter so currentFocusDistance reads live value without allocation
		const settingsRef = this.settings;
		Object.defineProperty( this._autoFocusContext, 'currentFocusDistance', {
			get: () => settingsRef.get( 'focusDistance' ),
		} );

		// ── Bind RenderSettings ──
		this.settings.bind( {
			pathTracer: this.stages.pathTracer,
			resetCallback: () => this.reset(),
			handlers: this._buildSettingsHandlers(),
			delegates: {},
		} );

		// ── Resize handling ──
		this.onResize();
		this.resizeHandler = () => this.onResize();
		if ( this._autoResize ) {

			window.addEventListener( 'resize', this.resizeHandler );

		}

		// ── Asset load events ──
		this._onAssetLoaded = async ( event ) => {

			if ( this._loadingInProgress ) return;

			if ( event.model ) {

				await this.loadSceneData();

			} else if ( event.texture ) {

				const envTexture = this.meshScene.environment;
				if ( envTexture && this.stages.pathTracer ) {

					await this.stages.pathTracer.environment.setEnvironmentMap( envTexture );

				}

				resetLoading();

			}

			this.pauseRendering = false;
			this.reset();

		};

		this.assetLoader.addEventListener( 'load', this._onAssetLoaded );

		this.assetLoader.addEventListener( 'modelProcessed', ( event ) => {

			const cameras = [ this._camera, ...( event.cameras || [] ) ];
			this.cameraManager.setCameras( cameras );

			this._floorPlane = this.assetLoader.floorPlane;
			if ( this._interactionManager ) {

				this._interactionManager.floorPlane = this._floorPlane;

			}

		} );

		// Seed path tracer with minimal empty scene data
		this.stages.pathTracer.setTriangleData( new Float32Array( 32 ), 0 );
		this.stages.pathTracer.setBVHData( new Float32Array( 16 ) );
		this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
		this.stages.pathTracer.setupMaterial();

		// Setup stats panel
		this._initStats();

		this.isInitialized = true;
		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		this.animationId = requestAnimationFrame( () => this.animate() );

		if ( this._loadingInProgress || this._sdf?.isProcessing ) {

			this._stats?.update();
			return;

		}

		if ( this._controls ) this._controls.update();

		// Animation playback: compute skinned positions and refit BVH.
		// Guard prevents overlapping async refits (fire-and-forget with 1-frame latency).
		if ( this.animationManager?.isPlaying && ! this._animRefitInFlight ) {

			const positions = this.animationManager.update();
			if ( positions ) {

				this._animRefitInFlight = true;
				this.refitBVH( positions )
					.catch( err => console.error( 'Animation refit error:', err ) )
					.finally( () => {

						this._animRefitInFlight = false;

					} );

			}

		}

		if ( this.needsReset ) {

			this.reset( true );
			this.needsReset = false;

		}

		this._camera.updateMatrixWorld();

		// Raster fallback when path tracer is disabled
		if ( ! this.pathTracerEnabled ) {

			this.renderer.render( this.meshScene, this._camera );
			this._renderHelperOverlay();
			return;

		}

		if ( this.pauseRendering ) return;

		// Auto-focus: compute focus distance before rendering
		this.cameraManager.updateAutoFocus( this._autoFocusContext );

		// Render path tracing
		if ( this.stages.pathTracer?.isReady ) {

			if ( this.stages.pathTracer.isComplete && this._renderCompleteDispatched ) {

				if ( this._needsDisplayRefresh ) {

					this._needsDisplayRefresh = false;
					this.stages.display.render( this.pipeline.context );
					this._renderHelperOverlay();

				}

				// Stop the loop to avoid constant CPU usage while idle
				this.stopAnimation();
				return;

			}

			this.pipeline.render();

			if ( ! this.stages.pathTracer.isComplete ) {

				this.timeElapsed = ( performance.now() - this.lastResetTime ) / 1000;

			}

			updateStats( { timeElapsed: this.timeElapsed, samples: getDisplaySamples( this.stages.pathTracer ) } );

			// Check time limit
			const renderLimitMode = this.settings.get( 'renderLimitMode' );
			const renderTimeLimit = this.settings.get( 'renderTimeLimit' );
			if ( renderLimitMode === 'time' && renderTimeLimit > 0 && this.timeElapsed >= renderTimeLimit ) {

				this.stages.pathTracer.isComplete = true;

			}

			// Render completion → denoise/upscale chain
			if ( this.stages.pathTracer.isComplete && ! this._renderCompleteDispatched ) {

				this._renderCompleteDispatched = true;

				this.denoisingManager.onRenderComplete( {
					isStillComplete: () => this._renderCompleteDispatched,
					context: this.pipeline?.context,
				} );

				this.dispatchEvent( { type: 'RenderComplete' } );
				this.dispatchEvent( { type: EngineEvents.RENDER_COMPLETE } );

			}

		}

		this._renderHelperOverlay();
		this._stats?.update();

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

	/** Wakes the animation loop if it was stopped due to idle. */
	wake() {

		if ( ! this.animationId && this.isInitialized && ! this._paused ) this.animate();

	}

	/** Pauses the animation loop. */
	pause() {

		this._paused = true;
		this.stopAnimation();
		if ( this._stats ) this._stats.dom.style.display = 'none';

	}

	/** Resumes the animation loop. */
	resume() {

		this._paused = false;
		if ( ! this.animationId ) this.animate();
		if ( this._stats ) this._stats.dom.style.display = '';

	}

	/**
	 * Resets the accumulation buffer.
	 * @param {boolean} soft - When true, preserves ASVGF temporal history
	 */
	reset( soft = false ) {

		if ( this.pipeline ) {

			this.pipeline.reset();
			if ( ! soft ) this.pipeline.eventBus.emit( 'asvgf:reset' );

		}

		// Abort post-processing
		this.denoisingManager?.abort( this.canvas );

		// Restore denoiser canvas to base render resolution
		if ( this.denoiserCanvas && this._lastRenderWidth && this._lastRenderHeight ) {

			const wasResized = this.denoiserCanvas.width !== this._lastRenderWidth
				|| this.denoiserCanvas.height !== this._lastRenderHeight;

			this.denoiserCanvas.width = this._lastRenderWidth;
			this.denoiserCanvas.height = this._lastRenderHeight;

			if ( wasResized ) {

				this.dispatchEvent( { type: 'resolution_changed', width: this._lastRenderWidth, height: this._lastRenderHeight } );

			}

		}

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this._renderCompleteDispatched = false;
		this.wake();
		this.dispatchEvent( { type: 'RenderReset' } );
		this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		this.animationManager?.dispose();
		this.stopAnimation();
		setStatusCallback( null );

		if ( this.assetLoader && this._onAssetLoaded ) {

			this.assetLoader.removeEventListener( 'load', this._onAssetLoaded );

		}

		this._transformManager?.dispose();
		this.overlayManager?.dispose();
		this._sceneHelpers?.clear();
		this.denoisingManager?.dispose();
		this.pipeline?.dispose();
		this._interactionManager?.dispose();
		this._controls?.dispose();
		this.renderer?.dispose();

		if ( this._stats ) {

			this._stats.dom.remove();
			this._stats = null;

		}

		clearTimeout( this._resizeDebounceTimer );
		window.removeEventListener( 'resize', this.resizeHandler );

		this.isInitialized = false;

	}

	// ═══════════════════════════════════════════════════════════════
	// Asset Loading
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Loads a model, builds BVH, and uploads scene data.
	 * @param {string} url - Model URL
	 */
	async loadModel( url ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadModel( url ),
			{ type: 'ModelLoaded', url }
		);

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
			if ( environmentTexture && this.stages.pathTracer ) {

				await this.stages.pathTracer.environment.setEnvironmentMap( environmentTexture );

			}

			this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
			this.reset();
			this.dispatchEvent( { type: 'EnvironmentLoaded', url } );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Loads example models by index.
	 * @param {number} index
	 * @param {Array} modelFiles
	 */
	async loadExampleModels( index, modelFiles ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadExampleModels( index, modelFiles ),
			{ type: 'ModelLoaded', index }
		);

	}

	/** Shared pipeline: load asset → sync controls → build BVH → reset → dispatch events */
	async _loadWithSceneRebuild( loadFn, eventPayload ) {

		this._loadingInProgress = true;

		try {

			await loadFn();
			this._syncControlsAfterLoad();
			await this.loadSceneData();
			this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
			this.reset();
			this.cameraManager.currentCameraIndex = 0;
			this.dispatchEvent( eventPayload );
			this.dispatchEvent( {
				type: 'CamerasUpdated',
				cameras: this.cameraManager.cameras,
				cameraNames: this.cameraManager.getCameraNames()
			} );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Builds BVH from meshScene and uploads all scene data to the path tracer.
	 * @returns {boolean}
	 */
	async loadSceneData() {

		// Stop any running animation before rebuilding scene data
		this.animationManager.dispose();
		this._animRefitInFlight = false;

		const timer = new BuildTimer( 'loadSceneData' );
		const environmentTexture = this.meshScene.environment;

		// Environment CDF build in parallel with BVH
		let cdfPromise = null;
		if ( environmentTexture?.image?.data ) {

			timer.start( 'Environment CDF build (worker)' );
			this.stages.pathTracer.scene.environment = environmentTexture;
			cdfPromise = this.stages.pathTracer.environment.buildEnvironmentCDF()
				.then( () => timer.end( 'Environment CDF build (worker)' ) );

		}

		// Build BVH
		timer.start( 'BVH build (SceneProcessor)' );
		await this._sdf.buildBVH( this.meshScene );
		timer.end( 'BVH build (SceneProcessor)' );

		const { triangleData, triangleCount, bvhData, materialData } = this._sdf;

		if ( ! triangleData ) {

			console.error( 'PathTracerApp: Failed to get triangle data' );
			return false;

		}

		updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'GPU data transfer' );
		this.stages.pathTracer.setTriangleData( triangleData, triangleCount );

		if ( ! bvhData ) {

			console.error( 'PathTracerApp: Failed to get BVH data' );
			return false;

		}

		this.stages.pathTracer.setBVHData( bvhData );

		if ( materialData ) {

			this.stages.pathTracer.materialData.setMaterialData( materialData );

		} else {

			console.warn( 'PathTracerApp: No material data, using defaults' );

		}

		if ( environmentTexture ) {

			this.stages.pathTracer.environment.setEnvironmentTexture( environmentTexture );

		}

		// Transfer material texture arrays
		this.stages.pathTracer.materialData.setMaterialTextures( {
			albedoMaps: this._sdf.albedoTextures,
			normalMaps: this._sdf.normalTextures,
			bumpMaps: this._sdf.bumpTextures,
			roughnessMaps: this._sdf.roughnessTextures,
			metalnessMaps: this._sdf.metalnessTextures,
			emissiveMaps: this._sdf.emissiveTextures,
			displacementMaps: this._sdf.displacementTextures,
		} );

		// Emissive triangle data
		if ( this._sdf.emissiveTriangleData ) {

			this.stages.pathTracer.setEmissiveTriangleData(
				this._sdf.emissiveTriangleData,
				this._sdf.emissiveTriangleCount,
				this._sdf.emissiveTotalPower,
			);

		}

		// Light BVH data
		if ( this._sdf.lightBVHNodeData ) {

			this.stages.pathTracer.setLightBVHData(
				this._sdf.lightBVHNodeData,
				this._sdf.lightBVHNodeCount,
			);

		}

		// Transfer lights
		this.lightManager.transferSceneLights( this.meshScene );
		timer.end( 'GPU data transfer' );

		// Compile shaders
		updateLoading( { status: "Compiling shaders...", progress: 90 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'Material setup (TSL compile)' );
		this.stages.pathTracer.setupMaterial();
		timer.end( 'Material setup (TSL compile)' );

		// Wait for CDF
		if ( cdfPromise ) {

			updateLoading( { status: "Finalizing environment map...", progress: 95 } );
			await cdfPromise;
			this.stages.pathTracer.environment.applyCDFResults();

		}

		// Apply all settings to stages in one shot
		timer.start( 'Apply settings' );
		this.settings.applyAll();
		this.stages.display.setTransparentBackground( this.settings.get( 'transparentBackground' ) );
		timer.end( 'Apply settings' );

		timer.print();
		resetLoading();

		// Initialize animation manager if GLTF has animation clips.
		// scene = meshScene (for full matrixWorld updates including parent chain)
		// mixerRoot = targetModel (GLTF model root, for animation track name resolution)
		const animations = this.assetLoader?.animations || [];
		if ( animations.length > 0 ) {

			const mixerRoot = this.assetLoader?.targetModel || this.meshScene;
			this.animationManager.init( this.meshScene, mixerRoot, this._sdf.meshes, animations, this._sdf.triangleCount );
			this.animationManager.onFinished = () => {

				this._animRefitInFlight = false;
				this.dispatchEvent( { type: EngineEvents.ANIMATION_FINISHED } );

			};

		}

		// Initialize transform manager mesh data for BVH refit on object transforms
		this._transformManager?.setMeshData( this._sdf.meshes, this._sdf.triangleCount );

		this.dispatchEvent( { type: 'SceneRebuild' } );
		return true;

	}

	// ═══════════════════════════════════════════════════════════════
	// BVH Refit (Animation)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Update vertex positions for animation without full BVH rebuild.
	 * O(N) bottom-up AABB refit instead of O(N log N) SAH rebuild.
	 *
	 * Topology must stay the same (same triangle count and connectivity).
	 * Call this per-frame for skeletal/morph-target animation.
	 *
	 * @param {Float32Array} newPositions - 9 floats per triangle (ax,ay,az, bx,by,bz, cx,cy,cz) in original mesh order
	 * @param {Float32Array} [newNormals] - Optional 9 floats per triangle smooth normals. If omitted, face normals are computed from positions.
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	async refitBVH( newPositions, newNormals ) {

		const result = await this._sdf.refitBVH( newPositions, newNormals );

		this.stages.pathTracer.updateTriangleData( this._sdf.triangleData );
		this.stages.pathTracer.updateBVHData( this._sdf.bvhData );
		this.reset();

		return result;

	}

	/**
	 * Refit specific mesh BLASes and rebuild TLAS after object transform.
	 * Faster than refitBVH for single-object transforms in multi-mesh scenes.
	 *
	 * @param {number[]} affectedMeshIndices - Mesh indices to refit
	 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order
	 * @param {Float32Array} [newNormals] - Optional smooth normals
	 * @returns {{ refitTimeMs: number }}
	 */
	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		const result = this._sdf.refitBLASes( affectedMeshIndices, newPositions, newNormals );

		// Compute dirty ranges for partial GPU upload instead of full buffer copy
		const instanceTable = this._sdf.instanceTable;
		const triRanges = [];
		const bvhRanges = [];
		const FPT = 32; // FLOATS_PER_TRIANGLE
		const FPN = 16; // FLOATS_PER_NODE

		for ( const meshIdx of affectedMeshIndices ) {

			const entry = instanceTable.entries[ meshIdx ];
			if ( ! entry ) continue;

			triRanges.push( {
				offset: entry.triOffset * FPT,
				count: entry.triCount * FPT
			} );

			bvhRanges.push( {
				offset: entry.blasOffset * FPN,
				count: entry.blasNodeCount * FPN
			} );

		}

		// Always include TLAS range (rebuilt on every refit)
		bvhRanges.push( {
			offset: 0,
			count: instanceTable.tlasNodeCount * FPN
		} );

		this.stages.pathTracer.updateBufferRanges( triRanges, bvhRanges );
		this.reset();

		// Kick off background rebuild for optimal SAH quality
		this._sdf.scheduleBackgroundRebuild( affectedMeshIndices, () => {

			// Swap complete — upload updated buffers and restart accumulation
			this.stages.pathTracer.updateTriangleData( this._sdf.triangleData );
			this.stages.pathTracer.updateBVHData( this._sdf.bvhData );
			this.reset();

		} );

		return result;

	}

	/**
	 * Start playing a GLTF animation clip.
	 * @param {number} [clipIndex=0] - Clip index, or -1 to play all
	 */
	playAnimation( clipIndex = 0 ) {

		if ( ! this.animationManager?.hasAnimations ) {

			console.warn( 'playAnimation: No animation clips available' );
			return;

		}

		this.animationManager.play( clipIndex );
		this.wake();
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STARTED, clipIndex } );

	}

	/**
	 * Pause animation — preserves current time position.
	 */
	pauseAnimation() {

		this.animationManager?.pause();
		this._animRefitInFlight = false;
		this.dispatchEvent( { type: EngineEvents.ANIMATION_PAUSED } );

	}

	/**
	 * Resume animation from paused state.
	 */
	resumeAnimation() {

		this.animationManager?.resume();
		this.wake();
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STARTED } );

	}

	/**
	 * Stop animation — resets to beginning.
	 */
	stopAnimationPlayback() {

		this.animationManager?.stop();
		this._animRefitInFlight = false;
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STOPPED } );

	}

	/**
	 * Set animation playback speed.
	 * @param {number} speed - Multiplier (1.0 = normal)
	 */
	setAnimationSpeed( speed ) {

		this.animationManager?.setSpeed( speed );

	}

	/**
	 * Set animation loop mode.
	 * @param {boolean} loop - true for repeat, false for play-once
	 */
	setAnimationLoop( loop ) {

		this.animationManager?.setLoop( loop );

	}

	/**
	 * Get info about available animation clips.
	 * @returns {{ index: number, name: string, duration: number }[]}
	 */
	get animationClips() {

		return this.animationManager?.clips || [];

	}

	// ═══════════════════════════════════════════════════════════════
	// Resize
	// ═══════════════════════════════════════════════════════════════

	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		if ( width === 0 || height === 0 ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this._camera.aspect = width / height;
		this._camera.updateProjectionMatrix();

		// Overlay helpers always render at display resolution
		const dpr = window.devicePixelRatio || 1;
		this.overlayManager?.setSize(
			Math.round( width * dpr ),
			Math.round( height * dpr )
		);

		if ( width === this._lastRenderWidth && height === this._lastRenderHeight ) return;

		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = setTimeout( () => {

			this._applyRenderResize( width, height );

		}, 300 );

	}

	_applyRenderResize( renderWidth, renderHeight ) {

		this._lastRenderWidth = renderWidth;
		this._lastRenderHeight = renderHeight;

		this.pipeline?.setSize( renderWidth, renderHeight );
		this.denoisingManager?.denoiser?.setSize( renderWidth, renderHeight );
		this.denoisingManager?.upscaler?.setBaseSize( renderWidth, renderHeight );
		this.needsReset = true;

		this.dispatchEvent( { type: 'resolution_changed', width: renderWidth, height: renderHeight } );

	}

	setCanvasSize( width, height ) {

		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;

		if ( this.denoiserCanvas ) {

			this.denoiserCanvas.style.width = `${width}px`;
			this.denoiserCanvas.style.height = `${height}px`;

		}

		if ( width === 0 || height === 0 ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this._camera.aspect = width / height;
		this._camera.updateProjectionMatrix();

		clearTimeout( this._resizeDebounceTimer );
		this._applyRenderResize( width, height );

	}

	// ═══════════════════════════════════════════════════════════════
	// Mode Configuration
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Configures the engine for a specific rendering mode.
	 * @param {string} mode - 'preview' | 'final-render' | 'results'
	 * @param {Object} [options]
	 */
	configureForMode( mode, options = {} ) {

		if ( mode === 'results' ) {

			this.pauseRendering = true;
			this._controls.enabled = false;
			this.renderer?.domElement && ( this.renderer.domElement.style.display = 'none' );
			this.denoisingManager?.denoiser?.output && ( this.denoisingManager.denoiser.output.style.display = 'none' );
			return;

		}

		const isFinal = mode === 'final-render';
		const config = isFinal ? FINAL_RENDER_CONFIG : PREVIEW_RENDER_CONFIG;

		this._controls.enabled = ! isFinal;

		// Batch uniform updates via settings
		this.settings.setMany( {
			maxSamples: config.maxSamples,
			maxBounces: config.bounces,
			samplesPerPixel: config.samplesPerPixel,
			transmissiveBounces: config.transmissiveBounces,
		}, { silent: true } );

		this.setRenderMode( config.renderMode );
		this.setTileCount( config.tiles );
		this.setTileHelperEnabled( config.tilesHelper );
		this.stages.pathTracer?.updateCompletionThreshold?.();

		const denoiser = this.denoisingManager?.denoiser;
		if ( denoiser ) {

			denoiser.abort();
			denoiser.enabled = config.enableOIDN;
			denoiser.updateQuality( config.oidnQuality );

		}

		this.denoisingManager?.upscaler?.abort();

		if ( options.canvasWidth && options.canvasHeight ) {

			this.setCanvasSize( options.canvasWidth, options.canvasHeight );

		}

		this.renderer?.domElement && ( this.renderer.domElement.style.display = 'block' );
		this.denoisingManager?.denoiser?.output && ( this.denoisingManager.denoiser.output.style.display = 'block' );

		this.needsReset = false;
		this.pauseRendering = false;
		this.reset();

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Camera
	// ═══════════════════════════════════════════════════════════════

	switchCamera( index ) {

		this.cameraManager.switchCamera(
			index,
			this.settings.get( 'focusDistance' ),
			() => this.onResize(),
			() => this.reset()
		);

	}

	getCameraNames() {

		return this.cameraManager.getCameraNames();

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Lights
	// ═══════════════════════════════════════════════════════════════

	addLight( type ) {

		const descriptor = this.lightManager.addLight( type );
		this.reset();
		return descriptor;

	}

	removeLight( uuid ) {

		const removed = this.lightManager.removeLight( uuid );
		if ( removed ) this.reset();
		return removed;

	}

	clearLights() {

		this.lightManager.clearLights();
		this.reset();

	}

	getLights() {

		return this.lightManager.getLights();

	}

	updateLights() {

		this.lightManager.updateLights();

	}

	setShowLightHelper( show ) {

		this.lightManager.setShowLightHelper( show );

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Denoiser
	// ═══════════════════════════════════════════════════════════════

	setDenoiserStrategy( strategy, asvgfPreset ) {

		this.denoisingManager.setDenoiserStrategy( strategy, asvgfPreset );
		this.reset();

	}

	setASVGFEnabled( enabled, qualityPreset ) {

		this.denoisingManager.setASVGFEnabled( enabled, qualityPreset );
		this.reset();

	}

	applyASVGFPreset( presetName ) {

		this.denoisingManager.applyASVGFPreset( presetName );
		this.reset();

	}

	setAutoExposureEnabled( enabled ) {

		this.denoisingManager.setAutoExposureEnabled( enabled, this.settings.get( 'exposure' ) );
		this.reset();

	}

	setAdaptiveSamplingEnabled( enabled ) {

		this.settings.set( 'useAdaptiveSampling', enabled );
		this.denoisingManager.setAdaptiveSamplingEnabled( enabled );

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Interaction
	// ═══════════════════════════════════════════════════════════════

	selectObject( object ) {

		const outlineHelper = this.overlayManager?.getHelper( 'outline' );
		if ( outlineHelper ) {

			outlineHelper.setSelectedObjects( object ? [ object ] : [] );

		}

		if ( this._interactionManager ) {

			this._interactionManager.selectedObject = object || null;

		}

		// Attach/detach transform gizmo
		if ( this._transformManager ) {

			if ( object ) {

				this._transformManager.attach( object );

			} else {

				this._transformManager.detach();

			}

		}

		this.dispatchEvent( { type: EngineEvents.OBJECT_SELECTED, object: object || null } );

	}

	toggleFocusMode() {

		if ( ! this._interactionManager ) return false;
		const enabled = this._interactionManager.toggleFocusMode();
		if ( this._controls ) this._controls.enabled = ! enabled;
		return enabled;

	}

	toggleSelectMode() {

		if ( ! this._interactionManager ) return false;
		return this._interactionManager.toggleSelectMode();

	}

	disableSelectMode() {

		this._interactionManager?.disableSelectMode();
		this._transformManager?.detach();

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Transform
	// ═══════════════════════════════════════════════════════════════

	setTransformMode( mode ) {

		this._transformManager?.setMode( mode );
		this.dispatchEvent( { type: EngineEvents.TRANSFORM_MODE_CHANGED, mode } );

	}

	setTransformSpace( space ) {

		this._transformManager?.setSpace( space );

	}

	get transformManager() {

		return this._transformManager;

	}

	refreshFrame() {

		this._needsDisplayRefresh = true;
		this.wake();

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Environment
	// ═══════════════════════════════════════════════════════════════

	getEnvParams() {

		return this.stages.pathTracer?.environment?.envParams ?? null;

	}

	getEnvironmentTexture() {

		return this.stages.pathTracer?.environment?.environmentTexture ?? null;

	}

	getEnvironmentCDF() {

		return null;

	}

	async generateProceduralSkyTexture() {

		return this.stages.pathTracer?.environment.generateProceduralSkyTexture();

	}

	async generateGradientTexture() {

		return this.stages.pathTracer?.environment.generateGradientTexture();

	}

	async generateSolidColorTexture() {

		return this.stages.pathTracer?.environment.generateSolidColorTexture();

	}

	async setEnvironmentMap( texture ) {

		if ( ! this.stages.pathTracer ) {

			console.warn( 'PathTracerApp: PathTracer not initialized' );
			return;

		}

		await this.stages.pathTracer.environment.setEnvironmentMap( texture );
		this.reset();

	}

	markEnvironmentNeedsUpdate() {

		const tex = this.stages.pathTracer?.environment?.environmentTexture;
		if ( tex ) tex.needsUpdate = true;

	}

	async setEnvironmentMode( mode ) {

		const previousMode = this._environmentMode || 'hdri';
		this._environmentMode = mode;

		if ( mode !== 'hdri' && previousMode === 'hdri' ) {

			this._previousHDRI = this.getEnvironmentTexture();
			this._previousCDF = this.getEnvironmentCDF();

		}

		if ( mode === 'gradient' ) {

			await this.generateGradientTexture();

		} else if ( mode === 'color' ) {

			await this.generateSolidColorTexture();

		} else if ( mode === 'procedural' ) {

			await this.generateProceduralSkyTexture();

		} else if ( mode === 'hdri' ) {

			if ( this._previousHDRI ) {

				await this.setEnvironmentMap( this._previousHDRI );
				this._previousHDRI = null;
				this._previousCDF = null;

			}

		}

		const envParams = this.getEnvParams();
		if ( envParams ) envParams.mode = mode;

		this.markEnvironmentNeedsUpdate();
		this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
		this.reset();

	}

	// ═══════════════════════════════════════════════════════════════
	// Read-Only Accessors
	// ═══════════════════════════════════════════════════════════════

	isComplete() {

		return this.stages.pathTracer?.isComplete ?? false;

	}

	getFrameCount() {

		return this.stages.pathTracer?.frameCount || 0;

	}

	/** Camera and controls — accessible via cameraManager */
	get camera() {

		return this.cameraManager?.camera ?? this._camera;

	}

	get controls() {

		return this.cameraManager?.controls ?? this._controls;

	}

	getSceneStatistics() {

		try {

			return this._sdf?.getStatistics?.() ?? null;

		} catch {

			return null;

		}

	}

	/**
	 * Returns the canvas element suitable for reading pixels from.
	 * Ensures the WebGPU canvas has fresh content if it's the source.
	 * Use this instead of directly accessing renderer.domElement / denoiserCanvas.
	 * @returns {HTMLCanvasElement|null}
	 */
	getOutputCanvas() {

		if ( ! this.renderer?.domElement ) return null;

		const denoiser = this.denoisingManager?.denoiser;
		const upscaler = this.denoisingManager?.upscaler;
		const usePostProcess = ( denoiser?.enabled || upscaler?.enabled )
			&& this.denoiserCanvas
			&& this.stages.pathTracer?.isComplete;

		if ( usePostProcess ) return this.denoiserCanvas;

		// Re-render display stage so the WebGPU canvas has valid content
		if ( this.stages.display && this.pipeline?.context ) {

			this.stages.display.render( this.pipeline.context );

		}

		return this.renderer.domElement;

	}

	/**
	 * Focuses the orbit camera on the center of a 3D object's bounding box.
	 * @param {import('three').Vector3} center - World-space center to focus on
	 */
	focusOnPoint( center ) {

		if ( ! center || ! this._controls ) return;
		this._controls.target.copy( center );
		this._controls.update();
		this.reset();

	}

	/**
	 * Dispatches an event through the interaction manager.
	 * @param {Object} event
	 */
	dispatchInteractionEvent( event ) {

		this._interactionManager?.dispatchEvent( event );

	}

	/**
	 * Subscribes to an interaction manager event.
	 * @param {string} type
	 * @param {Function} handler
	 * @returns {Function} unsubscribe function
	 */
	onInteractionEvent( type, handler ) {

		this._interactionManager?.addEventListener( type, handler );
		return () => this._interactionManager?.removeEventListener( type, handler );

	}

	takeScreenshot() {

		const canvas = this.getOutputCanvas();
		if ( ! canvas ) return;

		try {

			const screenshot = canvas.toDataURL( 'image/png' );
			const link = document.createElement( 'a' );
			link.href = screenshot;
			link.download = 'screenshot.png';
			link.click();

		} catch ( error ) {

			console.error( 'PathTracerApp: Screenshot failed:', error );

		}

	}

	setPathTracerEnabled( val ) {

		this.pathTracerEnabled = val;

	}
	setAccumulationEnabled( val ) {

		this.stages.pathTracer?.setAccumulationEnabled( val );

	}
	setRenderMode( mode ) {

		this.stages.pathTracer?.setUniform( 'renderMode', parseInt( mode ) );

	}
	setTileCount( val ) {

		this.stages.pathTracer?.tileManager?.setTileCount( val );

	}
	setInteractionModeEnabled( val ) {

		this.stages.pathTracer?.setInteractionModeEnabled( val );

	}

	setAdaptiveSamplingParameters( params ) {

		if ( params.min !== undefined ) this.stages.pathTracer?.setAdaptiveSamplingMin( params.min );
		if ( params.adaptiveSamplingMax !== undefined ) this.settings.set( 'adaptiveSamplingMax', params.adaptiveSamplingMax );
		this.stages.adaptiveSampling?.setAdaptiveSamplingParameters( params );

	}

	updateMaterialProperty( materialIndex, property, value ) {

		this.stages.pathTracer?.materialData.updateMaterialProperty( materialIndex, property, value );

		const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity', 'visible' ];
		if ( emissiveAffectingProps.includes( property )
			&& this._sdf?.emissiveTriangleBuilder
			&& this.stages.pathTracer?.enableEmissiveTriangleSampling?.value ) {

			const mat = this._sdf.materials[ materialIndex ];
			if ( mat ) {

				if ( property === 'emissive' ) mat.emissive = value;
				else if ( property === 'emissiveIntensity' ) mat.emissiveIntensity = value;
				else if ( property === 'visible' ) mat.visible = value;

				const changed = this._sdf.emissiveTriangleBuilder.updateMaterialEmissive(
					materialIndex, mat,
					this._sdf.triangleData, this._sdf.materials, this._sdf.triangleCount,
				);

				if ( changed ) {

					const emissiveRawData = this._sdf.emissiveTriangleBuilder.createEmissiveRawData();
					this.stages.pathTracer.setEmissiveTriangleData(
						emissiveRawData,
						this._sdf.emissiveTriangleBuilder.emissiveCount,
						this._sdf.emissiveTriangleBuilder.totalEmissivePower,
					);

				}

			}

		}

		this.reset();

	}

	updateTextureTransform( materialIndex, textureName, transform ) {

		this.stages.pathTracer?.materialData.updateTextureTransform( materialIndex, textureName, transform );
		this.reset();

	}

	refreshMaterial() {

		this.reset();

	}

	updateMaterial( materialIndex, material ) {

		this.stages.pathTracer?.materialData.updateMaterial( materialIndex, material );

	}

	async rebuildMaterials( scene ) {

		await this.stages.pathTracer?.rebuildMaterials( scene || this.meshScene );

	}

	// ═══════════════════════════════════════════════════════════════
	// Stage Parameter Facade — hides direct stage access from store
	// ═══════════════════════════════════════════════════════════════

	// ── ASVGF ──

	/** Updates ASVGF stage parameters (temporalAlpha, phiColor, etc.) */
	updateASVGFParameters( params ) {

		this.stages.asvgf?.updateParameters( params );

	}

	/** Toggles the ASVGF heatmap debug overlay */
	toggleASVGFHeatmap( enabled ) {

		this.stages.asvgf?.toggleHeatmap?.( enabled );

	}

	/**
	 * Configures ASVGF for a specific render mode.
	 * @param {Object} config - { enabled, temporalAlpha, atrousIterations, ... }
	 */
	configureASVGFForMode( config ) {

		if ( ! this.stages.asvgf ) return;

		this.stages.asvgf.enabled = config.enabled;
		if ( this.stages.variance ) this.stages.variance.enabled = config.enabled;
		if ( this.stages.bilateralFilter ) this.stages.bilateralFilter.enabled = config.enabled;

		if ( config.enabled ) {

			this.stages.asvgf.updateParameters( config );

		}

	}

	// ── SSRC ──

	/** Updates SSRC stage parameters (temporalAlpha, spatialRadius, spatialWeight) */
	updateSSRCParameters( params ) {

		this.stages.ssrc?.updateParameters( params );

	}

	// ── EdgeAware Filtering ──

	/** Updates EdgeAware filtering uniforms (pixelEdgeSharpness, edgeSharpenSpeed, edgeThreshold) */
	updateEdgeAwareUniforms( params ) {

		this.stages.edgeFilter?.updateUniforms( params );

	}

	// ── Auto Exposure ──

	/** Updates auto-exposure stage parameters */
	updateAutoExposureParameters( params ) {

		this.stages.autoExposure?.updateParameters( params );

	}

	// ── Adaptive Sampling ──

	/** Updates adaptive sampling stage parameters */
	updateAdaptiveSamplingParameters( params ) {

		this.stages.adaptiveSampling?.setAdaptiveSamplingParameters( params );

	}

	setAdaptiveSamplingVarianceThreshold( v ) {

		this.stages.adaptiveSampling?.setVarianceThreshold( v );

	}

	setAdaptiveSamplingMaterialBias( v ) {

		this.stages.adaptiveSampling?.setMaterialBias( v );

	}

	setAdaptiveSamplingEdgeBias( v ) {

		this.stages.adaptiveSampling?.setEdgeBias( v );

	}

	setAdaptiveSamplingConvergenceSpeed( v ) {

		this.stages.adaptiveSampling?.setConvergenceSpeed( v );

	}

	toggleAdaptiveSamplingHelper( enabled ) {

		this.stages.adaptiveSampling?.toggleHelper( enabled );

	}

	// ── Tile Highlight ──

	setTileHighlightEnabled( enabled ) {

		this.setTileHelperEnabled( enabled );

	}

	// ── OIDN Denoiser ──

	setOIDNEnabled( enabled ) {

		const d = this.denoisingManager?.denoiser;
		if ( d ) d.enabled = enabled;

	}

	updateOIDNQuality( quality ) {

		this.denoisingManager?.denoiser?.updateQuality( quality );

	}

	setOIDNTileHelper( enabled ) {

		this.setTileHelperEnabled( enabled );

	}

	setTileHelperEnabled( enabled ) {

		const tileHelper = this.overlayManager?.getHelper( 'tiles' );
		if ( tileHelper ) {

			tileHelper.enabled = enabled;
			if ( ! enabled ) tileHelper.hide();

		}

	}

	// ── AI Upscaler ──

	setUpscalerEnabled( enabled ) {

		const u = this.denoisingManager?.upscaler;
		if ( u ) u.enabled = enabled;

	}

	setUpscalerScaleFactor( factor ) {

		this.denoisingManager?.upscaler?.setScaleFactor( factor );

	}

	setUpscalerQuality( quality ) {

		this.denoisingManager?.upscaler?.setQuality( quality );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Stage creation & setup
	// ═══════════════════════════════════════════════════════════════

	_createStages() {

		const adaptiveSamplingMax = this.settings.get( 'adaptiveSamplingMax' );
		const useAdaptiveSampling = this.settings.get( 'useAdaptiveSampling' );

		this.stages.pathTracer = new PathTracer( this.renderer, this.scene, this._camera );
		this.stages.normalDepth = new NormalDepth( this.renderer, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.motionVector = new MotionVector( this.renderer, this._camera, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.ssrc = new SSRC( this.renderer, { enabled: false } );
		this.stages.asvgf = new ASVGF( this.renderer, { enabled: false } );
		this.stages.variance = new Variance( this.renderer, { enabled: false } );
		this.stages.bilateralFilter = new BilateralFilter( this.renderer, { enabled: false } );
		this.stages.adaptiveSampling = new AdaptiveSampling( this.renderer, {
			adaptiveSamplingMax,
			enabled: useAdaptiveSampling,
		} );
		this.stages.edgeFilter = new EdgeFilter( this.renderer, { enabled: false } );
		this.stages.autoExposure = new AutoExposure( this.renderer, { enabled: DEFAULT_STATE.autoExposure ?? false } );

		this.stages.display = new Display( this.renderer, {
			exposure: ( DEFAULT_STATE.autoExposure ) ? 1.0 : ( this.settings.get( 'exposure' ) ?? 1.0 ),
			saturation: this.settings.get( 'saturation' ) ?? DEFAULT_STATE.saturation,
		} );

	}

	_setupDenoisingManager() {

		this.denoisingManager = new DenoisingManager( {
			renderer: this.renderer,
			denoiserCanvas: this.denoiserCanvas,
			scene: this.scene,
			camera: this._camera,
			stages: {
				pathTracer: this.stages.pathTracer,
				asvgf: this.stages.asvgf,
				variance: this.stages.variance,
				bilateralFilter: this.stages.bilateralFilter,
				adaptiveSampling: this.stages.adaptiveSampling,
				edgeFilter: this.stages.edgeFilter,
				ssrc: this.stages.ssrc,
				autoExposure: this.stages.autoExposure,
				display: this.stages.display,
			},
			pipeline: this.pipeline,
			getExposure: () => this.settings.get( 'exposure' ) ?? 1.0,
			getSaturation: () => this.settings.get( 'saturation' ) ?? 1.0,
			getTransparentBg: () => this.settings.get( 'transparentBackground' ) ?? false,
		} );

		this.denoisingManager.setupDenoiser();
		this.denoisingManager.setupUpscaler();

	}

	/**
	 * Builds handler functions for multi-stage settings that can't
	 * be routed with a simple uniform forward.
	 */
	_buildSettingsHandlers() {

		return {

			handleTransparentBackground: ( value ) => {

				this.stages.pathTracer?.setUniform( 'transparentBackground', value );
				this.stages.display?.setTransparentBackground( value );

			},

			handleExposure: ( value ) => {

				if ( ! this.stages.autoExposure?.enabled ) {

					this.stages.display?.setExposure( value );

				}

			},

			handleSaturation: ( value ) => {

				this.stages.display?.setSaturation( value );

			},

			handleRenderLimitMode: ( value ) => {

				if ( this.stages.pathTracer?.setRenderLimitMode ) {

					this.stages.pathTracer.setRenderLimitMode( value );

				}

			},

			handleMaxSamples: ( value ) => {

				this.stages.pathTracer?.setUniform( 'maxSamples', value );
				this.stages.pathTracer?.updateCompletionThreshold();
				this._reconcileCompletion();

			},

			handleRenderTimeLimit: () => {

				this._reconcileCompletion();

			},

			handleRenderMode: ( value ) => {

				this.stages.pathTracer?.setUniform( 'renderMode', parseInt( value ) );

			},

			handleEnvironmentRotation: ( value ) => {

				this.stages.pathTracer?.environment.setEnvironmentRotation( value );

			},

		};

	}

	_reconcileCompletion() {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return;

		const shouldBeComplete = this._isRenderLimitReached();

		if ( shouldBeComplete && ! stage.isComplete ) {

			stage.isComplete = true;

		} else if ( ! shouldBeComplete && stage.isComplete ) {

			stage.isComplete = false;
			this._renderCompleteDispatched = false;

			// Adjust lastResetTime so timeElapsed continues from where it paused
			// rather than including idle time spent while completed
			this.lastResetTime = performance.now() - this.timeElapsed * 1000;

			this.canvas.style.opacity = '1';
			const denoiserOutput = this.denoisingManager?.denoiser?.output;
			if ( denoiserOutput ) denoiserOutput.style.display = 'none';

			this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

			// Restart the animation loop (it was stopped when render completed)
			this.wake();

		}

	}

	_isRenderLimitReached() {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return false;

		if ( this.settings.get( 'renderLimitMode' ) === 'time' ) {

			const limit = this.settings.get( 'renderTimeLimit' );
			return limit > 0 && this.timeElapsed >= limit;

		}

		return stage.frameCount >= stage.completionThreshold;

	}

	_setupFloorPlane() {

		this._floorPlane = new Mesh(
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
		this._floorPlane.name = "Ground";
		this._floorPlane.visible = false;
		this.meshScene.add( this._floorPlane );

	}

	_initStats() {

		this._stats = new Stats( { horizontal: true, trackGPU: true } );
		this._stats.dom.style.position = 'absolute';
		this._stats.dom.style.top = 'unset';
		this._stats.dom.style.bottom = '48px';

		this._stats.init( this.renderer );
		const container = this._statsContainer || this.canvas.parentElement || document.body;
		container.appendChild( this._stats.dom );

		const foregroundColor = '#ffffff';
		const backgroundColor = '#1e293b';

		const gradient = this._stats.fpsPanel.context.createLinearGradient( 0, this._stats.fpsPanel.GRAPH_Y, 0, this._stats.fpsPanel.GRAPH_Y + this._stats.fpsPanel.GRAPH_HEIGHT );
		gradient.addColorStop( 0, foregroundColor );

		this._stats.fpsPanel.fg = this._stats.msPanel.fg = foregroundColor;
		this._stats.fpsPanel.bg = this._stats.msPanel.bg = backgroundColor;
		this._stats.fpsPanel.gradient = this._stats.msPanel.gradient = gradient;

		if ( this._stats.gpuPanel ) {

			this._stats.gpuPanel.fg = foregroundColor;
			this._stats.gpuPanel.bg = backgroundColor;
			this._stats.gpuPanel.gradient = gradient;

		}

		this._stats.dom.style.display = '';

	}

	_setupInteractionListeners() {

		if ( ! this._interactionManager ) return;

		this._interactionManager.addEventListener( 'objectSelected', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();
			this.dispatchEvent( { type: 'objectSelected', object: event.object, uuid: event.uuid } );

		} );

		this._interactionManager.addEventListener( 'objectDeselected', ( event ) => {

			this.selectObject( null );
			this.refreshFrame();
			this.dispatchEvent( { type: 'objectDeselected', object: event.object, uuid: event.uuid } );

		} );

		this._interactionManager.addEventListener( 'selectModeChanged', ( event ) => {

			this.dispatchEvent( { type: EngineEvents.SELECT_MODE_CHANGED, enabled: event.enabled } );

		} );

		this._interactionManager.addEventListener( 'objectDoubleClicked', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();
			this.dispatchEvent( { type: EngineEvents.OBJECT_DOUBLE_CLICKED, object: event.object, uuid: event.uuid } );

		} );

		this._interactionManager.addEventListener( 'focusChanged', ( event ) => {

			this.settings.set( 'focusDistance', event.worldDistance );
			this.dispatchEvent( { type: 'focusChanged', distance: event.distance } );

		} );

		this._interactionManager.addEventListener( 'focusModeChanged', ( event ) => {

			if ( ! event.enabled && this._controls ) this._controls.enabled = true;

		} );

		this._interactionManager.addEventListener( 'afPointPlaced', ( event ) => {

			this.cameraManager.setAFScreenPoint( event.point.x, event.point.y );
			if ( this._controls ) this._controls.enabled = true;
			this.dispatchEvent( { type: EngineEvents.AF_POINT_PLACED, point: event.point } );

		} );

	}

	_setupAutoExposureListener() {

		if ( ! this.stages.autoExposure ) return;

		this.stages.autoExposure.on( 'autoexposure:updated', ( data ) => {

			this.dispatchEvent( {
				type: EngineEvents.AUTO_EXPOSURE_UPDATED,
				exposure: data.exposure,
				luminance: data.luminance
			} );

		} );

	}

	_renderHelperOverlay() {

		this.scene.updateMatrixWorld();
		this.overlayManager?.render();
		this._transformManager?.render( this.renderer );

	}

	_setupOverlayManager() {

		this.overlayManager = new OverlayManager( this.renderer, this._camera );
		this.overlayManager.setHelperScene( this._sceneHelpers );

		// ── Tile helper (shared across path tracer, OIDN, upscaler) ──
		const tileHelper = new TileHelper();
		this.overlayManager.register( 'tiles', tileHelper );

		// Sync render size
		tileHelper.setRenderSize( this._lastRenderWidth || 1, this._lastRenderHeight || 1 );
		this.addEventListener( 'resolution_changed', ( e ) => {

			tileHelper.setRenderSize( e.width, e.height );

		} );

		// ── Path tracer tile events ──
		this.pipeline.eventBus.on( 'tile:changed', ( e ) => {

			if ( e.renderMode === 1 && e.tileBounds ) {

				tileHelper.setActiveTile( e.tileBounds );
				tileHelper.show();

			}

		} );

		this.pipeline.eventBus.on( 'pipeline:reset', () => tileHelper.hide() );
		this.addEventListener( EngineEvents.RENDER_COMPLETE, () => tileHelper.hide() );

		// ── OIDN denoiser tile events ──
		this._setupDenoiserTileHelper( tileHelper );

		// ── Outline helper (renders at display resolution, not render resolution) ──
		const outlineHelper = new OutlineHelper( this.renderer, this.meshScene, this._camera );
		this.overlayManager.register( 'outline', outlineHelper );

	}

	_setupDenoiserTileHelper( tileHelper ) {

		// OIDN/upscaler tile events fire while the animation loop is stopped
		// (render completed → stopAnimation → async denoise). We must manually
		// trigger HUD redraws since overlayManager.render() isn't being called.
		const sources = [ this.denoisingManager?.denoiser, this.denoisingManager?.upscaler ];

		for ( const source of sources ) {

			if ( ! source ) continue;

			source.addEventListener( 'tileProgress', ( e ) => {

				if ( e.tile ) {

					tileHelper.setRenderSize( e.imageWidth, e.imageHeight );
					tileHelper.setActiveTile( e.tile );
					tileHelper.show();
					this.overlayManager?.refreshHUD();

				}

			} );

			source.addEventListener( 'end', () => {

				tileHelper.hide();
				this.overlayManager?.refreshHUD();

			} );

		}

	}


	_syncControlsAfterLoad() {

		this._controls.saveState();
		this._controls.update();

	}

	/**
	 * Forwards events from a source EventDispatcher to this app instance.
	 */
	_forwardEvents( source, eventTypes ) {

		if ( ! source ) return;
		for ( const type of eventTypes ) {

			source.addEventListener( type, ( e ) => this.dispatchEvent( e ) );

		}

	}

}
