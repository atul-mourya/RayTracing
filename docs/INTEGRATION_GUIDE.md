# Rayzee Integration Guide

Integrating Rayzee's WebGPU path tracer into an existing Three.js application.

## Overview

Rayzee can be added to any Three.js-based application to provide a path-traced rendering mode alongside the existing WebGL/WebGPU rasterized view. The two renderers run on separate canvases and users switch between them via a toggle button.

This guide uses the [Parametric-Simulator](https://github.com/nicedozie4u/parametric-simulator) integration as a reference implementation.

## Prerequisites

- Browser with WebGPU support (Chrome 113+, Edge 113+)
- Three.js r170+ (shared as peer dependency)
- A working Three.js scene with loaded geometry

## Architecture

```
Container
├── WebGL Canvas (your existing renderer)
├── Rayzee Canvas (hidden until toggled)
└── Toggle Button (appears after scene loads)
```

Key constraints:
- **Separate canvases** — WebGL and WebGPU cannot share a canvas
- **Separate renderers** — Rayzee creates its own WebGPURenderer, Scene, Camera, and OrbitControls
- **Object transfer via clone** — Use `object.clone(true)` to deep-clone the scene graph; the original stays untouched
- **Pause inactive renderer** — Prevents GPU contention when only one view is active

## Minimal Integration (HTML-only)

The simplest approach requires zero changes to the host application's source code. All integration logic lives in a `<script type="module">` block in the HTML.

### With Vite (dev server)

Install rayzee and exclude from pre-bundling:

```bash
npm install rayzee
```

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: {
    exclude: ['rayzee'],
  },
});
```

```html
<script type="module">
  import { PathTracerApp } from 'rayzee';
  // ... integration code (see below)
</script>
```

### With Import Maps (standalone HTML, no bundler)

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.tsl.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.webgpu.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/",
    "stats-gl": "https://cdn.jsdelivr.net/npm/stats-gl@4.0.2/dist/main.js",
    "rayzee": "https://cdn.jsdelivr.net/npm/rayzee/dist/rayzee.es.js"
  }
}
</script>
```

> **Note**: CDN usage requires rayzee v4.9+ which includes the cross-origin worker fix. Workers loaded from a different origin need a blob-based proxy — this is handled automatically by the engine.

## Integration Code

```js
import { PathTracerApp } from 'rayzee';

const container = document.getElementById('container');

// 1. Check WebGPU support
if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) {
  console.warn('WebGPU not supported');
  return;
}

// 2. Create rayzee canvas (hidden)
const rayzeeCanvas = document.createElement('canvas');
Object.assign(rayzeeCanvas.style, {
  position: 'absolute', top: '0', left: '0',
  width: '100%', height: '100%',
  zIndex: '1', display: 'none'
});
container.appendChild(rayzeeCanvas);

// 3. Create toggle button
const btn = document.createElement('button');
btn.textContent = 'Path Trace';
btn.style.cssText = `
  position:absolute; bottom:20px; left:50%;
  transform:translateX(-50%); z-index:10001;
  padding:8px 20px; border:none; border-radius:4px;
  background:#333; color:#fff; cursor:pointer; display:none;
`;
container.appendChild(btn);

// 4. Show button when host scene finishes loading
//    (adapt this event to your application)
hostApp.addEventListener('sceneLoaded', () => {
  btn.style.display = 'block';
});

// 5. Toggle logic
let rayzeeApp = null;
let active = false;

btn.addEventListener('click', async () => {
  if (active) {
    // Switch back to host renderer
    rayzeeCanvas.style.display = 'none';
    hostCanvas.style.display = 'block';
    rayzeeApp.pause();
    // Resume your render loop here
    active = false;
    btn.textContent = 'Path Trace';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    // Lazy init — only on first click
    if (!rayzeeApp) {
      rayzeeCanvas.width = container.clientWidth;
      rayzeeCanvas.height = container.clientHeight;
      rayzeeApp = new PathTracerApp(rayzeeCanvas, null, { autoResize: false });
      await rayzeeApp.init();

      // Optional: load an HDR environment for lighting
      try { await rayzeeApp.loadEnvironment('./path/to/env.hdr'); } catch {}

      // Clone and load the scene
      const sceneRoot = yourScene.getObjectByName('YourRootGroup');
      await rayzeeApp.loadObject3D(sceneRoot.clone(true), 'scene');

      rayzeeApp.animate();
      rayzeeApp.pause();
    }

    // Swap canvases
    rayzeeCanvas.style.display = 'block';
    hostCanvas.style.display = 'none';
    // Pause your render loop here
    rayzeeApp.resume();
    active = true;
    btn.textContent = 'Rasterized';
  } catch (e) {
    console.error('Rayzee activation failed:', e);
    btn.textContent = 'Path Trace';
  } finally {
    btn.disabled = false;
  }
});

// 6. Handle resize
window.addEventListener('resize', () => {
  rayzeeCanvas.width = container.clientWidth;
  rayzeeCanvas.height = container.clientHeight;
  if (rayzeeApp && active) rayzeeApp.onResize();
});
```

## Key API Methods

| Method | Description |
|---|---|
| `new PathTracerApp(canvas, null, options)` | Create engine instance |
| `engine.init()` | Initialize WebGPU renderer (async) |
| `engine.loadObject3D(object3d, name)` | Load a Three.js Object3D into the path tracer |
| `engine.loadModel(url)` | Load a GLB/GLTF model from URL |
| `engine.loadEnvironment(url)` | Load an HDR/EXR environment map |
| `engine.animate()` | Start the render loop |
| `engine.pause()` / `engine.resume()` | Pause/resume rendering |
| `engine.set(key, value)` | Set render parameter (e.g. `maxBounces`, `exposure`) |
| `engine.onResize()` | Handle canvas resize |
| `engine.dispose()` | Clean up all resources |

## Important Notes

### THREE.js Deduplication
Both rayzee and your app declare `three` as a peer dependency. In a Vite project, the bundler deduplicates automatically. For IIFE/script-tag setups, both use the global `THREE` — load `three.js` once before either script.

### Object Cloning
- Use `object.clone(true)` for deep cloning — shares geometry and texture data (memory efficient)
- Clone only once (on first toggle), not on every switch — avoids texture disposal issues
- Rayzee extracts PBR material properties (albedo, roughness, metalness, etc.) into its own GPU buffers, so custom `onBeforeCompile` shaders are irrelevant for path tracing

### WebGPU Feature Detection
Always check `navigator.gpu` before showing any rayzee UI. Hide the toggle button entirely on unsupported browsers for a clean degradation path.

### Environment Lighting
Path tracing without an environment map produces a black background with no indirect lighting. Always load an HDR environment for realistic results.

## Alternative: Manager Pattern Integration

For deeper integration into a library/framework, create a dedicated manager class that:
- Participates in the host app's lifecycle (init, dispose)
- Exposes a public API (`getRayzeeManager()`)
- Handles events internally (no polling or race conditions)
- Follows the host app's architectural conventions

This is recommended when the host application is consumed as a library by other apps, since the HTML-only approach won't survive an HTML replacement.
