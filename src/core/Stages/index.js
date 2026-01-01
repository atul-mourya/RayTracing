/**
 * Stages Module - Exports all refactored pipeline stages
 *
 * These are the new PipelineStage-based implementations that replace
 * the old Pass-based classes. They use the event-driven pipeline architecture
 * for loose coupling and better testability.
 *
 * Stage categories:
 *
 * Core Rendering:
 * - PathTracerStage - Monte Carlo path tracing with MRT outputs
 *
 * Motion & Temporal:
 * - MotionVectorStage - Screen/world-space motion vector computation
 *
 * Denoising:
 * - ASVGFStage - Adaptive spatiotemporal variance-guided filtering (temporal + spatial)
 * - BilateralFilteringStage - Standalone A-trous wavelet bilateral filtering (spatial only)
 * - EdgeAwareFilteringStage - Temporal edge-aware filtering
 *
 * Analysis & Quality:
 * - VarianceEstimationStage - Temporal/spatial variance for adaptive sampling & firefly detection
 * - AdaptiveSamplingStage - Variance-guided sample distribution
 *
 * Exposure & Tone Mapping:
 * - AutoExposureStage - GPU-based automatic exposure with temporal adaptation
 *
 * Debug & Visualization:
 * - TileHighlightStage - Visual feedback for progressive tile rendering
 */

export { TileHighlightStage } from './TileHighlightStage.js';
export { AdaptiveSamplingStage } from './AdaptiveSamplingStage.js';
export { EdgeAwareFilteringStage } from './EdgeAwareFilteringStage.js';
export { ASVGFStage } from './ASVGFStage.js';
export { PathTracerStage } from './PathTracerStage.js';
export { MotionVectorStage } from './MotionVectorStage.js';
export { BilateralFilteringStage } from './BilateralFilteringStage.js';
export { VarianceEstimationStage } from './VarianceEstimationStage.js';
export { AutoExposureStage } from './AutoExposureStage.js';
