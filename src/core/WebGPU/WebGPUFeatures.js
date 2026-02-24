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

	// ─── Utility & Integration (IMPLEMENTED) ───
	interactionMode: true,
	focusPicking: true,
	cameraPresets: true,
	screenshot: true,
	renderLimitMode: true,
	environmentRotation: true,
	assetLoading: true, // delegated to WebGL pipeline via DataTransfer

	// ─── Pipeline Stages (IMPLEMENTED) ───
	adaptiveSampling: true,

	// ─── Pipeline Stages (IMPLEMENTED — Denoising & Post-Processing) ───
	asvgf: true,
	edgeAwareFiltering: true,
	autoExposure: true,
	tileRendering: true,

	// ─── Not Yet Implemented ───
	oidnDenoiser: false,
	bloom: false,
	objectSelection: false,
	lights: false,
	materialEditing: false,

};

/**
 * Feature descriptions for UI tooltips.
 */
export const WebGPUFeatureDescriptions = {

	asvgf: 'ASVGF spatiotemporal denoiser with motion-compensated accumulation',
	edgeAwareFiltering: 'Edge-aware temporal filtering with progressive sharpening',
	oidnDenoiser: 'Intel Open Image Denoise — requires WebGL backend',
	bloom: 'Bloom post-processing — planned for WebGPU',
	autoExposure: 'GPU auto-exposure with hierarchical luminance reduction',
	tileRendering: 'Tiled progressive rendering with tile highlight overlay',
	interactionMode: 'Interactive quality mode — reduces quality during camera movement',
	objectSelection: 'Object selection/outlining — planned for WebGPU',
	focusPicking: 'Click-to-focus in scene for depth of field',
	lights: 'Dynamic light management — planned for WebGPU',
	materialEditing: 'Real-time material editing — planned for WebGPU',

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
