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

// Pipeline infrastructure (for advanced consumers building custom stages)
export { PassPipeline } from './Pipeline/PassPipeline.js';
export { PipelineStage, StageExecutionMode } from './Pipeline/PipelineStage.js';
export { PipelineContext } from './Pipeline/PipelineContext.js';
