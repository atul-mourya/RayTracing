# WebGPU Development Tools

This directory contains development and debugging utilities for the WebGPU path tracer.

## Files

### TSLTestScene.js
**Purpose:** Basic TSL (Three.js Shading Language) validation test

**Features:**
- Displays an animated color gradient using TSL node-based shaders
- Tests fundamental WebGPU + TSL rendering pipeline
- Useful for verifying WebGPU initialization and basic shader functionality

**Usage:**
```javascript
import { createTestMaterial, createTestQuad } from './core/WebGPU/dev/TSLTestScene.js';
// Or use the convenience function
import { initWebGPUTest } from './core/WebGPU';
const app = await initWebGPUTest(canvas);
```

### WebGPUHitTestApp.js
**Purpose:** Ray-scene intersection visualization for debugging

**Features:**
- Visualizes ray-triangle intersections
- Multiple visualization modes (normals, distance, material IDs)
- BVH traversal heatmap
- Shares scene data with main WebGL path tracer
- Useful for debugging BVH construction, triangle data, and ray-scene queries

**Visualization Modes:**
- `VIS_MODE.NORMALS` (0): Surface normals as RGB colors
- `VIS_MODE.DISTANCE` (1): Distance gradient from camera
- `VIS_MODE.MATERIAL_ID` (2): Material ID as colored regions
- `VIS_MODE.BVH_HEATMAP` (3): BVH traversal statistics

**Usage:**
```javascript
import { WebGPUHitTestApp, VIS_MODE } from './core/WebGPU/dev/WebGPUHitTestApp.js';
const hitTestApp = new WebGPUHitTestApp(canvas, existingPathTracerApp);
await hitTestApp.init();
hitTestApp.loadSceneData();
hitTestApp.animate();
hitTestApp.setVisMode(VIS_MODE.NORMALS);
```

**Or use the convenience function:**
```javascript
import { initHitTestVisualization } from './core/WebGPU';
const hitTestApp = await initHitTestVisualization(canvas, window.pathTracerApp);
```

### HitTestStage.js
**Purpose:** TSL-based ray tracing stage used by WebGPUHitTestApp

**Features:**
- Linear and BVH-accelerated ray traversal in TSL
- Multiple output modes for debugging
- Data texture reading for triangles, BVH nodes, and materials
- Shared by WebGPUHitTestApp for visualization

## When to Use These Tools

### Use TSLTestScene when:
- Setting up WebGPU for the first time
- Verifying WebGPU support in a browser
- Testing TSL shader compilation
- Debugging WebGPURenderer initialization issues

### Use WebGPUHitTestApp when:
- Debugging ray-scene intersection issues
- Verifying BVH construction correctness
- Visualizing triangle data layout
- Testing material ID assignments
- Comparing WebGL vs WebGPU ray tracing results
- Investigating performance bottlenecks in traversal

## Production vs Development

**Production code uses:**
- `WebGPUPathTracerApp` - Full path tracing with materials, lighting, BSDF
- `PathTracingStage` - Multi-bounce Monte Carlo path tracing
- `WebGPUPathTracerStage` - Pipeline-integrated stage for production rendering

**These dev tools should NOT be used in production** - they are for testing, debugging, and development only.

## Browser Console Testing

All dev tools are also available via `window.WebGPU` for console testing:

```javascript
// Check WebGPU support
WebGPU.isSupported()

// Start path tracer (production)
const pt = await WebGPU.startPathTracer(canvas, window.pathTracerApp)

// Start hit test visualization (dev)
const ht = await WebGPU.startHitTest(canvas, window.pathTracerApp)
ht.setVisMode(WebGPU.VIS_MODE.NORMALS)
```
