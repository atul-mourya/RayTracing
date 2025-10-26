/**
 * Stages Module - Exports all refactored pipeline stages
 *
 * These are the new PipelineStage-based implementations that replace
 * the old Pass-based classes. They use the event-driven pipeline architecture
 * for loose coupling and better testability.
 *
 * Migration status:
 * - ✅ TileHighlightStage - Complete (267 lines)
 * - ✅ AdaptiveSamplingStage - Complete (917 lines)
 * - ✅ EdgeAwareFilteringStage - Complete (622 lines)
 * - ✅ ASVGFStage - Complete (1292 lines)
 * - ✅ PathTracerStage - Complete (1520 lines)
 */

export { TileHighlightStage } from './TileHighlightStage.js';
export { AdaptiveSamplingStage } from './AdaptiveSamplingStage.js';
export { EdgeAwareFilteringStage } from './EdgeAwareFilteringStage.js';
export { ASVGFStage } from './ASVGFStage.js';
export { PathTracerStage } from './PathTracerStage.js';
