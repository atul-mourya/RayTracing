import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	SRGBColorSpace,
	DirectionalLight,
	WebGLRenderTarget,
	FloatType,
	Vector2,
	Mesh,
	CircleGeometry,
	MeshPhysicalMaterial,
	EventDispatcher,
	SphereGeometry,
	MeshBasicMaterial,
	Raycaster,
	TextureLoader,
	RGBAFormat
} from 'three';

import {
	OrbitControls,
	EffectComposer,
	RenderPass,
	OutlinePass,
	UnrealBloomPass,
	OutputPass
} from 'three/examples/jsm/Addons';
import Stats from 'stats-gl';

// Import custom passes and constants
import { PathTracerPass } from './PathTracerPass';
import { EdgeAwareFilteringPass } from './Passes/EdgeAwareFilteringPass';
import { ASVGFPass } from './Passes/ASVGFPass';
import { AdaptiveSamplingPass } from './Passes/AdaptiveSamplingPass';
import { TileHighlightPass } from './Passes/TileHighlightPass';
import { OIDNDenoiser } from './Passes/OIDNDenoiser';
import { updateStats } from './Processor/utils';
import { HDR_FILES, DEFAULT_STATE } from '../Constants';
import radialTexture from '../../public/radial-gradient.png';
import { useStore } from '@/store';
import AssetLoader from './Processor/AssetLoader';

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


		this.cameras = [];
		this.currentCameraIndex = 0;
		this.defaultCamera = this.camera;

	}

	getQueryParameter( name ) {

		const urlParams = new URLSearchParams( window.location.search );
		return urlParams.get( name );

	}

	async init() {

		// Setup renderer
		this.renderer.setClearColor( 0x000000, 0 ); // Set clear alpha to 0 for transparency
		this.renderer.toneMapping = DEFAULT_STATE.toneMapping;
		this.renderer.toneMappingExposure = Math.pow( DEFAULT_STATE.exposure, 4.0 );
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.setPixelRatio( DEFAULT_STATE.originalPixelRatio );
		this.renderer.setSize( this.width, this.height );
		this.container.appendChild( this.canvas );

		// Setup stats
		this.initStats();

		// Setup canvas
		this.canvas.style.position = 'absolute';
		this.canvas.style.top = '0';
		this.canvas.style.left = '0';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.background = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px;";

		// Setup camera
		this.camera.position.set( 0, 0, 5 );

		// Setup controls with interaction optimization
		this.controls = new OrbitControls( this.camera, this.canvas );
		// this.controls.zoomToCursor = true;
		this.controls.addEventListener( 'change', () => {

			this.pathTracingPass && this.pathTracingPass.enterInteractionMode();
			this.reset();

		} );
		this.controls.update();

		this.cameras = [ this.defaultCamera ];

		// Setup lighting
		this.directionalLight = new DirectionalLight( DEFAULT_STATE.directionalLightColor, DEFAULT_STATE.directionalLightIntensity );
		this.directionalLight.position.fromArray( DEFAULT_STATE.directionalLightPosition );
		this.directionalLight.name = "Sun Light";
		this.scene.add( this.directionalLight );

		// Setup composer and passes
		this.setupComposer();
		await this.setupFloorPlane();

		// Initialize asset loader
		this.assetLoader = new AssetLoader(
			this.scene,
			this.camera,
			this.controls,
			this.pathTracingPass
		);
		this.assetLoader.setFloorPlane( this.floorPlane );

		// Set initial optimization settings
		if ( useStore.getState().optimizeMeshes !== undefined ) {

			this.assetLoader.setOptimizeMeshes( useStore.getState().optimizeMeshes );

		}

		// Check for model URL in query parameters
		const modelUrl = this.getQueryParameter( 'model' );
		const envUrl = `${HDR_FILES[ DEFAULT_STATE.environment ].url}`;
		await this.assetLoader.loadEnvironment( envUrl );

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

		// Start animation loop
		this.animate();

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
		this.pathTracingPass.reset();
		// Always reset ASVGF pass if it exists, regardless of enabled state
		this.asvgfPass?.reset();
		this.edgeAwareFilterPass?.enabled && this.edgeAwareFilterPass.reset( this.renderer );
		this.adaptiveSamplingPass?.enabled && this.adaptiveSamplingPass.reset();
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

		this.adaptiveSamplingPass = new AdaptiveSamplingPass( this.renderer, this.width, this.height );
		this.adaptiveSamplingPass.enabled = DEFAULT_STATE.adaptiveSampling;
		this.composer.addPass( this.adaptiveSamplingPass );

		this.pathTracingPass = new PathTracerPass( this.renderer, this.scene, this.camera, this.width, this.height );
		this.pathTracingPass.interactionModeEnabled = DEFAULT_STATE.interactionModeEnabled;
		this.composer.addPass( this.pathTracingPass );

		this.asvgfPass = new ASVGFPass( this.renderer, this.camera, this.width, this.height, {
			temporalAlpha: DEFAULT_STATE.asvgfTemporalAlpha || 0.1,
			atrousIterations: DEFAULT_STATE.asvgfAtrousIterations || 4,
			phiColor: DEFAULT_STATE.asvgfPhiColor || 10.0,
			phiNormal: DEFAULT_STATE.asvgfPhiNormal || 128.0,
			phiDepth: DEFAULT_STATE.asvgfPhiDepth || 1.0,
			enableDebug: true
		} );
		this.asvgfPass.enabled = DEFAULT_STATE.enableASVGF || false;
		this.composer.addPass( this.asvgfPass );

		// Connect PathTracer to ASVGF
		this.pathTracingPass.setASVGFPass( this.asvgfPass );

		this.edgeAwareFilterPass = new EdgeAwareFilteringPass( this.width, this.height, {
			// Reduce edge filtering when ASVGF is active
			filteringEnabled: ! this.asvgfPass.enabled,
			pixelEdgeSharpness: DEFAULT_STATE.pixelEdgeSharpness || 0.75,
		} );
		this.composer.addPass( this.edgeAwareFilterPass );

		// Connect the new pipeline: PathTracer → ASVGF → AdaptiveSampling
		this.pathTracingPass.setAdaptiveSamplingPass( this.adaptiveSamplingPass );

		this.outlinePass = new OutlinePass( new Vector2( this.width, this.height ), this.scene, this.camera );
		this.composer.addPass( this.outlinePass );

		this.tileHighlightPass = new TileHighlightPass( new Vector2( this.width, this.height ) );
		this.tileHighlightPass.enabled = DEFAULT_STATE.tilesHelper;
		this.composer.addPass( this.tileHighlightPass );
		this.pathTracingPass.setTileHighlightPass( this.tileHighlightPass );

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

		this.denoiser = new OIDNDenoiser( this.denoiserCanvas, this.renderer, this.scene, this.camera, DEFAULT_STATE );
		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Set up denoiser event listeners to update store
		this.denoiser.addEventListener( 'start', () => useStore.getState().setIsDenoising( true ) );
		this.denoiser.addEventListener( 'end', () => useStore.getState().setIsDenoising( false ) );

	}

	async setupFloorPlane() {

		const texture = await new TextureLoader().loadAsync( radialTexture );
		this.floorPlane = new Mesh(
			new CircleGeometry(),
			new MeshPhysicalMaterial( {
				transparent: true,
				color: 0xFFFFFF,
				roughness: 0.35,
				metalness: 1,
				opacity: 1,
				transmission: 0,
				// map: texture,
				visible: false
			} )
		);
		this.floorPlane.name = "Ground";
		this.scene.add( this.floorPlane );

	}

	refreshFrame = () => {

		this.edgeAwareFilterPass.iteration -= 1;
		this.pathTracingPass.isComplete = false;

	};

	animate = () => {

		this.animationFrameId = requestAnimationFrame( this.animate );

		if ( this.pauseRendering ) return;

		const pathtracingUniforms = this.pathTracingPass.material.uniforms;

		if ( this.pathTracingPass.isComplete && pathtracingUniforms.frame.value >= pathtracingUniforms.maxFrames.value ) return;

		if ( ! this.pathTracingPass.isComplete ) {

			this.controls.update();

			this.edgeAwareFilterPass.updateUniforms( {
				cameraIsMoving: this.pathTracingPass.interactionMode || false,
				sceneIsDynamic: false,
				time: this.timeElapsed
			} );

			// Update adaptive sampling with MRT textures
			if ( this.adaptiveSamplingPass.enabled && pathtracingUniforms.frame.value > 0 ) {

				// Get textures from PathTracerPass (now includes accumulated results)
				const currentAccumulation = this.pathTracingPass.getCurrentAccumulation();
				const mrtTextures = this.pathTracingPass.getMRTTextures();

				this.adaptiveSamplingPass.setTextures(
					currentAccumulation.texture, // Accumulated color texture
					mrtTextures.normalDepth // G-buffer: normal + depth
				);

			}

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

		}

		// Early exit: Return immediately if path tracing is not complete
		if ( ! this.pathTracingPass.isComplete ) return;

		// Early exit: Check frame count before expensive completion operations
		if (
			( pathtracingUniforms.renderMode.value === 0 && pathtracingUniforms.frame.value >= pathtracingUniforms.maxFrames.value ) ||
			( pathtracingUniforms.renderMode.value === 1 && pathtracingUniforms.frame.value >= pathtracingUniforms.maxFrames.value * Math.pow( this.pathTracingPass.tileManager.tiles, 2 ) )
		) {

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
		if ( this.denoiser ) this.denoiser.mapGenerator.camera = this.camera;

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
		if ( this.denoiser ) this.denoiser.mapGenerator.camera = this.camera;

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

	updateResolution( value ) {

		this.renderer.setPixelRatio( value );
		this.composer.setPixelRatio( value );
		this.onResize();

	}

	selectObject( object ) {

		this.outlinePass.selectedObjects = object ? [ object ] : [];

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

		this.edgeAwareFilterPass.setSize( this.width, this.height );
		this.denoiser.setSize( this.width, this.height );
		this.adaptiveSamplingPass.setSize( this.width, this.height );

		this.reset();

		window.dispatchEvent( new CustomEvent( 'resolution_changed', { detail: { width: this.width, height: this.height } } ) );

	}

	setupClickToFocus() {

		// Ray caster for detecting clicked objects
		this.raycaster = new Raycaster();
		this.focusMode = false;
		this.focusPointIndicator = null;

	}

	// Toggle focus mode
	toggleFocusMode() {

		this.focusMode = ! this.focusMode;

		// Change cursor to indicate focus mode is active
		this.canvas.style.cursor = this.focusMode ? 'crosshair' : 'auto';

		// Disable orbit controls when in focus mode
		if ( this.controls ) {

			this.controls.enabled = ! this.focusMode;

		}

		// Set up click handler if entering focus mode
		if ( this.focusMode ) {

			this.canvas.addEventListener( 'click', this.handleFocusClick );

		} else {

			this.canvas.removeEventListener( 'click', this.handleFocusClick );

		}

		return this.focusMode;

	}

	// Handle click event when in focus mode
	handleFocusClick = ( event ) => {

		// Calculate mouse position in normalized device coordinates
		const rect = this.canvas.getBoundingClientRect();
		const x = ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1;
		const y = - ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1;

		// Update the raycaster
		this.raycaster.setFromCamera( { x, y }, this.camera );

		// Check for intersections with the scene
		const intersects = this.raycaster.intersectObjects( this.scene.children, true );

		if ( intersects.length > 0 ) {

			// Get the first intersection
			const intersection = intersects[ 0 ];

			// Calculate distance from camera to intersection point
			const distance = intersection.distance;

			// Set the focus distance
			this.setFocusDistance( distance );

			// Display focus point indicator
			this.showFocusPoint( intersection.point );

			// Exit focus mode
			this.toggleFocusMode();

			// Dispatch event to notify UI that focus has changed
			this.dispatchEvent( {
				type: 'focusChanged',
				distance: distance / this.assetLoader.getSceneScale()
			} );

		}

	};

	// Set focus distance
	setFocusDistance( distance ) {

		// Update path tracer uniforms
		this.pathTracingPass.material.uniforms.focusDistance.value = distance;

		// Reset rendering to apply changes
		this.reset();

	}

	// Show a visual indicator at the focus point
	showFocusPoint( point ) {

		// Remove existing indicator if present
		if ( this.focusPointIndicator ) {

			this.scene.remove( this.focusPointIndicator );

		}

		// Create a small sphere to mark the focus point
		const sphereSize = this.assetLoader.getSceneScale() * 0.02; // Size proportional to scene
		const geometry = new SphereGeometry( sphereSize, 16, 16 );
		const material = new MeshBasicMaterial( {
			color: 0x00ff00,
			transparent: true,
			opacity: 0.8,
			depthTest: false
		} );

		this.focusPointIndicator = new Mesh( geometry, material );
		this.focusPointIndicator.position.copy( point );
		this.scene.add( this.focusPointIndicator );

		// Fade out and remove the indicator after a delay
		setTimeout( () => {

			if ( this.focusPointIndicator ) {

				this.scene.remove( this.focusPointIndicator );
				this.focusPointIndicator = null;

			}

		}, 2000 ); // Remove after 2 seconds

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

	dispose() {

		cancelAnimationFrame( this.animationFrameId );
		// Dispose of js objects, remove event listeners, etc.
		this.canvas.removeEventListener( 'click', this.handleFocusClick );

		// Dispose of the main passes
		if ( this.pathTracingPass ) this.pathTracingPass.dispose();
		if ( this.edgeAwareFilterPass ) this.edgeAwareFilterPass.dispose();
		if ( this.adaptiveSamplingPass ) this.adaptiveSamplingPass.dispose();

	}

}

export default PathTracerApp;
