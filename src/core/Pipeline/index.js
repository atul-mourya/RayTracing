/**
 * Pipeline Module - Exports all pipeline infrastructure classes
 *
 * This module provides a clean, event-driven pipeline architecture for
 * managing rendering passes in the Rayzee path tracer.
 *
 * Core Components:
 * - EventEmitter: Event bus for loose coupling between stages
 * - PipelineContext: Shared state and resource registry
 * - PipelineStage: Base class for all rendering stages
 * - PassPipeline: Orchestrates execution of stages
 * - PipelineWrapperPass: Integrates with Three.js EffectComposer
 *
 * @example
 * import {
 *   PassPipeline,
 *   PipelineWrapperPass,
 *   PipelineStage
 * } from './core/Pipeline/index.js';
 *
 * // Create a custom stage
 * class MyStage extends PipelineStage {
 *   constructor() {
 *     super('MyStage');
 *   }
 *
 *   render(context, writeBuffer) {
 *     // Your rendering logic here
 *   }
 * }
 *
 * // Build the pipeline
 * const pipeline = new PassPipeline(renderer, width, height);
 * pipeline.addStage(new MyStage());
 *
 * // Integrate with EffectComposer
 * const pipelinePass = new PipelineWrapperPass(pipeline);
 * composer.addPass(pipelinePass);
 */

export { EventEmitter } from './EventEmitter.js';
export { PipelineContext } from './PipelineContext.js';
export { PipelineStage } from './PipelineStage.js';
export { PassPipeline } from './PassPipeline.js';
export { PipelineWrapperPass } from './PipelineWrapperPass.js';
