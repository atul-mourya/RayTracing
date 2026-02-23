import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import { PathTracingStage } from './PathTracingStage.js';

/**
 * WebGPUPathTracerStage - Pipeline-integrated WebGPU path tracer
 *
 * Adapter pattern wrapping PathTracingStage to integrate with the
 * event-driven pipeline architecture used by the WebGL backend.
 *
 * This allows the WebGPU path tracer to be used as a drop-in replacement
 * for the WebGL PathTracerStage in PassPipeline.
 *
 * Execution: ALWAYS - Must run every frame to accumulate samples
 *
 * Events emitted:
 * - pathtracer:frameComplete - When a frame finishes rendering
 * - camera:moved - When camera position/orientation changes
 * - asvgf:reset - Request ASVGF to reset temporal data
 *
 * Textures published to context:
 * - pathtracer:color - Main color output
 * - pathtracer:normalDepth - Normal/depth buffer (when MRT enabled)
 * - pathtracer:albedo - Albedo buffer (when MRT enabled)
 */
export class WebGPUPathTracerStage extends PipelineStage {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {PerspectiveCamera} camera - Three.js camera
	 * @param {Object} options - Stage options
	 */
	constructor( renderer, camera, options = {} ) {

		super( 'WebGPUPathTracer', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.camera = camera;

		// Create the underlying WebGPU path tracing stage
		this.pathTracingStage = new PathTracingStage( renderer, camera );

		// Track camera state for change detection
		this.lastCameraMatrixHash = '';
		this.cameraChanged = false;

		// Track resolution for dynamic updates
		this.width = 0;
		this.height = 0;

	}

	/**
	 * Setup event listeners for pipeline communication
	 */
	setupEventListeners() {

		// Listen for pipeline-wide resets
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

		// Listen for ASVGF reset requests (can come from other stages)
		this.on( 'asvgf:reset', () => {

			this.reset();

		} );

		// Listen for resize events
		this.on( 'pipeline:resize', ( data ) => {

			if ( data && data.width && data.height ) {

				this.setSize( data.width, data.height );

			}

		} );

	}

	/**
	 * Sets the triangle data from raw Float32Array
	 */
	setTriangleData( triangleData, triangleCount ) {

		this.pathTracingStage.setTriangleData( triangleData, triangleCount );

	}

	/**
	 * Sets the BVH data from raw Float32Array
	 */
	setBVHData( bvhImageData ) {

		this.pathTracingStage.setBVHData( bvhImageData );

	}

	/**
	 * Sets the material data from raw Float32Array
	 */
	setMaterialData( matImageData ) {

		this.pathTracingStage.setMaterialData( matImageData );

	}

	/**
	 * Sets the environment map texture
	 */
	setEnvironmentTexture( envTex ) {

		this.pathTracingStage.setEnvironmentTexture( envTex );

	}

	/**
	 * Creates render targets for accumulation
	 */
	createRenderTargets( width, height ) {

		this.width = width;
		this.height = height;
		this.pathTracingStage.createRenderTargets( width, height );

	}

	/**
	 * Sets up the path tracing material after textures are loaded
	 */
	setupMaterial() {

		this.pathTracingStage.setupMaterial();

	}

	/**
	 * Check if the stage is ready to render
	 */
	get isReady() {

		return this.pathTracingStage.isReady;

	}

	/**
	 * Get current frame count
	 */
	getFrameCount() {

		return this.pathTracingStage.frameCount;

	}

	/**
	 * Get current output texture (for display or downstream stages)
	 */
	getCurrentOutputTexture() {

		const currentTarget = this.pathTracingStage.currentTarget === 0
			? this.pathTracingStage.renderTargetA
			: this.pathTracingStage.renderTargetB;

		return currentTarget?.texture || null;

	}

	/**
	 * Get previous frame texture (for temporal effects)
	 */
	getPreviousOutputTexture() {

		const previousTarget = this.pathTracingStage.currentTarget === 0
			? this.pathTracingStage.renderTargetB
			: this.pathTracingStage.renderTargetA;

		return previousTarget?.texture || null;

	}

	/**
	 * Get MRT textures for denoising stages
	 * @returns {Object} Object containing color, normalDepth, and albedo textures
	 */
	getMRTTextures() {

		return this.pathTracingStage.getMRTTextures();

	}

	/**
	 * Main render method - called by pipeline
	 * @param {PipelineContext} context - Shared pipeline context
	 * @param {RenderTarget} writeBuffer - Optional output buffer
	 */
	render( context, writeBuffer ) {

		if ( ! this.enabled || ! this.pathTracingStage.isReady ) return;

		// Check for camera changes
		this.detectCameraChanges();

		// Sync state from context
		const contextFrame = context.getState( 'frame' );
		if ( contextFrame !== undefined && contextFrame !== this.pathTracingStage.frameCount ) {

			// Context frame is authoritative if set
			this.pathTracingStage.frame.value = contextFrame;

		}

		// Check for resolution changes
		const contextWidth = context.getState( 'width' );
		const contextHeight = context.getState( 'height' );
		if ( contextWidth && contextHeight &&
			( contextWidth !== this.width || contextHeight !== this.height ) ) {

			this.setSize( contextWidth, contextHeight );

		}

		// Render the path tracing pass
		this.pathTracingStage.render();

		// Publish textures to context for downstream stages
		this.publishTexturesToContext( context );

		// Emit events
		this.emitStateEvents( context );

	}

	/**
	 * Detect camera changes by comparing matrix hash
	 */
	detectCameraChanges() {

		const matrixElements = this.camera.matrixWorld.elements;
		const hash = matrixElements.slice( 0, 12 ).map( v => v.toFixed( 4 ) ).join( ',' );

		if ( hash !== this.lastCameraMatrixHash ) {

			this.lastCameraMatrixHash = hash;
			this.cameraChanged = true;
			this.reset();

		} else {

			this.cameraChanged = false;

		}

	}

	/**
	 * Publish textures to pipeline context
	 * @param {PipelineContext} context - Pipeline context
	 */
	publishTexturesToContext( context ) {

		// Get all MRT textures
		const mrtTextures = this.getMRTTextures();

		// Publish main color output
		if ( mrtTextures.color ) {

			context.setTexture( 'pathtracer:color', mrtTextures.color );

		}

		// Publish MRT outputs for denoising stages
		if ( mrtTextures.normalDepth ) {

			context.setTexture( 'pathtracer:normalDepth', mrtTextures.normalDepth );

		}

		if ( mrtTextures.albedo ) {

			context.setTexture( 'pathtracer:albedo', mrtTextures.albedo );

		}

		// Publish state
		context.setState( 'frame', this.pathTracingStage.frameCount );
		context.setState( 'isComplete', this.pathTracingStage.frameCount >= 1000 ); // Configurable threshold

	}

	/**
	 * Emit state change events
	 * @param {PipelineContext} context - Pipeline context
	 */
	emitStateEvents( context ) {

		// Emit frame complete event
		this.emit( 'pathtracer:frameComplete', {
			frame: this.pathTracingStage.frameCount,
			isComplete: false
		} );

		// Emit camera changed event
		if ( this.cameraChanged ) {

			this.emit( 'camera:moved' );

		}

	}

	/**
	 * Reset accumulation state
	 */
	reset() {

		this.pathTracingStage.reset();

		// Emit reset event to notify other stages
		this.emit( 'asvgf:reset' );

	}

	/**
	 * Resize render targets
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setSize( width, height ) {

		if ( width === this.width && height === this.height ) return;

		this.width = width;
		this.height = height;
		this.pathTracingStage.createRenderTargets( width, height );

		// Reset accumulation when resizing
		this.reset();

	}

	/**
	 * Sets the maximum number of bounces
	 */
	setMaxBounces( bounces ) {

		this.pathTracingStage.setMaxBounces( bounces );

	}

	/**
	 * Sets the environment intensity
	 */
	setEnvironmentIntensity( intensity ) {

		this.pathTracingStage.setEnvironmentIntensity( intensity );

	}

	/**
	 * Dispose of resources
	 */
	dispose() {

		this.pathTracingStage.dispose();

	}

}
