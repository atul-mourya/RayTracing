import { WebGPURenderer } from 'three/webgpu';
import { PerspectiveCamera, Scene } from 'three';
import { Inspector } from 'three/addons/inspector/Inspector.js';
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
		this.pathTracingStage = new PathTracingStage( this.renderer, this.scene, this.camera );

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

