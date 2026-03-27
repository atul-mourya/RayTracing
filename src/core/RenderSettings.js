import { EventDispatcher } from 'three';
import { ENGINE_DEFAULTS } from './EngineDefaults.js';
import { EngineEvents } from './EngineEvents.js';

/**
 * Routing table: maps each setting key to its target stage/handler.
 *
 * - `uniform`  → forwarded to PathTracingStage.setUniform(uniform, value)
 * - `handler`  → calls a named handler method for multi-stage settings
 * - `delegate` → routes to a named manager's updateParam(param, value)
 * - `reset`    → whether to reset accumulation after the change (default true)
 * - `after`    → optional method to call on PathTracingStage after the uniform is set
 */
const SETTING_ROUTES = {

	// ── Simple PathTracingStage uniforms ──────────────────────────

	maxBounces: { uniform: 'maxBounces', reset: true },
	samplesPerPixel: { uniform: 'samplesPerPixel', reset: true },
	transmissiveBounces: { uniform: 'transmissiveBounces', reset: true },
	environmentIntensity: { uniform: 'environmentIntensity', reset: true },
	backgroundIntensity: { uniform: 'backgroundIntensity', reset: true },
	showBackground: { uniform: 'showBackground', reset: true },
	enableEnvironment: { uniform: 'enableEnvironment', reset: true },
	globalIlluminationIntensity: { uniform: 'globalIlluminationIntensity', reset: true },
	enableDOF: { uniform: 'enableDOF', reset: true },
	focusDistance: { uniform: 'focusDistance', reset: true },
	focalLength: { uniform: 'focalLength', reset: true },
	aperture: { uniform: 'aperture', reset: true },
	apertureScale: { uniform: 'apertureScale', reset: true },
	samplingTechnique: { uniform: 'samplingTechnique', reset: true },
	fireflyThreshold: { uniform: 'fireflyThreshold', reset: true },
	enableEmissiveTriangleSampling: { uniform: 'enableEmissiveTriangleSampling', reset: true },
	emissiveBoost: { uniform: 'emissiveBoost', reset: true },
	visMode: { uniform: 'visMode', reset: true },
	debugVisScale: { uniform: 'debugVisScale', reset: true },
	useAdaptiveSampling: { uniform: 'useAdaptiveSampling', reset: true },
	adaptiveSamplingMax: { uniform: 'adaptiveSamplingMax', reset: true },

	// ── Multi-stage / special handling ────────────────────────────

	maxSamples: { handler: 'handleMaxSamples', reset: false },
	transparentBackground: { handler: 'handleTransparentBackground' },
	exposure: { handler: 'handleExposure' },
	renderLimitMode: { handler: 'handleRenderLimitMode' },
	renderTimeLimit: { handler: 'handleRenderTimeLimit', reset: false },
	renderMode: { handler: 'handleRenderMode' },
	environmentRotation: { handler: 'handleEnvironmentRotation' },

};

/**
 * Default keys to extract from ENGINE_DEFAULTS for initializing the values map.
 * Maps ENGINE_DEFAULTS key → RenderSettings key when they differ.
 */
const DEFAULTS_KEY_MAP = {
	bounces: 'maxBounces',
	adaptiveSampling: 'useAdaptiveSampling',
	debugMode: 'visMode',
};

/**
 * Single source of truth for all render parameters.
 *
 * Replaces the 48 property initializations and 22+ boilerplate setter
 * methods that were duplicated across PathTracerApp and UniformManager.
 *
 * Usage:
 *   settings.set('maxBounces', 8);
 *   settings.get('maxBounces');               // 8
 *   settings.setMany({ maxBounces: 8, exposure: 1.5 });
 */
export class RenderSettings extends EventDispatcher {

	constructor( defaults = ENGINE_DEFAULTS ) {

		super();

		/** @type {Map<string, *>} */
		this._values = new Map();

		/** @type {import('./Stages/PathTracingStage.js').PathTracingStage|null} */
		this._pathTracingStage = null;

		/** @type {Function|null} - Callback to reset accumulation */
		this._resetCallback = null;

		/** @type {Object<string, Function>} - Named handlers for multi-stage settings */
		this._handlers = {};

		/** @type {Object<string, Object>} - Named delegate managers */
		this._delegates = {};

		// Initialize values from ENGINE_DEFAULTS
		this._initDefaults( defaults );

	}

	/**
	 * Wires internal references. Called by PathTracerApp after init().
	 */
	bind( { pathTracingStage, resetCallback, handlers = {}, delegates = {} } ) {

		this._pathTracingStage = pathTracingStage;
		this._resetCallback = resetCallback;
		this._handlers = handlers;
		this._delegates = delegates;

	}

	/**
	 * Sets a single render parameter.
	 *
	 * @param {string} key   - Setting key (e.g. 'maxBounces')
	 * @param {*}      value - New value
	 * @param {Object}  [options]
	 * @param {boolean} [options.reset]  - Override the route's default reset behavior
	 * @param {boolean} [options.silent] - Suppress the settingChanged event
	 */
	set( key, value, { reset, silent } = {} ) {

		const prev = this._values.get( key );
		if ( prev === value ) return;

		this._values.set( key, value );

		const route = SETTING_ROUTES[ key ];

		if ( ! route ) {

			// Unknown key — store it but don't route anywhere.
			// This allows consumers to stash custom state.
			return;

		}

		if ( route.uniform ) {

			this._pathTracingStage?.setUniform( route.uniform, value );

			if ( route.after ) {

				this._pathTracingStage?.[ route.after ]?.();

			}

		} else if ( route.handler ) {

			this._handlers[ route.handler ]?.( value, prev );

		} else if ( route.delegate ) {

			this._delegates[ route.delegate ]?.updateParam?.( route.param, value );

		}

		const shouldReset = reset !== undefined ? reset : ( route.reset ?? true );

		if ( shouldReset ) {

			this._resetCallback?.();

		}

		if ( ! silent ) {

			this.dispatchEvent( { type: EngineEvents.SETTING_CHANGED, key, value, prev } );

		}

	}

	/**
	 * Batch-update multiple settings. Only calls reset() once at the end.
	 *
	 * @param {Object} updates - Key/value pairs to update
	 * @param {Object} [options]
	 * @param {boolean} [options.silent] - Suppress individual settingChanged events
	 */
	setMany( updates, { silent } = {} ) {

		let needsReset = false;

		for ( const [ key, value ] of Object.entries( updates ) ) {

			const prev = this._values.get( key );
			if ( prev === value ) continue;

			this._values.set( key, value );

			const route = SETTING_ROUTES[ key ];
			if ( ! route ) continue;

			if ( route.uniform ) {

				this._pathTracingStage?.setUniform( route.uniform, value );

				if ( route.after ) {

					this._pathTracingStage?.[ route.after ]?.();

				}

			} else if ( route.handler ) {

				this._handlers[ route.handler ]?.( value, prev );

			} else if ( route.delegate ) {

				this._delegates[ route.delegate ]?.updateParam?.( route.param, value );

			}

			const routeReset = route.reset ?? true;
			if ( routeReset ) needsReset = true;

			if ( ! silent ) {

				this.dispatchEvent( { type: EngineEvents.SETTING_CHANGED, key, value, prev } );

			}

		}

		if ( needsReset ) {

			this._resetCallback?.();

		}

	}

	/**
	 * Reads the current value of a setting.
	 * @param {string} key
	 * @returns {*}
	 */
	get( key ) {

		return this._values.get( key );

	}

	/**
	 * Returns a plain-object snapshot of all settings.
	 * @returns {Object}
	 */
	getAll() {

		return Object.fromEntries( this._values );

	}

	/**
	 * Pushes all stored values to their target stages.
	 * Called after loadSceneData() to ensure GPU uniforms match stored values.
	 */
	applyAll() {

		for ( const [ key, value ] of this._values ) {

			const route = SETTING_ROUTES[ key ];
			if ( ! route ) continue;

			if ( route.uniform ) {

				this._pathTracingStage?.setUniform( route.uniform, value );

				if ( route.after ) {

					this._pathTracingStage?.[ route.after ]?.();

				}

			} else if ( route.handler ) {

				this._handlers[ route.handler ]?.( value, this._values.get( key ) );

			}

		}

	}

	// ── Private ───────────────────────────────────────────────────

	/**
	 * Populates the values map from ENGINE_DEFAULTS.
	 * Handles key renames via DEFAULTS_KEY_MAP.
	 */
	_initDefaults( defaults ) {

		// Keys that exist in both SETTING_ROUTES and ENGINE_DEFAULTS (direct match)
		for ( const key of Object.keys( SETTING_ROUTES ) ) {

			if ( key in defaults ) {

				this._values.set( key, defaults[ key ] );

			}

		}

		// Keys where ENGINE_DEFAULTS uses a different name
		for ( const [ defaultsKey, settingsKey ] of Object.entries( DEFAULTS_KEY_MAP ) ) {

			if ( defaultsKey in defaults ) {

				this._values.set( settingsKey, defaults[ defaultsKey ] );

			}

		}

	}

}
