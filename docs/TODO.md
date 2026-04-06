# Rayzee Path Tracer - TODO List

## Bugs

### MVP
- [ ] Switching to resolution, does the viewport resize operation but with a lot of latency.
- [ ] oidndenoiser is desaturation the results
- [ ] cloudflare page shows one version behind in the ui, however the feature of the new version already included
  

### Known
- [ ] some pixels show black in the first rendered frame even if it hits the environment map
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] SSRC seen some pixel stretching artifacts in some scenes, need to investigate and fix,
- [ ] ASVFG gives smearing effect when moving the camera
- [ ] open issues by threejs https://github.com/mrdoob/three.js/issues/32969 and 33061
2Jd84No5SP

### Unconfirmed
---

## Features

### General
- [ ] Introduce Project based workflow
- [ ] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] three dots menu for features that are not frequently used. add a dropdown meny with the rest of the internal controls
- [ ] Migrate to vite 8+

### Rendering
- [ ] Subsurface scattering
- [ ] Volumetric rendering
- [ ] Caustic support
- [ ] Full WGSL transition, avoid TSL nodes
- [ ] Realtime OIDN denoising with WebGPU compute shader implementation

### Camera
- [ ] New snap points to be added for trackpad
- [ ] first person camera mode controls as an alternative to orbit controls
- [ ] Dynamic camera addition and removal
- [ ] Orthographic Camera Support


### Lighting
- [ ] emissive mesh triangle sorting - overkill maybe
- [ ] DDS texture support
- [ ] Shadow catcher - blender
- [ ] implement Stochastic Lightcuts for Sampling Many Lights - by Cem Yuksel
- [ ] light transform gizmo helpers
- [ ] Textured area lights

### Materials
- [ ] implement pending Physical material properties
- [ ] IES for spotlights
- [ ] SDF-based model rendering
- [ ] transmission support for displacement materials

### Environment
- [ ] Environment cube map support for HDRIs
- [ ] Ground projection environment mapping
- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX
- [ ] Separate environment and background sampling with different textures (like Three.js)

### Scene Management
- [ ] Dynamic object addition and removal
- [ ] move assests to cdn and object store instead of bundling with the app

### Animation
- [ ] Timeline scrubber for animation control
- [ ] Camera animation - interpolate camera path keyframes during video render
- [ ] PNG image sequence export for better quality and post-processing flexibility
- [ ] Multi-clip blending - cross-fade between animation clips with configurable transition duration
- [ ] ArrayBufferTarget memory for long videos - StreamTarget upgrade

---

## Performance & Architecture

### Pipeline
- [ ] GPU-CPU sync for environment in procedural sky, gradient sky, solid color sky modes

### BVH
- [x] Fast BVH refit updates - O(N) bottom-up AABB refit for animated geometry
- [ ] Parallel refit — split bottom-up traversal across multiple workers for large scenes
- [ ] GPU compute refit — once Three.js supports read-write storage buffers, move AABB recomputation to a compute shader for sub-millisecond refits
- [ ] Incremental rebuild — when SAH degrades past threshold, rebuild only the degraded subtree instead of the whole BVH

- [ ] Consider PLOC for maximum performance scenarios
- [ ] 4-way branching for GPU traversal (explored)

### Profiling
- [ ] GPU timing measurements
- [ ] Memory usage tracking
- [ ] Bottleneck identification
- [ ] Performance regression tests

---

## Experiments
- [ ] Offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
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
- [ ] Custom model URL support — let users provide their own ONNX SR model
- [ ] Estimated time remaining based on per-tile timing
- [ ] FSR 2.x port

---

## Documentation
- [ ] Shader code architecture documentation
- [ ] Asset processing documentation

---

## References
- WebGPU Graphics Pipeline: https://shi-yan.github.io/webgpuunleashed/Introduction/the_gpu_pipeline.html
- See [ROADMAP.md] for long-term vision and strategic planning
- See [CONTRIBUTING.md] for development guidelines
