import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	SRGBColorSpace,
	DirectionalLight,
	PointLight,
	SpotLight,
	Object3D,
	WebGLRenderTarget,
	FloatType,
	Vector2,
	Mesh,
	CircleGeometry,
	MeshPhysicalMaterial,
	EventDispatcher,
	// TextureLoader,
	RGBAFormat,
	RectAreaLight,
	MathUtils
} from 'three';

import {
	OrbitControls,
	EffectComposer,
	RenderPass,
	OutlinePass,
	UnrealBloomPass,
	OutputPass,
	RectAreaLightUniformsLib
} from 'three/examples/jsm/Addons';
import Stats from 'stats-gl';
import InteractionManager from './InteractionManager';

// Import denoiser
import { OIDNDenoiser } from './Passes/OIDNDenoiser';

// Import pipeline architecture
import { PassPipeline } from './Pipeline/PassPipeline';
import { PipelineWrapperPass } from './Pipeline/PipelineWrapperPass';
import {
	PathTracerStage,
	MotionVectorStage,
	ASVGFStage,
	VarianceEstimationStage,
	BilateralFilteringStage,
	AdaptiveSamplingStage,
	EdgeAwareFilteringStage,
	TileHighlightStage,
	AutoExposureStage
} from './Stages';
import { updateStats } from './Processor/utils';
import { DEFAULT_STATE } from '../Constants';
// import radialTexture from '../../public/radial-gradient.png';
import { useStore } from '@/store';
import AssetLoader from './Processor/AssetLoader';
import { EnvironmentService } from '@/services/EnvironmentService';

// WebGLProgram.prototype.getProgramInfoLog = function () {
//   return this.programInfoLog;
// };

class PathTracerApp extends EventDispatcher {

	constructor( primaryCanvas, denoiserCanvas ) {

		super();
		this.container = primaryCanvas.parentElement;
		this.canvas = primaryCanvas;
		this.denoiserCanvas = denoiserCanvas;
		this.width = this.canvas.clientWidth;
		this.height = this.canvas.clientHeight;

		this.scene = new Scene();
		this.scene.environmentIntensity = DEFAULT_STATE.environmentIntensity;
		this.scene.backgroundIntensity = DEFAULT_STATE.backgroundIntensity;
		this.camera = new PerspectiveCamera( DEFAULT_STATE.fov, this.width / this.height, 0.01, 1000 );
		this.renderer = new WebGLRenderer( {
			powerPreference: "high-performance",
			antialias: true,
			preserveDrawingBuffer: true,
			precision: "highp",
			canvas: this.canvas,
			alpha: true
		} );

		// Initialize RectAreaLight uniforms
		RectAreaLightUniformsLib.init( this.renderer );

		// Initialize other properties
		this.controls = null;
		this.composer = null;
		this.pathTracingPass = null;
		this.edgeAwareFilterPass = null;
		this.tileHighlightPass = null;
		this.denoiser = null;
		this.animationFrameId = null;
		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this.renderLimitMode = DEFAULT_STATE.renderLimitMode;
		this.renderTimeLimit = DEFAULT_STATE.renderTimeLimit;

		// Pipeline architecture
		this.pipeline = null;
		this.pipelineWrapperPass = null;

		// Target resolution for consistent rendering across different DPR displays
		// Maps to absolute pixel values: 0=256, 1=512, 2=1024, 3=2048, 4=4096
		this.targetResolution = DEFAULT_STATE.resolution;

		this.cameras = [];
		this.currentCameraIndex = 0;
		this.defaultCamera = this.camera;

		// Interface compliance
		this.isInitialized = false;
		this.pauseRendering = false;
		this._assetOnly = false;

		// Feature support map for IPathTracerApp interface
		this._supportedFeatures = {
			pathTracing: true,
			progressiveAccumulation: true,
			dof: true,
			environmentLighting: true,
			materialsBasic: true,
			asvgf: true,
			tileRendering: true,
			objectSelection: true,
			focusPicking: true,
			oidnDenoiser: true,
			bloom: true,
			autoExposure: true,
			adaptiveSampling: true,
			lightManagement: true,
			toneMapping: true,
			edgeAwareFiltering: true,
			cameraManagement: true,
			interactionMode: true,
		};

	}

	getQueryParameter( name ) {

		const urlParams = new URLSearchParams( window.location.search );
		return urlParams.get( name );

	}

	/**
	 * @param {Object} options
	 * @param {boolean} options.assetOnly - When true, only initializes asset processing
	 *   (renderer, camera, controls, PathTracerStage, AssetLoader) and skips the full
	 *   rendering pipeline (EffectComposer, denoiser, stats, animation loop).
	 *   Used when WebGPU is the target backend — WebGPU only needs processed
	 *   asset data via DataTransfer, not WebGL's rendering infrastructure.
	 *   Call initRendering() later if WebGL rendering is needed.
	 */
	async init( { assetOnly = false } = {} ) {

		this._assetOnly = assetOnly;

		// Setup renderer
		this.renderer.setClearColor( 0x000000, 0 ); // Set clear alpha to 0 for transparency
		this.renderer.toneMapping = DEFAULT_STATE.toneMapping;
		this.renderer.toneMappingExposure = Math.pow( DEFAULT_STATE.exposure, 4.0 );
		this.renderer.outputColorSpace = SRGBColorSpace;

		// Calculate pixel ratio for absolute resolution (DEFAULT_STATE.resolution: 1 = 512px)
		const targetResolutions = { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 };
		const targetRes = targetResolutions[ DEFAULT_STATE.resolution ] || 512;
		const shortestDim = Math.min( this.width, this.height ) || 512; // Fallback if canvas not ready
		this.renderer.setPixelRatio( targetRes / shortestDim );
		this.renderer.setSize( this.width, this.height );
		this.container.appendChild( this.canvas );

		// Enable full shader error logging
		// this.renderer.debug.checkShaderErrors = true;

		// Setup canvas
		this.canvas.style.position = 'absolute';
		this.canvas.style.top = '0';
		this.canvas.style.left = '0';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.borderRadius = '5px';
		this.canvas.style.background = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px;";

		// Setup camera
		this.camera.position.set( 0, 0, 5 );

		// Setup controls with interaction optimization
		this.controls = new OrbitControls( this.camera, this.canvas );
		this.controls.zoomToCursor = true;
		this.controls.addEventListener( 'change', () => {

			this.pathTracingPass && this.pathTracingPass.enterInteractionMode();
			// Reset ASVGF temporal accumulation when camera moves to prevent frozen screen
			// Only emit if pipeline exists (it's created later in setupComposer)
			if ( this.pipeline && this.pipeline.emit ) {

				this.pipeline.emit( 'asvgf:reset' );

			}

			// Fallback: directly reset ASVGF if available
			this.asvgfPass?.reset();
			// Soft reset - preserve buffers to avoid black flash during camera movement
			this.reset();

		} );
		this.controls.update();

		this.cameras = [ this.defaultCamera ];

		// Create PathTracerStage for asset data storage (needed by AssetLoader and DataTransfer)
		this.setupPathTracerStage();

		// Full rendering pipeline setup (skipped in asset-only mode for faster WebGPU startup)
		if ( ! assetOnly ) {

			this.setupComposer();
			this.initStats();

		}

		await this.setupFloorPlane();

		// Initialize asset loader
		this.assetLoader = new AssetLoader(
			this.scene,
			this.camera,
			this.controls,
			this.pathTracingPass
		);
		this.assetLoader.setFloorPlane( this.floorPlane );

		// Initialize interaction manager
		this.interactionManager = new InteractionManager( {
			scene: this.scene,
			camera: this.camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracingPass: this.pathTracingPass,
			floorPlane: this.floorPlane
		} );

		// Set up interaction event listeners
		this.setupInteractionListeners();

		// Set initial optimization settings
		if ( useStore.getState().optimizeMeshes !== undefined ) {

			this.assetLoader.setOptimizeMeshes( useStore.getState().optimizeMeshes );

		}

		// Check for model and environment URLs in query parameters
		const modelUrl = this.getQueryParameter( 'model' );
		const envUrlParam = this.getQueryParameter( 'envUrl' );
		const defaultEnv = EnvironmentService.getEnvironmentById( DEFAULT_STATE.environment );
		const envUrl = envUrlParam || defaultEnv?.url;
		if ( envUrl ) {

			await this.assetLoader.loadEnvironment( envUrl );

		}

		if ( modelUrl ) {

			try {

				await this.assetLoader.loadModel( modelUrl );

			} catch ( error ) {

				console.error( 'Failed to load model from URL:', error );
				// Fall back to default model loading
				await this.assetLoader.loadExampleModels( DEFAULT_STATE.model );

			}

		} else {

			await this.assetLoader.loadExampleModels( DEFAULT_STATE.model );

		}

		this.pauseRendering = false;

		// Mark initialization complete
		this.isInitialized = true;

		// Start animation loop (skipped in asset-only mode)
		if ( ! assetOnly ) {

			this.animate();

		}

		// window.addEventListener( 'resize', () => this.onResize() ); // weird bug with this
		this.assetLoader.addEventListener( 'load', ( event ) => {

			// Reset the renderer when a new asset is loaded
			if ( event.type === 'model' || event.type === 'environment' ) {

				this.reset();

			}

			// Fire a custom event that UI components can listen for
			this.dispatchEvent( {
				type: event.type === 'model' ? 'ModelLoaded' : 'EnvironmentLoaded',
				data: event
			} );

			// Set pause state back to false after loading
			this.pauseRendering = false;

		} );

		// Listen for model processing completion (includes camera extraction)
		this.assetLoader.addEventListener( 'modelProcessed', ( event ) => {

			// Always reset cameras and add new ones from the current model
			this.resetCamerasAndAddFromModel( event.cameras );

			// Dispatch event to update UI
			this.dispatchEvent( {
				type: 'CamerasUpdated',
				cameras: this.cameras,
				cameraNames: this.getCameraNames()
			} );

		} );

		this.assetLoader.addEventListener( 'error', ( event ) => {

			console.error( "Asset loading error:", event.message );
			this.dispatchEvent( { type: 'AssetError', data: event } );
			this.pauseRendering = false;

		} );

	}

	/**
	 * Completes the WebGL rendering setup when initially started in asset-only mode.
	 * Restores PathTracerStage to full rendering capability (blue noise, camera optimizer,
	 * DataTextures, shader defines) that were deferred during assetOnly initialization.
	 * Called before restoreState/resume during backend switch, or when WebGPU is unavailable.
	 * Does NOT start the animation loop — callers (resume or Viewport3D) handle that.
	 */
	async initRendering() {

		if ( ! this._assetOnly ) return;

		// Restore full PathTracerStage capability
		await this.pathTracingPass.restoreFullCapability();

		if ( ! this.composer ) this.setupComposer();
		if ( ! this.stats ) this.initStats();
		this.pauseRendering = false;
		this._assetOnly = false;

	}

	/**
	 * Returns the WebGL app to asset-only mode, freeing rendering resources
	 * (DataTextures, CameraOptimizer, FSQuad, blue noise) while preserving
	 * raw data and map textures shared with WebGPU. Called by BackendManager
	 * when switching away from WebGL.
	 */
	demoteToAssetOnly() {

		if ( this._assetOnly ) return;

		this.pathTracingPass.demoteToAssetOnly();
		this._assetOnly = true;

	}

	initStats() {

		this.stats = new Stats( { horizontal: true, trackGPU: true } );
		this.stats.dom.style.position = 'absolute';
		this.stats.dom.style.top = 'unset';
		this.stats.dom.style.bottom = '48px';

		this.stats.init( this.renderer );
		this.container.parentElement.parentElement.appendChild( this.stats.dom );

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

	}

	reset() {

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();

		this.canvas.style.opacity = 1;

		// Reset pipeline
		this.pipeline?.reset();

		this.denoiser?.enabled && this.denoiser.abort();
		this.dispatchEvent( { type: 'RenderReset' } );
		useStore.getState().setIsRenderComplete( false );

	}

	setupComposer() {

		const renderTarget = new WebGLRenderTarget( this.width, this.height, {
			type: FloatType,
			format: RGBAFormat,
		} );

		this.composer = new EffectComposer( this.renderer, renderTarget );

		this.renderPass = new RenderPass( this.scene, this.camera );
		this.renderPass.enabled = false;
		this.composer.addPass( this.renderPass );

		// Setup pipeline architecture
		this.setupPipeline();

		// Common passes (outside pipeline)
		this.outlinePass = new OutlinePass( new Vector2( this.width, this.height ), this.scene, this.camera );
		this.composer.addPass( this.outlinePass );

		this.bloomPass = new UnrealBloomPass( new Vector2( this.width, this.height ) );
		this.bloomPass.enabled = DEFAULT_STATE.enableBloom;
		this.bloomPass.strength = DEFAULT_STATE.bloomStrength;
		this.bloomPass.radius = DEFAULT_STATE.bloomRadius;
		this.bloomPass.threshold = DEFAULT_STATE.bloomThreshold;
		this.composer.addPass( this.bloomPass );

		const outputPass = new OutputPass();
		outputPass.material.toneMapped = true;
		outputPass.material.transparent = true;
		this.composer.addPass( outputPass );
		this.updateFixedPassResolution();

		this.denoiser = new OIDNDenoiser( this.denoiserCanvas, this.renderer, this.scene, this.camera, {
			...DEFAULT_STATE,
			getMRTTexture: () => {

				// Get normalDepth and albedo textures from path tracer's MRT output
				if ( this.pipeline?.context ) {

					const renderTarget = this.pipeline.context.getRenderTarget( 'pathtracer:current' );
					const normalDepthTexture = this.pipeline.context.getTexture( 'pathtracer:normalDepth' );
					const albedoTexture = this.pipeline.context.getTexture( 'pathtracer:albedo' );
					return {
						renderTarget,
						texture: normalDepthTexture,
						albedoTexture
					};

				}

				return null;

			}
		} );
		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Set up denoiser event listeners to update store
		this.denoiser.addEventListener( 'start', () => useStore.getState().setIsDenoising( true ) );
		this.denoiser.addEventListener( 'end', () => useStore.getState().setIsDenoising( false ) );

	}

	/**
	 * Creates the PathTracerStage independently of the full pipeline.
	 * Needed for asset data storage (sdfs) used by AssetLoader and DataTransfer.
	 */
	setupPathTracerStage() {

		this.pathTracingPass = new PathTracerStage( this.renderer, this.scene, this.camera, {
			width: this.width,
			height: this.height,
			enabled: true,
			assetOnly: this._assetOnly
		} );

	}

	setupPipeline() {

		// Create the new pipeline
		this.pipeline = new PassPipeline( this.renderer );

		// Reuse the PathTracerStage already created by setupPathTracerStage()
		const pathTracerStage = this.pathTracingPass;

		// Motion vector stage - runs after PathTracer, before ASVGF
		const motionVectorStage = new MotionVectorStage( {
			renderer: this.renderer,
			camera: this.camera,
			width: this.width,
			height: this.height,
			enabled: true
		} );

		const asvgfStage = new ASVGFStage( {
			renderer: this.renderer,
			camera: this.camera,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.enableASVGF || false,
			temporalAlpha: DEFAULT_STATE.asvgfTemporalAlpha || 0.1,
			enableDebug: true
		} );

		// Variance estimation stage - computes variance for adaptive sampling and denoising guidance
		// Must run PER_CYCLE to match ASVGFStage execution timing
		const varianceEstimationStage = new VarianceEstimationStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.enableASVGF || false,
			executionMode: 'per_cycle',
			varianceBoost: DEFAULT_STATE.asvgfVarianceBoost || 1.0,
			inputTextureName: 'asvgf:temporalColor',
			outputTextureName: 'variance:output'
		} );

		// Bilateral filtering stage - spatial denoising with edge preservation
		// Must run PER_CYCLE to match ASVGFStage execution timing
		const bilateralFilteringStage = new BilateralFilteringStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.enableASVGF || false,
			executionMode: 'per_cycle',
			iterations: 4, // Standard A-trous iterations with step sizes 1, 2, 4, 8
			phiColor: DEFAULT_STATE.asvgfPhiColor || 10.0,
			phiNormal: DEFAULT_STATE.asvgfPhiNormal || 128.0,
			phiDepth: DEFAULT_STATE.asvgfPhiDepth || 1.0,
			phiLuminance: DEFAULT_STATE.asvgfPhiLuminance || 4.0,
			useVarianceGuide: true,
			useHistoryAdaptive: true,
			inputTextureName: 'asvgf:temporalColor',
			normalDepthTextureName: 'pathtracer:normalDepth',
			varianceTextureName: 'variance:output',
			historyLengthTextureName: 'asvgf:temporalColor',
			outputTextureName: 'asvgf:output' // Final denoised output
		} );

		const adaptiveSamplingStage = new AdaptiveSamplingStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.adaptiveSampling
		} );

		const edgeFilteringStage = new EdgeAwareFilteringStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: ! ( DEFAULT_STATE.enableASVGF || false ),
			filteringEnabled: ! ( DEFAULT_STATE.enableASVGF || false ),
			pixelEdgeSharpness: DEFAULT_STATE.pixelEdgeSharpness || 0.75
		} );

		const tileHighlightStage = new TileHighlightStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.tilesHelper
		} );

		const autoExposureStage = new AutoExposureStage( {
			renderer: this.renderer,
			width: this.width,
			height: this.height,
			enabled: DEFAULT_STATE.autoExposure,
			keyValue: DEFAULT_STATE.autoExposureKeyValue,
			minExposure: DEFAULT_STATE.autoExposureMinExposure,
			maxExposure: DEFAULT_STATE.autoExposureMaxExposure,
			adaptSpeedBright: DEFAULT_STATE.autoExposureAdaptSpeedBright,
			adaptSpeedDark: DEFAULT_STATE.autoExposureAdaptSpeedDark
		} );

		// Add stages to pipeline in execution order
		this.pipeline.addStage( pathTracerStage );
		this.pipeline.addStage( motionVectorStage );
		this.pipeline.addStage( asvgfStage );
		this.pipeline.addStage( varianceEstimationStage );
		this.pipeline.addStage( bilateralFilteringStage );
		this.pipeline.addStage( adaptiveSamplingStage );
		this.pipeline.addStage( edgeFilteringStage );
		this.pipeline.addStage( autoExposureStage );
		this.pipeline.addStage( tileHighlightStage );

		// Wrap pipeline in a Pass for EffectComposer compatibility
		this.pipelineWrapperPass = new PipelineWrapperPass( this.pipeline );
		this.composer.addPass( this.pipelineWrapperPass );

		// Create proxy references for backward compatibility
		// (pathTracingPass already set by setupPathTracerStage)
		this.motionVectorPass = motionVectorStage;
		this.asvgfPass = asvgfStage;
		this.varianceEstimationPass = varianceEstimationStage;
		this.bilateralFilteringPass = bilateralFilteringStage;
		this.adaptiveSamplingPass = adaptiveSamplingStage;
		this.edgeAwareFilterPass = edgeFilteringStage;
		this.autoExposurePass = autoExposureStage;
		this.tileHighlightPass = tileHighlightStage;

		// Set up auto-exposure event listener to update store in real-time
		this.setupAutoExposureListener();

	}

	/**
	 * Set up event listener for auto-exposure updates
	 * Updates the store when exposure values change for UI display
	 */
	setupAutoExposureListener() {

		if ( ! this.autoExposurePass ) return;

		// Import store dynamically to avoid circular dependency issues
		import( '@/store' ).then( ( { usePathTracerStore } ) => {

			// Listen for auto-exposure updates from the stage
			this.autoExposurePass.on( 'autoexposure:updated', ( data ) => {

				const { exposure, luminance } = data;

				// Update store state for UI consumption
				// These setters are direct and won't trigger reset()
				usePathTracerStore.getState().setCurrentAutoExposure( exposure );
				usePathTracerStore.getState().setCurrentAvgLuminance( luminance );

			} );

		} );

	}

	/**
	 * Set up event listeners for interaction manager events
	 */
	setupInteractionListeners() {

		// Focus mode events
		this.interactionManager.addEventListener( 'focusChanged', ( event ) => {

			this.setFocusDistance( event.worldDistance );

			// Dispatch to external listeners (UI)
			this.dispatchEvent( {
				type: 'focusChanged',
				distance: event.distance
			} );

		} );

		// Object selection events
		this.interactionManager.addEventListener( 'objectSelected', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();
			useStore.getState().setSelectedObject( event.object );

			// Forward event to external listeners
			this.dispatchEvent( {
				type: 'objectSelected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		this.interactionManager.addEventListener( 'objectDeselected', ( event ) => {

			this.selectObject( null );
			this.refreshFrame();
			useStore.getState().setSelectedObject( null );

			// Forward event to external listeners
			this.dispatchEvent( {
				type: 'objectDeselected',
				object: event.object,
				uuid: event.uuid
			} );

		} );

		// Double-click to open material editor
		this.interactionManager.addEventListener( 'objectDoubleClicked', ( event ) => {

			this.selectObject( event.object );
			this.refreshFrame();
			useStore.getState().setSelectedObject( event.object );

			// Switch to material tab
			useStore.getState().setActiveTab( 'material' );

			// Forward event to external listeners
			this.dispatchEvent( {
				type: 'objectDoubleClicked',
				object: event.object,
				uuid: event.uuid
			} );

		} );

	}

	async setupFloorPlane() {

		// const texture = await new TextureLoader().loadAsync( radialTexture );
		this.floorPlane = new Mesh(
			new CircleGeometry(),
			new MeshPhysicalMaterial( {
				transparent: false,
				color: 0x303030,
				roughness: 1,
				metalness: 0,
				opacity: 0,
				transmission: 0,
				// map: texture,
			} )
		);
		this.floorPlane.name = "Ground";
		this.floorPlane.visible = false; // Set mesh visibility, not material visibility
		this.scene.add( this.floorPlane );

	}

	refreshFrame = () => {

		if ( this.edgeAwareFilterPass ) this.edgeAwareFilterPass.iteration -= 1;
		if ( this.pathTracingPass ) this.pathTracingPass.isComplete = false;

	};

	animate = () => {

		this.animationFrameId = requestAnimationFrame( this.animate );

		if ( this.pauseRendering ) return;

		const pathtracingUniforms = this.pathTracingPass.material.uniforms;

		if ( this.pathTracingPass.isComplete && pathtracingUniforms.frame.value >= pathtracingUniforms.maxFrames.value ) return;

		if ( ! this.pathTracingPass.isComplete ) {

			this.controls.update();

			// Pipeline architecture - stages handle their own updates via events
			// Edge filtering stage listens to context state updates
			if ( this.pipeline && this.pipeline.context ) {

				this.pipeline.context.setState( 'cameraIsMoving', this.pathTracingPass.interactionMode || false );
				this.pipeline.context.setState( 'sceneIsDynamic', false );
				this.pipeline.context.setState( 'time', this.timeElapsed );

			}

			// Adaptive sampling stage automatically reads textures from context

			// Render the frame
			this.composer.render();

			const currentTime = performance.now();
			this.timeElapsed = ( currentTime - this.lastResetTime ) / 1000;

			this.stats.update();

			updateStats( {
				timeElapsed: this.timeElapsed,
				samples: pathtracingUniforms.renderMode.value == 1 ?
					Math.floor( pathtracingUniforms.frame.value / Math.pow( this.pathTracingPass.tileManager.tiles, 2 ) ) :
					pathtracingUniforms.frame.value
			} );

			// Check if time limit reached and force completion logic
			if ( this.renderLimitMode === 'time' && this.renderTimeLimit > 0 && this.timeElapsed >= this.renderTimeLimit ) {

				this.pathTracingPass.isComplete = true;

			}

		}

		// Early exit: Return immediately if path tracing is not complete
		if ( ! this.pathTracingPass.isComplete ) return;

		// Check completion conditions
		const uniforms = pathtracingUniforms;
		const isFrameLimitReached =
			( uniforms.renderMode.value === 0 && uniforms.frame.value >= uniforms.maxFrames.value ) ||
			( uniforms.renderMode.value === 1 && uniforms.frame.value >= uniforms.maxFrames.value * Math.pow( this.pathTracingPass.tileManager.tiles, 2 ) );


		const isTimeLimitReached = this.renderLimitMode === 'time' && this.renderTimeLimit > 0 && this.timeElapsed >= this.renderTimeLimit;

		// Early exit: Check completion conditions before expensive operations
		if ( ( this.renderLimitMode !== 'time' && isFrameLimitReached ) || ( this.renderLimitMode === 'time' && isTimeLimitReached ) ) {

			this.denoiser.start();
			this.dispatchEvent( { type: 'RenderComplete' } );
			useStore.getState().setIsRenderComplete( true );

		}


	};

	// Updated method to reset cameras and add only from current model
	resetCamerasAndAddFromModel( modelCameras ) {

		// Always start fresh with only the default camera
		const defaultCamera = this.defaultCamera; // Store reference to original default camera
		this.cameras = [ defaultCamera ];

		// Add cameras from the current model only
		if ( modelCameras && modelCameras.length > 0 ) {

			modelCameras.forEach( camera => {

				this.cameras.push( camera );

			} );

		}

		// Always reset to default camera (index 0) when new model is loaded
		this.currentCameraIndex = 0;
		this.camera = this.cameras[ 0 ];

		// Update camera-dependent passes
		if ( this.pathTracingPass ) this.pathTracingPass.camera = this.camera;
		if ( this.outlinePass ) this.outlinePass.camera = this.camera;

		console.log( `Reset cameras. Total cameras: ${this.cameras.length} (1 default + ${modelCameras?.length || 0} from model). Using default camera.` );

	}

	getCameraNames() {

		return this.cameras.map( ( camera, index ) => {

			if ( index === 0 ) {

				return 'Default Camera';

			} else {

				return camera.name || `Camera ${index}`;

			}

		} );

	}

	switchCamera( index ) {

		// Ensure index is within bounds
		if ( index < 0 || index >= this.cameras.length ) {

			console.warn( `Invalid camera index ${index}. Using default camera.` );
			index = 0;

		}

		this.currentCameraIndex = index;
		this.camera = this.cameras[ index ];

		// Update camera-dependent passes
		if ( this.pathTracingPass ) this.pathTracingPass.camera = this.camera;
		if ( this.outlinePass ) this.outlinePass.camera = this.camera;

		this.onResize();
		this.dispatchEvent( { type: 'CameraSwitched', cameraIndex: index } );

	}

	async loadEnvironment( envUrl ) {

		return await this.assetLoader.loadEnvironment( envUrl ).then( () => this.pauseRendering = false );

	}

	async loadExampleModels( index ) {

		return await this.assetLoader.loadExampleModels( index ).then( () => this.pauseRendering = false );

	}

	async loadModel( modelUrl ) {

		return await this.assetLoader.loadModel( modelUrl ).then( () => this.pauseRendering = false );

	}

	async loadGLBFromArrayBuffer( arrayBuffer ) {

		return await this.assetLoader.loadGLBFromArrayBuffer( arrayBuffer ).then( () => this.pauseRendering = false );

	}

	/**
	 * Update resolution using a calculated pixel ratio value
	 * @param {number} value - The pixel ratio to set
	 * @param {number} [targetResolutionIndex] - Optional resolution index (0-4) to store for resize recalculation
	 */
	updateResolution( value, targetResolutionIndex ) {

		// Store target resolution index if provided (for maintaining resolution on window resize)
		if ( targetResolutionIndex !== undefined ) {

			this.targetResolution = targetResolutionIndex;

		}

		this.renderer.setPixelRatio( value );
		this.composer?.setPixelRatio( value );
		this.onResize();

	}

	/**
	 * Recalculate and apply pixel ratio based on stored target resolution
	 * Call this when canvas container dimensions change to maintain consistent resolution
	 */
	recalculateResolution() {

		const targetResolutions = { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 };
		const targetRes = targetResolutions[ this.targetResolution ] || 512;
		const shortestDim = Math.min( this.canvas.clientWidth, this.canvas.clientHeight ) || 512;
		const pixelRatio = targetRes / shortestDim;

		this.renderer.setPixelRatio( pixelRatio );
		this.composer?.setPixelRatio( pixelRatio );
		this.onResize();

	}

	/**
	 * Update certain passes resolution to render at actual devicePixelRatio
	 */
	updateFixedPassResolution() {

		if ( this.outlinePass ) {

			const dpr = window.devicePixelRatio;
			const width = this.width * dpr;
			const height = this.height * dpr;
			this.outlinePass.setSize( width, height );
			this.bloomPass.setSize( width, height );


		}

	}

	selectObject( object ) {

		if ( this.outlinePass ) this.outlinePass.selectedObjects = object ? [ object ] : [];

	}

	takeScreenshot() {

		let screenshot;
		// Check if denoising is active and completed
		if ( this.denoiser.enabled && this.denoiser.output && this.pathTracingPass.isComplete ) {

			screenshot = this.denoiser.output.toDataURL( 'image/png' );

		} else {

			screenshot = this.renderer.domElement.toDataURL( 'image/png' );

		}

		const link = document.createElement( 'a' );
		link.href = screenshot;
		link.download = 'screenshot.png';
		link.click();

	}

	onResize() {

		this.width = this.canvas.width;
		this.height = this.canvas.height;

		this.camera.aspect = this.width / this.height;
		this.camera.updateProjectionMatrix();

		// Pipeline architecture - resize all stages
		this.pipeline?.setSize( this.width, this.height );

		this.denoiser?.setSize( this.width, this.height );

		// Update OutlinePass to render at actual devicePixelRatio
		this.updateFixedPassResolution();

		this.reset();

		window.dispatchEvent( new CustomEvent( 'resolution_changed', { detail: { width: this.width, height: this.height } } ) );

	}

	toggleFocusMode() {

		const enabled = this.interactionManager.toggleFocusMode();

		// Disable orbit controls when in focus mode
		if ( this.controls ) {

			this.controls.enabled = ! enabled;

		}

		return enabled;

	}

	toggleSelectMode() {

		return this.interactionManager.toggleSelectMode();

	}

	disableSelectMode() {

		this.interactionManager.disableSelectMode();

	}

	setFocusDistance( distance ) {

		// Distance from raycaster is already in world units, so use directly
		// (Slider values are in scene units and get scaled separately in the store handler)
		this.pathTracingPass.material.uniforms.focusDistance.value = distance;

		// Reset rendering to apply changes
		this.reset();

	}

	/**
	 * Create Level of Detail (LOD) versions of the current model
	 * @param {Array<number>} lodLevels - Array of percentage values (0-100) for each LOD level
	 * @returns {Promise<Object3D>} - The LOD-optimized model
	 */
	async createModelLODs( lodLevels = [ 100, 50, 25, 10 ] ) {

		return await this.assetLoader.createModelLODs( lodLevels );

	}

	/**
	 * Get current mesh optimization status
	 * @returns {Object} - Status object with optimization flags
	 */
	getOptimizationStatus() {

		return this.assetLoader.getOptimizationStatus();

	}

	/**
	 * Set whether to optimize meshes during loading
	 * @param {boolean} enabled - Whether to optimize meshes
	 */
	setOptimizeMeshes( enabled ) {

		this.assetLoader.setOptimizeMeshes( enabled );

	}

	getTargetModel() {

		return this.assetLoader.getTargetModel();

	}

	// Light management methods
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
		this.pathTracingPass.updateLights();
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

	removeLight( uuid ) {

		const light = this.scene.getObjectByProperty( 'uuid', uuid );
		if ( ! light || ! light.isLight ) return false;

		if ( light.target ) light.target.removeFromParent();
		light.removeFromParent();
		this.pathTracingPass.updateLights();
		this.reset();
		return true;

	}

	clearLights() {

		this.scene.getObjectsByProperty( 'isLight', true ).forEach( light => {

			if ( light.target ) this.scene.remove( light.target );
			this.scene.remove( light );

		} );
		this.pathTracingPass.updateLights();
		this.reset();

	}

	getLights() {

		return this.scene.getObjectsByProperty( 'isLight', true ).map( light => {

			let angle = 0;
			if ( light.type === 'DirectionalLight' && light.angle !== undefined ) {

				angle = MathUtils.radToDeg( light.angle );

			} else if ( light.type === 'SpotLight' ) {

				// For SpotLights, check for valid angle values
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

	// ─── IPathTracerApp Interface — Setter Methods ────────────────────────
	// These wrap internal uniform/pass access to provide a backend-agnostic API
	// that the store and UI can call without knowing the backend implementation.

	/**
	 * Checks if this backend supports a given feature.
	 * @param {string} featureName - Feature key from WebGPUFeatures
	 * @returns {boolean}
	 */
	supportsFeature( featureName ) {

		return this._supportedFeatures[ featureName ] ?? false;

	}

	setMaxBounces( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.maxBounceCount ) {

			this.pathTracingPass.material.uniforms.maxBounceCount.value = val;

		}

	}

	setSamplesPerPixel( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.numRaysPerPixel ) {

			this.pathTracingPass.material.uniforms.numRaysPerPixel.value = val;

		}

	}

	setMaxSamples( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.maxFrames ) {

			this.pathTracingPass.material.uniforms.maxFrames.value = val;

		}

	}

	setTransmissiveBounces( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.transmissiveBounces ) {

			this.pathTracingPass.material.uniforms.transmissiveBounces.value = val;

		}

	}

	setSamplingTechnique( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.samplingTechnique ) {

			this.pathTracingPass.material.uniforms.samplingTechnique.value = val;

		}

	}

	setEnableEmissiveTriangleSampling( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.enableEmissiveTriangleSampling ) {

			this.pathTracingPass.material.uniforms.enableEmissiveTriangleSampling.value = val;

		}

	}

	setEmissiveBoost( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.emissiveBoost ) {

			this.pathTracingPass.material.uniforms.emissiveBoost.value = val;

		}

	}

	setFireflyThreshold( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.fireflyThreshold ) {

			this.pathTracingPass.material.uniforms.fireflyThreshold.value = val;

		}

	}

	setVisMode( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.visMode ) {

			this.pathTracingPass.material.uniforms.visMode.value = val;

		}

	}

	setDebugVisScale( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.debugVisScale ) {

			this.pathTracingPass.material.uniforms.debugVisScale.value = val;

		}

	}

	setEnvironmentIntensity( val ) {

		if ( this.scene ) this.scene.environmentIntensity = val;
		if ( this.pathTracingPass?.material?.uniforms?.environmentIntensity ) {

			this.pathTracingPass.material.uniforms.environmentIntensity.value = val;

		}

	}

	setBackgroundIntensity( val ) {

		if ( this.scene ) this.scene.backgroundIntensity = val;
		if ( this.pathTracingPass?.material?.uniforms?.backgroundIntensity ) {

			this.pathTracingPass.material.uniforms.backgroundIntensity.value = val;

		}

	}

	setShowBackground( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.showBackground ) {

			this.pathTracingPass.material.uniforms.showBackground.value = val;

		}

	}

	setEnableEnvironment( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.enableEnvironmentLight ) {

			this.pathTracingPass.material.uniforms.enableEnvironmentLight.value = val;

		}

	}

	setGlobalIlluminationIntensity( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.globalIlluminationIntensity ) {

			this.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = val;

		}

	}

	setExposure( val ) {

		if ( this.renderer ) this.renderer.toneMappingExposure = Math.pow( val, 4.0 );
		if ( this.pathTracingPass?.material?.uniforms?.exposure ) {

			this.pathTracingPass.material.uniforms.exposure.value = val;

		}

	}

	setEnableDOF( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.enableDOF ) {

			this.pathTracingPass.material.uniforms.enableDOF.value = val;

		}

	}

	setFocusDistance( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.focusDistance ) {

			this.pathTracingPass.material.uniforms.focusDistance.value = val;

		}

	}

	setFocalLength( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.focalLength ) {

			this.pathTracingPass.material.uniforms.focalLength.value = val;

		}

	}

	setAperture( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.aperture ) {

			this.pathTracingPass.material.uniforms.aperture.value = val;

		}

	}

	setApertureScale( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.apertureScale ) {

			this.pathTracingPass.material.uniforms.apertureScale.value = val;

		}

	}

	setUseAdaptiveSampling( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.useAdaptiveSampling ) {

			this.pathTracingPass.material.uniforms.useAdaptiveSampling.value = val;

		}

	}

	setAdaptiveSamplingMax( val ) {

		if ( this.pathTracingPass?.setAdaptiveSamplingParameters ) {

			this.pathTracingPass.setAdaptiveSamplingParameters( { max: val } );

		}

	}

	setRenderMode( val ) {

		if ( this.pathTracingPass?.material?.uniforms?.renderMode ) {

			this.pathTracingPass.material.uniforms.renderMode.value = val;

		}

	}

	/**
	 * Enables/disables the path tracer (toggles between path tracing and raster preview).
	 * @param {boolean} val
	 */
	setPathTracerEnabled( val ) {

		if ( this.pathTracingPass ) {

			this.pathTracingPass.setAccumulationEnabled( val );
			this.pathTracingPass.enabled = val;

		}

		if ( this.renderPass ) {

			this.renderPass.enabled = ! val;

		}

	}

	setAccumulationEnabled( val ) {

		if ( this.pathTracingPass?.setAccumulationEnabled ) {

			this.pathTracingPass.setAccumulationEnabled( val );

		}

	}

	setTileCount( val ) {

		if ( this.pathTracingPass?.setTileCount ) {

			this.pathTracingPass.setTileCount( val );

		}

	}

	setRenderLimitMode( val ) {

		this.renderLimitMode = val;
		if ( this.pathTracingPass?.setRenderLimitMode ) {

			this.pathTracingPass.setRenderLimitMode( val );

		}

	}

	setEnvironmentRotation( val ) {

		if ( this.pathTracingPass?.setEnvironmentRotation ) {

			this.pathTracingPass.setEnvironmentRotation( val );

		}

	}

	setInteractionModeEnabled( val ) {

		if ( this.pathTracingPass?.setInteractionModeEnabled ) {

			this.pathTracingPass.setInteractionModeEnabled( val );

		}

	}

	/**
	 * Updates a material property in the path tracer's material data texture.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	updateMaterialProperty( materialIndex, property, value ) {

		const pt = this.pathTracingPass;
		if ( typeof pt?.updateMaterialProperty === 'function' ) {

			pt.updateMaterialProperty( materialIndex, property, value );

		} else if ( typeof pt?.updateMaterialDataTexture === 'function' ) {

			pt.updateMaterialDataTexture( materialIndex, property, value );

		}

	}

	/**
	 * Updates texture transform data in the path tracer.
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Float32Array} transform
	 */
	updateTextureTransform( materialIndex, textureName, transform ) {

		if ( typeof this.pathTracingPass?.updateTextureTransform === 'function' ) {

			this.pathTracingPass.updateTextureTransform( materialIndex, textureName, transform );

		}

	}

	/**
	 * Marks the path tracer material as needing recompilation.
	 */
	refreshMaterial() {

		if ( this.pathTracingPass?.material ) {

			this.pathTracingPass.material.needsUpdate = true;

		}

	}

	/**
	 * Updates a complete material on the path tracer.
	 * @param {number} materialIndex
	 * @param {Object} material - Three.js material
	 */
	updateMaterial( materialIndex, material ) {

		const pt = this.pathTracingPass;
		if ( typeof pt?.updateMaterial === 'function' ) {

			pt.updateMaterial( materialIndex, material );

		} else if ( typeof pt?.rebuildMaterialDataTexture === 'function' ) {

			pt.rebuildMaterialDataTexture( materialIndex, material );

		}

	}

	/**
	 * Rebuilds all materials from the scene.
	 * @param {Object} scene - Three.js scene
	 */
	async rebuildMaterials( scene ) {

		if ( typeof this.pathTracingPass?.rebuildMaterials === 'function' ) {

			await this.pathTracingPass.rebuildMaterials( scene );

		}

	}

	/**
	 * Returns whether the render is complete.
	 * @returns {boolean}
	 */
	isComplete() {

		return this.pathTracingPass?.isComplete ?? false;

	}

	/**
	 * Gets the current frame count from the path tracer stage.
	 * @returns {number}
	 */
	getFrameCount() {

		return this.pathTracingPass?.material?.uniforms?.frame?.value || 0;

	}

	/**
	 * Pauses the animation loop.
	 */
	pause() {

		if ( this.animationFrameId ) {

			cancelAnimationFrame( this.animationFrameId );
			this.animationFrameId = null;
			console.log( 'PathTracerApp (WebGL): Paused' );

		}

		if ( this.stats ) this.stats.dom.style.display = 'none';

	}

	/**
	 * Resumes the animation loop.
	 * If in asset-only mode (WebGPU was the initial target), completes
	 * the full rendering setup first before starting the animation loop.
	 */
	async resume() {

		// Complete rendering setup if still in asset-only mode
		if ( this._assetOnly ) {

			await this.initRendering();

		}

		if ( ! this.animationFrameId ) {

			this.animate();
			console.log( 'PathTracerApp (WebGL): Resumed' );

		}

		if ( this.stats ) this.stats.dom.style.display = '';

	}

	dispose() {

		cancelAnimationFrame( this.animationFrameId );

		// Dispose interaction manager
		this.interactionManager?.dispose();

		// Pipeline architecture cleanup
		if ( this.pipeline ) this.pipeline.dispose();

	}

	// ── Environment mode helpers (app-level wrappers for pathTracingPass) ──

	/** Returns the envParams object from the path tracing pass. */
	getEnvParams() {

		return this.pathTracingPass?.envParams ?? null;

	}

	/** Returns the current environment texture. */
	getEnvironmentTexture() {

		return this.pathTracingPass?.material?.uniforms?.environment?.value ?? null;

	}

	/** Returns the current environment CDF texture. */
	getEnvironmentCDF() {

		return this.pathTracingPass?.material?.uniforms?.envCDF?.value ?? null;

	}

	/** Generates a procedural sky texture. */
	async generateProceduralSkyTexture() {

		return this.pathTracingPass?.generateProceduralSkyTexture?.();

	}

	/** Generates a gradient sky texture. */
	async generateGradientTexture() {

		return this.pathTracingPass?.generateGradientTexture?.();

	}

	/** Generates a solid-colour sky texture. */
	async generateSolidColorTexture() {

		return this.pathTracingPass?.generateSolidColorTexture?.();

	}

	/** Sets the environment map texture. */
	async setEnvironmentMap( texture ) {

		return this.pathTracingPass?.setEnvironmentMap?.( texture );

	}

	/** Marks the current environment texture as needing a GPU update. */
	markEnvironmentNeedsUpdate() {

		const tex = this.pathTracingPass?.material?.uniforms?.environment?.value;
		if ( tex ) tex.needsUpdate = true;

	}

	/**
	 * Returns scene statistics from the TriangleSDF, or null.
	 * @returns {object|null}
	 */
	getSceneStatistics() {

		try {

			return this.pathTracingPass?.sdfs?.getStatistics?.() ?? null;

		} catch {

			return null;

		}

	}

}

export default PathTracerApp;
