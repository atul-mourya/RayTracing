# Rayzee Path Tracer - TODO List

## Bugs

### MVP

- [ ] scrutenize the implementation of SSRC
- [ ] scrutenize for which all stages are needed as default
- [ ] dispose, reset, etc life cycle for rayzee engine. 
- [ ] optimized 4k hdr enviroments
- [ ] single DOM parant for all mountings, tiles, denoisers etc
  
### Known

- [ ] some pixels show black in the first rendered frame even if it hits the environment map
- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] SSRC seen some pixel stretching artifacts in some scenes, need to investigate and fix,
- [ ] directional light not working from kronos test file: <https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/DirectionalLight/README.md>
- [ ] Switching to resolution, does the viewport resize operation but with a lot of latency.


### Unconfirmed

---

## Features

### Chores
- [ ] minimize unwanted dependencies - <https://github.com/atul-mourya/RayTracing/network/dependencies>
- [ ] lint fix
- [ ] enhance test coverage of the engine, use headless chrome if needed
- [ ] needs WebGPU, can't unit-test
- [ ] open issues by threejs <https://github.com/mrdoob/three.js/issues/32969> and 33061
- [ ] Create e2e test
- [ ] benckmark tooling specification and implementation


### General

- [ ] Introduce Project based workflow
- [ ] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] transform control redesign

### Compilation
- [ ] compileAsync for compute shader

### Rendering

- [ ] Subsurface scattering
- [ ] Volumetric rendering
- [ ] Caustic support
- [ ] Full WGSL transition, avoid TSL nodes
- [ ] Realtime OIDN denoising with WebGPU compute shader implementation
- [ ] Normal-dependent MIS compensation (Karlík et al. 2019, Eq. 13) — precompute 512 compensated env map CDFs indexed by surface normal for ~19% improvement over current normal-independent compensation on diffuse+HDR scenes
- [ ] ReSTIR DI (Bitterli et al. 2020) — spatiotemporal resampling for many-light scenes

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
- [ ] Supporting GPU-compressed texture arrays requires adding  per-scene format selection at build time - the TSL compiler doesn't support clean teardown/rebuild of compute pipelines when texture binding types change.

### Environment

- [ ] Environment cube map support for HDRIs
- [ ] Ground projection environment mapping
- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX
- [ ] Separate environment and background sampling with different textures (like Three.js)
- [ ] the output of gradient light should look like hemisphere light in threejs

### Scene Management

- [ ] Dynamic object addition and removal

### Animation

- [ ] animating lights support
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
- [ ] Use ColorUtils.setKelvin() for light temperature
- [ ] Opacity micro map
- [ ] Shader Execution Reordering
- [ ] Mega Geometries - Compressed Clusters as input to BLAS
- [ ] Mega Geometries - PTLAS - Partitioned TLAS
- [ ] SHaRC - Spatial Hash Radiance Cache - observed issues: transparent objects blocky, glowing reflictive materials, color bleeding, baised
- [ ] Rerservoir sampling ( only per pixel, not neighboring )
- [ ] emissive triangles as trianle lights -  do research
  
---

## AI Integration

- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] <https://upscalerjs.com/models/>
- [ ] <https://enhance.addy.ie/>
- [ ] NRD - Nvidia Realtime Denoiser

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
- The Future of Path Tracing | Best Practices, Optimizations & Future Standards <https://www.youtube.com/watch?v=0IrzX4LDIx8>
