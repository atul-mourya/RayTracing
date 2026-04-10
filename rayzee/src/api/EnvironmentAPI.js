/**
 * Environment sub-API — HDR maps, sky modes, and procedural generation.
 *
 * Access via `engine.environment`.
 *
 * @example
 * await engine.environment.setMode('gradient');
 * engine.environment.params.sunElevation = 45;
 * engine.environment.markDirty();
 */
export class EnvironmentAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Current environment parameters (sun position, sky colors, etc.).
	 * @returns {Object|null}
	 */
	get params() {

		return this._app.getEnvParams();

	}

	/**
	 * The loaded environment texture.
	 * @returns {import('three').Texture|null}
	 */
	get texture() {

		return this._app.getEnvironmentTexture();

	}

	/**
	 * Loads an HDR/EXR environment map from URL.
	 * @param {string} url
	 */
	async load( url ) {

		await this._app.loadEnvironment( url );

	}

	/**
	 * Sets a custom environment texture directly.
	 * @param {import('three').Texture} texture
	 */
	async setTexture( texture ) {

		await this._app.setEnvironmentMap( texture );

	}

	/**
	 * Switches the sky mode.
	 * @param {'hdri'|'procedural'|'gradient'|'color'} mode
	 */
	async setMode( mode ) {

		await this._app.setEnvironmentMode( mode );

	}

	/**
	 * Generates a procedural Preetham-model sky texture.
	 */
	async generateProcedural() {

		return this._app.generateProceduralSkyTexture();

	}

	/**
	 * Generates a gradient sky texture.
	 */
	async generateGradient() {

		return this._app.generateGradientTexture();

	}

	/**
	 * Generates a solid color sky texture.
	 */
	async generateSolid() {

		return this._app.generateSolidColorTexture();

	}

	/**
	 * Flags the environment texture for GPU re-upload.
	 */
	markDirty() {

		this._app.markEnvironmentNeedsUpdate();

	}

}
