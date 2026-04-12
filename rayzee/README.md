# Rayzee Engine

A real-time WebGPU path tracing engine built on Three.js. Framework-agnostic — use it with React, Vue, vanilla JS, or any other setup.

## Installation

```bash
npm install rayzee three
```

`three` (>=0.170.0) is a required peer dependency. `stats-gl` is installed automatically as a transitive dependency.

## Getting Started

### Vanilla JS with Vite

1. **Create a project**

   ```bash
   npm create vite@latest my-raytracer -- --template vanilla
   cd my-raytracer
   npm install rayzee three
   ```

2. **Set up the HTML**

   ```html
   <!-- index.html -->
   <body style="margin: 0; overflow: hidden;">
     <canvas id="viewport"></canvas>
     <script type="module" src="/main.js"></script>
   </body>
   ```

3. **Write the code**

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
   engine.set('bounces', 8);
   engine.set('exposure', 1.2);

   // Use namespaced APIs and direct methods
   engine.cameraManager.switch(0);
   engine.lightManager.add('PointLight');
   engine.screenshot();
   ```

4. **Run**

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
    // Replace with your own model URL
    await engine.loadModel('https://your-cdn.com/scene.glb');
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
    const canvas = canvasRef.current;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    const engine = new PathTracerApp(canvas);
    engineRef.current = engine;

    (async () => {
      await engine.init();
      if (modelUrl) await engine.loadModel(modelUrl);
      engine.animate();
    })();

    return () => engine.dispose();
  }, [modelUrl]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100vh' }} />;
}
```

No special build config is needed — models and HDRs are loaded via URL at runtime.

## API Reference

### PathTracerApp

The main engine class. Extends Three.js `EventDispatcher`. Related functionality is grouped into **namespaced managers** accessed via `engine.cameraManager`, `engine.lightManager`, etc., or as direct methods on the engine instance.

```js
const engine = new PathTracerApp(canvas, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `canvas` | `HTMLCanvasElement` | Rendering target |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`) |
| `options.showStats` | `boolean` | Show the performance stats panel (default: `true`) |
| `options.statsContainer` | `HTMLElement` | DOM element to append the stats panel to (defaults to `document.body`) |

#### Lifecycle

```js
await engine.init()           // Initialize WebGPU renderer and pipeline
engine.animate()              // Start the render loop
engine.pause()                // Pause rendering
engine.resume()               // Resume rendering
engine.reset()                // Reset accumulation (restart from sample 0)
engine.dispose()              // Clean up all resources
engine.wake()                 // Resume render loop if idle
```

#### Loading Assets

```js
await engine.loadModel(url)           // Load GLB/GLTF/FBX/OBJ/STL/PLY/DAE/3MF/USDZ
await engine.loadObject3D(object3d)   // Load a Three.js Object3D directly
await engine.loadEnvironment(url)     // Load HDR/EXR environment map
```

#### Settings

```js
engine.set('bounces', 8)              // Set a single parameter
engine.setMany({                      // Set multiple parameters at once
  bounces: 8,
  samplesPerPixel: 1,
  exposure: 1.0
})
engine.get('bounces')                 // Read a parameter
engine.getAll()                       // Get all current settings
```

Key settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `bounces` | `number` | 3 | Max ray bounce depth |
| `samplesPerPixel` | `number` | 1 | Samples per pixel per frame |
| `maxSamples` | `number` | 60 | Max accumulated samples before stopping |
| `exposure` | `number` | 1.0 | Exposure value |
| `saturation` | `number` | 1.2 | Color saturation |
| `enableEnvironment` | `boolean` | true | Use environment lighting |
| `environmentIntensity` | `number` | 1.0 | Environment light strength |
| `environmentRotation` | `number` | 270 | Environment Y-rotation (degrees) |
| `fireflyThreshold` | `number` | 3.0 | Firefly clamping threshold |
| `transmissiveBounces` | `number` | 5 | Max bounces for transmissive materials |
| `enableDOF` | `boolean` | false | Enable depth of field |
| `focusDistance` | `number` | 0.8 | DOF focus distance |
| `aperture` | `number` | 5.6 | DOF aperture (f-stop) |
| `focalLength` | `number` | 50 | DOF focal length (mm) |
| `adaptiveSampling` | `boolean` | false | Variance-guided sample distribution |
| `transparentBackground` | `boolean` | false | Transparent canvas background |
| `interactionModeEnabled` | `boolean` | true | Lower quality during camera movement for smoother navigation |
| `debugMode` | `number` | 0 | Debug visualization mode (0 = off) |
| `environmentMode` | `string` | 'hdri' | Sky mode: `'hdri'` \| `'procedural'` \| `'gradient'` \| `'color'` |

See `ENGINE_DEFAULTS` for the full list with default values.

#### Rendering Modes

```js
engine.configureForMode('final-render')  // High quality (tiled, 20 bounces, OIDN)
engine.configureForMode('preview')       // Real-time navigation (3 bounces)
engine.configureForMode('results')       // Paused rendering for image viewing
```

---

### engine.cameraManager

Camera switching, auto-focus, DOF, and direct Three.js access.

```js
engine.cameraManager.active                  // The active PerspectiveCamera
engine.cameraManager.controls                // The OrbitControls instance
engine.cameraManager.switch(index)           // Switch between scene cameras
engine.cameraManager.getNames()              // List available cameras
engine.cameraManager.focusOn(center)         // Focus orbit camera on a world-space point
engine.cameraManager.setAutoFocusMode(mode)  // 'auto' | 'manual'
engine.cameraManager.setAFScreenPoint(x, y)  // Set normalized AF screen point (0-1)
```

### engine.lightManager

Light CRUD, visual helpers, and GPU sync.

```js
engine.lightManager.add('PointLight')       // Add a light (PointLight, SpotLight, DirectionalLight, RectAreaLight)
engine.lightManager.remove(uuid)            // Remove by UUID
engine.lightManager.clear()                 // Remove all lights
engine.lightManager.getAll()                // Get all light descriptors
engine.lightManager.sync()                  // Re-upload light data to GPU
engine.lightManager.showHelpers(true)       // Toggle visual helpers
```

### engine.animationManager

GLTF animation playback controls.

```js
engine.animationManager.play(clipIndex)      // Play an animation clip
engine.animationManager.pause()              // Pause playback
engine.animationManager.resume()             // Resume playback
engine.animationManager.stop()               // Stop and reset
engine.animationManager.setSpeed(2)          // Set playback speed multiplier
engine.animationManager.setLoop(true)        // Enable/disable looping
engine.animationManager.clips                // Get available animation clips
```

### Materials

Material property updates and texture transforms — accessed as direct methods on the engine.

```js
engine.setMaterialProperty(index, property, value)  // Update a material property
engine.setTextureTransform(index, name, transform)   // Update texture transform
engine.reset()                        // Re-upload all material data to GPU
engine.stages.pathTracer.materialData.updateMaterial(index, mat)  // Replace a material
await engine.rebuildMaterials(scene)  // Full rebuild (after texture changes)
```

### engine.environmentManager

Environment maps, sky modes, and procedural generation.

```js
engine.environmentManager.params             // Current environment parameters
engine.environmentManager.texture            // The loaded environment texture
await engine.environmentManager.load(url)    // Load HDR/EXR environment map
await engine.environmentManager.setTexture(tex) // Set a custom environment texture
await engine.environmentManager.setMode(mode)   // 'hdri' | 'procedural' | 'gradient' | 'color'
await engine.environmentManager.generateProcedural() // Preetham-model sky
await engine.environmentManager.generateGradient()   // Gradient sky
await engine.environmentManager.generateSolid()      // Solid color sky
engine.environmentManager.markDirty()        // Flag environment for GPU re-upload
```

### engine.denoisingManager

Denoiser strategy, ASVGF, OIDN, upscaler, adaptive sampling, and auto-exposure.

```js
// Strategy
engine.denoisingManager.setStrategy('asvgf', 'medium')  // 'none' | 'asvgf' | 'ssrc' | 'edgeaware'
engine.denoisingManager.setASVGFEnabled(true, 'medium')
engine.denoisingManager.applyASVGFPreset('high')         // 'low' | 'medium' | 'high'
engine.denoisingManager.setAutoExposure(true)
engine.denoisingManager.setAdaptiveSampling(true)

// Fine-grained parameters
engine.denoisingManager.setASVGFParams({ temporalAlpha: 0.1, phiColor: 10 })
engine.denoisingManager.setSSRCParams({ temporalAlpha: 0.1, spatialRadius: 3 })
engine.denoisingManager.setEdgeAwareParams({ pixelEdgeSharpness: 1.0 })
engine.denoisingManager.setAutoExposureParams({ keyValue: 0.18 })
engine.denoisingManager.setAdaptiveSamplingParams({ varianceThreshold: 0.01 })

// OIDN & Upscaler
engine.denoisingManager.setOIDNEnabled(true)
engine.denoisingManager.setOIDNQuality('high')
engine.denoisingManager.setUpscalerEnabled(true)
engine.denoisingManager.setUpscalerScaleFactor(2)
engine.denoisingManager.setUpscalerQuality('high')
```

### engine.interactionManager

Object picking and interaction modes.

```js
engine.interactionManager.select(object)       // Programmatically select an object
engine.interactionManager.deselect()           // Deselect the current object
engine.interactionManager.toggleSelectMode()   // Toggle object selection mode
engine.interactionManager.disableMode()        // Disable selection mode and detach gizmo
engine.interactionManager.toggleFocusMode()    // Toggle click-to-focus DOF
engine.interactionManager.on(type, handler)    // Subscribe (returns unsubscribe function)
```

### engine.transformManager

Transform gizmo controls.

```js
engine.transformManager.setMode('translate') // 'translate' | 'rotate' | 'scale'
engine.transformManager.setSpace('world')    // 'world' | 'local'
engine.transformManager.manager              // Access the underlying TransformManager
```

### Output Methods

Canvas output, screenshots, and scene statistics — accessed as direct methods on the engine.

```js
engine.getCanvas()             // Get the canvas with the final rendered image
engine.screenshot()            // Download a PNG screenshot
engine.getStatistics()         // Triangle count, mesh count, etc.
engine.setCanvasSize(1920, 1080)  // Set explicit canvas dimensions
engine.onResize()              // Trigger manual resize recalculation
engine.isComplete()            // Check if rendering has converged
engine.getFrameCount()         // Get the current accumulated frame count
```

---

### Events

Subscribe to engine lifecycle events via `addEventListener`:

```js
import { EngineEvents } from 'rayzee';

engine.addEventListener(EngineEvents.RENDER_COMPLETE, (e) => {
  console.log('Render complete');
});
```

| Event | Fired when |
|---|---|
| `RENDER_COMPLETE` | Rendering has converged |
| `RENDER_RESET` | Accumulation buffer is reset |
| `DENOISING_START` / `DENOISING_END` | Denoiser runs |
| `UPSCALING_START` / `UPSCALING_PROGRESS` / `UPSCALING_END` | AI upscaler runs |
| `LOADING_UPDATE` / `LOADING_RESET` | Asset loading progress |
| `STATS_UPDATE` | Performance stats updated |
| `OBJECT_SELECTED` / `OBJECT_DESELECTED` | Object selection changes |
| `OBJECT_DOUBLE_CLICKED` | Object double-clicked |
| `OBJECT_TRANSFORM_START` / `OBJECT_TRANSFORM_END` | Transform gizmo drag |
| `TRANSFORM_MODE_CHANGED` | Gizmo mode changed |
| `SELECT_MODE_CHANGED` | Selection mode toggled |
| `SETTING_CHANGED` | A render setting is modified |
| `AUTO_FOCUS_UPDATED` | Auto-focus recalculated |
| `AUTO_EXPOSURE_UPDATED` | Auto-exposure recalculated |
| `AF_POINT_PLACED` | Focus point placed on screen |
| `ANIMATION_STARTED` / `ANIMATION_PAUSED` / `ANIMATION_STOPPED` / `ANIMATION_FINISHED` | Animation lifecycle |
| `VIDEO_RENDER_PROGRESS` / `VIDEO_RENDER_COMPLETE` | Video export progress |

### Advanced: Custom Pipeline Stages

Build custom rendering stages by extending `RenderStage`:

```js
import { RenderStage } from 'rayzee';

class MyCustomStage extends RenderStage {
  constructor() {
    super('my-stage');
  }

  render(context, writeBuffer) {
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
  AUTO_FOCUS_MODES,
  AF_DEFAULTS,
  TRIANGLE_DATA_LAYOUT,
  BVH_LEAF_MARKERS,
  TEXTURE_CONSTANTS,
  DEFAULT_TEXTURE_MATRIX,
  MEMORY_CONSTANTS,
  FINAL_RENDER_CONFIG,
  PREVIEW_RENDER_CONFIG,
} from 'rayzee';

// Advanced: managers & pipeline
import {
  RenderSettings,
  CameraManager,
  LightManager,
  DenoisingManager,
  OverlayManager,
  AnimationManager,
  TransformManager,
  VideoRenderManager,
  RenderPipeline,
  RenderStage,
  StageExecutionMode,
  PipelineContext,
} from 'rayzee';
```

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox 141+)
- Secure context (HTTPS or localhost)

## Optional Dependencies

| Package | Purpose | Install needed? |
|---|---|---|
| `oidn-web` | Intel Open Image Denoise for high-quality final renders | Yes — `npm install oidn-web` |
| `onnxruntime-web` | AI-powered upscaling | No — loaded from CDN at runtime |

### Enabling OIDN (Intel Open Image Denoise)

OIDN provides high-quality AI denoising for final renders. It runs automatically after the render converges (reaches `maxSamples`).

1. **Install the package**

   ```bash
   npm install oidn-web
   ```

2. **Enable in your app**

   ```js
   // After engine.init() completes
   engine.denoisingManager.setOIDNEnabled(true);
   engine.denoisingManager.setOIDNQuality('balance'); // 'fast' | 'balance' | 'high'
   ```

3. **Listen for progress** (optional)

   ```js
   engine.addEventListener(EngineEvents.DENOISING_START, () => {
     console.log('Denoising started');
   });
   engine.addEventListener(EngineEvents.DENOISING_END, () => {
     console.log('Denoising complete');
   });
   ```

| Quality | Model size | Speed | Best for |
|---|---|---|---|
| `'fast'` | ~20 MB | Fastest | Quick previews |
| `'balance'` | ~50 MB | Moderate | General use (default) |
| `'high'` | ~100 MB | Slowest | Final quality renders |

> **Note:** The neural network model is downloaded on first use. Subsequent runs use the browser cache. OIDN also works with `configureForMode('final-render')`, which enables it automatically alongside high-quality render settings.

## Troubleshooting

**OIDN: `Cannot find module './tza'` (webpack)**
The `oidn-web` package uses dynamic imports that webpack cannot resolve. This does not affect Vite or other ESM-native bundlers. Add `oidn-web` to your webpack externals:

```js
// webpack.config.js
module.exports = {
  externals: {
    'oidn-web': 'oidn-web'
  }
};
```

Then load it via a script tag or import map instead:

```html
<script type="importmap">
{
  "imports": {
    "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.3.0/+esm"
  }
}
</script>
```

**Black screen / "WebGPU not supported"**
Your browser may not support WebGPU. Use Chrome 113+, Edge 113+, Safari 18+, or Firefox 141+. Ensure you're on HTTPS or localhost.

**Models not loading**
If serving locally, place files in your `public/` folder and reference them with absolute paths (e.g., `/scene.glb`). For remote files, ensure the server allows CORS.

## License

MIT
