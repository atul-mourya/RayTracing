# Rayzee Engine

A real-time WebGPU path tracing engine built on Three.js. Framework-agnostic — use it with React, Vue, vanilla JS, or any other setup.

## Installation

```bash
npm install rayzee@github:atul-mourya/RayTracing three stats-gl
```

Or add to `package.json`:

```json
{
  "dependencies": {
    "rayzee": "github:atul-mourya/RayTracing",
    "three": "^0.183.0",
    "stats-gl": "^4.0.2"
  }
}
```

npm publishing is coming soon. `three` and `stats-gl` are required peer dependencies.

## Getting Started

### Vanilla JS with Vite

1. **Create a project**

   ```bash
   npm create vite@latest my-raytracer -- --template vanilla
   cd my-raytracer
   npm install rayzee@github:atul-mourya/RayTracing three stats-gl
   ```

2. **Configure Vite** — WebGPU needs cross-origin isolation headers and `.hdr` asset support. Create or update `vite.config.js`:

   ```js
   import { defineConfig } from 'vite';

   export default defineConfig({
     server: {
       headers: {
         'Cross-Origin-Opener-Policy': 'same-origin',
         'Cross-Origin-Embedder-Policy': 'credentialless',
       },
     },
     assetsInclude: ['**/*.hdr'],
   });
   ```

3. **Set up the HTML**

   ```html
   <!-- index.html -->
   <body style="margin: 0; overflow: hidden;">
     <canvas id="viewport"></canvas>
     <script type="module" src="/main.js"></script>
   </body>
   ```

4. **Write the code**

   ```js
   // main.js
   import { PathTracerApp, EngineEvents } from 'rayzee';

   const canvas = document.getElementById('viewport');
   canvas.width = window.innerWidth;
   canvas.height = window.innerHeight;

   const engine = new PathTracerApp(canvas);
   await engine.init();

   // Load a 3D model (place .glb in public/ folder)
   await engine.loadModel('/scene.glb');

   // Or load an environment map
   // await engine.loadEnvironment('/environment.hdr');

   // Start rendering
   engine.animate();

   // Listen for events
   engine.addEventListener(EngineEvents.RENDER_COMPLETE, () => {
     console.log('Frame rendered');
   });

   // Tweak settings
   engine.set('maxBounces', 8);
   engine.set('exposure', 1.2);
   ```

5. **Run**

   ```bash
   npm run dev
   ```

### Vanilla JS (no bundler)

A single HTML file — no Node.js, no build step. Uses [ES module import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to resolve the pre-built ESM bundle and its dependencies from a CDN.

```html
<!DOCTYPE html>
<html>
<head>
  <title>Rayzee Path Tracer</title>
  <style>body { margin: 0; overflow: hidden; background: #111; }</style>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.webgpu.js",
      "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.tsl.js",
      "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.webgpu.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/",
      "stats-gl": "https://cdn.jsdelivr.net/npm/stats-gl@4.0.2/dist/main.js",
      "rayzee": "https://cdn.jsdelivr.net/gh/atul-mourya/RayTracing@main/rayzee/dist/rayzee.es.js"
    }
  }
  </script>
</head>
<body>
  <canvas id="viewport"></canvas>
  <script type="module">
    import { PathTracerApp } from 'rayzee';

    const canvas = document.getElementById('viewport');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const engine = new PathTracerApp(canvas);
    await engine.init();
    await engine.loadModel('https://example.com/scene.glb');
    engine.animate();

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      engine.onResize();
    });
  </script>
</body>
</html>
```

Serve with any static server (ES modules require HTTP, not `file://`):

```bash
npx serve .
```

> **Note**: The import map approach loads dependencies from a CDN, so initial load is slower than a bundled build. For production, use the Vite setup above.

### React

```jsx
import { useRef, useEffect } from 'react';
import { PathTracerApp } from 'rayzee';

export default function Viewport({ modelUrl }) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => {
    let engine;

    async function start() {
      engine = new PathTracerApp(canvasRef.current);
      await engine.init();
      if (modelUrl) await engine.loadModel(modelUrl);
      engine.animate();
      engineRef.current = engine;
    }

    start();
    return () => engine?.dispose();
  }, [modelUrl]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100vh' }} />;
}
```

The same Vite config (headers + assetsInclude) applies for React projects.

## API Reference

### PathTracerApp

The main engine class. Extends Three.js `EventDispatcher`.

```js
const engine = new PathTracerApp(canvas, denoiserCanvas?, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `canvas` | `HTMLCanvasElement` | Rendering target |
| `denoiserCanvas` | `HTMLCanvasElement` | Optional canvas for OIDN denoiser output |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`) |

#### Lifecycle

```js
await engine.init()           // Initialize WebGPU renderer and pipeline
engine.animate()              // Start the render loop
engine.pause()                // Pause rendering
engine.resume()               // Resume rendering
engine.reset()                // Reset accumulation (restart from sample 0)
engine.dispose()              // Clean up all resources
```

#### Loading Assets

```js
await engine.loadModel(url)           // Load GLB/GLTF/FBX/OBJ/STL/PLY/DAE/3MF/USDZ
await engine.loadEnvironment(url)     // Load HDR/EXR environment map
```

#### Settings

```js
engine.set('maxBounces', 8)           // Set a single parameter
engine.setMany({                      // Set multiple parameters at once
  maxBounces: 8,
  samplesPerPixel: 1,
  exposure: 1.0
})
engine.get('maxBounces')              // Read a parameter
engine.getAll()                       // Get all current settings
```

Key settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `maxBounces` | `number` | 5 | Max ray bounce depth |
| `samplesPerPixel` | `number` | 1 | Samples per pixel per frame |
| `exposure` | `number` | 1.0 | Exposure value |
| `enableEnvironment` | `boolean` | true | Use environment lighting |
| `environmentIntensity` | `number` | 1.0 | Environment light strength |
| `environmentRotation` | `number` | 0 | Environment Y-rotation (radians) |
| `fireflyThreshold` | `number` | 10 | Firefly clamping threshold |
| `transmissiveBounces` | `number` | 5 | Max bounces for transmissive materials |
| `visMode` | `number` | 0 | Debug visualization mode (0 = off) |

See `ENGINE_DEFAULTS` for the full list with default values.

#### Rendering Modes

```js
import { FINAL_RENDER_CONFIG, PREVIEW_RENDER_CONFIG } from 'rayzee';

engine.configureForMode('final')      // High quality (tiled, 20 bounces)
engine.configureForMode('interactive') // Real-time navigation (3 bounces)
```

#### Camera

```js
engine.switchCamera(index)            // Switch between scene cameras
engine.getCameraNames()               // List available cameras
engine.toggleFocusMode()              // Enable click-to-focus DOF
```

#### Lights

```js
engine.addLight('point')              // Add a light (point, spot, directional, area)
engine.removeLight(uuid)              // Remove by UUID
engine.getLights()                     // Get all lights
engine.setShowLightHelper(true)       // Toggle visual helpers
```

#### Denoising

```js
engine.setDenoiserStrategy('asvgf')   // Real-time temporal denoiser
engine.setDenoiserStrategy('oidn')    // Intel OIDN (higher quality, final renders)
engine.setDenoiserStrategy('none')    // No denoising
engine.setASVGFEnabled(true, 'balanced') // ASVGF with quality preset
```

#### Canvas & Resolution

```js
engine.setCanvasSize(1920, 1080)      // Set explicit canvas dimensions
engine.onResize()                     // Trigger manual resize recalculation
```

### Events

Subscribe to engine lifecycle events via `addEventListener`:

```js
import { EngineEvents } from 'rayzee';

engine.addEventListener(EngineEvents.RENDER_COMPLETE, (e) => {
  console.log('Render complete', e.detail);
});

engine.addEventListener(EngineEvents.STATS_UPDATE, (e) => {
  console.log('FPS:', e.detail.fps);
});
```

| Event | Fired when |
|---|---|
| `RENDER_COMPLETE` | A frame finishes rendering |
| `RENDER_RESET` | Accumulation buffer is reset |
| `DENOISING_START` / `DENOISING_END` | Denoiser runs |
| `UPSCALING_START` / `UPSCALING_PROGRESS` / `UPSCALING_END` | AI upscaler runs |
| `LOADING_UPDATE` / `LOADING_RESET` | Asset loading progress |
| `STATS_UPDATE` | Performance stats updated |
| `OBJECT_SELECTED` / `OBJECT_DESELECTED` | Object selection changes |
| `SETTING_CHANGED` | A render setting is modified |
| `AUTO_FOCUS_UPDATED` | Auto-focus recalculated |
| `AUTO_EXPOSURE_UPDATED` | Auto-exposure recalculated |

### Advanced: Custom Pipeline Stages

Build custom rendering stages by extending `RenderStage`:

```js
import { RenderStage, PipelineContext } from 'rayzee';

class MyCustomStage extends RenderStage {
  constructor() {
    super('my-stage');
  }

  render(renderer, context) {
    const input = context.getTexture('pathtracer:color');
    // ... process input, write output
    context.setTexture('my-stage:output', this.outputTexture);
  }
}
```

### All Exports

```js
// Core
import { PathTracerApp, EngineEvents } from 'rayzee';

// Configuration & presets
import {
  ENGINE_DEFAULTS,
  ASVGF_QUALITY_PRESETS,
  CAMERA_PRESETS,
  CAMERA_RANGES,
  SKY_PRESETS,
  FINAL_RENDER_CONFIG,
  PREVIEW_RENDER_CONFIG,
} from 'rayzee';

// Advanced: managers
import {
  RenderSettings,
  CameraManager,
  LightManager,
  DenoiserOrchestrator,
} from 'rayzee';

// Advanced: pipeline infrastructure
import {
  RenderPipeline,
  RenderStage,
  StageExecutionMode,
  PipelineContext,
} from 'rayzee';
```

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Firefox Nightly)
- Secure context (HTTPS or localhost)

## Optional Dependencies

| Package | Purpose |
|---|---|
| `oidn-web` | Intel Open Image Denoise for high-quality final renders |
| `onnxruntime-web` | AI-powered upscaling |

Install them alongside rayzee if needed:

```bash
npm install oidn-web onnxruntime-web
```

## Troubleshooting

**Black screen / "WebGPU not supported"**
Your browser may not support WebGPU. Use Chrome 113+ or Edge 113+. Ensure you're on HTTPS or localhost.

**CORS errors loading models/HDRs**
Add cross-origin isolation headers to your dev server (see the Vite config in Getting Started).

**Models not loading**
Place `.glb` / `.hdr` files in your `public/` folder and reference them with absolute paths (e.g., `/scene.glb`).

## License

MIT
