/**
 * Output sub-API — canvas, screenshots, resize, and scene statistics.
 *
 * Access via `engine.output`.
 *
 * @example
 * engine.output.setSize(1920, 1080);
 * engine.output.screenshot();
 * const stats = engine.output.getStatistics();
 */
export class OutputAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Returns the canvas element with the final rendered image.
	 * Ensures the WebGPU canvas has fresh content if needed.
	 * @returns {HTMLCanvasElement|null}
	 */
	getCanvas() {

		return this._app.getOutputCanvas();

	}

	/**
	 * Downloads a PNG screenshot of the current render.
	 */
	screenshot() {

		this._app.takeScreenshot();

	}

	/**
	 * Returns scene statistics (triangle count, mesh count, etc.).
	 * @returns {Object|null}
	 */
	getStatistics() {

		return this._app.getSceneStatistics();

	}

	/**
	 * Sets explicit canvas dimensions and triggers resize.
	 * @param {number} width
	 * @param {number} height
	 */
	setSize( width, height ) {

		this._app.setCanvasSize( width, height );

	}

	/**
	 * Triggers a manual resize recalculation from current canvas dimensions.
	 */
	resize() {

		this._app.onResize();

	}

	/**
	 * Whether the path tracer has finished converging.
	 * @returns {boolean}
	 */
	isComplete() {

		return this._app.isComplete();

	}

	/**
	 * Returns the current accumulated frame/sample count.
	 * @returns {number}
	 */
	getFrameCount() {

		return this._app.getFrameCount();

	}

}
