/**
 * Camera sub-API — camera switching, auto-focus, DOF, and raw Three.js access.
 *
 * Access via `engine.camera`.
 *
 * @example
 * engine.camera.switch(1);
 * engine.camera.active.fov = 60;
 * engine.camera.controls.target.set(0, 1, 0);
 */
export class CameraAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * The active Three.js PerspectiveCamera.
	 * @returns {import('three').PerspectiveCamera}
	 */
	get active() {

		return this._app.cameraManager?.camera ?? this._app._camera;

	}

	/**
	 * The OrbitControls instance.
	 * @returns {import('three/addons/controls/OrbitControls.js').OrbitControls}
	 */
	get controls() {

		return this._app.cameraManager?.controls ?? this._app._controls;

	}

	/**
	 * Switches the active camera by index.
	 * @param {number} index
	 */
	switch( index ) {

		this._app.switchCamera( index );

	}

	/**
	 * Returns display names for all available cameras.
	 * @returns {string[]}
	 */
	getNames() {

		return this._app.getCameraNames();

	}

	/**
	 * Focuses the orbit camera on a world-space point.
	 * @param {import('three').Vector3} center
	 */
	focusOn( center ) {

		this._app.focusOnPoint( center );

	}

	/**
	 * Sets the auto-focus mode.
	 * @param {'auto'|'manual'} mode
	 */
	setAutoFocusMode( mode ) {

		this._app.cameraManager?.setAutoFocusMode( mode );

	}

	/**
	 * Sets the normalized AF screen point (0-1 range).
	 * @param {number} x
	 * @param {number} y
	 */
	setAFScreenPoint( x, y ) {

		this._app.cameraManager?.setAFScreenPoint( x, y );

	}

	/**
	 * Enters AF point placement interaction mode.
	 */
	enterAFPointPlacementMode() {

		this._app.cameraManager?.enterAFPointPlacementMode();

	}

	/**
	 * Exits AF point placement interaction mode.
	 */
	exitAFPointPlacementMode() {

		this._app.cameraManager?.exitAFPointPlacementMode();

	}

}
