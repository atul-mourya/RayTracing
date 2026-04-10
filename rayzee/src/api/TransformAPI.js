/**
 * Transform sub-API — gizmo mode and space controls.
 *
 * Access via `engine.transform`.
 *
 * @example
 * engine.transform.setMode('rotate');
 * engine.transform.setSpace('local');
 */
export class TransformAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Sets the transform gizmo mode.
	 * @param {'translate'|'rotate'|'scale'} mode
	 */
	setMode( mode ) {

		this._app.setTransformMode( mode );

	}

	/**
	 * Sets the transform gizmo coordinate space.
	 * @param {'world'|'local'} space
	 */
	setSpace( space ) {

		this._app.setTransformSpace( space );

	}

	/**
	 * Direct access to the underlying TransformManager (advanced).
	 * @returns {import('../managers/TransformManager.js').TransformManager}
	 */
	get manager() {

		return this._app.transformManager;

	}

}
