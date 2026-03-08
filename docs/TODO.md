# Rayzee Path Tracer - TODO List

## Bugs

### Critical
- [ ] change default enviroment and model to best showcase the renderer, make the tonemapping default to auto-exposure
- [ ] Area light shadows not visible beyond a distance
- [ ] Object rendering looks dimmer than environment lighting in background (hardcoded 2.0 multiplier for env lighting on secondary rays)
- [ ] Iridescence not producing expected colors
- [x] convergence issue - in some case when a orbit controlled camera dolly in or out, the accumulation doesnt converge and every frame looks differently noised rendered with no convergence to provision
- [ ] transparent background + transparent / transmissive materials not working together
- [ ] when convergence is done and i trigger play from ui, it switches to rasterisation. Similarly on double press of spacebar triggers it all even if still converging

### RCA unknown
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] Save render doesn't show in results panel in some cases

---

## Features

### Rendering
- [ ] Fly mode camera controls as an alternative to orbit controls
- [ ] Subsurface scattering
- [ ] Volumetric rendering
- [ ] Caustic support for direct lights
- [ ] camera motion video rendering
- [ ] Tile Rendering need a webgpu revamp
- [ ] Full WGSL transition, avoid TSL nodes

### Camera
- [ ] Dynamic camera addition and removal
- [ ] Orthographic Camera Support
- [ ] Depth of field with support for anamorphic bokeh
- [ ] Improve focus control - https://x.com/thefrontendcat/status/1885422008344903980


### Lighting
- [ ] implement pending Physical material properties
- [ ] DDS texture support
- [ ] Shadow catcher - blender
- [ ] change the slider range of emissive mesh sampling to 0 to 100

### Materials
- [ ] implement Stochastic Lightcuts for Sampling Many Lights - by Cem Yuksel
- [ ] Area light helper toggle control
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
- [ ] Separate pipeline for path tracing passes vs helper passes (tile helper, outline, etc.)
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
- [ ] Remove unwanted debug modes

---

## Experiments
- [ ] Screen-space radiance caching
- [ ] Investigate dot grid / moire-like effect and its impact on rendering
- [ ] Primary ray from rasterization pass for path tracing
- [ ] Ray frustum culling
- [ ] Two-level BVH with coarse top-level
- [ ] Full Disney BSDF
- [ ] Efficient Panorama Rendering
- [x] No Kulla-Conty or Turquin energy compensation - didnt like the results, but could be worth revisiting with a more accurate implementation
- [x] ReSTIR-based sampling techniques - Branch open with name "ReSTIR"
- [x] stackless BVH traversal - slowness expected
- [x] Bindless texture - True hardware-level bindless isn't available in WebGPU

---

## AI Integration
- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] https://upscalerjs.com/models/
- [ ] https://enhance.addy.ie/

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
