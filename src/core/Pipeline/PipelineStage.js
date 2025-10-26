/**
 * PipelineStage - Base class for all pipeline stages
 *
 * Provides standard lifecycle methods and event handling capabilities.
 * All rendering passes should extend this class and implement the render() method.
 *
 * Lifecycle:
 * 1. constructor() - Create stage with name and options
 * 2. initialize() - Called by pipeline, receives context and eventBus
 * 3. setupEventListeners() - Override to register event listeners
 * 4. render() - Called every frame (MUST be implemented)
 * 5. reset() - Called when scene/camera changes (optional)
 * 6. setSize() - Called when viewport resizes (optional)
 * 7. dispose() - Called when stage is destroyed (optional)
 *
 * @example
 * class MyStage extends PipelineStage {
 *   constructor() {
 *     super('MyStage', { enabled: true });
 *   }
 *
 *   setupEventListeners() {
 *     this.on('camera:moved', () => this.handleCameraMove());
 *   }
 *
 *   render(context, writeBuffer) {
 *     // Read from context
 *     const inputTexture = context.getTexture('pathtracer:color');
 *
 *     // Do rendering...
 *
 *     // Write to context
 *     context.setTexture('mystage:output', outputTexture);
 *
 *     // Emit events
 *     this.emit('mystage:complete', { frame: context.getState('frame') });
 *   }
 * }
 */
export class PipelineStage {

	/**
	 * Create a new pipeline stage
	 * @param {string} name - Stage name (used for debugging and logging)
	 * @param {Object} options - Stage options
	 * @param {boolean} [options.enabled=true] - Whether stage is enabled
	 */
	constructor( name, options = {} ) {

		this.name = name;
		this.enabled = options.enabled !== false;

		// Set by initialize()
		this.context = null;
		this.eventBus = null;

	}

	/**
	 * Initialize stage with pipeline context and event bus
	 * Called once during pipeline setup
	 * @param {PipelineContext} context - Shared pipeline context
	 * @param {EventEmitter} eventBus - Event bus for stage communication
	 */
	initialize( context, eventBus ) {

		this.context = context;
		this.eventBus = eventBus;
		this.setupEventListeners();

	}

	/**
	 * Setup event listeners
	 * Override in subclasses to listen to events
	 *
	 * @example
	 * setupEventListeners() {
	 *   this.on('camera:moved', () => { ... });
	 *   this.on('tile:changed', (data) => { ... });
	 * }
	 */
	setupEventListeners() {
		// Override in subclasses
	}

	/**
	 * Main render method - MUST be implemented in subclasses
	 *
	 * @param {PipelineContext} context - Shared context with textures, state, etc.
	 * @param {THREE.WebGLRenderTarget} [writeBuffer] - Optional output buffer
	 * @throws {Error} If not implemented
	 */
	render( context, writeBuffer ) {

		throw new Error( `render() must be implemented in ${this.name}` );

	}

	/**
	 * Reset stage state
	 * Override if stage needs to reset internal state when scene/camera changes
	 */
	reset() {
		// Override if needed
	}

	/**
	 * Resize stage resources
	 * Override if stage needs to resize render targets or update resolution-dependent state
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setSize( width, height ) {
		// Override if needed
	}

	/**
	 * Clean up resources
	 * Override to dispose of render targets, materials, geometries, etc.
	 */
	dispose() {
		// Override if needed
	}

	// ===== EVENT UTILITIES =====

	/**
	 * Emit an event
	 * Convenience method for this.eventBus.emit()
	 * @param {string} type - Event type
	 * @param {*} data - Event data
	 */
	emit( type, data ) {

		if ( this.eventBus ) {

			this.eventBus.emit( type, data );

		}

	}

	/**
	 * Listen to an event
	 * Convenience method for this.eventBus.on()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	on( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.on( type, listener );

		}

	}

	/**
	 * Listen to an event once
	 * Convenience method for this.eventBus.once()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	once( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.once( type, listener );

		}

	}

	/**
	 * Stop listening to an event
	 * Convenience method for this.eventBus.off()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	off( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.off( type, listener );

		}

	}

	// ===== STATE UTILITIES =====

	/**
	 * Enable this stage
	 * Emits 'stage:enabled' event
	 */
	enable() {

		if ( ! this.enabled ) {

			this.enabled = true;
			this.emit( 'stage:enabled', { stage: this.name } );

		}

	}

	/**
	 * Disable this stage
	 * Emits 'stage:disabled' event
	 */
	disable() {

		if ( this.enabled ) {

			this.enabled = false;
			this.emit( 'stage:disabled', { stage: this.name } );

		}

	}

	/**
	 * Toggle stage enabled state
	 */
	toggle() {

		if ( this.enabled ) {

			this.disable();

		} else {

			this.enable();

		}

	}

	/**
	 * Check if stage is enabled
	 * @returns {boolean} True if enabled
	 */
	isEnabled() {

		return this.enabled;

	}

	// ===== DEBUG UTILITIES =====

	/**
	 * Log a message with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	log( ...args ) {

		console.log( `[${this.name}]`, ...args );

	}

	/**
	 * Log a warning with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	warn( ...args ) {

		console.warn( `[${this.name}]`, ...args );

	}

	/**
	 * Log an error with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	error( ...args ) {

		console.error( `[${this.name}]`, ...args );

	}

}
