import { EventDispatcher } from 'three';

/**
 * EventEmitter - Enhanced event bus extending Three.js EventDispatcher
 *
 * Provides convenient pub/sub pattern for loose coupling between pipeline stages.
 * Extends Three.js EventDispatcher with modern convenience methods (on, off, emit).
 *
 * @example
 * const eventBus = new EventEmitter();
 * eventBus.on('camera:moved', (data) => console.log('Camera moved:', data));
 * eventBus.emit('camera:moved', { position: [0, 0, 5] });
 */
export class EventEmitter extends EventDispatcher {

	constructor() {

		super();
		this._onceCallbacks = new Map();

	}

	/**
	 * Register an event listener (convenience wrapper for addEventListener)
	 * @param {string} type - Event type
	 * @param {Function} listener - Callback function
	 */
	on( type, listener ) {

		this.addEventListener( type, listener );

	}

	/**
	 * Register a one-time listener that auto-unregisters after first call
	 * @param {string} type - Event type
	 * @param {Function} listener - Callback function
	 */
	once( type, listener ) {

		const wrappedListener = ( event ) => {

			listener( event );
			this.off( type, wrappedListener );
			this._onceCallbacks.delete( listener );

		};

		this._onceCallbacks.set( listener, wrappedListener );
		this.on( type, wrappedListener );

	}

	/**
	 * Unregister a listener (convenience wrapper for removeEventListener)
	 * @param {string} type - Event type
	 * @param {Function} listener - Callback function to remove
	 */
	off( type, listener ) {

		// Check if this was registered via once()
		const wrappedListener = this._onceCallbacks.get( listener );
		if ( wrappedListener ) {

			this.removeEventListener( type, wrappedListener );
			this._onceCallbacks.delete( listener );

		} else {

			this.removeEventListener( type, listener );

		}

	}

	/**
	 * Emit an event to all registered listeners (convenience wrapper for dispatchEvent)
	 * Automatically wraps data in event object if needed
	 * @param {string} type - Event type
	 * @param {*} data - Data to pass to listeners (optional)
	 */
	emit( type, data ) {

		// If data is already an event object with type, use it directly
		if ( data && typeof data === 'object' && data.type ) {

			this.dispatchEvent( data );

		} else {

			// Otherwise, create event object
			this.dispatchEvent( { type, ...data } );

		}

	}

	/**
	 * Remove all listeners for a specific event type
	 * Note: Three.js EventDispatcher doesn't provide removeAllListeners,
	 * so we clear our internal tracking and rely on disposal for cleanup
	 * @param {string} type - Event type (optional)
	 */
	removeAllListeners( type ) {

		if ( type ) {

			// Clear once callbacks for this type
			for ( const [ originalListener, wrappedListener ] of this._onceCallbacks.entries() ) {

				if ( this.hasEventListener( type, wrappedListener ) ) {

					this.removeEventListener( type, wrappedListener );
					this._onceCallbacks.delete( originalListener );

				}

			}

			// Note: Three.js EventDispatcher stores listeners in ._listeners[type]
			// We can access it directly to clear all
			if ( this._listeners && this._listeners[ type ] ) {

				delete this._listeners[ type ];

			}

		} else {

			this._onceCallbacks.clear();
			if ( this._listeners ) {

				this._listeners = {};

			}

		}

	}

	/**
	 * Get the number of listeners for an event type
	 * @param {string} type - Event type
	 * @returns {number} Number of listeners
	 */
	listenerCount( type ) {

		if ( ! this._listeners || ! this._listeners[ type ] ) {

			return 0;

		}

		return this._listeners[ type ].length;

	}

	/**
	 * Clear all listeners
	 */
	clear() {

		this.removeAllListeners();

	}

	/**
	 * Get all event types that have listeners
	 * @returns {string[]} Array of event types
	 */
	eventNames() {

		if ( ! this._listeners ) {

			return [];

		}

		return Object.keys( this._listeners );

	}

}
