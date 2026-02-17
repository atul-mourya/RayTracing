import { WebGPURenderer } from 'three/webgpu';
import { ACESFilmicToneMapping, PerspectiveCamera, Scene, EventDispatcher } from 'three';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PathTracingStage } from './Stages/PathTracingStage.js';
import { DataTransfer } from './DataTransfer.js';
import { DEFAULT_STATE } from '../../Constants.js';
import { WebGPUFeatures } from './WebGPUFeatures.js';
import { updateStats } from '../Processor/utils.js';
import InteractionManager from '../InteractionManager.js';
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
	constructor( canvas, existingApp = null ) {

		super();

		this.canvas = canvas;
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
			powerPreference: 'high-performance'
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

		// Create path tracing stage
		this.pathTracingStage = new PathTracingStage( this.renderer, this.scene, this.camera );

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

		this.isInitialized = true;

		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

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
	 * Loads scene data from the existing PathTracerApp.
	 *
	 * @returns {boolean} True if data was loaded successfully
	 */
	async loadSceneData() {

		if ( ! this.existingApp ) {

			console.warn( 'WebGPUPathTracerApp: No existing app to load data from' );
			return false;

		}

		// Get textures
		const triangleTexture = DataTransfer.getTriangleTexture( this.existingApp );
		const bvhTexture = DataTransfer.getBVHTexture( this.existingApp );
		const materialTexture = DataTransfer.getMaterialTexture( this.existingApp );
		const environmentTexture = DataTransfer.getEnvironmentTexture( this.existingApp );

		if ( ! triangleTexture ) {

			console.error( 'WebGPUPathTracerApp: Failed to get triangle texture' );
			return false;

		}

		// Set data
		this.pathTracingStage.setTriangleTexture( triangleTexture );

		if ( ! bvhTexture ) {

			console.error( 'WebGPUPathTracerApp: Failed to get BVH texture' );
			return false;

		}

		this.pathTracingStage.setBVHTexture( bvhTexture );

		if ( materialTexture ) {

			this.pathTracingStage.setMaterialTexture( materialTexture );

		} else {

			console.warn( 'WebGPUPathTracerApp: No material texture, using defaults' );

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

		// Transfer emissive triangle data
		const emissiveData = DataTransfer.getEmissiveTriangleData( this.existingApp );
		if ( emissiveData.emissiveTriangleTexture ) {

			this.pathTracingStage.setEmissiveTriangleTexture( emissiveData.emissiveTriangleTexture );
			this.pathTracingStage.setEmissiveTriangleCount( emissiveData.emissiveTriangleCount );

		}

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

			this.pathTracingStage.reset();
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
				if ( this.pathTracingStage.isComplete && this._renderCompleteDispatched ) return;

				this.pathTracingStage.render();

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

				// Check for render completion (use stage's own isComplete flag)
				if ( this.pathTracingStage.isComplete && ! this._renderCompleteDispatched ) {

					this._renderCompleteDispatched = true;
					this.dispatchEvent( { type: 'RenderComplete' } );
					useStore.getState().setIsRenderComplete( true );

				}

			}

		} else {

			// Traditional rasterization when path tracer is disabled
			// Similar to WebGL's RenderPass behavior
			this.renderer.render( this.scene, this.camera );

		}

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

	}

	/**
	 * Resumes the animation loop.
	 */
	resume() {

		if ( ! this.animationId ) {

			this.animate();
			console.log( 'WebGPUPathTracerApp: Resumed' );

		}

	}

	/**
	 * Resets the accumulation buffer.
	 */
	reset() {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.reset();

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

		// Exposure is applied in the display shader via the TSL uniform
		// (pow(exposure, 4.0) curve matching WebGL). No need to set
		// renderer.toneMappingExposure — kept at 1.0 to avoid doubling.
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setExposure( exposure );

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
	 * Enables/disables adaptive sampling.
	 */
	setUseAdaptiveSampling( use ) {

		this.useAdaptiveSampling = use;
		if ( this.pathTracingStage ) {

			this.pathTracingStage.setUseAdaptiveSampling( use );

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
	 * Selects an object for highlighting in the UI.
	 * No outline pass in WebGPU, so just updates the store.
	 */
	selectObject( object ) {

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
	 * @stub
	 */
	addLight() {}

	/**
	 * @stub
	 */
	removeLight() {}

	/**
	 * @stub
	 */
	clearLights() {}

	/**
	 * @stub
	 */
	getLights() {

		return [];

	}

	/**
	 * Takes a screenshot of the current render and downloads it.
	 */
	takeScreenshot() {

		if ( ! this.renderer?.domElement ) return;

		try {

			const screenshot = this.renderer.domElement.toDataURL( 'image/png' );
			const link = document.createElement( 'a' );
			link.href = screenshot;
			link.download = 'screenshot.png';
			link.click();

		} catch ( error ) {

			console.error( 'WebGPUPathTracerApp: Screenshot failed:', error );

		}

	}

	/**
	 * @stub
	 */
	refreshFrame() {}

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

	/**
	 * @stub
	 */
	setRenderLimitMode( /* val */ ) {}

	/**
	 * @stub
	 */
	setEnvironmentRotation( /* val */ ) {}

	/**
	 * @stub
	 */
	setInteractionModeEnabled( /* val */ ) {}

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

		if ( this.pathTracingStage ) {

			this.pathTracingStage.dispose();

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

		window.removeEventListener( 'resize', this.resizeHandler );

		this.isInitialized = false;

	}

}

