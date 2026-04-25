import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { texture as _tslTexture, cubeTexture as _tslCubeTexture } from 'three/tsl';
import {
	ACESFilmicToneMapping, Scene, EventDispatcher, TimestampQuery, Box3, Vector3
} from 'three';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { SceneHelpers } from './SceneHelpers.js';
import { createStats } from './managers/helpers/StatsHelper.js';
import { PathTracer } from './Stages/PathTracer.js';
import { NormalDepth } from './Stages/NormalDepth.js';
import { MotionVector } from './Stages/MotionVector.js';
import { ASVGF } from './Stages/ASVGF.js';
import { Variance } from './Stages/Variance.js';
import { BilateralFilter } from './Stages/BilateralFilter.js';
import { AdaptiveSampling } from './Stages/AdaptiveSampling.js';
import { EdgeFilter } from './Stages/EdgeFilter.js';
import { AutoExposure } from './Stages/AutoExposure.js';
import { SHaRC } from './Stages/SHaRC.js';
import { Display } from './Stages/Display.js';
import { RenderPipeline } from './Pipeline/RenderPipeline.js';
import { CompletionTracker } from './Pipeline/CompletionTracker.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, FINAL_RENDER_CONFIG, PREVIEW_RENDER_CONFIG } from './EngineDefaults.js';
import { updateStats, updateLoading, resetLoading, setStatusCallback, getDisplaySamples, disposeObjectFromMemory } from './Processor/utils.js';
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

// One app per canvas — auto-dispose a prior owner if the caller double-
// instantiates (StrictMode, HMR, etc.) so its rAF loop can't burn CPU.
const _appsByCanvas = new WeakMap();


/**
 * WebGPU Path Tracer Application.
 *
 * Managers are exposed as direct public properties (Three.js style):
 * - `app.cameraManager`      — {@link CameraManager} (camera, controls, auto-focus, DOF)
 * - `app.lightManager`       — {@link LightManager} (CRUD, helpers, GPU transfer)
 * - `app.denoisingManager`   — {@link DenoisingManager} (strategy, OIDN, AI upscaler)
 * - `app.animationManager`   — {@link AnimationManager} (playback, clips, speed)
 * - `app.transformManager`   — {@link TransformManager} (gizmo, drag, BVH refit)
 * - `app.interactionManager` — {@link InteractionManager} (selection, focus, context menu)
 * - `app.overlayManager`     — {@link OverlayManager} (HUD, helpers)
 * - `app.environmentManager` — EnvironmentManager (HDRI, procedural sky, mode switching)
 * - `app.settings`           — {@link RenderSettings} (all render parameters)
 * - `app.stages`             — Named pipeline stages for advanced control
 *
 * Extends EventDispatcher for event-driven communication with stores/UI.
 */
export class PathTracerApp extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {Object} [options] - Engine options
	 * @param {boolean} [options.autoResize=true] - Automatically listen for window resize events
	 * @param {boolean} [options.showStats=true] - Show the performance stats panel
	 * @param {HTMLElement} [options.statsContainer] - DOM element to append the stats panel to (defaults to document.body)
	 */
	constructor( canvas, options = {} ) {

		super();

		try {

			_appsByCanvas.get( canvas )?.dispose();

		} catch ( err ) {

			console.warn( 'PathTracerApp: prior canvas owner dispose failed', err );

		}

		_appsByCanvas.set( canvas, this );

		this.canvas = canvas;
		this._autoResize = options.autoResize !== false;
		this._showStats = options.showStats !== false;
		this._statsContainer = options.statsContainer || null;

		// ── Settings (single source of truth for all render parameters) ──
		this.settings = new RenderSettings( DEFAULT_STATE );

		// ── Core objects (populated in init) ──
		this.renderer = null;
		this.scene = null;
		this.meshScene = null;
		this._sceneHelpers = null;

		// ── Asset pipeline ──
		this.assetLoader = null;
		this._sdf = null;
		this._animRefitInFlight = false;

		// ── Pipeline & stages ──
		this.pipeline = null;

		/**
		 * Named access to all pipeline stages.
		 * Advanced consumers can reach into stages for fine-grained control.
		 * @type {Object}
		 */
		this.stages = {};

		// ── Managers (direct public access) ──
		/** @type {CameraManager} */
		this.cameraManager = null;
		/** @type {LightManager} */
		this.lightManager = null;
		/** @type {DenoisingManager} */
		this.denoisingManager = null;
		/** @type {OverlayManager} */
		this.overlayManager = null;
		/** @type {InteractionManager} */
		this.interactionManager = null;
		/** @type {TransformManager} */
		this.transformManager = null;
		/** @type {AnimationManager} */
		this.animationManager = new AnimationManager();
		/** @type {import('./managers/EnvironmentManager.js').EnvironmentManager} */
		this.environmentManager = null;

		// ── State ──
		this.isInitialized = false;
		this.pauseRendering = false;
		this.pathTracerEnabled = true;
		this.animationManagerId = null;
		this.needsReset = false;
		this._loadingInProgress = false;
		this._needsDisplayRefresh = false;
		this._paused = false;

		// Render completion tracking
		this.completion = new CompletionTracker();

		// Resolution state
		this._resizeDebounceTimer = null;

		// Tracked listeners for clean dispose()
		this._trackedListeners = [];
		this._disposed = false;

	}

	/**
	 * Registers an event listener and tracks it for automatic cleanup on dispose().
	 * @param {EventTarget|{addEventListener:Function, removeEventListener:Function}} target
	 * @param {string} type
	 * @param {Function} handler
	 */
	_addTrackedListener( target, type, handler ) {

		if ( ! target ) return;
		target.addEventListener( type, handler );
		this._trackedListeners.push( { target, type, handler } );

	}

	/** Removes all listeners registered via _addTrackedListener. */
	_removeTrackedListeners() {

		for ( const { target, type, handler } of this._trackedListeners ) {

			try {

				target.removeEventListener( type, handler );

			} catch ( err ) {

				console.warn( 'PathTracerApp: failed to remove listener', type, err );

			}

		}

		this._trackedListeners.length = 0;

	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Initializes the WebGPU renderer, pipeline stages, and managers.
	 */
	async init() {

		await this._initRenderer();
		this._initCameraManager();
		this._initScenes();
		this._initAssetPipeline();
		this._initPipeline();
		this._initManagers();
		this._wireEvents();

		// Seed path tracer with minimal empty scene data
		this.stages.pathTracer.setTriangleData( new Float32Array( 32 ), 0 );
		this.stages.pathTracer.setBVHData( new Float32Array( 16 ) );
		this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
		this.stages.pathTracer.setupMaterial();

		if ( this._showStats ) this._initStats();

		this.isInitialized = true;
		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		this.animationManagerId = requestAnimationFrame( () => this.animate() );

		if ( this._loadingInProgress || this._sdf?.isProcessing ) {

			this._stats?.update();
			return;

		}

		if ( this.cameraManager.controls ) this.cameraManager.controls.update();

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

		this.cameraManager.camera.updateMatrixWorld();

		// Raster fallback when path tracer is disabled
		if ( ! this.pathTracerEnabled ) {

			this.renderer.render( this.meshScene, this.cameraManager.camera );
			this._renderHelperOverlay();
			return;

		}

		if ( this.pauseRendering ) return;

		// Auto-focus: compute focus distance before rendering
		this.cameraManager.updateAutoFocus();

		// Render path tracing
		if ( this.stages.pathTracer?.isReady ) {

			if ( this.stages.pathTracer.isComplete && this.completion.renderCompleteDispatched ) {

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

				this.completion.updateTime();

			}

			updateStats( { timeElapsed: this.completion.timeElapsed, samples: getDisplaySamples( this.stages.pathTracer ) } );

			// Check time limit
			if ( this.completion.isTimeLimitReached( this.settings.get( 'renderLimitMode' ), this.settings.get( 'renderTimeLimit' ) ) ) {

				this.stages.pathTracer.isComplete = true;

			}

			// Render completion → denoise/upscale chain
			if ( this.stages.pathTracer.isComplete && this.completion.markComplete() ) {

				this.denoisingManager.onRenderComplete( {
					isStillComplete: () => this.completion.renderCompleteDispatched,
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

		if ( this.animationManagerId ) {

			cancelAnimationFrame( this.animationManagerId );
			this.animationManagerId = null;

		}

	}

	/** Wakes the animation loop if it was stopped due to idle. */
	wake() {

		if ( ! this.animationManagerId && this.isInitialized && ! this._paused ) this.animate();

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
		if ( ! this.animationManagerId ) this.animate();
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

		// Abort post-processing and restore denoiser canvas resolution
		this.denoisingManager?.abort( this.canvas );

		if ( this.denoisingManager?.restoreBaseResolution() ) {

			const w = this.denoisingManager._lastRenderWidth;
			const h = this.denoisingManager._lastRenderHeight;
			this.dispatchEvent( { type: 'resolution_changed', width: w, height: h } );

		}

		this.completion.reset();
		this.wake();
		this.dispatchEvent( { type: 'RenderReset' } );
		this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		if ( this._disposed ) return;
		this._disposed = true;

		this.dispatchEvent( { type: EngineEvents.DISPOSE } );
		this.stopAnimation();
		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = null;

		this._removeTrackedListeners();
		setStatusCallback( null );

		this.interactionManager?.deselect?.();
		this.transformManager?.detach?.();

		this.animationManager?.dispose();
		this.transformManager?.dispose();
		this.overlayManager?.dispose();
		this.lightManager?.dispose();
		this.denoisingManager?.dispose();
		this.interactionManager?.dispose();
		this.cameraManager?.dispose();

		this.pipeline?.dispose();

		// _sdf + assetLoader own the heaviest GPU allocations (material texture arrays,
		// BVH/triangle buffers, loaded GLTF resources, BVH refit worker, loader caches).
		// They are not referenced by the pipeline, so pipeline.dispose() does not reach them.
		this._sdf?.dispose();
		this._sdf = null;

		this.assetLoader?.dispose();
		this.assetLoader = null;

		if ( this.meshScene ) {

			this.meshScene.environment?.dispose();
			this.meshScene.environment = null;

			for ( const child of [ ...this.meshScene.children ] ) {

				disposeObjectFromMemory( child );

			}

			this.meshScene.clear();
			this.meshScene = null;

		}

		this._sceneHelpers?.clear();
		this._sceneHelpers = null;

		this.scene?.clear();
		this.scene = null;

		// Three.js 0.184 leaks (confirmed via heap-snapshot retainer analysis):
		//
		//   1) Renderer.dispose() does not remove the 'resize' listener it installs on
		//      _canvasTarget. The bound handler closes over the renderer, pinning the
		//      entire WebGPU graph (Backend, Nodes, Bindings, Pipelines, GPUDevice,
		//      every TSL node) alive indefinitely.
		//      See three/src/renderers/common/Renderer.js:292 (attach) and
		//      :2503 (dispose — missing removal).
		//
		//   2) Textures manager (one per renderer) registers a per-texture 'dispose'
		//      listener that closes over `this = Textures` — which transitively
		//      captures backend → renderer. These listeners are removed only when
		//      the texture itself is destroyed. For module-level singletons like
		//      EmptyTexture (new Texture in TextureNode.js) and its CubeTexture
		//      counterpart, the texture is never destroyed, so every renderer ever
		//      created leaks through the singleton's listener array.
		//
		// Both workarounds are safe when only a single PathTracerApp is active at a
		// time. If you run multiple in parallel, reset listeners only on the renderer
		// being disposed (not the shared singletons).
		if ( this.renderer?._canvasTarget && this.renderer._onCanvasTargetResize ) {

			this.renderer._canvasTarget.removeEventListener(
				'resize',
				this.renderer._onCanvasTargetResize
			);

		}

		try {

			const emptyTex = _tslTexture().value;
			const emptyCube = _tslCubeTexture().value;
			if ( emptyTex?._listeners?.dispose ) emptyTex._listeners.dispose.length = 0;
			if ( emptyCube?._listeners?.dispose ) emptyCube._listeners.dispose.length = 0;

		} catch ( err ) {

			console.warn( 'PathTracerApp: failed to clear TSL texture singleton listeners', err );

		}

		this.renderer?.dispose();
		if ( this.renderer ) this.renderer._canvasTarget = null;
		this.renderer = null;

		if ( this._stats ) {

			this._stats.dom.remove();
			this._stats = null;

		}

		this.stages = {};
		this.isInitialized = false;

	}

	// ═══════════════════════════════════════════════════════════════
	// Asset Loading
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Tears down the current scene: stops animation, deselects, disposes
	 * the loaded model + its GPU resources, clears lights, and seeds the
	 * path tracer with an empty scene. Leaves the renderer, pipeline, and
	 * managers intact so a subsequent loadModel() can reuse them.
	 *
	 * Safe to call at any point after init() (including while idle).
	 * Throws if called concurrently with a load.
	 */
	unloadScene() {

		if ( ! this.isInitialized ) return;
		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.unloadScene: cannot unload while a load is in progress' );

		}

		if ( this._disposed ) return;

		// Stop animation + refit
		this.animationManager?.dispose();
		this._animRefitInFlight = false;

		// Drop selection + transform gizmo attachment
		this.interactionManager?.deselect();
		this.transformManager?.detach?.();

		// Release the loaded model. If loaded via loadObject3D(), the caller owns it —
		// we only detach it from the scene. Otherwise dispose geometries/materials/textures.
		this.assetLoader?.releaseTargetModel();

		// Clear lights in the WebGPU light scene
		this.lightManager?.clearLights?.();

		// Seed path tracer with empty data (matches the init-time seed)
		if ( this.stages.pathTracer ) {

			this.stages.pathTracer.setTriangleData( new Float32Array( 32 ), 0 );
			this.stages.pathTracer.setBVHData( new Float32Array( 16 ) );
			this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
			this.stages.pathTracer.setEmissiveTriangleData?.( new Float32Array( 0 ), 0, 0 );
			this.stages.pathTracer.setupMaterial();

		}

		this.reset();
		this.dispatchEvent( { type: 'SceneUnloaded' } );

	}

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
	 * Loads a Three.js Object3D directly into the path tracer scene.
	 * Builds BVH from the object's meshes and uploads scene data.
	 * @param {import('three').Object3D} object3d - The Object3D to render
	 * @param {string} [name='object3d'] - Display name for the object
	 */
	async loadObject3D( object3d, name = 'object3d' ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadObject3D( object3d, name ),
			{ type: 'Object3DLoaded', name }
		);

	}

	/**
	 * Loads an environment map and rebuilds CDF.
	 * @param {string} url - Environment URL
	 */
	async loadEnvironment( url ) {

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.loadEnvironment: another load is already in progress' );

		}

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

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp: another load is already in progress' );

		}

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

		// Clear selection before rebuilding — the old object leaves the scene graph
		this.interactionManager?.deselect();

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

		// Transfer geometry, materials, and textures to GPU
		updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'GPU data transfer' );

		if ( ! this._sdf.uploadToPathTracer( this.stages.pathTracer, this.lightManager, this.meshScene, environmentTexture ) ) return false;

		// Patch per-mesh visibility into the TLAS leaves we just uploaded
		this.stages.pathTracer._meshRefs = this.stages.pathTracer._collectMeshRefs( this.meshScene );
		this.stages.pathTracer.setMeshVisibilityData( this.stages.pathTracer._meshRefs );

		timer.end( 'GPU data transfer' );

		// Compile shaders
		updateLoading( { status: "Compiling shaders...", progress: 90 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'Material setup (TSL compile)' );
		this.stages.pathTracer.setupMaterial();
		timer.end( 'Material setup (TSL compile)' );

		// Front-load GPU pipeline creation so the first animate frame is snappy:
		//  - compute: Three.js has no async compute compile — one dispatch at
		//    build time moves the stall to this loading moment.
		//  - raster fallback: compileAsync yields to main thread (r184+).
		timer.start( 'Pipeline precompile' );
		this.stages.pathTracer.shaderBuilder.forceCompile( this.renderer );
		try {

			await this.renderer.compileAsync( this.meshScene, this.cameraManager.camera );

		} catch ( err ) {

			console.warn( 'PathTracerApp: raster fallback precompile failed', err );

		}

		timer.end( 'Pipeline precompile' );

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

		// Auto-derive SHaRC scene scale from the loaded scene's bounds. Picks a
		// sensible default that keeps voxel-cell density in budget across very
		// different scene sizes (tabletop → architectural). Fired once per scene
		// load so the slider in the UI reflects the new value; user can still
		// override and the override persists until the next scene load.
		this._autoTuneSharcSceneScale();

		timer.print();
		resetLoading();

		this._initAnimationAndTransforms();

		this.dispatchEvent( { type: 'SceneRebuild' } );
		return true;

	}

	/**
	 * Heuristic: pick `sharcSceneScale` based on the loaded scene's bounding
	 * diagonal. Larger scenes get a smaller scale so the cache budget isn't
	 * blown by sub-meter cells across hundreds of meters; tabletop scenes get a
	 * larger scale so cells are fine enough to capture sub-cm detail.
	 *
	 * Voxel size at distance d from camera with default levelBias=3:
	 *   voxelSize ≈ d / sceneScale
	 * Number of cells filling a viewing volume of side D scales as sceneScale³,
	 * so capping sceneScale based on D keeps occupancy in budget.
	 *
	 * Step function rather than smooth scaling because the LOD math is already
	 * distance-adaptive — these tiers just shift the absolute density.
	 */
	/**
	 * Pick a SHaRC capacity that fits the device's storage buffer binding limit.
	 * Largest SHaRC buffer is `_cellData` at 32 bytes/entry (8 × u32 per cell).
	 * If the requested capacity would exceed the device's max binding size,
	 * halve until it fits. Defensive for low-memory iGPUs and restricted browser
	 * environments — most desktop GPUs have plenty of headroom.
	 */
	_pickSharcCapacity( requested ) {

		const device = this.renderer?.backend?.device;
		const maxBinding = device?.limits?.maxStorageBufferBindingSize;
		if ( ! maxBinding ) return requested; // Fall through if limit unavailable

		const BYTES_PER_ENTRY = 32; // 8 × u32 in cellData (the largest SHaRC buffer)
		// Reserve some headroom — don't fill the binding limit exactly.
		const safeBudget = Math.floor( maxBinding * 0.5 );

		let capacity = requested;
		while ( capacity * BYTES_PER_ENTRY > safeBudget && capacity > 65536 ) {

			capacity = Math.floor( capacity / 2 );

		}

		if ( capacity !== requested ) {

			console.log(
				`PathTracerApp: SHaRC capacity reduced from ${requested.toLocaleString()} ` +
				`to ${capacity.toLocaleString()} entries to fit device's ` +
				`maxStorageBufferBindingSize (${( maxBinding / 1048576 ).toFixed( 1 )} MiB).`
			);

		}

		return capacity;

	}

	_autoTuneSharcSceneScale() {

		if ( ! this.stages.pathTracer || ! this.meshScene ) return;

		const box = new Box3().setFromObject( this.meshScene );
		if ( ! isFinite( box.min.x ) || ! isFinite( box.max.x ) ) return;

		const size = new Vector3();
		box.getSize( size );
		const diagonal = size.length();
		if ( diagonal < 1e-4 ) return; // Empty / invalid scene

		let scale;
		if ( diagonal < 0.5 ) scale = 100; // tabletop / product (< 50cm)
		else if ( diagonal < 5 ) scale = 50; // object / character (50cm–5m)
		else if ( diagonal < 50 ) scale = 25; // room / interior (5–50m)
		else scale = 10; // architectural / outdoor (> 50m)

		const pt = this.stages.pathTracer;
		pt.sharcSceneScale.value = scale;
		this.settings.set( 'sharcSceneScale', scale );

		// Notify UI so the slider reflects the new value. App-side listener in
		// EngineAdapter syncs the Zustand store on this event.
		this.dispatchEvent( {
			type: 'sharc:autoTuned',
			sceneScale: scale,
			sceneDiagonal: diagonal,
		} );

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

		const { triRanges, bvhRanges } = this._sdf.computeBLASDirtyRanges( affectedMeshIndices );
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

	// ═══════════════════════════════════════════════════════════════
	// Resize
	// ═══════════════════════════════════════════════════════════════

	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		if ( width === 0 || height === 0 ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.cameraManager.camera.aspect = width / height;
		this.cameraManager.camera.updateProjectionMatrix();

		// Overlay helpers always render at display resolution
		const dpr = window.devicePixelRatio || 1;
		this.overlayManager?.setSize(
			Math.round( width * dpr ),
			Math.round( height * dpr )
		);

		const lastW = this.denoisingManager?._lastRenderWidth ?? 0;
		const lastH = this.denoisingManager?._lastRenderHeight ?? 0;
		if ( width === lastW && height === lastH ) return;

		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = setTimeout( () => {

			this._applyRenderResize( width, height );

		}, 300 );

	}

	_applyRenderResize( renderWidth, renderHeight ) {

		this.pipeline?.setSize( renderWidth, renderHeight );
		this.denoisingManager?.setRenderSize( renderWidth, renderHeight );
		this.needsReset = true;

		this.dispatchEvent( { type: 'resolution_changed', width: renderWidth, height: renderHeight } );

	}

	setCanvasSize( width, height ) {

		if ( width === 0 || height === 0 ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.cameraManager.camera.aspect = width / height;
		this.cameraManager.camera.updateProjectionMatrix();

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
			this.cameraManager.controls.enabled = false;
			this.renderer?.domElement && ( this.renderer.domElement.style.display = 'none' );
			this.denoisingManager?.denoiser?.output && ( this.denoisingManager.denoiser.output.style.display = 'none' );
			return;

		}

		const isFinal = mode === 'final-render';
		const config = isFinal ? FINAL_RENDER_CONFIG : PREVIEW_RENDER_CONFIG;

		this.cameraManager.controls.enabled = ! isFinal;

		// Batch uniform updates via settings
		this.settings.setMany( {
			maxSamples: config.maxSamples,
			maxBounces: config.bounces,
			samplesPerPixel: config.samplesPerPixel,
			transmissiveBounces: config.transmissiveBounces,
		}, { silent: true } );

		this.stages.pathTracer?.setUniform( 'renderMode', parseInt( config.renderMode ) );
		this.stages.pathTracer?.setUniform( 'enableAlphaShadows', config.enableAlphaShadows ?? false );
		this.stages.pathTracer?.tileManager?.setTileCount( config.tiles );

		// SHaRC: force Query off in Final (cache is biased; path tracer must
		// converge to ground truth). On Preview, restore the user's last toggle
		// from settings. Update path is left untouched so the cache keeps warming.
		if ( this.stages.pathTracer && 'sharcQueryEnabled' in config ) {

			const restoreFromUser = config.sharcQueryEnabled === null;
			const queryVal = restoreFromUser
				? ( this.settings.get( 'sharcQueryEnabled' ) ? 1 : 0 )
				: ( config.sharcQueryEnabled ? 1 : 0 );
			this.stages.pathTracer.sharcQueryEnabled.value = queryVal;

		}

		const tileHelper = this.overlayManager?.getHelper( 'tiles' );
		if ( tileHelper ) {

			tileHelper.enabled = config.tilesHelper;
			if ( ! config.tilesHelper ) tileHelper.hide();

		}

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

	refreshFrame() {

		this._needsDisplayRefresh = true;
		this.wake();

	}

	// ═══════════════════════════════════════════════════════════════
	// Output (absorbed from OutputAPI)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Returns the canvas element with the final rendered image.
	 * Chooses the post-processing canvas when denoiser/upscaler are active.
	 * @returns {HTMLCanvasElement|null}
	 */
	getCanvas() {

		if ( ! this.renderer?.domElement ) return null;

		const dm = this.denoisingManager;
		const usePostProcess = ( dm?.denoiser?.enabled || dm?.upscaler?.enabled )
			&& dm?.denoiserCanvas
			&& this.stages.pathTracer?.isComplete;

		if ( usePostProcess ) return dm.denoiserCanvas;

		// Re-render display stage so the WebGPU canvas has valid content
		if ( this.stages.display && this.pipeline?.context ) {

			this.stages.display.render( this.pipeline.context );

		}

		return this.renderer.domElement;

	}

	/**
	 * Downloads a PNG screenshot of the current render.
	 */
	screenshot() {

		const canvas = this.getCanvas();
		if ( ! canvas ) return;

		try {

			const data = canvas.toDataURL( 'image/png' );
			const link = document.createElement( 'a' );
			link.href = data;
			link.download = 'screenshot.png';
			link.click();

		} catch ( error ) {

			console.error( 'Screenshot failed:', error );

		}

	}

	/**
	 * Returns scene statistics (triangle count, mesh count, etc.).
	 * @returns {Object|null}
	 */
	getStatistics() {

		try {

			return this._sdf?.getStatistics?.() ?? null;

		} catch {

			return null;

		}

	}

	/**
	 * Whether a model/environment load is currently in progress.
	 * @returns {boolean}
	 */
	get isLoading() {

		return this._loadingInProgress;

	}

	/**
	 * Whether the path tracer has finished converging.
	 * @returns {boolean}
	 */
	isComplete() {

		return this.stages.pathTracer?.isComplete ?? false;

	}

	/**
	 * Returns the current accumulated frame/sample count.
	 * @returns {number}
	 */
	getFrameCount() {

		return this.stages.pathTracer?.frameCount || 0;

	}

	// ═══════════════════════════════════════════════════════════════
	// Materials (absorbed from MaterialsAPI)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Updates a single material property and triggers emissive rebuild if needed.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	setMaterialProperty( materialIndex, property, value ) {

		this.stages.pathTracer?.materialData.updateMaterialProperty( materialIndex, property, value );

		const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity' ];
		if ( emissiveAffectingProps.includes( property )
			&& this.stages.pathTracer?.enableEmissiveTriangleSampling?.value ) {

			const result = this._sdf.updateMaterialEmissive( materialIndex, property, value );
			if ( result ) {

				this.stages.pathTracer.setEmissiveTriangleData(
					result.rawData, result.emissiveCount, result.totalPower,
				);

			}

		}

		this.reset();

	}

	/**
	 * Update per-mesh visibility without rebuilding the scene.
	 * Walks the parent chain to resolve world-space visibility.
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setMeshVisibility( meshIndex, visible ) {

		this.stages.pathTracer?.updateMeshVisibility( meshIndex, visible );
		this.reset();

	}

	/**
	 * Recompute world-visibility for all meshes.
	 * Call after changing visibility on groups or parent objects.
	 */
	updateAllMeshVisibility() {

		this.stages.pathTracer?.updateAllMeshVisibility();
		this.reset();

	}

	/**
	 * Updates a material's texture transform (offset, repeat, rotation).
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Object} transform
	 */
	setTextureTransform( materialIndex, textureName, transform ) {

		this.stages.pathTracer?.materialData.updateTextureTransform( materialIndex, textureName, transform );
		this.reset();

	}

	/**
	 * Full material rebuild (required after texture changes).
	 * @param {import('three').Scene} [scene]
	 */
	async rebuildMaterials( scene ) {

		await this.stages.pathTracer?.rebuildMaterials( scene || this.meshScene );
		this.reset();

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Initialization
	// ═══════════════════════════════════════════════════════════════

	async _initRenderer() {

		setStatusCallback( ( event ) => this.dispatchEvent( event ) );

		if ( ! navigator.gpu ) {

			throw new Error( 'WebGPU is not supported in this browser' );

		}

		const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! adapter ) {

			throw new Error( 'Failed to get WebGPU adapter' );

		}

		const adapterLimits = adapter.limits;

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

		await this.renderer.init();

		RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );

		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.setPixelRatio( 1.0 );

	}

	_initCameraManager() {

		this.cameraManager = new CameraManager( this.canvas );

	}

	_initScenes() {

		this.scene = new Scene();
		this.meshScene = new Scene();
		this._sceneHelpers = new SceneHelpers();

	}

	_initAssetPipeline() {

		this._sdf = new SceneProcessor();
		this.assetLoader = new AssetLoader( this.meshScene, this.cameraManager.camera, this.cameraManager.controls );
		this.assetLoader.setRenderer( this.renderer );
		this.assetLoader.createFloorPlane();

		this._addTrackedListener( this.cameraManager.controls, 'change', () => {

			this.needsReset = true;
			this.wake();

		} );

	}

	_initPipeline() {

		this._createStages();

		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new RenderPipeline( this.renderer, w || 1, h || 1 );

		// SHaRC runs before the path tracer so the resolve pass dispatches on
		// the previous frame's accumulator before this frame writes to it. In
		// Phase 1 this is purely cosmetic (path tracer doesn't write yet);
		// matters in Phase 2.
		this.pipeline.addStage( this.stages.sharc );
		this.pipeline.addStage( this.stages.pathTracer );
		this.pipeline.addStage( this.stages.normalDepth );
		this.pipeline.addStage( this.stages.motionVector );
		this.pipeline.addStage( this.stages.asvgf );
		this.pipeline.addStage( this.stages.variance );
		this.pipeline.addStage( this.stages.bilateralFilter );
		this.pipeline.addStage( this.stages.adaptiveSampling );
		this.pipeline.addStage( this.stages.edgeFilter );
		this.pipeline.addStage( this.stages.autoExposure );
		this.pipeline.addStage( this.stages.display );

		const initRenderW = this.canvas.clientWidth || 1;
		const initRenderH = this.canvas.clientHeight || 1;
		this.pipeline.setSize( initRenderW, initRenderH );

	}

	_initManagers() {

		this.interactionManager = new InteractionManager( {
			scene: this.meshScene,
			camera: this.cameraManager.camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracer: null,
			floorPlane: this.assetLoader.floorPlane
		} );

		this.interactionManager.wireAppEvents( this );

		this.cameraManager.setInteractionManager( this.interactionManager );
		this.lightManager = new LightManager( this.scene, this._sceneHelpers, this.stages.pathTracer, {
			onReset: () => this.reset(),
		} );
		this._setupDenoisingManager();
		this._setupOverlayManager();

		this.transformManager = new TransformManager( {
			camera: this.cameraManager.camera,
			canvas: this.canvas,
			orbitControls: this.cameraManager.controls,
			app: this,
		} );

		// Wire cross-manager dependencies
		this.interactionManager.setDependencies( {
			overlayManager: this.overlayManager,
			transformManager: this.transformManager,
			appDispatch: ( e ) => this.dispatchEvent( e ),
			orbitControls: this.cameraManager.controls,
		} );

		this.denoisingManager.setOverlayManager( this.overlayManager );
		this.denoisingManager.setResetCallback( () => this.reset() );
		this.denoisingManager.setSettings( this.settings );

		// Expose environment manager (lives on pathTracer stage)
		this.environmentManager = this.stages.pathTracer.environment;
		this.environmentManager.callbacks.onAutoExposureReset = () => this.pipeline.eventBus.emit( 'autoexposure:resetHistory' );

	}

	_wireEvents() {

		// Forward manager events → app events
		this._addTrackedListener( this.cameraManager, 'CameraSwitched', ( e ) => this.dispatchEvent( e ) );
		this._addTrackedListener( this.cameraManager, EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => this.dispatchEvent( e ) );

		this._forwardEvents( this.denoisingManager, [
			EngineEvents.DENOISING_START, EngineEvents.DENOISING_END,
			EngineEvents.UPSCALING_START, EngineEvents.UPSCALING_PROGRESS, EngineEvents.UPSCALING_END,
			'resolution_changed',
		] );

		this._setupAutoExposureListener();

		// Animation lifecycle → wake + refit flag
		this.animationManager.wakeCallback = () => this.wake();
		this._forwardEvents( this.animationManager, [
			EngineEvents.ANIMATION_STARTED,
			EngineEvents.ANIMATION_PAUSED,
			EngineEvents.ANIMATION_STOPPED,
		] );
		this._addTrackedListener( this.animationManager, EngineEvents.ANIMATION_PAUSED, () => {

			this._animRefitInFlight = false;

		} );
		this._addTrackedListener( this.animationManager, EngineEvents.ANIMATION_STOPPED, () => {

			this._animRefitInFlight = false;

		} );

		// Camera callbacks for switchCamera / focusOn
		this.cameraManager.initCallbacks( {
			onResize: () => this.onResize(),
			onReset: () => this.reset(),
			getSettings: ( k ) => this.settings.get( k ),
		} );

		// Auto-focus context — CameraManager stores it, reads it each frame
		this.cameraManager.initAutoFocus( {
			meshScene: this.meshScene,
			assetLoader: this.assetLoader,
			floorPlane: this.assetLoader.floorPlane,
			pathTracer: this.stages.pathTracer,
			settings: this.settings,
			softReset: () => this.reset( true ),
			hardReset: () => this.reset(),
		} );

		// Bind settings to pipeline stages
		this.settings.bind( {
			stages: this.stages,
			resetCallback: () => this.reset(),
			reconcileCompletion: () => this._reconcileCompletion(),
		} );

		// Resize handling
		this.onResize();
		this.resizeHandler = () => this.onResize();
		if ( this._autoResize ) {

			this._addTrackedListener( window, 'resize', this.resizeHandler );

		}

		// Asset load events
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

		this._addTrackedListener( this.assetLoader, 'load', this._onAssetLoaded );

		this._addTrackedListener( this.assetLoader, 'modelProcessed', ( event ) => {

			const cameras = [ this.cameraManager.camera, ...( event.cameras || [] ) ];
			this.cameraManager.setCameras( cameras );

			if ( this.interactionManager ) {

				this.interactionManager.floorPlane = this.assetLoader.floorPlane;

			}

		} );

	}

	/**
	 * Initializes animation manager and transform manager after scene rebuild.
	 */
	_initAnimationAndTransforms() {

		const animations = this.assetLoader?.animations || [];
		if ( animations.length > 0 ) {

			const mixerRoot = this.assetLoader?.targetModel || this.meshScene;
			this.animationManager.init( this.meshScene, mixerRoot, this._sdf.meshes, animations, this._sdf.triangleCount );
			this.animationManager.onFinished = () => {

				this._animRefitInFlight = false;
				this.dispatchEvent( { type: EngineEvents.ANIMATION_FINISHED } );

			};

		}

		this.transformManager?.setMeshData( this._sdf.meshes, this._sdf.triangleCount );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Stage creation & setup
	// ═══════════════════════════════════════════════════════════════

	_createStages() {

		const adaptiveSamplingMax = this.settings.get( 'adaptiveSamplingMax' );
		const useAdaptiveSampling = this.settings.get( 'useAdaptiveSampling' );

		this.stages.pathTracer = new PathTracer( this.renderer, this.scene, this.cameraManager.camera );
		this.stages.normalDepth = new NormalDepth( this.renderer, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.motionVector = new MotionVector( this.renderer, this.cameraManager.camera, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.asvgf = new ASVGF( this.renderer, { enabled: false } );
		this.stages.variance = new Variance( this.renderer, { enabled: false } );
		this.stages.bilateralFilter = new BilateralFilter( this.renderer, { enabled: false } );
		this.stages.adaptiveSampling = new AdaptiveSampling( this.renderer, {
			adaptiveSamplingMax,
			enabled: useAdaptiveSampling,
		} );
		this.stages.edgeFilter = new EdgeFilter( this.renderer, { enabled: false } );
		this.stages.autoExposure = new AutoExposure( this.renderer, { enabled: DEFAULT_STATE.autoExposure ?? false } );
		const sharcCapacity = this._pickSharcCapacity( DEFAULT_STATE.sharcCapacity ?? ( 1 << 20 ) );
		this.stages.sharc = new SHaRC( this.renderer, {
			enabled: DEFAULT_STATE.sharcEnabled ?? false,
			capacity: sharcCapacity,
			staleFrameNumMax: DEFAULT_STATE.sharcStaleFrameMax ?? 32,
			resolveStride: DEFAULT_STATE.sharcResolveStride ?? 1,
		} );
		// Wire SHaRC into PathTracer so ShaderBuilder can bind its atomic buffers
		// when the compute graph is built. Phase 2 path-tracer Update path reads
		// `this.sharcStage` lazily inside ShaderBuilder._createTextureNodes.
		this.stages.pathTracer.sharcStage = this.stages.sharc;

		this.stages.display = new Display( this.renderer, {
			exposure: ( DEFAULT_STATE.autoExposure ) ? 1.0 : ( this.settings.get( 'exposure' ) ?? 1.0 ),
			saturation: this.settings.get( 'saturation' ) ?? DEFAULT_STATE.saturation,
		} );

	}

	_setupDenoisingManager() {

		this.denoisingManager = new DenoisingManager( {
			renderer: this.renderer,
			mainCanvas: this.canvas,
			scene: this.scene,
			camera: this.cameraManager.camera,
			stages: {
				pathTracer: this.stages.pathTracer,
				asvgf: this.stages.asvgf,
				variance: this.stages.variance,
				bilateralFilter: this.stages.bilateralFilter,
				adaptiveSampling: this.stages.adaptiveSampling,
				edgeFilter: this.stages.edgeFilter,
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

		// Set initial render resolution
		const initW = this.canvas.clientWidth || 1;
		const initH = this.canvas.clientHeight || 1;
		this.denoisingManager.setRenderSize( initW, initH );

	}

	_reconcileCompletion() {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return;

		const shouldBeComplete = this.completion.isLimitReached(
			stage, this.settings.get( 'renderLimitMode' ), this.settings.get( 'renderTimeLimit' )
		);

		if ( shouldBeComplete && ! stage.isComplete ) {

			stage.isComplete = true;

		} else if ( ! shouldBeComplete && stage.isComplete ) {

			stage.isComplete = false;
			this.completion.resumeFromPause();

			this.canvas.style.opacity = '1';
			const denoiserOutput = this.denoisingManager?.denoiser?.output;
			if ( denoiserOutput ) denoiserOutput.style.display = 'none';

			this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );
			this.wake();

		}

	}

	_initStats() {

		const container = this._statsContainer || this.canvas.parentElement || document.body;
		this._stats = createStats( this.renderer, container );

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
		this.transformManager?.render( this.renderer );

	}

	_setupOverlayManager() {

		this.overlayManager = new OverlayManager( this.renderer, this.cameraManager.camera );
		this.overlayManager.setupDefaultHelpers( {
			helperScene: this._sceneHelpers,
			meshScene: this.meshScene,
			pipeline: this.pipeline,
			denoisingManager: this.denoisingManager,
			app: this,
			renderWidth: this.denoisingManager?._lastRenderWidth || this.canvas.clientWidth || 1,
			renderHeight: this.denoisingManager?._lastRenderHeight || this.canvas.clientHeight || 1,
		} );

	}


	_syncControlsAfterLoad() {

		this.cameraManager.controls.saveState();
		this.cameraManager.controls.update();

	}

	/**
	 * Forwards events from a source EventDispatcher to this app instance.
	 */
	_forwardEvents( source, eventTypes ) {

		if ( ! source ) return;
		for ( const type of eventTypes ) {

			this._addTrackedListener( source, type, ( e ) => this.dispatchEvent( e ) );

		}

	}

}
