/**
 * Lights sub-API — light CRUD, helpers, and GPU sync.
 *
 * Access via `engine.lights`.
 *
 * @example
 * engine.lights.add('PointLight');
 * engine.lights.showHelpers(true);
 * engine.lights.getAll();
 */
export class LightsAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Adds a light to the scene.
	 * @param {'DirectionalLight'|'PointLight'|'SpotLight'|'RectAreaLight'} type
	 * @returns {Object|null} Light descriptor
	 */
	add( type ) {

		return this._app.addLight( type );

	}

	/**
	 * Removes a light by UUID.
	 * @param {string} uuid
	 * @returns {boolean}
	 */
	remove( uuid ) {

		return this._app.removeLight( uuid );

	}

	/**
	 * Removes all lights from the scene.
	 */
	clear() {

		this._app.clearLights();

	}

	/**
	 * Returns descriptors for all lights in the scene.
	 * @returns {Object[]}
	 */
	getAll() {

		return this._app.getLights();

	}

	/**
	 * Re-uploads light data to the GPU.
	 */
	sync() {

		this._app.updateLights();

	}

	/**
	 * Shows or hides visual light helpers.
	 * @param {boolean} show
	 */
	showHelpers( show ) {

		this._app.setShowLightHelper( show );

	}

}
