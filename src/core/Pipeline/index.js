/**
 * Pipeline Module - Exports all pipeline infrastructure classes
 *
 * Core Components:
 * - EventEmitter: Event bus for loose coupling between stages
 * - PipelineContext: Shared state and resource registry
 * - PipelineStage: Base class for all rendering stages
 * - PassPipeline: Orchestrates execution of stages
 */

export { EventEmitter } from './EventEmitter.js';
export { PipelineContext } from './PipelineContext.js';
export { PipelineStage } from './PipelineStage.js';
export { PassPipeline } from './PassPipeline.js';
