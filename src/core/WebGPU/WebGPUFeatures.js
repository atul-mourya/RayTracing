/**
 * WebGPU Feature Registry
 *
 * Tracks which features are currently implemented in the WebGPU backend.
 * As features are completed, flip the corresponding flag to `true` and
 * the UI will automatically enable the corresponding controls.
 *
 * Consumed by:
 * - WebGPUPathTracerApp._supportedFeatures (initializes from this)
 * - BackendManager.supportsFeature() (delegates to active app)
 * - useBackendFeature() hook (reads from store backend state)
 * - UI components (conditional rendering with {isWebGL && ...})
 */

/**
 * Feature categories and their implementation status.
 */
export const WebGPUFeatures = {

	// ─── Core Rendering (IMPLEMENTED) ───
	pathTracing: true,
	progressiveAccumulation: true,
	dof: true,
	environmentLighting: true,
	materialsBasic: true,
	resolution: true,
	accumulation: true,
	rendering: true,
	samplingTechnique: true,
	fireflyThreshold: true,
	emissiveTriangleSampling: true,
	transmissiveBounces: true,

	// ─── Partially Implemented ───
	adaptiveSampling: false,

	// ─── Not Yet Implemented ───
	asvgf: false,
	edgeAwareFiltering: false,
	oidnDenoiser: false,
	bloom: false,
	autoExposure: false,
	tileRendering: false,
	interactionMode: false,
	objectSelection: false,
	focusPicking: false,
	lights: false,
	assetLoading: false, // delegated to WebGL pipeline currently
	materialEditing: false,
	cameraPresets: false,
	screenshot: false,
	renderLimitMode: false,
	environmentRotation: false,

};

/**
 * Feature descriptions for UI tooltips.
 */
export const WebGPUFeatureDescriptions = {

	asvgf: 'ASVGF denoiser — planned for WebGPU',
	edgeAwareFiltering: 'Edge-aware temporal filtering — planned for WebGPU',
	oidnDenoiser: 'Intel Open Image Denoise — requires WebGL backend',
	bloom: 'Bloom post-processing — planned for WebGPU',
	autoExposure: 'Auto exposure — planned for WebGPU',
	tileRendering: 'Tiled progressive rendering — planned for WebGPU',
	interactionMode: 'Interactive quality mode — planned for WebGPU',
	objectSelection: 'Object selection/outlining — planned for WebGPU',
	focusPicking: 'Click-to-focus in scene — planned for WebGPU',
	lights: 'Dynamic light management — planned for WebGPU',
	assetLoading: 'Direct asset loading — currently uses WebGL pipeline',
	materialEditing: 'Real-time material editing — planned for WebGPU',
	cameraPresets: 'DOF camera presets — planned for WebGPU',
	screenshot: 'Screenshot export — planned for WebGPU',
	renderLimitMode: 'Render limit modes — planned for WebGPU',
	environmentRotation: 'HDRI environment rotation — planned for WebGPU',

};

/**
 * Returns a description for a feature, or null if no description.
 * @param {string} featureName
 * @returns {string|null}
 */
export function getFeatureDescription( featureName ) {

	return WebGPUFeatureDescriptions[ featureName ] || null;

}

/**
 * Returns all features grouped by status.
 * @returns {{ implemented: string[], partial: string[], planned: string[] }}
 */
export function getFeatureSummary() {

	const implemented = [];
	const planned = [];

	for ( const [ key, value ] of Object.entries( WebGPUFeatures ) ) {

		if ( value ) {

			implemented.push( key );

		} else {

			planned.push( key );

		}

	}

	return { implemented, planned };

}
