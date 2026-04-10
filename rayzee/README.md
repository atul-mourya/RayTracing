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

The main engine class. Extends Three.js `EventDispatcher`.

```js
const engine = new PathTracerApp(canvas, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `canvas` | `HTMLCanvasElement` | Rendering target |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`) |
| `options.statsContainer` | `HTMLElement` | DOM element to append the stats panel to (defaults to `document.body`) |

#### Lifecycle

```js
await engine.init()           // Initialize WebGPU renderer and pipeline
engine.animate()              // Start the render loop
engine.pause()                // Pause rendering
engine.resume()               // Resume rendering
engine.reset()                // Reset accumulation (restart from sample 0)
engine.dispose()              // Clean up all resources
engine.wake()                 // Resume render loop if idle (called automatically on interaction)
engine.isComplete()           // Check if rendering has converged
engine.getFrameCount()        // Get the current accumulated frame count
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
| `debugMode` | `number` | 0 | Debug visualization mode (0 = off) |
| `environmentMode` | `string` | 'hdri' | Sky mode: `'hdri'` \| `'procedural'` \| `'gradient'` \| `'color'` |

See `ENGINE_DEFAULTS` for the full list with default values.

#### Rendering Modes

```js
engine.configureForMode('final-render')  // High quality (tiled, 20 bounces, OIDN)
engine.configureForMode('preview')       // Real-time navigation (3 bounces)
engine.configureForMode('results')       // Paused rendering for image viewing
```

#### Camera

```js
engine.switchCamera(index)            // Switch between scene cameras
engine.getCameraNames()               // List available cameras
engine.toggleFocusMode()              // Enable click-to-focus DOF
engine.focusOnPoint(center)           // Focus orbit camera on a world-space point
engine.camera                         // Access the active PerspectiveCamera
engine.controls                       // Access OrbitControls
```

#### Lights

```js
engine.addLight('point')              // Add a light (point, spot, directional, area)
engine.removeLight(uuid)              // Remove by UUID
engine.clearLights()                  // Remove all lights
engine.getLights()                     // Get all lights
engine.updateLights()                 // Re-upload light data to GPU
engine.setShowLightHelper(true)       // Toggle visual helpers
```

#### Object Selection & Transform

```js
engine.toggleSelectMode()             // Toggle object selection mode
engine.selectObject(object)           // Programmatically select an object
engine.setTransformMode('translate')  // Set gizmo mode: 'translate' | 'rotate' | 'scale'
engine.setTransformSpace('world')     // Set gizmo space: 'world' | 'local'
engine.transformManager               // Access the underlying TransformManager
```

#### Animation

```js
engine.playAnimation(clipIndex)       // Play a GLTF animation clip
engine.pauseAnimation()               // Pause playback
engine.resumeAnimation()              // Resume playback
engine.stopAnimationPlayback()        // Stop and reset
engine.setAnimationSpeed(speed)       // Set playback speed multiplier
engine.setAnimationLoop(loop)         // Enable/disable looping
engine.animationClips                 // Get available animation clips
```

#### Denoising

```js
engine.setDenoiserStrategy('asvgf')       // Real-time temporal denoiser
engine.setDenoiserStrategy('oidn')        // Intel OIDN (higher quality, final renders)
engine.setDenoiserStrategy('edgeaware')   // Edge-preserving temporal filter (default)
engine.setDenoiserStrategy('none')        // No denoising
engine.setASVGFEnabled(true, 'medium')    // ASVGF with quality preset (low/medium/high)
engine.applyASVGFPreset('high')           // Apply an ASVGF quality preset
engine.setAutoExposureEnabled(true)       // Toggle auto-exposure
engine.setAdaptiveSamplingEnabled(true)   // Toggle adaptive sampling
```

#### Environment

```js
engine.getEnvParams()                         // Get current environment parameters
engine.getEnvironmentTexture()                // Get the loaded environment texture
engine.setEnvironmentMap(texture)             // Set a custom environment texture
engine.setEnvironmentMode('procedural')       // Switch sky mode
engine.generateProceduralSkyTexture()         // Generate Preetham-model sky
engine.generateGradientTexture()              // Generate gradient sky
engine.generateSolidColorTexture()            // Generate solid color sky
engine.markEnvironmentNeedsUpdate()           // Flag environment for GPU re-upload
```

#### Canvas & Resolution

```js
engine.setCanvasSize(1920, 1080)      // Set explicit canvas dimensions
engine.onResize()                     // Trigger manual resize recalculation
engine.getOutputCanvas()              // Get the canvas with the final rendered image
engine.takeScreenshot()               // Download a PNG screenshot
```

#### Materials

```js
engine.updateMaterialProperty(index, property, value)  // Update a material property
engine.updateTextureTransform(index, textureName, transform)
engine.refreshMaterial()              // Re-upload all material data to GPU
engine.updateMaterial(index, material) // Replace a material entirely
await engine.rebuildMaterials(scene)  // Full material rebuild (texture changes)
```

#### Scene Info

```js
engine.getSceneStatistics()           // Triangle count, mesh count, etc.
engine.stages                         // Named access to all pipeline stages
```

### Events

Subscribe to engine lifecycle events via `addEventListener`:

```js
import { EngineEvents } from 'rayzee';

engine.addEventListener(EngineEvents.RENDER_COMPLETE, (e) => {
  console.log('Render complete');
});

engine.addEventListener(EngineEvents.STATS_UPDATE, (e) => {
  console.log('Stats:', e);
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

// Advanced: managers
import {
  RenderSettings,
  CameraManager,
  LightManager,
  DenoisingManager,
  OverlayManager,
  AnimationManager,
  TransformManager,
  VideoRenderManager,
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

- WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox 141+)
- Secure context (HTTPS or localhost)

## Optional Dependencies

| Package | Purpose | Install needed? |
|---|---|---|
| `oidn-web` | Intel Open Image Denoise for high-quality final renders | Yes — `npm install oidn-web` |
| `onnxruntime-web` | AI-powered upscaling | No — loaded from CDN at runtime |

## Troubleshooting

**Black screen / "WebGPU not supported"**
Your browser may not support WebGPU. Use Chrome 113+, Edge 113+, Safari 18+, or Firefox 141+. Ensure you're on HTTPS or localhost.

**Models not loading**
If serving locally, place files in your `public/` folder and reference them with absolute paths (e.g., `/scene.glb`). For remote files, ensure the server allows CORS.

## License

MIT
