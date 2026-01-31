import { WebGPURenderer } from 'three/webgpu';
import { PerspectiveCamera, Scene } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HitTestStage, VIS_MODE } from '../Stages/HitTestStage.js';
import { DataTransfer } from '../DataTransfer.js';
import { DEFAULT_STATE } from '../../../Constants.js';

// Resolution index to pixel values mapping (same as main app)
const TARGET_RESOLUTIONS = { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 };

/**
 * WebGPU Hit Test Application.
 * Visualizes ray-scene intersections using WebGPU and TSL.
 *
 * Can be initialized standalone or with a reference to an existing
 * PathTracerApp to share scene data.
 */
export class WebGPUHitTestApp {

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
		this.hitTestStage = null;

		// State
		this.isInitialized = false;
		this.animationId = null;

		// Resolution settings - match main app's resolution system
		// Get target resolution from existing app or use default
		this.targetResolution = existingApp?.targetResolution ?? DEFAULT_STATE.resolution ?? 3;

	}

	/**
	 * Initializes the WebGPU renderer and related objects.
	 * WebGPU requires async initialization.
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

		// Calculate pixel ratio for absolute resolution (same as main app)
		// Maps resolution index to absolute pixel values: 0=256, 1=512, 2=1024, 3=2048, 4=4096
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		const targetRes = TARGET_RESOLUTIONS[ this.targetResolution ] || 512;
		const shortestDim = Math.min( width, height ) || 512; // Fallback if canvas not ready
		this.renderer.setPixelRatio( targetRes / shortestDim );

		// Setup camera - copy from existing app or create new
		if ( this.existingApp?.camera ) {

			this.camera = this.existingApp.camera.clone();
			DataTransfer.copyCameraSettings( this.existingApp, this.camera );

		} else {

			this.camera = new PerspectiveCamera( 65, 1, 0.01, 1000 );
			this.camera.position.set( 0, 0, 5 );

		}

		// Create scene (not used directly in fullscreen quad rendering)
		this.scene = new Scene();

		// Setup orbit controls
		this.controls = new OrbitControls( this.camera, this.canvas );
		// this.controls.enableDamping = true;
		// this.controls.dampingFactor = 0.05;
		this.controls.screenSpacePanning = true;

		// Create hit test stage
		this.hitTestStage = new HitTestStage( this.renderer, this.camera );

		// Handle resize
		this.onResize();
		this.resizeHandler = () => this.onResize();
		window.addEventListener( 'resize', this.resizeHandler );

		this.isInitialized = true;

		console.log( 'WebGPU Hit Test App initialized' );

		return this;

	}

	/**
	 * Loads scene data from the existing PathTracerApp.
	 *
	 * @returns {boolean} True if data was loaded successfully
	 */
	loadSceneData() {

		if ( ! this.existingApp ) {

			console.warn( 'WebGPUHitTestApp: No existing app to load data from' );
			return false;

		}

		// Try to get triangle texture directly (preferred)
		const triangleTexture = DataTransfer.getTriangleTexture( this.existingApp );

		if ( ! triangleTexture ) {

			// Fallback: Get raw data
			const triangleData = DataTransfer.getTriangleData( this.existingApp );

			if ( ! triangleData ) {

				console.error( 'WebGPUHitTestApp: Failed to get triangle data' );
				return false;

			}

			// Validate triangle data
			const validation = DataTransfer.validateTriangleData( triangleData );
			if ( ! validation.isValid ) {

				console.error( 'WebGPUHitTestApp: Invalid triangle data -', validation.error );
				return false;

			}

			console.log( `WebGPUHitTestApp: Loading ${validation.triangleCount} triangles from raw data` );
			this.hitTestStage.setTriangleData( triangleData );

		} else {

			console.log( 'WebGPUHitTestApp: Using existing triangle texture' );
			this.hitTestStage.setTriangleTexture( triangleTexture );

		}

		// Try to get BVH texture for accelerated traversal
		const bvhTexture = DataTransfer.getBVHTexture( this.existingApp );

		if ( bvhTexture ) {

			console.log( 'WebGPUHitTestApp: Using BVH texture for accelerated traversal' );
			this.hitTestStage.setBVHTexture( bvhTexture );

		} else {

			console.warn( 'WebGPUHitTestApp: No BVH texture found, using linear traversal' );

		}

		// Setup the material (uses BVH if available)
		this.hitTestStage.setupMaterial();

		return true;

	}

	/**
	 * Loads scene data directly from Float32Arrays.
	 *
	 * @param {Float32Array} triangleData - Triangle vertex data
	 * @param {Float32Array} bvhData - Optional BVH node data
	 * @returns {boolean} True if data was loaded successfully
	 */
	loadSceneDataDirect( triangleData, bvhData = null ) {

		if ( ! triangleData ) {

			console.error( 'WebGPUHitTestApp: Triangle data is required' );
			return false;

		}

		// Validate
		const validation = DataTransfer.validateTriangleData( triangleData );
		if ( ! validation.isValid ) {

			console.error( 'WebGPUHitTestApp: Invalid triangle data -', validation.error );
			return false;

		}

		// Set data
		this.hitTestStage.setTriangleData( triangleData );

		if ( bvhData ) {

			this.hitTestStage.setBVHData( bvhData );

		}

		// Setup material
		this.hitTestStage.setupMaterial();

		return true;

	}

	/**
	 * Handles window resize events.
	 */
	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;

		if ( width === 0 || height === 0 ) return;

		// Recalculate pixel ratio based on target resolution (same as main app)
		const targetRes = TARGET_RESOLUTIONS[ this.targetResolution ] || 512;
		const shortestDim = Math.min( width, height ) || 512;
		this.renderer.setPixelRatio( targetRes / shortestDim );

		this.renderer.setSize( width, height, false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

	}

	/**
	 * Update resolution using a resolution index.
	 * @param {number} resolutionIndex - Resolution index (0-4 maps to 256-4096 pixels)
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

		// Update camera matrix world
		this.camera.updateMatrixWorld();

		// Render hit test visualization
		if ( this.hitTestStage?.isReady ) {

			this.hitTestStage.render();

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
	 * Sets the visualization mode.
	 *
	 * @param {number} mode - VIS_MODE value (NORMALS=0, DISTANCE=1, MATERIAL_ID=2)
	 */
	setVisMode( mode ) {

		if ( this.hitTestStage ) {

			this.hitTestStage.setVisMode( mode );

		}

	}

	/**
	 * Sets the maximum distance for distance visualization.
	 *
	 * @param {number} distance - Maximum distance value
	 */
	setMaxDistance( distance ) {

		if ( this.hitTestStage ) {

			this.hitTestStage.setMaxDistance( distance );

		}

	}

	/**
	 * Gets the camera for external manipulation.
	 *
	 * @returns {PerspectiveCamera} The camera
	 */
	getCamera() {

		return this.camera;

	}

	/**
	 * Gets the controls for external manipulation.
	 *
	 * @returns {OrbitControls} The orbit controls
	 */
	getControls() {

		return this.controls;

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		this.stopAnimation();

		if ( this.hitTestStage ) {

			this.hitTestStage.dispose();

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

// Export VIS_MODE for convenience
export { VIS_MODE };
