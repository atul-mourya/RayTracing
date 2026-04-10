/**
 * Selection sub-API — object picking and interaction modes.
 *
 * Access via `engine.selection`.
 *
 * @example
 * engine.selection.select(meshObject);
 * engine.selection.toggleMode();
 */
export class SelectionAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Programmatically selects an object (or deselects if null).
	 * @param {import('three').Object3D|null} object
	 */
	select( object ) {

		this._app.selectObject( object );

	}

	/**
	 * Deselects the current object.
	 */
	deselect() {

		this._app.selectObject( null );

	}

	/**
	 * Toggles object selection mode on/off.
	 * @returns {boolean} Whether selection mode is now active
	 */
	toggleMode() {

		return this._app.toggleSelectMode();

	}

	/**
	 * Disables selection mode and detaches transform gizmo.
	 */
	disableMode() {

		this._app.disableSelectMode();

	}

	/**
	 * Toggles click-to-focus DOF mode.
	 * @returns {boolean} Whether focus mode is now active
	 */
	toggleFocusMode() {

		return this._app.toggleFocusMode();

	}

	/**
	 * Dispatches an event through the interaction manager.
	 * @param {Object} event
	 */
	dispatchEvent( event ) {

		this._app.dispatchInteractionEvent( event );

	}

	/**
	 * Subscribes to an interaction manager event.
	 * @param {string} type
	 * @param {Function} handler
	 * @returns {Function} Unsubscribe function
	 */
	on( type, handler ) {

		return this._app.onInteractionEvent( type, handler );

	}

}
