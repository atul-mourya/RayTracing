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
	TextureLoader
} from 'three';

import {
	OrbitControls,
	EffectComposer,
	RenderPass,
	OutlinePass,
	OutputPass,
	UnrealBloomPass,
} from 'three/examples/jsm/Addons';
import Stats from 'stats-gl';

// Import custom passes and constants
import { PathTracerPass } from './Shaders/PathTracerPass';
import { AccumulationPass } from './Passes/AccumulationPass';
import { AdaptiveSamplingPass } from './Passes/AdaptiveSamplingPass';
import { TemporalStatisticsPass } from './Passes/TemporalStatisticsPass';
import { LygiaSmartDenoiserPass } from './Passes/LygiaSmartDenoiserPass';
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
			canvas: this.canvas
		} );

		// Initialize other properties
		this.controls = null;
		this.composer = null;
		this.pathTracingPass = null;
		this.accPass = null;
		this.denoiserPass = null;
		this.tileHighlightPass = null;
		this.denoiser = null;
		this.animationFrameId = null;

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
		this.renderer.setClearColor( 0x000000, 1 );
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
		this.controls.addEventListener( 'change', () => {

			this.pathTracingPass && this.pathTracingPass.enterInteractionMode();
			this.reset();

		} );
		this.controls.update();

		this.cameras = [ this.defaultCamera ];

		// Setup lighting
		this.directionalLight = new DirectionalLight( DEFAULT_STATE.directionalLightColor, DEFAULT_STATE.directionalLightIntensity );
		this.directionalLight.position.fromArray( DEFAULT_STATE.directionalLightPosition );
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

		window.addEventListener( 'resize', () => this.onResize() );

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

		this.canvas.style.opacity = 1;
		this.pathTracingPass.reset();
		this.accPass.reset( this.renderer );
		this.temporalStatsPass.reset();
		this.denoiser.abort();
		this.dispatchEvent( { type: 'RenderReset' } );
		useStore.getState().setIsRenderComplete( false );

	}

	setupComposer() {

		const renderTarget = new WebGLRenderTarget( this.width, this.height, {
			type: FloatType,
		} );

		this.composer = new EffectComposer( this.renderer, renderTarget );

		this.renderPass = new RenderPass( this.scene, this.camera );
		this.renderPass.enabled = false;
		this.composer.addPass( this.renderPass );

		this.temporalStatsPass = new TemporalStatisticsPass( this.renderer, this.width, this.height );
		// No need to add this pass to the composer - it's used for tracking statistics only

		this.adaptiveSamplingPass = new AdaptiveSamplingPass( this.renderer, this.width, this.height );
		this.adaptiveSamplingPass.enabled = DEFAULT_STATE.adaptiveSampling;
		this.adaptiveSamplingPass.setTemporalStatisticsPass( this.temporalStatsPass );
		this.composer.addPass( this.adaptiveSamplingPass );

		this.pathTracingPass = new PathTracerPass( this.renderer, this.scene, this.camera, this.width, this.height );
		// Initialize the interaction mode setting
		this.pathTracingPass.interactionModeEnabled = DEFAULT_STATE.interactionModeEnabled;
		this.composer.addPass( this.pathTracingPass );

		this.accPass = new AccumulationPass( this.scene, this.width, this.height );
		this.composer.addPass( this.accPass );

		this.pathTracingPass.setAccumulationPass( this.accPass );

		this.pathTracingPass.setAdaptiveSamplingPass( this.adaptiveSamplingPass );
		this.adaptiveSamplingPass.setTextures( this.pathTracingPass.material.uniforms.previousFrameTexture.value, this.accPass.blendedFrameBuffer.texture );

		this.outlinePass = new OutlinePass( new Vector2( this.width, this.height ), this.scene, this.camera );
		this.composer.addPass( this.outlinePass );

		this.denoiserPass = new LygiaSmartDenoiserPass( this.width, this.height );
		this.denoiserPass.enabled = false;
		this.composer.addPass( this.denoiserPass );

		this.tileHighlightPass = new TileHighlightPass( new Vector2( this.width, this.height ) );
		this.tileHighlightPass.enabled = DEFAULT_STATE.tilesHelper;
		this.composer.addPass( this.tileHighlightPass );

		this.bloomPass = new UnrealBloomPass( new Vector2( this.width, this.height ) );
		this.bloomPass.enabled = DEFAULT_STATE.enableBloom;
		this.bloomPass.strength = DEFAULT_STATE.bloomStrength;
		this.bloomPass.radius = DEFAULT_STATE.bloomRadius;
		this.bloomPass.threshold = DEFAULT_STATE.bloomThreshold;
		this.composer.addPass( this.bloomPass );

		const outputPass = new OutputPass();
		outputPass.material.toneMapped = true;
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
				map: texture,
				visible: false
			} )
		);
		this.floorPlane.name = "Ground";
		this.scene.add( this.floorPlane );

	}

	refreshFrame = () => {

		this.accPass.iteration -= 1;
		this.pathTracingPass.isComplete = false;

	};

	animate = () => {

		this.animationFrameId = requestAnimationFrame( this.animate );

		if ( this.pauseRendering ) return;

		const pathtracingUniforms = this.pathTracingPass.material.uniforms;

		if ( this.pathTracingPass.isComplete && pathtracingUniforms.frame.value >= pathtracingUniforms.maxFrames.value ) return;

		if ( ! this.pathTracingPass.isComplete ) {

			this.controls.update();

			if ( this.tileHighlightPass.enabled ) {

				this.tileHighlightPass.uniforms.frame.value = pathtracingUniforms.frame.value + 1;
				this.tileHighlightPass.uniforms.renderMode.value = pathtracingUniforms.renderMode.value;
				this.tileHighlightPass.uniforms.tiles.value = pathtracingUniforms.tiles.value;

			}

			this.composer.render();

			// After rendering, update the temporal statistics with the newest frame
			this.temporalStatsPass.update( this.pathTracingPass.currentRenderTarget.texture );

			this.stats.update();

			// This is already using the store so no need to modify this part
			updateStats( {
				timeElapsed: this.accPass.timeElapsed,
				samples: this.pathTracingPass.material.uniforms.renderMode.value == 1 ?
					Math.floor( this.accPass.iteration / Math.pow( pathtracingUniforms.tiles.value, 2 ) ) :
					this.accPass.iteration
			} );

		}

		if ( ! this.pathTracingPass.isComplete ) return;

		if (
			( pathtracingUniforms.renderMode.value === 0 && pathtracingUniforms.frame.value === pathtracingUniforms.maxFrames.value ) ||
			( pathtracingUniforms.renderMode.value === 1 && pathtracingUniforms.frame.value === pathtracingUniforms.maxFrames.value * Math.pow( pathtracingUniforms.tiles.value, 2 ) )
		) {

			pathtracingUniforms.frame.value ++;
			this.denoiser.start();
			this.dispatchEvent( { type: 'RenderComplete' } );
			useStore.getState().setIsRenderComplete( true );

		}

	};

	getCameraNames() {

		return this.cameras.map( ( camera, index ) => `Camera ${index + 1}` );

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
		this.denoiser.setSize( this.width, this.height );
		this.temporalStatsPass.setSize( this.width, this.height );

		this.reset();

		window.dispatchEvent( new CustomEvent( 'resolution_changed' ) );

	}

	// Method to customize interaction quality settings
	setInteractionQuality( settings ) {

		if ( this.pathTracingPass ) {

			this.pathTracingPass.setInteractionQuality( settings );

		}

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

	getTargetModel() {

		return this.assetLoader.getTargetModel();

	}

	dispose() {

		cancelAnimationFrame( this.animationFrameId );
		// Dispose of js objects, remove event listeners, etc.
		this.canvas.removeEventListener( 'click', this.handleFocusClick );
		this.temporalStatsPass.dispose();

	}

}

export default PathTracerApp;
