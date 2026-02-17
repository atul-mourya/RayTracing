/**
 * IPathTracerApp — Backend-Agnostic Interface Contract
 *
 * Defines the common API surface that both PathTracerApp (WebGL) and
 * WebGPUPathTracerApp (WebGPU) must implement. The store layer and UI
 * components communicate exclusively through this interface.
 *
 * Methods that a backend does not support should be implemented as
 * graceful no-ops rather than omitted.
 *
 * @module IPathTracerApp
 */

/**
 * List of all required interface methods with their categories.
 * Used by validateInterface() for runtime checks.
 */
export const INTERFACE_METHODS = {

	// Lifecycle
	lifecycle: [
		'init',
		'reset',
		'pause',
		'resume',
		'dispose',
	],

	// Render Settings
	renderSettings: [
		'setMaxBounces',
		'setSamplesPerPixel',
		'setMaxSamples',
		'setTransmissiveBounces',
		'setEnvironmentIntensity',
		'setBackgroundIntensity',
		'setShowBackground',
		'setEnableEnvironment',
		'setGlobalIlluminationIntensity',
		'setExposure',
		'setVisMode',
		'setDebugVisScale',
		'setFireflyThreshold',
		'setSamplingTechnique',
	],

	// Camera & DOF
	cameraDOF: [
		'setEnableDOF',
		'setFocusDistance',
		'setFocalLength',
		'setAperture',
	],

	// Emissive
	emissive: [
		'setEnableEmissiveTriangleSampling',
		'setEmissiveBoost',
	],

	// Adaptive Sampling
	adaptiveSampling: [
		'setUseAdaptiveSampling',
		'setAdaptiveSamplingMax',
	],

	// Resolution
	resolution: [
		'updateResolution',
	],

	// Asset Loading
	assetLoading: [
		'loadModel',
		'loadEnvironment',
		'loadExampleModels',
	],

	// Events (Three.js EventDispatcher)
	events: [
		'addEventListener',
		'removeEventListener',
		'dispatchEvent',
	],

};

/**
 * List of required properties on any app instance.
 */
export const INTERFACE_PROPERTIES = [
	'camera',
	'scene',
	'controls',
	'canvas',
	'renderer',
	'isInitialized',
];

/**
 * Optional interface methods — no-op if missing.
 * These are features that not all backends support yet.
 */
export const OPTIONAL_METHODS = [
	'setAccumulationEnabled',
	'setTileCount',
	'setRenderLimitMode',
	'setEnvironmentRotation',
	'setInteractionModeEnabled',
	'setAdaptiveSamplingParameters',
	'selectObject',
	'refreshFrame',
	'toggleFocusMode',
	'toggleSelectMode',
	'disableSelectMode',
	'takeScreenshot',
	'switchCamera',
	'getCameraNames',
	'addLight',
	'removeLight',
	'clearLights',
	'getLights',
	'getFrameCount',
	'loadGLBFromArrayBuffer',
	'supportsFeature',
];

/**
 * Standard event types that backends should emit.
 */
export const STANDARD_EVENTS = {
	RENDER_COMPLETE: 'RenderComplete',
	RENDER_RESET: 'RenderReset',
	CAMERAS_UPDATED: 'CamerasUpdated',
	CAMERA_SWITCHED: 'CameraSwitched',
	MODEL_LOADED: 'ModelLoaded',
	ENVIRONMENT_LOADED: 'EnvironmentLoaded',
	ASSET_ERROR: 'AssetError',
	FOCUS_CHANGED: 'focusChanged',
	OBJECT_SELECTED: 'objectSelected',
	OBJECT_DESELECTED: 'objectDeselected',
};

/**
 * Validates that an app instance implements the required interface.
 * Logs warnings for missing methods/properties but does not throw.
 *
 * @param {Object} app - App instance to validate
 * @param {string} backendName - Name for logging (e.g., 'WebGL', 'WebGPU')
 * @returns {{ valid: boolean, missing: string[] }} Validation result
 */
export function validateInterface( app, backendName = 'Unknown' ) {

	const missing = [];

	// Check required methods
	for ( const category of Object.values( INTERFACE_METHODS ) ) {

		for ( const method of category ) {

			if ( typeof app[ method ] !== 'function' ) {

				missing.push( `method: ${method}` );

			}

		}

	}

	// Check required properties
	for ( const prop of INTERFACE_PROPERTIES ) {

		if ( app[ prop ] === undefined ) {

			missing.push( `property: ${prop}` );

		}

	}

	if ( missing.length > 0 ) {

		console.warn(
			`[IPathTracerApp] ${backendName} backend is missing ${missing.length} interface members:`,
			missing
		);

	}

	return { valid: missing.length === 0, missing };

}

/**
 * Creates a safe proxy that wraps an app instance.
 * Calls to missing optional methods become no-ops.
 * Useful for calling optional methods without checking existence.
 *
 * @param {Object} app - App instance to wrap
 * @returns {Proxy} Proxied app instance
 */
export function createSafeProxy( app ) {

	if ( ! app ) return null;

	return new Proxy( app, {
		get( target, prop ) {

			const value = target[ prop ];
			if ( value !== undefined ) return value;

			// If it's an optional method that's missing, return no-op
			if ( OPTIONAL_METHODS.includes( prop ) ) {

				return () => {

					// no-op

				};

			}

			return undefined;

		}
	} );

}
