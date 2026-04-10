# Rayzee Engine

WebGPU path tracing engine. Framework-agnostic — works with React, Vue, Svelte, or vanilla JS.

## Quick Start

```html
<canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { PathTracerApp } from 'rayzee';

const engine = new PathTracerApp(document.getElementById('c'));
await engine.init();
await engine.loadEnvironment('studio.hdr');
await engine.loadModel('scene.glb');
engine.animate();
</script>
```

## Constructor

```js
new PathTracerApp(canvas, options?)
```

| Param | Type | Description |
|-------|------|-------------|
| `canvas` | `HTMLCanvasElement` | Render target |
| `options.autoResize` | `boolean` | Auto-listen for window resize (default `true`) |

## API Reference

### Settings — Unified Parameter Access

All render parameters go through a single API. No individual setter methods.

```js
engine.set('maxBounces', 8);
engine.set('exposure', 1.5);
engine.get('maxBounces');                     // 8
engine.setMany({ maxBounces: 8, exposure: 1.5 }); // batch, single reset
engine.getAll();                              // snapshot of all settings
```

**Available setting keys:**

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxBounces` | `number` | 3 | Ray bounce limit |
| `samplesPerPixel` | `number` | 1 | SPP multiplier |
| `maxSamples` | `number` | 60 | Max accumulated samples |
| `transmissiveBounces` | `number` | 5 | Bounces through transparent materials |
| `fireflyThreshold` | `number` | 1.8 | Clamp bright outliers |
| `exposure` | `number` | 1.0 | Manual exposure |
| `enableDOF` | `boolean` | false | Depth of field |
| `focusDistance` | `number` | 0.8 | Focus distance |
| `aperture` | `number` | 5.6 | F-stop |
| `focalLength` | `number` | 50 | Focal length in mm |
| `apertureScale` | `number` | 1.0 | Aperture multiplier |
| `samplingTechnique` | `number` | 3 | Sampling strategy |
| `environmentIntensity` | `number` | 1.0 | Environment brightness |
| `backgroundIntensity` | `number` | 1.0 | Background brightness |
| `showBackground` | `boolean` | true | Show environment background |
| `transparentBackground` | `boolean` | false | Alpha transparency |
| `enableEnvironment` | `boolean` | true | Enable environment lighting |
| `globalIlluminationIntensity` | `number` | 1.0 | GI multiplier |
| `enableEmissiveTriangleSampling` | `boolean` | false | Direct emissive sampling |
| `emissiveBoost` | `number` | 1.0 | Emissive multiplier |
| `useAdaptiveSampling` | `boolean` | false | Variance-guided sampling |
| `adaptiveSamplingMax` | `number` | 8 | Max samples for high-variance pixels |
| `visMode` | `number` | 0 | Debug visualization mode |
| `debugVisScale` | `number` | 100 | Debug vis scale factor |
| `renderLimitMode` | `string` | 'frames' | `'frames'` or `'time'` |
| `renderTimeLimit` | `number` | 30 | Time limit in seconds |
| `environmentRotation` | `number` | 0.0 | Env rotation in radians |

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

### Rendering Mode

| Method | Description |
|--------|-------------|
| `configureForMode(mode, opts?)` | Batch-configure for `'preview'`, `'final-render'`, or `'results'` |
| `setRenderMode(0\|1)` | 0=progressive, 1=tiled |
| `setTileCount(n)` | Tiles per axis (e.g. 3 = 3x3 grid) |
| `isComplete()` | Whether render converged |
| `getFrameCount()` | Current accumulated frame count |
| `getOutputCanvas()` | Returns the correct canvas for reading pixels |
| `takeScreenshot()` | Download current render as PNG |

### Managers

Access camera, lights, and denoising through focused manager objects:

#### `engine.cameraManager`

| Property / Method | Description |
|-------------------|-------------|
| `.camera` | Active `PerspectiveCamera` |
| `.controls` | `OrbitControls` instance |
| `.switchCamera(index)` | Switch to loaded camera (0=default) |
| `.getCameraNames()` | Array of camera display names |
| `.setAutoFocusMode('manual'\|'auto')` | Auto-focus mode |
| `.setAFScreenPoint(x, y)` | Focus point in screen-space (0-1) |
| `.enterAFPointPlacementMode()` | Click-to-place AF point |
| `.exitAFPointPlacementMode()` | Exit AF placement |

#### `engine.lightManager`

| Method | Description |
|--------|-------------|
| `.addLight(type)` | `'DirectionalLight'` \| `'PointLight'` \| `'SpotLight'` \| `'RectAreaLight'` |
| `.removeLight(uuid)` | Remove by UUID |
| `.getLights()` | Get all light descriptors |
| `.clearLights()` | Remove all lights |
| `.updateLights()` | Sync lights to GPU |
| `.setShowLightHelper(bool)` | Toggle light visualizations |

#### `engine.denoiseManager`

| Method | Description |
|--------|-------------|
| `.setDenoiserStrategy(s, preset?)` | `'none'` \| `'asvgf'` \| `'ssrc'` \| `'edgeaware'` |
| `.setASVGFEnabled(bool, preset?)` | Toggle ASVGF with optional quality preset |
| `.applyASVGFPreset(name)` | `'low'` \| `'medium'` \| `'high'` |
| `.setAutoExposureEnabled(bool)` | Toggle auto-exposure |
| `.setAdaptiveSamplingEnabled(bool)` | Toggle adaptive sampling |

### Stage Parameter Updates

For fine-grained control over individual pipeline stages:

| Method | Description |
|--------|-------------|
| `updateASVGFParameters(params)` | Update ASVGF params (temporalAlpha, phiColor, etc.) |
| `updateSSRCParameters(params)` | Update SSRC params |
| `updateEdgeAwareUniforms(params)` | Update edge-aware filter uniforms |
| `updateAutoExposureParameters(params)` | Update auto-exposure params |
| `updateAdaptiveSamplingParameters(params)` | Update adaptive sampling params |
| `setTileHelperEnabled(bool)` | Toggle tile highlight overlay (2D canvas, never baked into renders) |

### OIDN & AI Upscaler

| Method | Description |
|--------|-------------|
| `setOIDNEnabled(bool)` | Enable/disable OIDN denoiser |
| `updateOIDNQuality(quality)` | `'fast'` \| `'balance'` \| `'high'` |
| `setUpscalerEnabled(bool)` | Enable/disable AI upscaler |
| `setUpscalerScaleFactor(n)` | Upscale factor (2, 4) |
| `setUpscalerQuality(quality)` | `'fast'` \| `'balance'` |

### Environment Modes

| Method | Description |
|--------|-------------|
| `setEnvironmentMode(m)` | `'hdri'` \| `'procedural'` \| `'gradient'` \| `'color'` |
| `await setEnvironmentMap(texture)` | Set custom env texture |
| `generateProceduralSkyTexture()` | Regenerate procedural sky |
| `generateGradientTexture()` | Regenerate gradient sky |
| `generateSolidColorTexture()` | Regenerate solid color sky |
| `markEnvironmentNeedsUpdate()` | Flag env texture for GPU re-upload |

### Materials

| Method | Description |
|--------|-------------|
| `updateMaterialProperty(idx, prop, val)` | Update single material property |
| `updateTextureTransform(idx, name, matrix)` | Update UV transform |
| `rebuildMaterials(scene)` | Full material rebuild and GPU upload |

### Interaction

| Method | Description |
|--------|-------------|
| `selectObject(obj)` | Select for outline highlight |
| `toggleSelectMode()` | Toggle click-to-select |
| `toggleFocusMode()` | Toggle click-to-focus |
| `focusOnPoint(vec3)` | Move orbit target to world point |
| `dispatchInteractionEvent(event)` | Forward events to interaction manager |
| `onInteractionEvent(type, handler)` | Subscribe to interaction events (returns unsubscribe fn) |

### Direct Stage Access

For advanced consumers, all pipeline stages are accessible via `engine.stages`:

```js
engine.stages.pathTracer      // PathTracer
engine.stages.normalDepth     // NormalDepth
engine.stages.motionVector    // MotionVector
engine.stages.asvgf           // ASVGF
engine.stages.variance
engine.stages.bilateralFilter
engine.stages.adaptiveSampling
engine.stages.edgeFilter
engine.stages.autoExposure
engine.stages.ssrc
engine.stages.display         // Display
engine.overlayManager         // OverlayManager (tile helper, scene helpers)
```

## Events

Subscribe via `engine.addEventListener(EngineEvents.X, handler)`.

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
| `SETTING_CHANGED` | `key`, `value`, `prev` | Any render setting changed |

## Exports

```js
import {
  PathTracerApp,        // Main engine class
  EngineEvents,         // Event type constants

  // Settings & managers
  RenderSettings,       // Unified parameter store
  CameraManager,        // Camera switching, auto-focus, DOF
  LightManager,         // Light CRUD and GPU transfer
  DenoisingManager, // Denoiser strategy, OIDN, upscaler

  // Configuration
  ENGINE_DEFAULTS,      // Default config values
  ASVGF_QUALITY_PRESETS,// { low, medium, high }
  CAMERA_PRESETS,       // { portrait, landscape, macro, product, architectural, cinematic }
  CAMERA_RANGES,        // { fov, focusDistance, aperture, focalLength } with min/max
  SKY_PRESETS,          // { clearMorning, clearNoon, overcast, goldenHour, sunset, dusk }
  AF_DEFAULTS,          // Auto-focus constants
  FINAL_RENDER_CONFIG,  // High-quality render preset
  PREVIEW_RENDER_CONFIG,// Interactive preview preset

  // Pipeline (for building custom stages)
  RenderPipeline,
  RenderStage,
  StageExecutionMode,
  PipelineContext,
} from 'rayzee';
```

## React Integration

Use the provided adapter to bridge engine events to Zustand stores:

```js
import { connectEngineToStore } from './src/lib/EngineAdapter.js';

const cleanup = connectEngineToStore(engine, { useStore, useCameraStore, usePathTracerStore });
// cleanup() to unsubscribe
```

For other frameworks, subscribe to `EngineEvents` directly and update your state layer.
