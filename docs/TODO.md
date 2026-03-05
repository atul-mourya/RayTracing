# Rayzee Path Tracer - TODO List

## Bugs

### Critical
- [ ] Area light shadows not visible
- [ ] Object rendering looks dimmer than environment lighting in background (hardcoded 2.0 multiplier for env lighting on secondary rays)
- [ ] Iridescence not producing expected colors
- [ ] convergence issue
- [ ] transparent background + transparent / transmissive materials not working together

### RCA unknown
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] Save render doesn't show in results panel in some cases

---

## Features

### Rendering
- [ ] Variance-based firefly suppression
- [ ] Transparent background support
- [ ] Subsurface scattering
- [ ] Volumetric rendering
- [ ] Caustic support for direct lights
- [ ] Investigate dot grid / moire-like effect and its impact on rendering
- [ ] camera motion video rendering

### Lighting & Materials
- [ ] implement pending Physical material properties
- [ ] implement Stochastic Lightcuts for Sampling Many Lights - by Cem Yuksel
- [ ] Area light helper toggle control
- [ ] Separate environment and background sampling with different textures (like Three.js)
- [ ] Environment cube map support for HDRIs
- [ ] DDS texture support
- [ ] IES light support
- [ ] SDF-based model rendering
- [ ] Shadow catcher
- [ ] Ground projection environment mapping

### Environment
- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX

### Scene Management
- [ ] Dynamic camera addition and removal
- [ ] Dynamic object addition and removal
- [ ] Improve focus control - https://x.com/thefrontendcat/status/1885422008344903980

---

## Performance & Architecture

### Pipeline
- [ ] Separate pipeline for path tracing passes vs helper passes (tile helper, outline, etc.)
- [ ] Offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ] GPU-CPU sync for environment in procedural sky, gradient sky, solid color sky modes

### Optimization
- [ ] Screen-space radiance caching
- [ ] Primary ray from rasterization pass for path tracing
- [ ] Ray frustum culling

### BVH
- [ ] BVH update / refit - https://claude.ai/share/e55132c8-758a-4117-b5ae-04d73e67351b
- [ ] Consider PLOC for maximum performance scenarios
- [ ] 4-way branching for GPU traversal (explored)

### Profiling
- [ ] GPU timing measurements
- [ ] Memory usage tracking
- [ ] Bottleneck identification
- [ ] Performance regression tests

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
