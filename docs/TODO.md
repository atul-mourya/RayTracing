# Rayzee Path Tracer - TODO List

## Bugs

### MVP

- [ ] Switching to resolution, does the viewport resize operation but with a lot of latency.
- [ ] oidndenoiser is desaturation the results
- [ ] enhance test coverage of the engine
- [ ] lint fix
- [ ] compileAsync
- [ ] SSRC apha, seems to have no effect
- [ ] ASVGF heatmap shows black - normal
- [ ] ASVGF heatmap shows improper motion vector
- [ ] unify all patches in one file
- [ ] scrutenize for which all stages are needed as default
- [ ] dispose, reset, etc life cycle for rayzee
  
### Known

- [ ] some pixels show black in the first rendered frame even if it hits the environment map
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] SSRC seen some pixel stretching artifacts in some scenes, need to investigate and fix,
- [ ] ASVFG gives smearing effect when moving the camera
- [ ] open issues by threejs <https://github.com/mrdoob/three.js/issues/32969> and 33061
2Jd84No5SP
- [ ] directional light not working from kronos test file: <https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/DirectionalLight/README.md>

### Unconfirmed

---

## Features

### General

- [ ] Introduce Project based workflow
- [ ] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] three dots menu for features that are not frequently used. add a dropdown meny with the rest of the internal controls

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
- [ ] Shadow catcher - blender
- [ ] implement Stochastic Lightcuts for Sampling Many Lights - by Cem Yuksel
- [ ] light transform gizmo helpers
- [ ] Textured area lights

### Materials

- [ ] implement pending Physical material properties
- [ ] IES for spotlights
- [ ] SDF-based model rendering
- [ ] transmission support for displacement materials
- [ ] Supporting GPU-compressed texture arrays requires adding per-scene format selection at build time - the TSL compiler doesn't support clean
  teardown/rebuild of compute pipelines when texture binding types
  change.

### Environment

- [ ] Environment cube map support for HDRIs
- [ ] Ground projection environment mapping
- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX
- [ ] Separate environment and background sampling with different textures (like Three.js)

### Scene Management

- [ ] Dynamic object addition and removal

### Animation

- [ ] animate lights support
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

- [x] O(N) bottom-up BVH refit for animated geometry
- [x] Two-level BVH (TLAS/BLAS) with per-mesh refit for transforms
- [x] Bounded worker pool for BLAS builds (no main-thread blocking)
- [x] Ranged GPU upload (addUpdateRange) for partial buffer updates
- [x] TLAS in-place refit instead of full SAH rebuild on transform
- [ ] Object-space triangles + instance transform buffer for true instancing
- [ ] GPU compute refit via compute shader (blocked on Three.js read-write storage buffers)
- [ ] Background BLAS rebuild after refit when SAH quality degrades
- [ ] Compact Wide BVH (CWBVH) — 4/8-way branching for GPU traversal

### Profiling

- [ ] GPU timing measurements
- [ ] Memory usage tracking
- [ ] Bottleneck identification
- [ ] Performance regression tests

---

## Experiments

- [ ] Offscreen canvas rendering - <https://threejs.org/manual/#en/offscreencanvas>
- [ ] Ray-Guiding based on Octahedron Mapping CDF
- [ ] Interleaved Gradient Noise
- [ ] Primary ray from rasterization pass for path tracing
- [ ] Ray frustum culling
- [x] Two-level BVH with coarse top-level
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
- [ ] Experiment PLOC for maximum BVH performance scenarios
- [x] tiered-material-buffer-access generalization - already at its practical optimum
  
---

## AI Integration

- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] <https://upscalerjs.com/models/>
- [ ] <https://enhance.addy.ie/>

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

- WebGPU Graphics Pipeline: <https://shi-yan.github.io/webgpuunleashed/Introduction/the_gpu_pipeline.html>
- See [ROADMAP.md] for long-term vision and strategic planning
- See [CONTRIBUTING.md] for development guidelines
