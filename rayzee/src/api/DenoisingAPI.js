/**
 * Denoising sub-API — denoiser strategy, ASVGF, OIDN, upscaler,
 * adaptive sampling, and auto-exposure controls.
 *
 * Access via `engine.denoising`.
 *
 * @example
 * engine.denoising.setStrategy('asvgf', 'medium');
 * engine.denoising.setAutoExposure(true);
 * engine.denoising.setASVGFParams({ temporalAlpha: 0.1 });
 */
export class DenoisingAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	// ── Strategy ──

	/**
	 * Switches the real-time denoiser strategy.
	 * @param {'none'|'asvgf'|'ssrc'|'edgeaware'} strategy
	 * @param {string} [asvgfPreset] - ASVGF quality preset if strategy is 'asvgf'
	 */
	setStrategy( strategy, asvgfPreset ) {

		this._app.setDenoiserStrategy( strategy, asvgfPreset );

	}

	/**
	 * Enables or disables the ASVGF denoiser with optional quality preset.
	 * @param {boolean} enabled
	 * @param {string} [qualityPreset]
	 */
	setASVGFEnabled( enabled, qualityPreset ) {

		this._app.setASVGFEnabled( enabled, qualityPreset );

	}

	/**
	 * Applies an ASVGF quality preset.
	 * @param {'low'|'medium'|'high'} presetName
	 */
	applyASVGFPreset( presetName ) {

		this._app.applyASVGFPreset( presetName );

	}

	/**
	 * Enables or disables auto-exposure.
	 * @param {boolean} enabled
	 */
	setAutoExposure( enabled ) {

		this._app.setAutoExposureEnabled( enabled );

	}

	/**
	 * Enables or disables adaptive sampling.
	 * @param {boolean} enabled
	 */
	setAdaptiveSampling( enabled ) {

		this._app.setAdaptiveSamplingEnabled( enabled );

	}

	// ── Stage Parameters ──

	/**
	 * Updates ASVGF stage parameters.
	 * @param {Object} params - { temporalAlpha, phiColor, phiLuminance, atrousIterations, ... }
	 */
	setASVGFParams( params ) {

		this._app.updateASVGFParameters( params );

	}

	/**
	 * Toggles the ASVGF heatmap debug overlay.
	 * @param {boolean} enabled
	 */
	toggleASVGFHeatmap( enabled ) {

		this._app.toggleASVGFHeatmap( enabled );

	}

	/**
	 * Configures ASVGF for a specific render mode.
	 * @param {Object} config - { enabled, temporalAlpha, atrousIterations, ... }
	 */
	configureASVGFForMode( config ) {

		this._app.configureASVGFForMode( config );

	}

	/**
	 * Updates SSRC stage parameters.
	 * @param {Object} params - { temporalAlpha, spatialRadius, spatialWeight }
	 */
	setSSRCParams( params ) {

		this._app.updateSSRCParameters( params );

	}

	/**
	 * Updates edge-aware filtering parameters.
	 * @param {Object} params - { pixelEdgeSharpness, edgeSharpenSpeed, edgeThreshold }
	 */
	setEdgeAwareParams( params ) {

		this._app.updateEdgeAwareUniforms( params );

	}

	/**
	 * Updates auto-exposure stage parameters.
	 * @param {Object} params - { keyValue, minExposure, maxExposure, ... }
	 */
	setAutoExposureParams( params ) {

		this._app.updateAutoExposureParameters( params );

	}

	// ── Adaptive Sampling ──

	/**
	 * Updates adaptive sampling parameters.
	 * @param {Object} params
	 */
	setAdaptiveSamplingParams( params ) {

		this._app.setAdaptiveSamplingParameters( params );

	}

	/**
	 * Toggles the adaptive sampling debug helper.
	 * @param {boolean} enabled
	 */
	toggleAdaptiveSamplingHelper( enabled ) {

		this._app.toggleAdaptiveSamplingHelper( enabled );

	}

	// ── OIDN ──

	/**
	 * Enables or disables Intel OIDN denoiser (final render quality).
	 * @param {boolean} enabled
	 */
	setOIDNEnabled( enabled ) {

		this._app.setOIDNEnabled( enabled );

	}

	/**
	 * Sets OIDN denoiser quality.
	 * @param {string} quality
	 */
	setOIDNQuality( quality ) {

		this._app.updateOIDNQuality( quality );

	}

	/**
	 * Enables or disables the OIDN tile helper overlay.
	 * @param {boolean} enabled
	 */
	setOIDNTileHelper( enabled ) {

		this._app.setOIDNTileHelper( enabled );

	}

	/**
	 * Enables or disables the tile helper overlay.
	 * @param {boolean} enabled
	 */
	setTileHelperEnabled( enabled ) {

		this._app.setTileHelperEnabled( enabled );

	}

	/**
	 * Enables or disables tile highlight.
	 * @param {boolean} enabled
	 */
	setTileHighlightEnabled( enabled ) {

		this._app.setTileHighlightEnabled( enabled );

	}

	// ── AI Upscaler ──

	/**
	 * Enables or disables the AI upscaler.
	 * @param {boolean} enabled
	 */
	setUpscalerEnabled( enabled ) {

		this._app.setUpscalerEnabled( enabled );

	}

	/**
	 * Sets the upscaler scale factor.
	 * @param {number} factor
	 */
	setUpscalerScaleFactor( factor ) {

		this._app.setUpscalerScaleFactor( factor );

	}

	/**
	 * Sets the upscaler quality level.
	 * @param {string} quality
	 */
	setUpscalerQuality( quality ) {

		this._app.setUpscalerQuality( quality );

	}

}
