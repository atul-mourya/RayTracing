# Pipeline Architecture

**Rayzee Path Tracing Engine - Dual-Backend Event-Driven Rendering Pipeline**

---

## Overview

Rayzee uses a **dual-backend architecture** supporting both WebGL and WebGPU rendering. The WebGL backend uses an event-driven pipeline of modular stages communicating through events and shared context. The WebGPU backend uses TSL (Three Shading Language) shaders compiled to WGSL at runtime. Both backends implement the same `IPathTracerApp` interface, allowing the UI/store layer to be completely backend-agnostic.

### System Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              UI / React                  │
                    │  (Zustand Store + appProxy.getApp())    │
                    └─────────────────┬───────────────────────┘
                                      │
                              ┌───────┴───────┐
                              │ BackendManager │
                              │  (singleton)   │
                              └───┬───────┬───┘
                     ┌────────────┘       └────────────┐
                     ▼                                 ▼
          ┌──────────────────┐              ┌──────────────────┐
          │  WebGL Backend   │              │  WebGPU Backend  │
          │  PathTracerApp   │              │WebGPUPathTracerApp│
          │  (main.js)       │              │                  │
          ├──────────────────┤              ├──────────────────┤
          │ EffectComposer   │              │ WebGPURenderer   │
          │ PassPipeline     │              │ PathTracingStage │
          │ ├─PathTracerStage│              │ (TSL shaders)    │
          │ ├─ASVGFStage     │              │                  │
          │ ├─AdaptiveSampling│             │ InteractionMgr   │
          │ ├─EdgeFiltering  │              └────────┬─────────┘
          │ ├─AutoExposure   │                       │
          │ └─TileHighlight  │              ┌────────┴─────────┐
          │ OutlinePass      │              │   DataTransfer   │
          │ BloomPass        │              │ (shares textures │
          │ OutputPass       │              │  from WebGL app) │
          └──────────────────┘              └──────────────────┘
```

### Dual-Canvas Model

WebGL and WebGPU each have their own `<canvas>` element. Only one is visible at a time, controlled by `BackendManager.toggleCanvasVisibility()`. The inactive backend is paused to conserve GPU resources.

---

## BackendManager

**File:** `src/core/BackendManager.js` (~700 lines, singleton via `getBackendManager()`)

Orchestrates the dual-backend lifecycle:

### Responsibilities
- WebGPU capability detection (`navigator.gpu`, adapter probing)
- App registration (`setWebGLApp()`, `setWebGPUApp()`)
- Backend switching with full state preservation
- Canvas visibility management
- Event emission (`switching`, `switched`, `error`)

### Backend Switch Flow

```
setBackend(newBackend)
    │
    ├─ preserveState()  → snapshot camera + all render settings
    ├─ pause current app
    ├─ swap currentBackend
    ├─ toggleCanvasVisibility()
    ├─ restoreState()   → apply camera + settings to new app
    ├─ resume new app (app.resume() or app.animate())
    └─ emit 'BackendSwitched' window event
```

### State Preservation

Preserved across backend switches:
- Camera: position, quaternion, FOV, target, near, far
- Render: bounces, SPP, max samples, transmissive bounces
- DOF: focus distance, focal length, aperture, enable state
- Environment: intensity, background intensity, show background
- Sampling: technique, adaptive sampling, firefly threshold
- Resolution: target resolution index
- Tone mapping: exposure

### App Proxy (`src/core/appProxy.js`)

All UI/store code accesses the active backend via `getApp()`:

```javascript
import { getApp, getBackend, supportsFeature, isWebGL, isWebGPU } from '@/core/appProxy';

const app = getApp();  // Returns active app or null
if (app) app.setMaxBounces(8);

if (supportsFeature('bloom')) { /* WebGL only */ }
```

`getApp()` resolves via `BackendManager.getCurrentApp()` with `window.pathTracerApp` as an early-init fallback.

---

## WebGL Pipeline (Event-Driven Stages)

### Key Components

```
PipelineContext (shared state & textures)
        ↓
EventBus (stage communication)
        ↓
PassPipeline (orchestration)
        ↓
PipelineStage (base class)
        ↓
├─ PathTracerStage (ray tracing)
├─ MotionVectorStage (motion vectors)
├─ ASVGFStage (denoising)
├─ VarianceEstimationStage (variance)
├─ BilateralFilteringStage (spatial denoising)
├─ AdaptiveSamplingStage (variance-based sampling)
├─ EdgeAwareFilteringStage (temporal filtering)
├─ AutoExposureStage (auto exposure)
└─ TileHighlightStage (tile borders visualization)
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

### Pipeline Integration (WebGL)

```
EffectComposer
    ↓
RenderPass (Three.js scene)
    ↓
PipelineWrapperPass (wraps entire pipeline)
    ↓ delegates to
PassPipeline.render(writeBuffer)
    ↓ executes stages sequentially
[PathTracer → MotionVector → ASVGF → Variance → Bilateral → AdaptiveSampling → EdgeFiltering → AutoExposure → TileHighlight]
    ↓
writeBuffer → OutlinePass → BloomPass → OutputPass → Screen
```

---

## WebGPU Pipeline

The WebGPU backend uses a simpler pipeline — a single `PathTracingStage` that handles path tracing, accumulation, and output in one pass using TSL shaders.

### Architecture

```
WebGPUPathTracerApp
    ├─ WebGPURenderer (Three.js WebGPU)
    │   ├─ toneMapping: ACESFilmicToneMapping
    │   └─ toneMappingExposure: exposure^4.0
    ├─ PathTracingStage (TSL)
    │   ├─ pathTracerMain() → TSL entry point
    │   ├─ Ping-pong accumulation targets
    │   ├─ MRT outputs (gColor, gNormalDepth, gAlbedo)
    │   └─ All uniforms managed as TSL uniform() nodes
    ├─ InteractionManager (click-to-select, focus picking)
    └─ DataTransfer (shares textures from WebGL app)
```

### Data Flow

WebGPU doesn't load assets directly — it delegates to the WebGL app's processing pipeline:

```
WebGL AssetLoader
  ├─ GeometryExtractor → triangle Float32Array (32 floats/tri)
  ├─ BVHBuilder (Web Worker) → BVH texture
  ├─ TextureCreator → material textures, texture arrays
  └─ Environment processing → HDR + CDF textures
       │
       ▼
DataTransfer (static utility)
  ├─ getTriangleTexture()      → shared reference
  ├─ getBVHTexture()           → shared reference
  ├─ getMaterialTexture()      → shared reference
  ├─ getEnvironmentTexture()   → from scene.environment
  ├─ getMaterialTextureArrays()→ { albedo, normal, bump, ... }
  └─ getEmissiveTriangleData() → { texture, count }
       │
       ▼
WebGPUPathTracerApp.loadSceneData()
  └─ pathTracingStage.set[Triangle|BVH|Material|Environment]Texture()
     + pathTracingStage.setupMaterial() → builds TSL node graph
```

**Critical**: Textures are shared by reference (not copied) to avoid GPU memory duplication.

### Feature Support Comparison

| Feature | WebGL | WebGPU |
|---------|-------|--------|
| Path tracing | ✅ | ✅ |
| Progressive accumulation | ✅ | ✅ |
| DOF | ✅ | ✅ |
| Environment lighting | ✅ | ✅ |
| Materials (Disney BSDF) | ✅ | ✅ |
| Resolution control | ✅ | ✅ |
| Sampling techniques | ✅ | ✅ |
| Emissive triangle sampling | ✅ | ✅ |
| Click-to-select | ✅ | ✅ |
| Focus picking | ✅ | ✅ |
| Screenshot | ✅ | ✅ |
| ASVGF denoiser | ✅ | ❌ |
| OIDN denoiser | ✅ | ❌ |
| Bloom | ✅ | ❌ |
| Auto exposure | ✅ | ❌ |
| Tile rendering | ✅ | ❌ |
| Edge-aware filtering | ✅ | ❌ |
| Dynamic lights | ✅ | ❌ |
| Object outline | ✅ | ❌ |
| Direct asset loading | ✅ | ❌ (delegates) |
| Material editing | ✅ | ❌ |

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
import { ShaderMaterial, WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class MyCustomStage extends PipelineStage {

    constructor(options = {}) {
        super('MyCustom', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE // Choose appropriate mode
        });

        // Create render target
        this.outputTarget = new WebGLRenderTarget(
            options.width,
            options.height
        );

        // Create material
        this.material = new ShaderMaterial({
            uniforms: {
                tInput: { value: null },
                intensity: { value: 1.0 }
            },
            vertexShader: `...`,
            fragmentShader: `...`
        });

        this.quad = new FullScreenQuad(this.material);
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

        this.material.uniforms.tInput.value = inputTexture;

        // Render to output target
        const renderer = context.renderer;
        renderer.setRenderTarget(this.outputTarget);
        this.quad.render(renderer);

        // Publish to context
        context.setTexture('mycustom:output', this.outputTarget.texture);

        // Copy to writeBuffer if needed
        if (writeBuffer) {
            renderer.setRenderTarget(writeBuffer);
            // ... render to writeBuffer
        }
    }

    setSize(width, height) {
        this.outputTarget.setSize(width, height);
    }

    dispose() {
        this.outputTarget.dispose();
        this.material.dispose();
        this.quad.dispose();
    }
}
```

### Step 2: Add to Pipeline

```javascript
// In main.js setupPipeline()
import { MyCustomStage } from './Stages/MyCustomStage.js';

const myStage = new MyCustomStage({
    width: this.width,
    height: this.height,
    enabled: true
});

// Add in desired execution order
this.pipeline.addStage(pathTracerStage);
this.pipeline.addStage(asvgfStage);
this.pipeline.addStage(myStage);  // ← Add here
this.pipeline.addStage(tileHighlightStage);
```

### Step 3: Add Store Handler (Optional)

```javascript
// In store.js - uses getApp() from appProxy (backend-agnostic)
handleMyCustomIntensity: handleChange(
    val => set({ myCustomIntensity: val }),
    val => getApp().myStage.material.uniforms.intensity.value = val
),
```

### Step 4: WebGPU Considerations

If the new stage's capability should also work on WebGPU:

1. **Register the feature** in `WebGPUFeatures.js`:
   ```javascript
   myCustomEffect: false  // or true if implementing
   ```

2. **Guard UI with feature flags**:
   ```javascript
   import { supportsFeature } from '@/core/appProxy';
   // Only show controls if the active backend supports the feature
   if (supportsFeature('myCustomEffect')) { /* render controls */ }
   ```

3. **Implement in TSL** (if supporting WebGPU):
   - Create `src/core/WebGPU/TSL/myCustomEffect.js` using TSL `Fn()` patterns
   - Integrate into `PathTracingStage.js`

4. **Use `getApp()` not `window.pathTracerApp`** in store handlers to stay backend-agnostic.

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
- **Use `getApp()` from appProxy** - Never reference `window.pathTracerApp` directly in new code
- **Register feature flags** - Add `WebGPUFeatures.js` entries for features not yet ported to WebGPU
- **Test both backends** - Verify behavior on both WebGL and WebGPU when adding features

### Don'ts ❌

- **Don't access other stages directly** - Use context/events
- **Don't assume execution order** - Stages should work independently
- **Don't leak render targets** - Always dispose
- **Don't allocate in render loop** - Pre-allocate in constructor
- **Don't reference `window.pathTracerApp`** - Use `getApp()` from appProxy instead
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
window.pathTracerApp.pipeline.getInfo();
// Returns: stage names, enabled states, execution order

window.pathTracerApp.pipeline.context.textures;
// Shows all registered textures

window.pathTracerApp.pipeline.eventBus.listenerCount('tile:changed');
// Check event listeners
```

### Debug Tile Rendering Execution

```javascript
// Enable logging of skipped stages during tile rendering
window.pathTracerApp.pipeline.stats.enabled = true;
window.pathTracerApp.pipeline.stats.logSkipped = true;

// Console will show:
// [Pipeline] Skipped stage 'ASVGF' (executionMode: per_cycle)
// [Pipeline] Skipped stage 'AdaptiveSampling' (executionMode: per_cycle)

// Check tile completion state
window.pathTracerApp.pipeline.context.getState('tileRenderingComplete');
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
- ✅ **Dual-Backend** - WebGL and WebGPU share the same UI/store layer via `BackendManager` and `appProxy`

**Key Innovation (WebGL):** The execution mode system allows stages to declaratively control when they run during tile rendering, ensuring post-processing only operates on complete frames for optimal quality and performance.

**Key Innovation (WebGPU):** TSL shaders compile JavaScript shader definitions to WGSL at runtime, enabling the same path tracing algorithms to run on WebGPU without hand-written WGSL. Data textures are shared by reference from the WebGL backend, avoiding GPU memory duplication.

**Key Innovation (Architecture):** The `BackendManager` singleton enables seamless backend switching with full state preservation (camera, render settings, resolution) — users can switch between WebGL and WebGPU without losing their current scene configuration.

**Result:** Clean, maintainable, and scalable rendering pipeline supporting dual GPU backends.
