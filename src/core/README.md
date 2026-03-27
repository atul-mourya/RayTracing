# Rayzee Engine

WebGPU path tracing engine. Framework-agnostic — works with React, Vue, Svelte, or vanilla JS.

## Quick Start

```html
<canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { PathTracerApp } from './src/core/index.js';

const engine = new PathTracerApp(document.getElementById('c'));
await engine.init();
await engine.loadEnvironment('studio.hdr');
await engine.loadModel('scene.glb');
engine.animate();
engine.reset();
</script>
```

## Constructor

```js
new PathTracerApp(canvas, denoiserCanvas?, options?)
```

| Param | Type | Description |
|-------|------|-------------|
| `canvas` | `HTMLCanvasElement` | Render target |
| `denoiserCanvas` | `HTMLCanvasElement \| null` | Optional canvas for OIDN output |
| `options.autoResize` | `boolean` | Auto-listen for window resize (default `true`) |

## API Reference

### Lifecycle

| Method | Description |
|--------|-------------|
| `await init()` | Initialize WebGPU renderer and pipeline |
| `animate()` | Start render loop |
| `pause()` / `resume()` | Pause/resume animation |
| `reset(soft?)` | Reset accumulation (`soft=true` preserves temporal history) |
| `dispose()` | Release all GPU resources |

### Scene Loading

| Method | Description |
|--------|-------------|
| `await loadModel(url)` | Load GLB/GLTF, build BVH, upload to GPU |
| `await loadEnvironment(url)` | Load HDR environment map |
| `await loadExampleModels(index, modelFiles)` | Load from a model catalog array |

### Rendering

| Method | Description |
|--------|-------------|
| `setMaxBounces(n)` | Ray bounce limit |
| `setSamplesPerPixel(n)` | SPP multiplier |
| `setMaxSamples(n)` | Max accumulated samples |
| `setTransmissiveBounces(n)` | Bounces through transparent materials |
| `setFireflyThreshold(v)` | Clamp bright outliers |
| `setExposure(v)` | Manual exposure |
| `setRenderMode(0\|1)` | 0=progressive, 1=tiled |
| `setTileCount(n)` | Tiles per axis (e.g. 3 = 3x3 grid) |
| `configureForMode(mode, opts?)` | Batch-configure for `'preview'`, `'final-render'`, or `'results'` |
| `isComplete()` | Whether render converged |
| `getFrameCount()` | Current accumulated frame count |

### Denoising

| Method | Description |
|--------|-------------|
| `setDenoiserStrategy(s, preset?)` | `'none'` \| `'asvgf'` \| `'ssrc'` \| `'edgeaware'` |
| `setASVGFEnabled(bool, preset?)` | Toggle ASVGF with optional quality preset |
| `applyASVGFPreset(name)` | `'low'` \| `'medium'` \| `'high'` |
| `setAutoExposureEnabled(bool)` | Toggle auto-exposure (manages stacking with manual) |

### Camera & DOF

| Method | Description |
|--------|-------------|
| `getCamera()` | Active `PerspectiveCamera` |
| `getControls()` | `OrbitControls` instance |
| `switchCamera(index)` | Switch to loaded camera (0=default) |
| `setEnableDOF(bool)` | Toggle depth of field |
| `setFocusDistance(v)` | Manual focus distance |
| `setAperture(v)` | F-stop (1.4 ... 16) |
| `setFocalLength(v)` | Focal length in mm |
| `setAutoFocusMode('manual'\|'auto')` | Auto-focus mode |
| `setAFScreenPoint(x, y)` | Focus point in screen-space (0-1) |

### Environment

| Method | Description |
|--------|-------------|
| `setEnvironmentMode(m)` | `'hdri'` \| `'procedural'` \| `'gradient'` \| `'color'` |
| `setEnvironmentIntensity(v)` | Environment brightness |
| `setBackgroundIntensity(v)` | Background brightness (independent) |
| `setEnvironmentRotation(v)` | Rotation in radians |
| `setShowBackground(bool)` | Show/hide environment background |
| `setTransparentBackground(bool)` | Alpha transparency |
| `generateProceduralSkyTexture()` | Regenerate procedural sky |
| `generateGradientTexture()` | Regenerate gradient sky |

### Materials

| Method | Description |
|--------|-------------|
| `updateMaterialProperty(idx, prop, val)` | Update single material property |
| `updateTextureTransform(idx, name, matrix)` | Update UV transform |
| `rebuildMaterials(scene)` | Full material rebuild and GPU upload |

### Lights

| Method | Description |
|--------|-------------|
| `addLight(type)` | `'DirectionalLight'` \| `'PointLight'` \| `'SpotLight'` \| `'RectAreaLight'` |
| `removeLight(uuid)` | Remove by UUID |
| `updateLights()` | Sync lights to GPU |
| `setShowLightHelper(bool)` | Toggle light visualizations |

### Interaction

| Method | Description |
|--------|-------------|
| `selectObject(obj)` | Select for outline highlight |
| `toggleSelectMode()` | Toggle click-to-select |
| `toggleFocusMode()` | Toggle click-to-focus |

### Adaptive Sampling

| Method | Description |
|--------|-------------|
| `setAdaptiveSamplingEnabled(bool)` | Toggle with stage cleanup |
| `setAdaptiveSamplingMax(n)` | Max samples for high-variance pixels |

## Events

Subscribe via `engine.addEventListener(EngineEvents.X, handler)`. All event objects include `type` and `target`.

| Event | Extra Fields | When |
|-------|-------------|------|
| `RENDER_COMPLETE` | | Accumulation finished |
| `RENDER_RESET` | | Accumulation restarted |
| `DENOISING_START` | | OIDN denoiser begins |
| `DENOISING_END` | | OIDN denoiser finishes |
| `UPSCALING_START` | | AI upscaler begins |
| `UPSCALING_PROGRESS` | `progress` | Upscaler progress (0-1) |
| `UPSCALING_END` | | AI upscaler finishes |
| `LOADING_UPDATE` | `status`, `progress`, ... | Asset loading progress |
| `LOADING_RESET` | | Loading state cleared |
| `STATS_UPDATE` | `timeElapsed`, `samples` | Per-frame render stats |
| `OBJECT_SELECTED` | `object` | Object selected |
| `OBJECT_DESELECTED` | `object` | Object deselected |
| `OBJECT_DOUBLE_CLICKED` | `object`, `uuid` | Object double-clicked |
| `SELECT_MODE_CHANGED` | `enabled` | Select mode toggled |
| `AUTO_FOCUS_UPDATED` | `distance` | Auto-focus distance changed |
| `AUTO_EXPOSURE_UPDATED` | `exposure`, `luminance` | Auto-exposure computed |
| `AF_POINT_PLACED` | `point` | Focus point placed via click |

## Exports

```js
import {
  PathTracerApp,        // Main engine class
  EngineEvents,         // Event type constants

  ENGINE_DEFAULTS,      // Default config values
  ASVGF_QUALITY_PRESETS,// { low, medium, high }
  CAMERA_PRESETS,       // { portrait, landscape, macro, product, architectural, cinematic }
  CAMERA_RANGES,        // { fov, focusDistance, aperture, focalLength } with min/max
  SKY_PRESETS,          // { clearMorning, clearNoon, overcast, goldenHour, sunset, dusk }
  AF_DEFAULTS,          // Auto-focus constants
  FINAL_RENDER_CONFIG,  // High-quality render preset
  PREVIEW_RENDER_CONFIG,// Interactive preview preset

  // Advanced — for building custom pipeline stages
  PassPipeline,
  PipelineStage,
  StageExecutionMode,
  PipelineContext,
} from './src/core/index.js';
```

## React Integration

Use the provided adapter to bridge engine events to Zustand stores:

```js
import { connectEngineToStore } from './src/lib/EngineAdapter.js';

const cleanup = connectEngineToStore(engine, { useStore, useCameraStore, usePathTracerStore });
// cleanup() to unsubscribe
```

For other frameworks, subscribe to `EngineEvents` directly and update your state layer.
