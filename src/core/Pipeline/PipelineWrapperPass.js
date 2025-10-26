import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * PipelineWrapperPass - Integrates PassPipeline with Three.js EffectComposer
 *
 * Wraps the new PassPipeline system so it can be used as a standard Three.js Pass
 * in the EffectComposer chain. This allows gradual migration from the old
 * architecture to the new pipeline system.
 *
 * The wrapper delegates all Pass lifecycle methods to the pipeline:
 * - render() -> pipeline.render()
 * - setSize() -> pipeline.setSize()
 * - dispose() -> pipeline.dispose()
 *
 * @example
 * // In main.js setupComposer():
 * const pipeline = new PassPipeline(renderer, width, height);
 * pipeline.addStage(new PathTracerStage(...));
 * pipeline.addStage(new ASVGFStage(...));
 *
 * const pipelinePass = new PipelineWrapperPass(pipeline);
 * composer.addPass(pipelinePass);
 */
export class PipelineWrapperPass extends Pass {

	/**
	 * Create a wrapper pass for a pipeline
	 * @param {PassPipeline} pipeline - The pipeline to wrap
	 */
	constructor( pipeline ) {

		super();

		if ( ! pipeline ) {

			throw new Error( 'PipelineWrapperPass requires a pipeline' );

		}

		this.pipeline = pipeline;
		this.name = 'PipelineWrapperPass';

		// Enable by default
		this.enabled = true;

		// This pass doesn't need swap (pipeline manages its own buffers)
		this.needsSwap = false;

		// Clear behavior - let pipeline handle it
		this.clear = false;

	}

	/**
	 * Render the pipeline
	 * Called by EffectComposer during its render loop
	 *
	 * @param {THREE.WebGLRenderer} renderer - Three.js renderer
	 * @param {THREE.WebGLRenderTarget} writeBuffer - Output render target
	 * @param {THREE.WebGLRenderTarget} readBuffer - Input render target
	 * @param {number} deltaTime - Time since last frame
	 * @param {boolean} maskActive - Whether mask is active
	 */
	render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {

		// Update pipeline context with frame time
		this.pipeline.context.setState( 'deltaTime', deltaTime );
		this.pipeline.context.setState( 'time', this.pipeline.context.getState( 'time' ) + deltaTime );

		// Execute all pipeline stages
		this.pipeline.render( writeBuffer );

	}

	/**
	 * Resize the pipeline
	 * Called by EffectComposer when viewport size changes
	 *
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setSize( width, height ) {

		this.pipeline.setSize( width, height );

	}

	/**
	 * Dispose the pipeline
	 * Called when the pass is being destroyed
	 */
	dispose() {

		this.pipeline.dispose();

	}

	// ===== PIPELINE ACCESS =====

	/**
	 * Get the wrapped pipeline
	 * @returns {PassPipeline} The pipeline
	 */
	getPipeline() {

		return this.pipeline;

	}

	/**
	 * Get the pipeline context
	 * Convenience method for external access to context
	 * @returns {PipelineContext} The pipeline context
	 */
	getContext() {

		return this.pipeline.context;

	}

	/**
	 * Get the pipeline event bus
	 * Convenience method for external access to events
	 * @returns {EventEmitter} The event bus
	 */
	getEventBus() {

		return this.pipeline.eventBus;

	}

	/**
	 * Get a stage from the pipeline by name
	 * @param {string} name - Stage name
	 * @returns {PipelineStage|undefined} The stage or undefined
	 */
	getStage( name ) {

		return this.pipeline.getStage( name );

	}

	/**
	 * Enable/disable a stage by name
	 * @param {string} name - Stage name
	 * @param {boolean} enabled - Enable state
	 */
	setStageEnabled( name, enabled ) {

		this.pipeline.setStageEnabled( name, enabled );

	}

	// ===== CONVENIENCE METHODS =====

	/**
	 * Reset the pipeline
	 * Useful for external code that needs to trigger a reset
	 */
	reset() {

		this.pipeline.reset();

	}

	/**
	 * Get pipeline info for debugging
	 * @returns {Object} Pipeline information
	 */
	getInfo() {

		return this.pipeline.getInfo();

	}

	/**
	 * Enable performance tracking
	 * @param {boolean} enabled - Enable state
	 */
	setStatsEnabled( enabled ) {

		this.pipeline.setStatsEnabled( enabled );

	}

	/**
	 * Get performance statistics
	 * @returns {Object} Statistics object
	 */
	getStats() {

		return this.pipeline.getStats();

	}

	/**
	 * Log performance statistics
	 */
	logStats() {

		this.pipeline.logStats();

	}

	/**
	 * Log pipeline info
	 */
	logInfo() {

		this.pipeline.logInfo();

	}

}
