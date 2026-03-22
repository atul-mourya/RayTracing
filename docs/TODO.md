# Rayzee Path Tracer - TODO List

## Bugs

### MVP
- [ ] Switching to Final Render Tab, does the css animated resize operation while doing the thread blocking Final Rendering causing momentary stutter
- [ ] outline resolution need to stay constant regardless of render resolution, currently it gets blurrier at lower resolutions,
  
- [ ] three dots menu for features that are not frequently used. add a dropdown meny with the rest of the internal controls. Example

### Known
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] SSRC seen some pixel stretching artifacts in some scenes, need to investigate and fix,
- [ ] open issues by threejs https://github.com/mrdoob/three.js/issues/32969 and 33061
2Jd84No5SP

### Unconfirmed
- [ ] occasional jarring flickers with auto-exposure - studio vray aparment example file - windows device
- [ ] when i save a final render, and switch to results tab, the saved render is not visible in the results tab until refreshing the page
- [ ] Get feedback on default render settings and convergence criteria, and adjust for better out-of-box experience

---

## Features

### General
- [ ] Save rendering state in local storage and load on app start
- [ ] export/import option for settings

### Rendering
- [ ] Subsurface scattering
- [ ] Volumetric rendering
- [ ] Caustic support
- [ ] camera motion video rendering
- [ ] Tile Rendering helper not working
- [ ] Tile Rendering count displayed in UI is wrong. it shows tile count * current tile index, instead of just current tile index
- [ ] Full WGSL transition, avoid TSL nodes
- [ ] Realtime OIDN denoising with WebGPU compute shader implementation

### Camera
- [ ] New snap points to be added for trackpad
- [ ] first person camera mode controls as an alternative to orbit controls
- [ ] Dynamic camera addition and removal
- [ ] Orthographic Camera Support
- [ ] Depth of field with support for anamorphic bokeh
- [x] Improve focus control - https://x.com/thefrontendcat/status/1885422008344903980


### Lighting
- [ ] emissive mesh triangle sorting - overkill maybe
- [ ] DDS texture support
- [ ] Shadow catcher - blender
- [ ] implement Stochastic Lightcuts for Sampling Many Lights - by Cem Yuksel

### Materials
- [ ] implement pending Physical material properties
- [ ] IES for spotlights
- [ ] SDF-based model rendering

### Environment
- [ ] Environment cube map support for HDRIs
- [ ] Ground projection environment mapping
- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX
- [ ] Separate environment and background sampling with different textures (like Three.js)

### Scene Management
- [ ] Dynamic object addition and removal
- [ ] move assests to cdn and object store instead of bundling with the app

---

## Performance & Architecture

### Pipeline
- [ ] Offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ] GPU-CPU sync for environment in procedural sky, gradient sky, solid color sky modes

### BVH
- [ ] Fast BVH refit updates - blender
- [ ] Consider PLOC for maximum performance scenarios
- [ ] 4-way branching for GPU traversal (explored)

### Profiling
- [ ] GPU timing measurements
- [ ] Memory usage tracking
- [ ] Bottleneck identification
- [ ] Performance regression tests

---

## Experiments
- [ ] Ray-Guiding based on Octahedron Mapping CDF
- [ ] Investigate dot grid / moire-like effect and its impact on rendering
- [ ] Primary ray from rasterization pass for path tracing
- [ ] Ray frustum culling
- [ ] Two-level BVH with coarse top-level
- [ ] Full Disney BSDF
- [ ] Efficient Panorama Rendering
- [x] Screen-space radiance caching
- [x] No Kulla-Conty or Turquin energy compensation
- [x] ReSTIR-based sampling techniques - Branch open with name "ReSTIR"
- [x] stackless BVH traversal - slowness expected
- [x] Bindless texture - True hardware-level bindless isn't available in WebGPU
- [x] irradiance probes,
- [ ] Photon mapping
- [ ] Bidirectional path tracing support

---

## AI Integration
- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] https://upscalerjs.com/models/
- [ ] https://enhance.addy.ie/

## AI Upscaler
### Performance
- [ ] Profile WebGPU EP — verify heavy ops (Conv, DepthToSpace) actually run on GPU, not just shape ops
- [ ] Auto-detect tile size based on GPU VRAM (smaller for integrated GPUs, larger for discrete)
- [ ] Move inference to a Web Worker to keep UI responsive during upscaling

### Quality
- [ ] HDR pipeline — upscale in linear/HDR space before tonemapping (zero-copy from path tracer GPU textures via `Tensor.fromGpuBuffer()`)
- [ ] Alpha preservation — cache and restore alpha channel for transparent backgrounds (matching OIDN pattern)

### Models
- [ ] Model quality presets (fast/balanced/quality) with different model sizes per scale factor
- [ ] Custom model URL support — let users provide their own ONNX SR model
- [ ] Persistent model caching via IndexedDB (don't rely solely on browser HTTP cache)

### UX
- [ ] Progress bar — render the `progress` event as a visual percentage/bar (not just spinner)
- [ ] Estimated time remaining based on per-tile timing
- [ ] Explicit cancel button in the UI during upscaling

---

## Documentation
- [ ] Comprehensive test suite
- [ ] Shader code architecture documentation
- [ ] Asset processing documentation

---

## References
- WebGPU Graphics Pipeline: https://shi-yan.github.io/webgpuunleashed/Introduction/the_gpu_pipeline.html
- See [ROADMAP.md] for long-term vision and strategic planning
- See [CONTRIBUTING.md] for development guidelines



__Side note:: Ignore below. Only an outdated note__
Root Cause: Two independent bugs, both making IOR appear stronger than set.

Bug 1 (Primary — refraction direction wrong)
generateSampledDirection is the fallback transmission path (fires for partial glass where transmission < 1.0). It computed:


const entering = dot(V, N).lessThan(0.0)  // WRONG
Since V = -rayDir, this is equivalent to dot(rayDir, N) > 0 — the exact opposite of "entering". So when a ray hit the front face of glass, entering = false, causing sampleMicrofacetTransmission to use etaRatio = ior (exit path) instead of 1/ior (entry path). The refracted ray bent away from the normal instead of toward it — same visual effect as a dramatically higher IOR.

Bug 2 (Secondary — wrong Fresnel reflectance)
evaluateMaterialResponse hardcoded the dielectric F0 as vec3(0.04), which is the correct value only for IOR=1.5. For any other IOR, Fresnel reflectance was wrong — e.g., at IOR=2.0 the physical F0 is ~0.111 but the code used 0.04. This caused incorrect reflection/transmission balance at grazing angles for all non-default IOR values.

Why the main glass path was unaffected: handleMaterialTransparency → handleTransmission has its own correct entering logic and N reorientation — so full glass (transmission=1.0) routed entirely through that path and rendered correctly. The bug only manifested for partial glass or when the CDF budget fell through to the fallback.