import { WebGPURenderer } from 'three/webgpu';
import { PerspectiveCamera, Scene } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PathTracingStage } from './Stages/PathTracingStage.js';
import { DataTransfer } from './DataTransfer.js';
import { DEFAULT_STATE } from '../../Constants.js';

// Resolution index to pixel values mapping (same as main app)
const TARGET_RESOLUTIONS = { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 };

/**
 * WebGPU Path Tracer Application.
 * Full path tracing implementation using WebGPU and TSL.
 *
 * Can be initialized standalone or with a reference to an existing
 * PathTracerApp to share scene data.
 */
export class WebGPUPathTracerApp {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {PathTracerApp} existingApp - Optional existing app for data sharing
	 */
	constructor( canvas, existingApp = null ) {

		this.canvas = canvas;
		this.existingApp = existingApp;

		// Core objects
		this.renderer = null;
		this.camera = null;
		this.scene = null;
		this.controls = null;

		// Stages
		this.pathTracingStage = null;

		// State
		this.isInitialized = false;
		this.animationId = null;
		this.needsReset = false;

		// Resolution settings
		this.targetResolution = existingApp?.targetResolution ?? DEFAULT_STATE.resolution ?? 3;

		// Settings
		this.maxBounces = DEFAULT_STATE.bounces ?? 4;
		this.environmentIntensity = DEFAULT_STATE.environmentIntensity ?? 1.0;

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

		await this.renderer.init();

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

		// Track camera movement for reset
		this.controls.addEventListener( 'change', () => {

			this.needsReset = true;

		} );

		// Create path tracing stage
		this.pathTracingStage = new PathTracingStage( this.renderer, this.camera );

		// Handle resize
		this.onResize();
		this.resizeHandler = () => this.onResize();
		window.addEventListener( 'resize', this.resizeHandler );

		this.isInitialized = true;

		console.log( 'WebGPU Path Tracer App initialized' );

		return this;

	}

	/**
	 * Loads scene data from the existing PathTracerApp.
	 *
	 * @returns {boolean} True if data was loaded successfully
	 */
	loadSceneData() {

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

		if ( bvhTexture ) {

			this.pathTracingStage.setBVHTexture( bvhTexture );

		} else {

			console.warn( 'WebGPUPathTracerApp: No BVH texture, using linear traversal' );

		}

		if ( materialTexture ) {

			this.pathTracingStage.setMaterialTexture( materialTexture );

		} else {

			console.warn( 'WebGPUPathTracerApp: No material texture, using defaults' );

		}

		if ( environmentTexture ) {

			this.pathTracingStage.setEnvironmentTexture( environmentTexture );

		}

		// Setup material with all data
		this.pathTracingStage.setupMaterial();

		// Apply settings
		this.pathTracingStage.setMaxBounces( this.maxBounces );
		this.pathTracingStage.setEnvironmentIntensity( this.environmentIntensity );

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

	}

	/**
	 * Update resolution using a resolution index.
	 */
	updateResolution( resolutionIndex ) {

		this.targetResolution = resolutionIndex;
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

		// Render path tracing
		if ( this.pathTracingStage?.isReady ) {

			this.pathTracingStage.render();

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
	 * Resets the accumulation buffer.
	 */
	reset() {

		if ( this.pathTracingStage ) {

			this.pathTracingStage.reset();

		}

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
	 * Disposes of all resources.
	 */
	dispose() {

		this.stopAnimation();

		if ( this.pathTracingStage ) {

			this.pathTracingStage.dispose();

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

