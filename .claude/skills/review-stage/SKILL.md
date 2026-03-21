---
name: review-stage
description: >
  Review a pipeline stage for correctness, performance, and architectural compliance.
  Use when creating a new PipelineStage, modifying an existing one, or debugging stage interactions.
  Pass the stage filename as an argument (e.g., /review-stage ASVGFStage).
allowed-tools: Read, Glob, Grep
---

You are reviewing a rendering pipeline stage in the Rayzee path tracer. The user will specify which stage to review (or you should ask).

## Stage Location
Stages live in `src/core/Stages/`. Find the file matching the user's input.

## Review Checklist

### 1. Base Class Compliance
- [ ] Extends `PipelineStage` from `src/core/Pipeline/PipelineStage.js`
- [ ] Implements required lifecycle methods: `setup()`, `render()`, `dispose()`
- [ ] Calls `super()` with appropriate config (name, enabled state)
- [ ] Has proper `dispose()` that cleans up all GPU resources (render targets, textures, materials)

### 2. Event Bus Usage
- [ ] Communicates with other stages ONLY via `this.eventBus.emit()` and `this.eventBus.on()`
- [ ] No direct imports of other stage classes
- [ ] Event listeners properly removed in `dispose()`
- [ ] Event names follow convention: `stagename:eventtype` (e.g., `pathtracer:frameComplete`)

### 3. Context Texture Management
- [ ] Inputs read via `context.getTexture('name')` — not passed directly
- [ ] Outputs published via `context.setTexture('name', texture)`
- [ ] Stale textures cleaned from context when stage is disabled
- [ ] Consider DisplayStage fallback chain priority impact

### 4. Camera & Uniform Synchronization
- [ ] If using camera matrices: syncs from PathTracingStage uniforms, NOT camera object
- [ ] Uniforms created once, only `.value` mutated (preserves shader graph references)

### 5. Rendering Mode Awareness
- [ ] Behaves correctly in Interactive mode (low quality, real-time)
- [ ] Behaves correctly in Final mode (high quality, tiled)
- [ ] Handles `reset()` properly (clears temporal state if applicable)

### 6. TSL Shader Quality (if stage has inline shaders)
- [ ] If/Else chains (not separate If blocks)
- [ ] NaN guards on normalize() calls
- [ ] outputNode used for technical passes (not colorNode)
- [ ] .toVar() on all mutable variables
- [ ] UV Y-flip handled for QuadMesh screen-space shaders

### 7. Performance
- [ ] Compute dispatch dimensions appropriate for the task
- [ ] No redundant full-resolution passes
- [ ] Shared memory (workgroupArray) used where beneficial
- [ ] Proper workgroupBarrier() placement

### 8. Memory & Lifecycle
- [ ] Render targets properly sized and resized on resolution change
- [ ] No memory leaks (all created resources tracked and disposed)
- [ ] Worker-based processing for heavy CPU tasks

## Output Format
Provide a structured review:
```
## Stage: [StageName]

### Summary
Brief description of what the stage does and overall quality assessment.

### Issues Found
1. [CRITICAL/WARNING/SUGGESTION] Description — file:line

### Positive Patterns
- Things done well worth preserving

### Recommendations
- Ordered by priority
```
