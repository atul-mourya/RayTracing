# Rayzee Path Tracer - TODO List
*Immediate actionable items and development tasks*

## 🚨 Critical Bug Fixes

### Known Issues
- [ ] Soft shadows for directional lights not working when enabled from UI

### Code Quality & Performance
- [ ] **Performance Profiling**
  - [ ] GPU timing measurements
  - [ ] Memory usage tracking
  - [ ] Bottleneck identification
  - [ ] Performance regression tests

- [ ] **Code Organization**
  - [ ] Comprehensive test suite
  - [ ] Shader code architecture documentation.
  - [ ] Asset processing documentation.

---

## ✨ Immediate Features to Implement

### Advanced Rendering
- [ ] Implement Motion Vector Pass
- [ ] Implement Variance-based Firefly Suppression
- [ ] OIDN HDR denoising Support
- [ ] Transparent background support
- [ ] Subsurface scattering implementation
- [ ] Volumetric rendering
- [ ] Caustic support for direct lights
- [ ] Auto exposure control - https://x.com/chriskwallis/status/1817041601274708240
- [ ] Study dot grid / moiré–like effect and its impact on rendering

### Lighting & Materials
- [ ] Implement support for IES light
- [ ] Introduce tessellation free displacement mapping or parallax occlusion mapping
- [ ] Implement SDF-based model rendering
- [ ] Implement Shadow Catcher
- [ ] Implement ground projection environment mapping

### Performance & Architecture
- [ ] separate pipeline for path tracing related passes and helper related passes like tilehelper, outline, etc.
- [ ] Implement Dynamic BVH update
- [ ] Implement support for Radiance Caching (Screen-Space)
- [ ] Implement offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ] Refactor lights to use data texture instead of uniform buffer
- [ ] Experiment with leveraging primary ray from rasterization pass for path tracing
- [ ] Experiment with ray frustum culling
- [ ] Refactor path tracing to use define instead of if-else

### UX Enhancements
- [ ] Add dynamic camera addition and removal
- [ ] Add dynamic object addition and removal
- [ ] improve focus control - https://x.com/thefrontendcat/status/1885422008344903980
- [x] useHook - https://github.com/uidotdev/usehooks
- [ ] Estimated time remaining display

### BVH Construction Improvements
- [ ] BVH update / refit - https://claude.ai/share/e55132c8-758a-4117-b5ae-04d73e67351b
- [ ] Experiment with 4-way branching for GPU traversal
- [ ] Consider PLOC for maximum performance scenarios

---

*Last Updated: October 2025*
*See [ROADMAP.md] for long-term vision and strategic planning*

**Priority Legend:**
- 🚨 Critical bugs that need immediate attention
- ✨ New features ready for implementation
- 🔧 Technical improvements and optimizations

**Contributing:** See [CONTRIBUTING.md] for development guidelines
