/**
 * Engine event type constants.
 * The rendering engine dispatches these events via THREE.EventDispatcher.
 * UI adapters subscribe to these events to bridge engine state to their framework.
 */
export const EngineEvents = {
	// Render lifecycle
	RENDER_COMPLETE: 'engine:renderComplete',
	RENDER_RESET: 'engine:renderReset',

	// Denoiser
	DENOISING_START: 'engine:denoisingStart',
	DENOISING_END: 'engine:denoisingEnd',

	// Upscaler
	UPSCALING_START: 'engine:upscalingStart',
	UPSCALING_PROGRESS: 'engine:upscalingProgress',
	UPSCALING_END: 'engine:upscalingEnd',

	// Loading & stats
	LOADING_UPDATE: 'engine:loadingUpdate',
	LOADING_RESET: 'engine:loadingReset',
	STATS_UPDATE: 'engine:statsUpdate',

	// Selection & interaction
	OBJECT_SELECTED: 'engine:objectSelected',
	OBJECT_DESELECTED: 'engine:objectDeselected',
	OBJECT_DOUBLE_CLICKED: 'engine:objectDoubleClicked',
	SELECT_MODE_CHANGED: 'engine:selectModeChanged',

	// Camera
	AUTO_FOCUS_UPDATED: 'engine:autoFocusUpdated',
	AUTO_EXPOSURE_UPDATED: 'engine:autoExposureUpdated',
	AF_POINT_PLACED: 'engine:afPointPlaced',
};
