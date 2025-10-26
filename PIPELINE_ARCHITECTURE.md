# Pipeline Architecture

**Rayzee Path Tracing Engine - Event-Driven Rendering Pipeline**

---

## Overview

Rayzee uses an event-driven pipeline architecture for its rendering system. The pipeline consists of modular stages that communicate through events and a shared context, providing loose coupling and clear execution order.

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
├─ ASVGFStage (denoising)
├─ AdaptiveSamplingStage (variance-based sampling)
├─ EdgeAwareFilteringStage (temporal filtering)
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

---

### AdaptiveSamplingStage

**Purpose:** Variance-based adaptive sampling

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

---

### EdgeAwareFilteringStage

**Purpose:** Temporal edge-aware filtering (alternative to ASVGF)

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

---

### TileHighlightStage

**Purpose:** Visualize tile boundaries during tiled rendering

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

---

## Execution Flow

### Normal Frame

```
1. PathTracerStage.render()
   ↓ emits 'tile:changed' (if tiled)
   ↓ writes 'pathtracer:color', 'pathtracer:normalDepth' to context

2. ASVGFStage.render() (if enabled)
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'asvgf:output', 'asvgf:variance' to context

3. AdaptiveSamplingStage.render() (if enabled)
   ↓ reads 'asvgf:variance' or 'pathtracer:color'
   ↓ writes 'adaptiveSampling:output' to context

4. EdgeAwareFilteringStage.render() (if enabled && !ASVGF)
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'edgeFiltering:output' to context

5. TileHighlightStage.render() (if enabled && tiled mode)
   ↓ reads last filter output
   ↓ draws borders
   ↓ writes to writeBuffer → EffectComposer → Screen
```

### Pipeline Integration

```
EffectComposer
    ↓
RenderPass (Three.js scene)
    ↓
PipelineWrapperPass (wraps entire pipeline)
    ↓ delegates to
PassPipeline.render(writeBuffer)
    ↓ executes stages sequentially
[PathTracer → ASVGF → AdaptiveSampling → EdgeFiltering → TileHighlight]
    ↓
writeBuffer → OutlinePass → BloomPass → OutputPass → Screen
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

```javascript
import { PipelineStage } from '../Pipeline/PipelineStage.js';
import { ShaderMaterial, WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class MyCustomStage extends PipelineStage {

    constructor(options = {}) {
        super('MyCustom', options);

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
// In store.js
handleMyCustomIntensity: handleChange(
    val => set({ myCustomIntensity: val }),
    val => window.pathTracerApp.myStage.material.uniforms.intensity.value = val
),
```

---

## Best Practices

### Do's ✅

- **Use context for texture sharing** - Don't pass textures directly between stages
- **Emit events for state changes** - Let other stages react
- **Check enabled state** - Early return if disabled
- **Dispose resources** - Clean up in dispose()
- **Use meaningful texture keys** - Format: `stageName:textureName`
- **Document events** - What data is emitted
- **Handle missing inputs gracefully** - Check if textures exist

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
window.pathTracerApp.pipeline.getInfo();
// Returns: stage names, enabled states, execution order

window.pathTracerApp.pipeline.context.textures;
// Shows all registered textures

window.pathTracerApp.pipeline.eventBus.listenerCount('tile:changed');
// Check event listeners
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
- ✅ **Performance** - Enable/disable stages dynamically
- ✅ **Flexibility** - Events enable reactive workflows

**Result:** Clean, maintainable, and scalable rendering pipeline.
