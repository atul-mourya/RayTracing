/**
 * Rayzee Rendering Engine — Public API
 *
 * Framework-agnostic WebGPU path tracing engine.
 * Subscribe to EngineEvents via addEventListener() to integrate with any UI framework.
 */

// Main application
export { PathTracerApp } from './PathTracerApp.js';

// Event types
export { EngineEvents } from './EngineEvents.js';

// Configuration defaults and presets
export {
	ENGINE_DEFAULTS,
	ASVGF_QUALITY_PRESETS,
	CAMERA_PRESETS,
	CAMERA_RANGES,
	SKY_PRESETS,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TRIANGLE_DATA_LAYOUT,
	TEXTURE_CONSTANTS,
	DEFAULT_TEXTURE_MATRIX,
	MEMORY_CONSTANTS,
	FINAL_RENDER_CONFIG,
	PREVIEW_RENDER_CONFIG,
} from './EngineDefaults.js';

// Settings & managers (for advanced consumers)
export { RenderSettings } from './RenderSettings.js';
export { CameraManager } from './managers/CameraManager.js';
export { LightManager } from './managers/LightManager.js';
export { DenoisingManager } from './managers/DenoisingManager.js';
export { OverlayManager } from './managers/OverlayManager.js';

// Pipeline infrastructure (for advanced consumers building custom stages)
export { RenderPipeline } from './Pipeline/RenderPipeline.js';
export { RenderStage, StageExecutionMode } from './Pipeline/RenderStage.js';
export { PipelineContext } from './Pipeline/PipelineContext.js';
