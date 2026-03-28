# Pipeline Architecture

**Rayzee Path Tracing Engine - Event-Driven Rendering Pipeline**

---

## Overview

Rayzee uses an **event-driven pipeline** of modular rendering stages built on WebGPU. TSL (Three Shading Language) shaders are compiled to WGSL at runtime. The `PathTracerApp` manages the renderer, scene, camera, and pipeline lifecycle, while the UI/store layer accesses it via `getApp()` from appProxy.

### System Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              UI / React                  │
                    │  (Zustand Store + appProxy.getApp())    │
                    └─────────────────┬───────────────────────┘
                                      │
                              ┌───────┴───────┐
                              │  appProxy     │
                              │  getApp()     │
                              │  subscribeApp()│
                              └───────┬───────┘
                                      │
                              ┌───────┴───────────────┐
                              │    PathTracerApp      │
                              │    (WebGPU Renderer)  │
                              ├───────────────────────┤
                              │ PassPipeline          │
                              │ ├─PathTracingStage    │
                              │ │ ├─UniformManager    │
                              │ │ ├─MaterialDataMgr   │
                              │ │ ├─EnvironmentMgr    │
                              │ │ ├─ShaderComposer    │
                              │ │ └─RenderTargetPool  │
                              │ ├─NormalDepthStage    │
                              │ ├─MotionVectorStage   │
                              │ ├─ASVGFStage          │
                              │ ├─VarianceEstimation  │
                              │ ├─BilateralFiltering  │
                              │ ├─AdaptiveSampling    │
                              │ ├─EdgeAwareFiltering  │
                              │ ├─AutoExposureStage   │
                              │ ├─TileHighlightStage  │
                              │ └─DisplayStage        │
                              │ InteractionManager    │
                              │ OIDNDenoiser          │
                              └───────────────────────┘
```

### App Proxy (`rayzee/src/appProxy.js`)

All UI/store code accesses the app via `getApp()`:

```javascript
import { getApp, subscribeApp } from '@/core/appProxy';

const app = getApp();  // Returns app instance or null
if (app) app.setMaxBounces(8);

// Subscribe to app initialization/changes
const unsub = subscribeApp((app) => {
    if (app) console.log('App ready');
});
```

---

## Architecture Benefits

### Solved Problems

**Before (Legacy Pass Architecture):**
- Tight coupling between passes
- Implicit execution order
- Difficult to test in isolation
- Hard to add new features
- Manual texture passing between passes

**After (Pipeline Architecture):**
- ✅ Loose coupling via events
- ✅ Explicit execution order (stages added sequentially)
- ✅ Easy to test (mock context/events)
- ✅ Simple to extend (just add new stage)
- ✅ Automatic texture sharing via context

### Design Principles

1. **Single Responsibility** - Each stage does one thing well
2. **Dependency Inversion** - Stages depend on context/events, not each other
3. **Event-Driven** - Communication through pub/sub pattern
4. **Explicit Over Implicit** - Clear execution order, no hidden dependencies

---

## Core Components

### 1. PipelineContext

Shared state container for all stages.

**Purpose:**
- Store textures (for sharing between stages)
- Store state (frame counters, settings, etc.)
- Manage frame lifecycle

**Key Methods:**
```javascript
// Textures
context.setTexture('pathtracer:color', texture);
context.getTexture('pathtracer:color');

// State
context.setState('frame', 0);
context.getState('frame');

// Lifecycle
context.incrementFrame();
context.reset();
```

**Important State Keys:**
| Key | Type | Description |
|-----|------|-------------|
| `frame` | number | Current frame counter |
| `renderMode` | number | 0=progressive, 1=tiled |
| `tileRenderingComplete` | boolean | True when tile cycle completes (used by PER_CYCLE stages) |
| `interactionMode` | boolean | True during camera movement |
| `width` / `height` | number | Viewport dimensions |

**Example:**
```javascript
// PathTracerStage publishes its output
context.setTexture('pathtracer:color', this.colorTarget.texture);
context.setTexture('pathtracer:normalDepth', this.normalDepthTarget.texture);

// ASVGFStage reads PathTracer output
const colorTexture = context.getTexture('pathtracer:color');
const normalDepth = context.getTexture('pathtracer:normalDepth');
```

---

### 2. EventBus

Event-driven communication between stages.

**Purpose:**
- Decouple stages
- Enable reactive updates
- Support async workflows

**Key Events:**
```javascript
'tile:changed'           // Current tile changed (tiled rendering)
'camera:moved'           // Camera transformation changed
'interaction:started'    // User started interacting
'interaction:ended'      // User stopped interacting
'asvgf:reset'           // Reset ASVGF history
'frame:complete'         // Frame finished rendering
'pipeline:reset'         // Pipeline reset
'pipeline:resize'        // Viewport resized
```

**Example:**
```javascript
// PathTracerStage emits tile change
this.emit('tile:changed', {
    tileIndex: 0,
    tileBounds: { x, y, width, height },
    renderMode: 1
});

// TileHighlightStage listens
this.on('tile:changed', (data) => {
    this.setCurrentTileBounds(data.tileBounds);
    this.uniforms.tileIndex.value = data.tileIndex;
});
```

---

### 3. PassPipeline

Orchestrates stage execution.

**Purpose:**
- Manage stage lifecycle
- Execute stages in order
- Handle errors gracefully
- Track performance

**Usage:**
```javascript
const pipeline = new PassPipeline(renderer, width, height);

// Add stages in execution order
pipeline.addStage(pathTracerStage);
pipeline.addStage(asvgfStage);
pipeline.addStage(adaptiveSamplingStage);
pipeline.addStage(edgeFilteringStage);
pipeline.addStage(tileHighlightStage);

// Render all enabled stages
pipeline.render(writeBuffer);

// Lifecycle
pipeline.reset();
pipeline.setSize(width, height);
pipeline.dispose();
```

---

### 4. PipelineStage (Base Class)

Base class for all stages.

#### Execution Modes

Stages can declare when they should execute during tile rendering via `executionMode`:

```javascript
export const StageExecutionMode = {
    // Execute every frame regardless of tile state
    ALWAYS: 'always',

    // Execute only when tile rendering cycle completes
    // (Progressive mode: every frame, Tile mode: only when all tiles rendered)
    PER_CYCLE: 'per_cycle',

    // Execute for each tile including intermediates
    PER_TILE: 'per_tile',

    // Custom execution logic via shouldExecute() override
    CONDITIONAL: 'conditional'
};
```

**Usage by Stage Type:**

| Mode | Use Case | Example Stages |
|------|----------|---------------|
| `ALWAYS` | Accumulator stages, real-time feedback | PathTracerStage, TileHighlightStage |
| `PER_CYCLE` | Post-processing, denoisers, filters | ASVGFStage, EdgeAwareFilteringStage, AdaptiveSamplingStage |
| `PER_TILE` | Per-tile analysis (future use) | - |
| `CONDITIONAL` | Complex custom logic | - |

**Rationale:**

During tile rendering, intermediate tiles contain incomplete frame data. Post-processing stages (denoisers, filters) should only operate on complete frames to:
- Prevent artifacts from partial data
- Improve performance by skipping redundant operations
- Maintain temporal consistency

**Example:**
```javascript
export class MyDenoiserStage extends PipelineStage {
    constructor(options = {}) {
        super('MyDenoiser', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE
        });
    }

    render(context, writeBuffer) {
        // This automatically skips during intermediate tile rendering
        // Only runs when: (renderMode === 0) || (all tiles complete)
    }
}
```

**Key Methods to Override:**
```javascript
class MyStage extends PipelineStage {

    // Required: Render this stage
    render(context, writeBuffer) {
        // Read from context
        const input = context.getTexture('previous:output');

        // Render
        renderer.setRenderTarget(this.outputTarget);
        this.quad.render(renderer);

        // Write to context
        context.setTexture('mystage:output', this.outputTarget.texture);
    }

    // Optional: Setup event listeners
    setupEventListeners() {
        this.on('tile:changed', (data) => { ... });
    }

    // Optional: Reset state
    reset() {
        this.frameCount = 0;
    }

    // Optional: Resize render targets
    setSize(width, height) {
        this.outputTarget.setSize(width, height);
    }

    // Optional: Cleanup
    dispose() {
        this.outputTarget.dispose();
        this.material.dispose();
    }
}
```

**Utility Methods:**
```javascript
// Events
this.emit('event:name', data);
this.on('event:name', callback);
this.off('event:name', callback);

// Logging
this.log('message');
this.warn('warning');
this.error('error');

// Enable/Disable
this.enable();
this.disable();
```

---

## Stage Descriptions

### PathTracerStage

**Purpose:** Core ray tracing renderer
**Execution Mode:** `ALWAYS` - Must accumulate samples every frame

**Input:** Scene geometry, materials, camera
**Output:**
- `pathtracer:color` - Accumulated color
- `pathtracer:normalDepth` - G-buffer (normals + depth)

**Key Features:**
- Progressive accumulation
- Tiled rendering support
- BVH acceleration
- Material sampling (PBR, emissive, etc.)
- Multiple Render Targets (MRT)

**Events Emitted:**
- `tile:changed` - When current tile changes

#### Composition Architecture

PathTracingStage (~1500 lines) delegates data management to 5 focused sub-managers via composition:

```
PathTracingStage
  ├── uniforms: UniformManager          (~260 lines)
  ├── materialData: MaterialDataManager  (~530 lines)
  ├── environment: EnvironmentManager    (~470 lines)
  ├── shaderComposer: ShaderComposer     (~400 lines)
  └── renderTargets: RenderTargetPool    (~100 lines)
```

PathTracingStage keeps: constructor, `render()`, `reset()`, `build()`, event emission, camera updates, ASVGF coordination, tile orchestration, and disposal. Everything else is delegated.

**Sub-Manager Access Pattern:**

External code (other stages, PathTracerApp) accesses sub-managers directly:

```javascript
// UniformManager — get/set TSL uniform nodes
const maxBounces = stage.uniforms.get('maxBounces');      // returns TSL uniform node
stage.uniforms.set('maxBounces', 12);                     // sets node.value

// Dynamic getters on PathTracingStage (shorthand for uniforms)
stage.maxBounces;                // equivalent to stage.uniforms.get('maxBounces')
stage.cameraWorldMatrix;         // equivalent to stage.uniforms.get('cameraWorldMatrix')

// MaterialDataManager
stage.materialData.materialStorageAttr;   // StorageInstancedBufferAttribute
stage.materialData.materialStorageNode;   // storage().toReadOnly() node
stage.materialData.albedoMaps;            // DataArrayTexture
stage.materialData.updateMaterialProperty(index, property, value);

// EnvironmentManager
stage.environment.environmentTexture;     // current env texture
stage.environment.envParams;              // { type, color, ... }
await stage.environment.setEnvironmentMap(envMap);
await stage.environment.generateProceduralSkyTexture();

// ShaderComposer
stage.shaderComposer.setupMaterial({ stage, renderTargets });
stage.shaderComposer.updateSceneTextures(stage);  // in-place texture node update
stage.shaderComposer.accumQuad;           // QuadMesh for path trace render
stage.shaderComposer.displayQuad;         // QuadMesh for display render

// RenderTargetPool
stage.renderTargets.swap();
stage.renderTargets.getCurrentAccumulation();  // returns current RenderTarget
stage.renderTargets.ensureSize(width, height);
```

**Callback Pattern:**

Sub-managers use callbacks to communicate back without circular dependencies:

```javascript
// In PathTracingStage constructor:
this.materialData.callbacks.onReset = () => this.reset();
this.environment.callbacks.onReset = () => this.reset();
this.environment.callbacks.getSceneTextureNodes = () =>
    this.shaderComposer.getSceneTextureNodes();
```

**Key Design Constraint:** TSL uniform nodes and texture nodes are created once and never replaced — only `.value` is mutated. This preserves compiled shader graph references. All sub-managers follow this pattern.

---

### ASVGFStage

**Purpose:** Adaptive Spatially-Varying Global Filtering (denoiser)
**Execution Mode:** `PER_CYCLE` - Only denoises complete frames

**Input:**
- `pathtracer:color`
- `pathtracer:normalDepth`

**Output:**
- `asvgf:output` - Denoised color
- `asvgf:variance` - Variance map
- `asvgf:temporalColor` - Temporal accumulation

**Key Features:**
- Motion vector calculation
- Temporal accumulation
- Variance estimation
- A-trous wavelet filtering
- Edge-aware filtering

**Events Listened:**
- `asvgf:reset` - Reset temporal history

**Rationale:** Denoising intermediate tiles causes artifacts. ASVGF skips until all tiles are rendered.

---

### AdaptiveSamplingStage

**Purpose:** Variance-based adaptive sampling
**Execution Mode:** `PER_CYCLE` - Only analyzes complete frames

**Input:**
- `asvgf:variance` or compute from color
- `pathtracer:normalDepth`

**Output:**
- `adaptiveSampling:output` - Sample mask
- `adaptiveSampling:heatmap` - Visualization

**Key Features:**
- Variance threshold detection
- Convergence tracking
- Heatmap visualization
- Per-pixel sample allocation

**Events Listened:**
- `tile:changed` - Update for current tile

**Rationale:** Variance analysis requires complete frame data for accurate guidance.

---

### EdgeAwareFilteringStage

**Purpose:** Temporal edge-aware filtering (alternative to ASVGF)
**Execution Mode:** `PER_CYCLE` - Only filters complete frames

**Input:**
- `pathtracer:color`
- `pathtracer:normalDepth`

**Output:**
- `edgeFiltering:output` - Filtered color

**Key Features:**
- Edge detection
- Temporal accumulation
- Pixel sharpness control
- Iteration-based filtering

**Note:** Typically disabled when ASVGF is enabled

**Rationale:** Temporal filtering needs complete frames to maintain consistency.

---

### TileHighlightStage

**Purpose:** Visualize tile boundaries during tiled rendering
**Execution Mode:** `ALWAYS` - Provides real-time visual feedback

**Input:**
- `edgeFiltering:output` OR
- `asvgf:output` OR
- `pathtracer:color` (priority order)

**Output:** Final composited image with tile borders

**Key Features:**
- Red border visualization
- Only active in tiled rendering mode
- Configurable border width
- Coordinate space transformation

**Events Listened:**
- `tile:changed` - Update tile bounds

**Rationale:** Must run every frame to show which tile is currently being rendered.

---

## Execution Flow

### Progressive Rendering (renderMode=0)

All stages execute every frame:

```
1. PathTracerStage.render() [ALWAYS]
   ↓ writes 'pathtracer:color', 'pathtracer:normalDepth' to context
   ↓ sets 'tileRenderingComplete' = true

2. ASVGFStage.render() [PER_CYCLE] ✅ Executes
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'asvgf:output', 'asvgf:variance' to context

3. AdaptiveSamplingStage.render() [PER_CYCLE] ✅ Executes
   ↓ reads 'asvgf:variance' or 'pathtracer:color'
   ↓ writes 'adaptiveSampling:output' to context

4. EdgeAwareFilteringStage.render() [PER_CYCLE] ✅ Executes
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'edgeFiltering:output' to context

5. TileHighlightStage.render() [ALWAYS] ✅ Executes
   ↓ reads last filter output
   ↓ writes to writeBuffer → EffectComposer → Screen
```

### Tile Rendering - Intermediate Tile (renderMode=1, tiles 1-15 of 16)

Post-processing stages skip intermediate tiles:

```
1. PathTracerStage.render() [ALWAYS] ✅ Executes
   ↓ renders tile 5 (for example)
   ↓ writes 'pathtracer:color', 'pathtracer:normalDepth' to context
   ↓ sets 'tileRenderingComplete' = false

2. ASVGFStage.render() [PER_CYCLE] ⏭️ SKIPPED
   (Would denoise incomplete frame - causes artifacts)

3. AdaptiveSamplingStage.render() [PER_CYCLE] ⏭️ SKIPPED
   (Variance analysis needs complete frame data)

4. EdgeAwareFilteringStage.render() [PER_CYCLE] ⏭️ SKIPPED
   (Temporal filtering needs complete frame data)

5. TileHighlightStage.render() [ALWAYS] ✅ Executes
   ↓ draws border around current tile
   ↓ writes to writeBuffer → EffectComposer → Screen
```

### Tile Rendering - Cycle Complete (renderMode=1, tile 16 of 16)

All stages execute when cycle completes:

```
1. PathTracerStage.render() [ALWAYS] ✅ Executes
   ↓ renders final tile (16)
   ↓ writes 'pathtracer:color', 'pathtracer:normalDepth' to context
   ↓ sets 'tileRenderingComplete' = true

2. ASVGFStage.render() [PER_CYCLE] ✅ Executes
   ↓ denoises complete frame
   ↓ writes 'asvgf:output', 'asvgf:variance' to context

3. AdaptiveSamplingStage.render() [PER_CYCLE] ✅ Executes
   ↓ analyzes variance on complete frame
   ↓ writes 'adaptiveSampling:output' to context

4. EdgeAwareFilteringStage.render() [PER_CYCLE] ✅ Executes
   ↓ filters complete frame
   ↓ writes 'edgeFiltering:output' to context

5. TileHighlightStage.render() [ALWAYS] ✅ Executes
   ↓ draws final composited result
   ↓ writes to writeBuffer → EffectComposer → Screen
```

**Performance Impact:**
- Progressive mode: All stages every frame (standard overhead)
- Tile mode intermediate: Only PathTracer + TileHighlight (reduced overhead)
- Tile mode complete: All stages (standard overhead, but less frequent)

### Pipeline Integration

```
PassPipeline.render(writeBuffer)
    ↓ executes stages sequentially
[PathTracer → NormalDepth → MotionVector → ASVGF → Variance → Bilateral → AdaptiveSampling → EdgeFiltering → AutoExposure → TileHighlight → Display]
    ↓
DisplayStage → Screen (with exposure + outline compositing)
```

---

## Texture Flow

### Context Texture Registry

| Texture Key | Producer | Consumers | Description |
|-------------|----------|-----------|-------------|
| `pathtracer:color` | PathTracerStage | ASVGF, EdgeFiltering, TileHighlight | Accumulated path traced color |
| `pathtracer:normalDepth` | PathTracerStage | ASVGF, EdgeFiltering, AdaptiveSampling | G-buffer: normals + depth |
| `asvgf:output` | ASVGFStage | TileHighlight | Denoised color |
| `asvgf:variance` | ASVGFStage | AdaptiveSampling | Variance map |
| `asvgf:temporalColor` | ASVGFStage | - | Temporal accumulation |
| `edgeFiltering:output` | EdgeAwareFilteringStage | TileHighlight | Filtered color |
| `adaptiveSampling:output` | AdaptiveSamplingStage | - | Sample mask |
| `adaptiveSampling:heatmap` | AdaptiveSamplingStage | - | Heatmap visualization |

---

## Adding a New Stage

### Step 1: Create Stage Class

**Choose the Right Execution Mode:**
- **ALWAYS** - If your stage accumulates data or provides real-time feedback
- **PER_CYCLE** - If your stage does post-processing/filtering (most common for new stages)
- **PER_TILE** - If you need per-tile analysis (rare)
- **CONDITIONAL** - If you have complex custom logic

```javascript
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { uv, uniform } from 'three/tsl';

export class MyCustomStage extends PipelineStage {

    constructor(renderer, options = {}) {
        super('MyCustom', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE // Choose appropriate mode
        });

        this.renderer = renderer;

        // Create render target
        this.outputTarget = new RenderTarget(
            options.width,
            options.height
        );

        // TSL uniform
        this.intensity = uniform(1.0);

        // Updatable texture node
        this._inputTexNode = new TextureNode();

        // Build TSL shader — sample input and apply intensity
        const shader = this._inputTexNode.sample(uv()).mul(this.intensity);

        this.material = new MeshBasicNodeMaterial();
        this.material.outputNode = shader;

        this.quad = new QuadMesh(this.material);
    }

    setupEventListeners() {
        this.on('mycustom:update', (data) => {
            this.material.uniforms.intensity.value = data.intensity;
        });
    }

    render(context, writeBuffer) {
        if (!this.enabled) return;

        // Read input from context
        const inputTexture = context.getTexture('pathtracer:color');
        if (!inputTexture) return;

        // Swap texture node value (no shader recompile)
        this._inputTexNode.value = inputTexture;

        // Render to output target
        this.renderer.setRenderTarget(this.outputTarget);
        this.quad.render(this.renderer);

        // Publish to context
        context.setTexture('mycustom:output', this.outputTarget.texture);
    }

    setSize(width, height) {
        this.outputTarget.setSize(width, height);
    }

    dispose() {
        this.outputTarget.dispose();
        this.material.dispose();
    }
}
```

### Step 2: Add to Pipeline

```javascript
// In PathTracerApp.js setupPipeline()
import { MyCustomStage } from './Stages/MyCustomStage.js';

const myStage = new MyCustomStage(this.renderer, {
    width: this.width,
    height: this.height,
    enabled: true
});

// Add in desired execution order
this.pipeline.addStage(pathTracerStage);
this.pipeline.addStage(asvgfStage);
this.pipeline.addStage(myStage);  // ← Add here
this.pipeline.addStage(tileHighlightStage);
this.pipeline.addStage(displayStage);
```

### Step 3: Add Store Handler (Optional)

```javascript
// In app/src/store.js - uses getApp() from appProxy
handleMyCustomIntensity: handleChange(
    val => set({ myCustomIntensity: val }),
    val => getApp().myStage.intensity.value = val
),
```

---

## Best Practices

### Do's ✅

- **Use context for texture sharing** - Don't pass textures directly between stages
- **Emit events for state changes** - Let other stages react
- **Check enabled state** - Early return if disabled
- **Choose correct execution mode** - PER_CYCLE for post-processing, ALWAYS for accumulators
- **Dispose resources** - Clean up in dispose()
- **Use meaningful texture keys** - Format: `stageName:textureName`
- **Document events** - What data is emitted
- **Handle missing inputs gracefully** - Check if textures exist
- **Test in tile mode** - Ensure your stage works correctly with tiled rendering
- **Use `getApp()` from appProxy** - Never store direct app references in components

### Don'ts ❌

- **Don't access other stages directly** - Use context/events
- **Don't assume execution order** - Stages should work independently
- **Don't leak render targets** - Always dispose
- **Don't allocate in render loop** - Pre-allocate in constructor
- **Don't modify shared state without events** - Others won't know
- **Don't forget to check this.enabled** - Wasted GPU cycles

---

## Performance Considerations

### Optimization Tips

1. **Conditional Execution**
   ```javascript
   render(context, writeBuffer) {
       if (!this.enabled) return;  // Early exit
       // ... expensive work
   }
   ```

2. **Lazy Initialization**
   ```javascript
   if (!this.copyMaterial) {
       this.copyMaterial = new ShaderMaterial({...});
   }
   ```

3. **Render Target Reuse**
   ```javascript
   // Ping-pong between two targets
   [this.targetA, this.targetB] = [this.targetB, this.targetA];
   ```

4. **Event Debouncing**
   ```javascript
   this.on('expensive:event', debounce(() => {
       // ... expensive operation
   }, 100));
   ```

### Performance Monitoring

```javascript
pipeline.setStatsEnabled(true);
pipeline.logStats();  // Shows per-stage timing
```

---

## Debugging

### Enable Debug Logging

```javascript
// In stage constructor
this.debug = true;

// In render method
if (this.debug) {
    console.log('[MyStage] Rendering with:', {
        enabled: this.enabled,
        inputTexture: !!inputTexture,
        frame: context.getState('frame')
    });
}
```

### Check Pipeline State

```javascript
// In browser console
getApp().pipeline.getInfo();
// Returns: stage names, enabled states, execution order

getApp().pipeline.context.textures;
// Shows all registered textures

getApp().pipeline.eventBus.listenerCount('tile:changed');
// Check event listeners
```

### Debug Tile Rendering Execution

```javascript
// Enable logging of skipped stages during tile rendering
getApp().pipeline.stats.enabled = true;
getApp().pipeline.stats.logSkipped = true;

// Console will show:
// [Pipeline] Skipped stage 'ASVGF' (executionMode: per_cycle)
// [Pipeline] Skipped stage 'AdaptiveSampling' (executionMode: per_cycle)

// Check tile completion state
getApp().pipeline.context.getState('tileRenderingComplete');
// Returns: true (cycle complete) or false (intermediate tile)
```

---

## Common Patterns

### Reading from Previous Stage

```javascript
render(context, writeBuffer) {
    // Try multiple sources (priority order)
    let input = context.getTexture('asvgf:output');
    if (!input) input = context.getTexture('pathtracer:color');
    if (!input) {
        this.warn('No input texture');
        return;
    }
    // ... use input
}
```

### Copying to writeBuffer

```javascript
render(context, writeBuffer) {
    // Render to own target
    renderer.setRenderTarget(this.outputTarget);
    this.quad.render(renderer);

    // Publish to context
    context.setTexture('mystage:output', this.outputTarget.texture);

    // Copy to writeBuffer
    if (writeBuffer && !this.renderToScreen) {
        this.copyTexture(renderer, this.outputTarget, writeBuffer);
    }
}
```

### Temporal Accumulation

```javascript
render(context, writeBuffer) {
    // Blend current with previous
    this.material.uniforms.tCurrent.value = currentTexture;
    this.material.uniforms.tPrevious.value = this.prevTarget.texture;
    this.material.uniforms.alpha.value = 0.1;  // Blend factor

    renderer.setRenderTarget(this.currentTarget);
    this.quad.render(renderer);

    // Swap for next frame
    [this.currentTarget, this.prevTarget] =
        [this.prevTarget, this.currentTarget];
}
```

---

## Summary

The Pipeline architecture provides:

- ✅ **Modularity** - Each stage is independent
- ✅ **Testability** - Mock context/events for unit tests
- ✅ **Extensibility** - Add stages without modifying existing code
- ✅ **Maintainability** - Clear responsibilities, easy to understand
- ✅ **Performance** - Enable/disable stages dynamically, smart execution modes
- ✅ **Flexibility** - Events enable reactive workflows
- ✅ **Tile-Aware** - Automatic optimization for tiled rendering via execution modes

**Key Innovation (Execution Modes):** The execution mode system allows stages to declaratively control when they run during tile rendering, ensuring post-processing only operates on complete frames for optimal quality and performance.

**Key Innovation (TSL):** TSL shaders compile JavaScript shader definitions to WGSL at runtime, enabling path tracing algorithms to run on WebGPU without hand-written WGSL.

**Result:** Clean, maintainable, and scalable WebGPU rendering pipeline with TSL shaders.
