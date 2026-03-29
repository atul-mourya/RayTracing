import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
	ACESFilmicToneMapping, PerspectiveCamera, Scene, EventDispatcher,
	Color, Mesh, CircleGeometry, MeshPhysicalMaterial, TimestampQuery
} from 'three';
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
import { RenderPipeline } from './Pipeline/RenderPipeline.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, FINAL_RENDER_CONFIG, PREVIEW_RENDER_CONFIG } from './EngineDefaults.js';
import { updateStats, updateLoading, resetLoading, setStatusCallback } from './Processor/utils.js';
import BuildTimer from './Processor/BuildTimer.js';
import InteractionManager from './InteractionManager.js';
import { EngineEvents } from './EngineEvents.js';
import AssetLoader from './Processor/AssetLoader.js';
import TriangleSDF from './Processor/TriangleSDF.js';

// Managers
import { RenderSettings } from './RenderSettings.js';
import { CameraManager } from './managers/CameraManager.js';
import { LightManager } from './managers/LightManager.js';
import { DenoiserOrchestrator } from './managers/DenoiserOrchestrator.js';


/**
 * WebGPU Path Tracer Application.
 *
 * Thin facade that delegates to focused managers:
 * - {@link RenderSettings} — single source of truth for all render parameters
 * - {@link CameraManager} — camera switching, auto-focus, DOF
 * - {@link LightManager} — light CRUD, helpers, GPU transfer
 * - {@link DenoiserOrchestrator} — denoiser strategy, OIDN, AI upscaler
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
		this.denoiserOrchestrator = null;

		// ── State ──
		this.isInitialized = false;
		this.pauseRendering = false;
		this.pathTracerEnabled = true;
		this.animationId = null;
		this.needsReset = false;
		this._renderCompleteDispatched = false;
		this._loadingInProgress = false;
		this._needsDisplayRefresh = false;

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
		this._camera = new PerspectiveCamera( 65, width / height || 1, 0.01, 1000 );
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
		this._sdf = new TriangleSDF();
		this.assetLoader = new AssetLoader( this.meshScene, this._camera, this._controls );
		this._setupFloorPlane();
		this.assetLoader.setFloorPlane( this._floorPlane );

		// Track camera movement for reset
		this._controls.addEventListener( 'change', () => {

			this.needsReset = true;

		} );

		// ── Create pipeline stages ──
		this._createStages();

		// ── Pipeline orchestration ──
		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new RenderPipeline( this.renderer, w || 1, h || 1 );
		this.pipeline.addStage( this.stages.pathTracing );
		this.pipeline.addStage( this.stages.normalDepth );
		this.pipeline.addStage( this.stages.motionVector );
		this.pipeline.addStage( this.stages.ssrc );
		this.pipeline.addStage( this.stages.asvgf );
		this.pipeline.addStage( this.stages.varianceEstimation );
		this.pipeline.addStage( this.stages.bilateralFiltering );
		this.pipeline.addStage( this.stages.adaptiveSampling );
		this.pipeline.addStage( this.stages.edgeAwareFiltering );
		this.pipeline.addStage( this.stages.autoExposure );
		this.pipeline.addStage( this.stages.tileHighlight );
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
			pathTracingStage: null,
			floorPlane: this._floorPlane
		} );
		this._setupInteractionListeners();

		// ── Managers ──
		this.cameraManager = new CameraManager( this._camera, this._controls, this._interactionManager );
		this.lightManager = new LightManager( this.scene, this._sceneHelpers, this.stages.pathTracing );
		this._setupDenoiserOrchestrator();

		// Wire CameraManager events → app events
		this.cameraManager.addEventListener( 'CameraSwitched', ( e ) => this.dispatchEvent( e ) );
		this.cameraManager.addEventListener( EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => this.dispatchEvent( e ) );

		// Wire DenoiserOrchestrator events → app events
		this._forwardEvents( this.denoiserOrchestrator, [
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
			pathTracingStage: this.stages.pathTracing,
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
			pathTracingStage: this.stages.pathTracing,
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
				if ( envTexture && this.stages.pathTracing ) {

					await this.stages.pathTracing.environment.setEnvironmentMap( envTexture );

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
		this.stages.pathTracing.setTriangleData( new Float32Array( 32 ), 0 );
		this.stages.pathTracing.setBVHData( new Float32Array( 16 ) );
		this.stages.pathTracing.materialData.setMaterialData( new Float32Array( 16 ) );
		this.stages.pathTracing.setupMaterial();

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
		if ( this.stages.pathTracing?.isReady ) {

			if ( this.stages.pathTracing.isComplete && this._renderCompleteDispatched ) {

				if ( this._needsDisplayRefresh ) {

					this._needsDisplayRefresh = false;
					this.stages.display.render( this.pipeline.context );
					this._renderHelperOverlay();

				}

				return;

			}

			this.pipeline.render();

			const frameCount = this.stages.pathTracing.frameCount || 0;

			if ( ! this.stages.pathTracing.isComplete ) {

				this.timeElapsed = ( performance.now() - this.lastResetTime ) / 1000;

			}

			// Tiled mode: convert raw frame count to completed sample passes
			const stage = this.stages.pathTracing;
			let displaySamples = frameCount;
			if ( stage.renderMode?.value === 1 && frameCount > 0 ) {

				const totalTiles = stage.tileManager.totalTilesCache;
				displaySamples = 1 + Math.floor( ( frameCount - 1 ) / totalTiles );

			}

			updateStats( { timeElapsed: this.timeElapsed, samples: displaySamples } );

			// Check time limit
			const renderLimitMode = this.settings.get( 'renderLimitMode' );
			const renderTimeLimit = this.settings.get( 'renderTimeLimit' );
			if ( renderLimitMode === 'time' && renderTimeLimit > 0 && this.timeElapsed >= renderTimeLimit ) {

				this.stages.pathTracing.isComplete = true;

			}

			// Render completion → denoise/upscale chain
			if ( this.stages.pathTracing.isComplete && ! this._renderCompleteDispatched ) {

				this._renderCompleteDispatched = true;

				this.denoiserOrchestrator.onRenderComplete( {
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

	/** Pauses the animation loop. */
	pause() {

		this.stopAnimation();
		if ( this._stats ) this._stats.dom.style.display = 'none';

	}

	/** Resumes the animation loop. */
	resume() {

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
		this.denoiserOrchestrator?.abort( this.canvas );

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
		this.dispatchEvent( { type: 'RenderReset' } );
		this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		this.stopAnimation();
		setStatusCallback( null );

		if ( this.assetLoader && this._onAssetLoaded ) {

			this.assetLoader.removeEventListener( 'load', this._onAssetLoaded );

		}

		this._sceneHelpers?.clear();

		if ( this._outlineNode ) {

			this._outlineNode.dispose();
			this._outlineNode = null;

		}

		this.denoiserOrchestrator?.dispose();
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
			if ( environmentTexture && this.stages.pathTracing ) {

				await this.stages.pathTracing.environment.setEnvironmentMap( environmentTexture );

			}

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

		const timer = new BuildTimer( 'loadSceneData' );
		const environmentTexture = this.meshScene.environment;

		// Environment CDF build in parallel with BVH
		let cdfPromise = null;
		if ( environmentTexture?.image?.data ) {

			timer.start( 'Environment CDF build (worker)' );
			this.stages.pathTracing.scene.environment = environmentTexture;
			cdfPromise = this.stages.pathTracing.environment.buildEnvironmentCDF()
				.then( () => timer.end( 'Environment CDF build (worker)' ) );

		}

		// Build BVH
		timer.start( 'BVH build (TriangleSDF)' );
		await this._sdf.buildBVH( this.meshScene );
		timer.end( 'BVH build (TriangleSDF)' );

		const { triangleData, triangleCount, bvhData, materialData } = this._sdf;

		if ( ! triangleData ) {

			console.error( 'PathTracerApp: Failed to get triangle data' );
			return false;

		}

		updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'GPU data transfer' );
		this.stages.pathTracing.setTriangleData( triangleData, triangleCount );

		if ( ! bvhData ) {

			console.error( 'PathTracerApp: Failed to get BVH data' );
			return false;

		}

		this.stages.pathTracing.setBVHData( bvhData );

		if ( materialData ) {

			this.stages.pathTracing.materialData.setMaterialData( materialData );

		} else {

			console.warn( 'PathTracerApp: No material data, using defaults' );

		}

		if ( environmentTexture ) {

			this.stages.pathTracing.environment.setEnvironmentTexture( environmentTexture );

		}

		// Transfer material texture arrays
		this.stages.pathTracing.materialData.setMaterialTextures( {
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

			this.stages.pathTracing.setEmissiveTriangleData(
				this._sdf.emissiveTriangleData,
				this._sdf.emissiveTriangleCount,
				this._sdf.emissiveTotalPower,
			);

		}

		// Light BVH data
		if ( this._sdf.lightBVHNodeData ) {

			this.stages.pathTracing.setLightBVHData(
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
		this.stages.pathTracing.setupMaterial();
		timer.end( 'Material setup (TSL compile)' );

		// Wait for CDF
		if ( cdfPromise ) {

			updateLoading( { status: "Finalizing environment map...", progress: 95 } );
			await cdfPromise;
			this.stages.pathTracing.environment.applyCDFResults();

		}

		// Apply all settings to stages in one shot
		timer.start( 'Apply settings' );
		this.settings.applyAll();
		this.stages.display.setTransparentBackground( this.settings.get( 'transparentBackground' ) );
		timer.end( 'Apply settings' );

		timer.print();
		resetLoading();

		this.dispatchEvent( { type: 'SceneRebuild' } );
		return true;

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
		this.denoiserOrchestrator?.denoiser?.setSize( renderWidth, renderHeight );
		this.denoiserOrchestrator?.upscaler?.setBaseSize( renderWidth, renderHeight );
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
			this.denoiserOrchestrator?.denoiser?.output && ( this.denoiserOrchestrator.denoiser.output.style.display = 'none' );
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
		if ( this.stages.tileHighlight ) this.stages.tileHighlight.enabled = config.tilesHelper;
		this.stages.pathTracing?.updateCompletionThreshold?.();

		const denoiser = this.denoiserOrchestrator?.denoiser;
		if ( denoiser ) {

			denoiser.abort();
			denoiser.enabled = config.enableOIDN;
			denoiser.updateQuality( config.oidnQuality );
			denoiser.toggleHDR( config.oidnHdr );
			denoiser.toggleUseGBuffer( config.useGBuffer );

		}

		this.denoiserOrchestrator?.upscaler?.abort();

		if ( options.canvasWidth && options.canvasHeight ) {

			this.setCanvasSize( options.canvasWidth, options.canvasHeight );

		}

		this.renderer?.domElement && ( this.renderer.domElement.style.display = 'block' );
		this.denoiserOrchestrator?.denoiser?.output && ( this.denoiserOrchestrator.denoiser.output.style.display = 'block' );

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

		this.denoiserOrchestrator.setDenoiserStrategy( strategy, asvgfPreset );
		this.reset();

	}

	setASVGFEnabled( enabled, qualityPreset ) {

		this.denoiserOrchestrator.setASVGFEnabled( enabled, qualityPreset );
		this.reset();

	}

	applyASVGFPreset( presetName ) {

		this.denoiserOrchestrator.applyASVGFPreset( presetName );
		this.reset();

	}

	setAutoExposureEnabled( enabled ) {

		this.denoiserOrchestrator.setAutoExposureEnabled( enabled, this.settings.get( 'exposure' ) );
		this.reset();

	}

	setAdaptiveSamplingEnabled( enabled ) {

		this.settings.set( 'useAdaptiveSampling', enabled );
		this.denoiserOrchestrator.setAdaptiveSamplingEnabled( enabled );

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Interaction
	// ═══════════════════════════════════════════════════════════════

	selectObject( object ) {

		if ( this._outlineNode ) {

			this._outlineNode.selectedObjects = object ? [ object ] : [];

		}

		if ( this._interactionManager ) {

			this._interactionManager.selectedObject = object || null;

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

	}

	refreshFrame() {

		this._needsDisplayRefresh = true;

	}

	// ═══════════════════════════════════════════════════════════════
	// Delegated APIs — Environment
	// ═══════════════════════════════════════════════════════════════

	getEnvParams() {

		return this.stages.pathTracing?.environment?.envParams ?? null;

	}

	getEnvironmentTexture() {

		return this.stages.pathTracing?.environment?.environmentTexture ?? null;

	}

	getEnvironmentCDF() {

		return null;

	}

	async generateProceduralSkyTexture() {

		return this.stages.pathTracing?.environment.generateProceduralSkyTexture();

	}

	async generateGradientTexture() {

		return this.stages.pathTracing?.environment.generateGradientTexture();

	}

	async generateSolidColorTexture() {

		return this.stages.pathTracing?.environment.generateSolidColorTexture();

	}

	async setEnvironmentMap( texture ) {

		if ( ! this.stages.pathTracing ) {

			console.warn( 'PathTracerApp: PathTracingStage not initialized' );
			return;

		}

		await this.stages.pathTracing.environment.setEnvironmentMap( texture );
		this.reset();

	}

	markEnvironmentNeedsUpdate() {

		const tex = this.stages.pathTracing?.environment?.environmentTexture;
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
		this.reset();

	}

	// ═══════════════════════════════════════════════════════════════
	// Read-Only Accessors
	// ═══════════════════════════════════════════════════════════════

	isComplete() {

		return this.stages.pathTracing?.isComplete ?? false;

	}

	getFrameCount() {

		return this.stages.pathTracing?.frameCount || 0;

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

		const denoiser = this.denoiserOrchestrator?.denoiser;
		const upscaler = this.denoiserOrchestrator?.upscaler;
		const usePostProcess = ( denoiser?.enabled || upscaler?.enabled )
			&& this.denoiserCanvas
			&& this.stages.pathTracing?.isComplete;

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

		this.stages.pathTracing?.setAccumulationEnabled( val );

	}
	setRenderMode( mode ) {

		this.stages.pathTracing?.setUniform( 'renderMode', parseInt( mode ) );

	}
	setTileCount( val ) {

		this.stages.pathTracing?.tileManager?.setTileCount( val );

	}
	setInteractionModeEnabled( val ) {

		this.stages.pathTracing?.setInteractionModeEnabled( val );

	}

	setAdaptiveSamplingParameters( params ) {

		if ( params.min !== undefined ) this.stages.pathTracing?.setAdaptiveSamplingMin( params.min );
		if ( params.adaptiveSamplingMax !== undefined ) this.settings.set( 'adaptiveSamplingMax', params.adaptiveSamplingMax );
		this.stages.adaptiveSampling?.setAdaptiveSamplingParameters( params );

	}

	updateMaterialProperty( materialIndex, property, value ) {

		this.stages.pathTracing?.materialData.updateMaterialProperty( materialIndex, property, value );

		const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity', 'visible' ];
		if ( emissiveAffectingProps.includes( property )
			&& this._sdf?.emissiveTriangleBuilder
			&& this.stages.pathTracing?.enableEmissiveTriangleSampling?.value ) {

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
					this.stages.pathTracing.setEmissiveTriangleData(
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

		this.stages.pathTracing?.materialData.updateTextureTransform( materialIndex, textureName, transform );
		this.reset();

	}

	refreshMaterial() {

		this.reset();

	}

	updateMaterial( materialIndex, material ) {

		this.stages.pathTracing?.materialData.updateMaterial( materialIndex, material );

	}

	async rebuildMaterials( scene ) {

		await this.stages.pathTracing?.rebuildMaterials( scene || this.meshScene );

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
		if ( this.stages.varianceEstimation ) this.stages.varianceEstimation.enabled = config.enabled;
		if ( this.stages.bilateralFiltering ) this.stages.bilateralFiltering.enabled = config.enabled;

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

		this.stages.edgeAwareFiltering?.updateUniforms( params );

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

		if ( this.stages.tileHighlight ) this.stages.tileHighlight.enabled = enabled;

	}

	// ── OIDN Denoiser ──

	setOIDNEnabled( enabled ) {

		const d = this.denoiserOrchestrator?.denoiser;
		if ( d ) d.enabled = enabled;

	}

	updateOIDNQuality( quality ) {

		this.denoiserOrchestrator?.denoiser?.updateQuality( quality );

	}

	toggleOIDNHdr( enabled ) {

		this.denoiserOrchestrator?.denoiser?.toggleHDR( enabled );

	}

	toggleOIDNUseGBuffer( enabled ) {

		this.denoiserOrchestrator?.denoiser?.toggleUseGBuffer( enabled );

	}

	setOIDNTileHelper( enabled ) {

		const d = this.denoiserOrchestrator?.denoiser;
		if ( d ) d.showTileHelper = enabled;

	}

	// ── AI Upscaler ──

	setUpscalerEnabled( enabled ) {

		const u = this.denoiserOrchestrator?.upscaler;
		if ( u ) u.enabled = enabled;

	}

	setUpscalerScaleFactor( factor ) {

		this.denoiserOrchestrator?.upscaler?.setScaleFactor( factor );

	}

	setUpscalerQuality( quality ) {

		this.denoiserOrchestrator?.upscaler?.setQuality( quality );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Stage creation & setup
	// ═══════════════════════════════════════════════════════════════

	_createStages() {

		const adaptiveSamplingMax = this.settings.get( 'adaptiveSamplingMax' );
		const useAdaptiveSampling = this.settings.get( 'useAdaptiveSampling' );

		this.stages.pathTracing = new PathTracingStage( this.renderer, this.scene, this._camera );
		this.stages.normalDepth = new NormalDepthStage( this.renderer, {
			pathTracingStage: this.stages.pathTracing
		} );
		this.stages.motionVector = new MotionVectorStage( this.renderer, this._camera, {
			pathTracingStage: this.stages.pathTracing
		} );
		this.stages.ssrc = new SSRCStage( this.renderer, { enabled: false } );
		this.stages.asvgf = new ASVGFStage( this.renderer, { enabled: false } );
		this.stages.varianceEstimation = new VarianceEstimationStage( this.renderer, { enabled: false } );
		this.stages.bilateralFiltering = new BilateralFilteringStage( this.renderer, { enabled: false } );
		this.stages.adaptiveSampling = new AdaptiveSamplingStage( this.renderer, {
			adaptiveSamplingMax,
			enabled: useAdaptiveSampling,
		} );
		this.stages.edgeAwareFiltering = new EdgeAwareFilteringStage( this.renderer, { enabled: false } );
		this.stages.autoExposure = new AutoExposureStage( this.renderer, { enabled: DEFAULT_STATE.autoExposure ?? false } );
		this.stages.tileHighlight = new TileHighlightStage( this.renderer, { enabled: false } );

		// Outline effect
		const outlineScene = this.meshScene;
		this._outlineNode = outline( outlineScene, this._camera, {
			selectedObjects: [],
			edgeThickness: uniform( 1.0 ),
			edgeGlow: uniform( 0.0 ),
		} );

		const outlineCanvas = this.canvas;
		const outlineSetSize = this._outlineNode.setSize.bind( this._outlineNode );
		this._outlineNode.setSize = () => {

			const dpr = window.devicePixelRatio;
			outlineSetSize(
				Math.round( outlineCanvas.clientWidth * dpr ),
				Math.round( outlineCanvas.clientHeight * dpr )
			);

		};

		const edgeStrength = uniform( 3.0 );
		const visibleEdgeColor = uniform( new Color( 0xffffff ) );
		const hiddenEdgeColor = uniform( new Color( 0x190a05 ) );
		const { visibleEdge, hiddenEdge } = this._outlineNode;
		const outlineColorNode = visibleEdge.mul( visibleEdgeColor )
			.add( hiddenEdge.mul( hiddenEdgeColor ) )
			.mul( edgeStrength );

		this.stages.display = new DisplayStage( this.renderer, {
			exposure: ( DEFAULT_STATE.autoExposure ) ? 1.0 : ( this.settings.get( 'exposure' ) ?? 1.0 ),
			saturation: this.settings.get( 'saturation' ) ?? DEFAULT_STATE.saturation,
			outlineColorNode
		} );

	}

	_setupDenoiserOrchestrator() {

		this.denoiserOrchestrator = new DenoiserOrchestrator( {
			renderer: this.renderer,
			denoiserCanvas: this.denoiserCanvas,
			scene: this.scene,
			camera: this._camera,
			stages: {
				pathTracing: this.stages.pathTracing,
				asvgf: this.stages.asvgf,
				varianceEstimation: this.stages.varianceEstimation,
				bilateralFiltering: this.stages.bilateralFiltering,
				adaptiveSampling: this.stages.adaptiveSampling,
				edgeAwareFiltering: this.stages.edgeAwareFiltering,
				ssrc: this.stages.ssrc,
				autoExposure: this.stages.autoExposure,
				display: this.stages.display,
				tileHighlight: this.stages.tileHighlight,
			},
			pipeline: this.pipeline,
			getExposure: () => this.settings.get( 'exposure' ) ?? 1.0,
			getTransparentBg: () => this.settings.get( 'transparentBackground' ) ?? false,
		} );

		this.denoiserOrchestrator.setupDenoiser();
		this.denoiserOrchestrator.setupUpscaler();

	}

	/**
	 * Builds handler functions for multi-stage settings that can't
	 * be routed with a simple uniform forward.
	 */
	_buildSettingsHandlers() {

		return {

			handleTransparentBackground: ( value ) => {

				this.stages.pathTracing?.setUniform( 'transparentBackground', value );
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

				if ( this.stages.pathTracing?.setRenderLimitMode ) {

					this.stages.pathTracing.setRenderLimitMode( value );

				}

			},

			handleMaxSamples: ( value ) => {

				this.stages.pathTracing?.setUniform( 'maxSamples', value );
				this.stages.pathTracing?.updateCompletionThreshold();
				this._reconcileCompletion();

			},

			handleRenderTimeLimit: () => {

				this._reconcileCompletion();

			},

			handleRenderMode: ( value ) => {

				this.stages.pathTracing?.setUniform( 'renderMode', parseInt( value ) );

			},

			handleEnvironmentRotation: ( value ) => {

				this.stages.pathTracing?.environment.setEnvironmentRotation( value );

			},

		};

	}

	_reconcileCompletion() {

		const stage = this.stages.pathTracing;
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
			const denoiserOutput = this.denoiserOrchestrator?.denoiser?.output;
			if ( denoiserOutput ) denoiserOutput.style.display = 'none';

			this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

		}

	}

	_isRenderLimitReached() {

		const stage = this.stages.pathTracing;
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
		this._sceneHelpers.render( this.renderer, this._camera );

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
