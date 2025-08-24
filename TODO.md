# Rayzee Path Tracer - Development Roadmap
*Making the ultimate web-based path tracing application*

## 🎯 Vision & Goals
- **Performance:** Industry-leading real-time path tracing performance
- **Quality:** Production-grade rendering capabilities 
- **Usability:** Intuitive interface for artists and developers
- **Popularity:** Community-driven features and ecosystem

---

## 🚀 High Impact Features (Priority 1)

### WebGPU Migration & Performance
- [ ] **WebGPU Compute Shaders Implementation**
  - [ ] Port core path tracing to WebGPU compute for 3-5x performance boost
  - [ ] Implement multi-threaded BVH construction using compute shaders
  - [ ] Add GPU-accelerated denoising passes
  - [ ] Support WebGPU ray tracing extensions when available
  - [ ] Fallback system for WebGL2 compatibility

- [ ] **Advanced Hybrid Rendering Pipeline**
  - [ ] Rasterization + path tracing fusion for interactive previews
  - [ ] Temporal upsampling from low-res path tracing
  - [ ] Motion vector generation for better temporal stability
  - [ ] Depth-aware temporal accumulation

### Next-Generation Rendering Features
- [ ] **Volumetric Rendering & Atmosphere**
  - [ ] Heterogeneous volume rendering (clouds, smoke, fog)
  - [ ] Atmospheric scattering with multiple scattering
  - [ ] Participating media with anisotropic scattering
  - [ ] Volumetric lighting and shadows

- [ ] **Advanced Material System**
  - [ ] Disney BSDF 2.0 implementation
  - [ ] Subsurface scattering (BSSRDF)
  - [ ] Procedural material nodes/graph
  - [ ] Fabric/cloth shading models
  - [ ] Car paint and complex layered materials

- [ ] **Caustics & Advanced Light Transport**
  - [ ] Bidirectional path tracing (BDPT)
  - [ ] Photon mapping for caustics
  - [ ] Multiple importance sampling improvements
  - [ ] Light path caching and reuse

---

## 🎨 User Experience & Interface (Priority 1)

### Professional UI/UX Overhaul
- [ ] **Modern Node-Based Material Editor**
  - [ ] Visual material graph with real-time preview
  - [ ] Procedural texture generation nodes
  - [ ] Material library with PBR presets
  - [ ] Import/export material definitions

- [ ] **Scene Management & Asset Pipeline**
  - [x] Hierarchical scene outliner with search/filter
  - [x] Asset browser with thumbnails and metadata
  - [x] Drag-and-drop import from various formats
  - [ ] Scene templates and presets
  - [ ] Version control integration (Git LFS)

- [ ] **Advanced Camera Controls**
  - [ ] Cinema-grade camera with physical parameters
  - [x] Multiple camera views and switching
  - [ ] Camera animation and keyframing
  - [ ] Virtual camera with gamepad support

### Rendering Management
- [ ] **Render Queue & Batch Processing**
  - [ ] Background rendering with progress tracking
  - [ ] Render queue management
  - [ ] Distributed rendering across multiple devices
  - [ ] Cloud rendering integration (optional)

- [ ] **Advanced Denoising Pipeline**
  - [ ] Real-time OIDN with WebAssembly optimization
  - [x] Temporal denoising (SVGF/A-SVGF improvements)
  - [ ] Machine learning denoising models
  - [ ] Custom denoising parameter profiles

---

## 🔧 Technical Excellence (Priority 2)

### Performance Optimization
- [ ] **Next-Gen BVH & Acceleration**
  - [ ] GPU-accelerated BVH construction
  - [x] Compressed wide BVH (CWBVH) implementation
  - [ ] Dynamic BVH updates for animated scenes
  - [ ] Ray frustum culling
  - [ ] Primitive specialization (curves, volumes)

- [ ] **Memory & Bandwidth Optimization**
  - [ ] Texture compression and streaming
  - [ ] Geometry level-of-detail (LOD)
  - [ ] Occlusion culling
  - [ ] Smart caching strategies

### Advanced Sampling & Convergence
- [ ] **Intelligent Sampling**
  - [ ] Adaptive sampling 2.0 with ML guidance
  - [x] Variance-guided sample distribution
  - [ ] Importance sampling for complex lighting
  - [x] Blue noise sampling optimization

- [ ] **Convergence Acceleration**
  - [ ] Reservoir sampling (ReSTIR)
  - [ ] Path guiding implementation
  - [ ] Radiance caching
  - [ ] Temporal sample reuse

---

## 🌍 Content & Ecosystem (Priority 2)

### Asset Integration
- [ ] **Comprehensive Format Support**
  - [ ] USD/OpenUSD integration
  - [ ] Blender direct integration
  - [ ] Houdini/Maya plugin development
  - [ ] Standard material exchange formats

- [ ] **Built-in Asset Library**
  - [ ] Curated high-quality 3D models
  - [x] HDR environment collection (8K+)
  - [x] Material library with physical accuracy
  - [ ] Procedural content generation

### Community Features
- [ ] **Sharing & Collaboration**
  - [ ] Cloud scene sharing platform
  - [ ] Render gallery with voting/comments
  - [ ] Scene remix and derivative works
  - [ ] Educational content and tutorials

---

## � Platform & Distribution (Priority 2)

### Multi-Platform Support
- [ ] **Desktop Applications**
  - [ ] Electron-based desktop wrapper
  - [ ] Native file system access
  - [ ] Better performance profiles
  - [ ] Offline capabilities

- [ ] **Mobile Optimization**
  - [ ] Progressive Web App (PWA)
  - [ ] Touch-optimized interface
  - [ ] Mobile-specific performance modes
  - [ ] iOS/Android app store presence

### Developer Experience
- [ ] **Plugin Architecture**
  - [ ] JavaScript plugin system
  - [ ] Custom render passes
  - [ ] Material and light plugins
  - [ ] API for third-party integrations

- [ ] **Documentation & Learning**
  - [ ] Interactive tutorials
  - [ ] API documentation
  - [ ] Video tutorial series
  - [ ] Technical blog posts

---

## 🎓 Educational & Research (Priority 3)

### Learning Tools
- [ ] **Educational Mode**
  - [ ] Step-by-step rendering visualization
  - [ ] Algorithm explanations
  - [ ] Performance profiling tools
  - [ ] Academic research integration

- [ ] **Research Features**
  - [ ] Custom BRDF implementation
  - [ ] Experimental rendering techniques
  - [ ] Performance benchmarking suite
  - [ ] Research paper reproduction

### Industry Integration
- [ ] **Production Pipeline**
  - [ ] Color management (ACES workflow)
  - [ ] Multi-pass rendering (AOVs)
  - [ ] Batch rendering automation
  - [ ] Integration with render farms

---

## 🐛 Critical Bug Fixes & Improvements

### Known Issues
- [ ] some meshes in outliner shows as group and i'm not able to activate material editor (example bistro)
- [ ] wip tile rendering - https://claude.ai/chat/47f754db-f674-4965-849e-5afa2748dc8b
- [ ] after each tile rendering cycle, the rendered image is becomes dim/low quality

### Code Quality
- [ ] **Performance Profiling**
  - [ ] GPU timing measurements
  - [ ] Memory usage tracking
  - [ ] Bottleneck identification
  - [ ] Performance regression tests

- [ ] **Code Organization**
  - [ ] TypeScript migration for better maintainability
  - [ ] Comprehensive test suite
  - [ ] CI/CD pipeline with automated testing
  - [ ] Code documentation and examples

---

## ✨ Core Features

### Advanced Rendering
- [ ] OIDN HDR denoising Support
- [ ] Transparent background support
- [ ] Subsurface scattering implementation
- [ ] Volumetric rendering
- [ ] Caustic support for direct lights
- [ ] Auto exposure control - https://x.com/chriskwallis/status/1817041601274708240
- [ ] Study dot grid / moiré–like effect and its impact on rendering

### Lighting & Materials
- [x] Implement support for point light
- [x] Implement support for spot light
- [ ] Implement support for IES light
- [ ] Introduce tessellation free displacement mapping
- [ ] Implement SDF-based model rendering
- [ ] Implement Shadow Catcher
- [ ] Implement ground projection environment mapping
- [ ] Implement Bidirectional Path Tracing mode

### Performance & Architecture
- [ ] separate pipeline for path tracing related passes and rasterization related passes like tilehelper, bloom, outline, etc.
- [ ] Implement Dynamic BVH update
- [ ] Implement support for Radiance Caching
- [ ] Implement offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ] Refactor lights to use data texture instead of uniform buffer
- [ ] Experiment with leveraging primary ray from rasterization pass for path tracing
- [ ] Experiment with ray frustum culling
- [ ] Refactor path tracing to use define instead of if-else

### UX Enhancements
- [ ] Add dynamic lights addition and removal
- [ ] Add dynamic camera addition and removal
- [ ] Add dynamic object addition and removal
- [ ] improve focus control - https://x.com/thefrontendcat/status/1885422008344903980
- [x] useHook - https://github.com/uidotdev/usehooks
- [x] **Recent searches dropdown in catalog with clear button**
- [x] **Keyboard shortcuts: Esc (deselect), R (reset camera), Space (play/pause)**
- [x] Star/heart button on each catalog item
- [ ] Estimated time remaining display
- [x] **Model polycount information**

### BVH Construction Improvements
- [ ] BVH update / refit - https://claude.ai/share/e55132c8-758a-4117-b5ae-04d73e67351b
- [ ] Experiment with 4-way branching for GPU traversal
- [ ] Consider PLOC for maximum performance scenarios

---

## 🎯 Success Metrics & Milestones

### Performance Targets
- **Interactive:** 60 FPS at 1080p with 3 bounces
- **Progressive:** 1024 SPP convergence in <30 seconds
- **Quality:** Match offline renderers in visual quality

### User Adoption Goals
- **Community:** 10K+ users, 1K+ GitHub stars
- **Content:** 1K+ shared scenes, 500+ materials
- **Education:** Used in 50+ courses/tutorials

### Technical Milestones
- **Q2 2025:** WebGPU beta release
- **Q3 2025:** Volumetric rendering
- **Q4 2025:** Production pipeline tools
- **Q1 2026:** Mobile optimization

---

## 📊 Implementation Strategy

### Phase 1 (Immediate - 3 months)
1. WebGPU proof of concept
2. UI/UX improvements 
3. Critical bug fixes
4. Performance profiling setup

### Phase 2 (Short term - 6 months)  
1. Volumetric rendering
2. Advanced materials
3. Asset pipeline
4. Community features

### Phase 3 (Medium term - 12 months)
1. Full WebGPU migration
2. Mobile optimization  
3. Desktop applications
4. Production tools

---

## 📚 Research & Resources

### Technical References
- Disney BSDF: <https://schuttejoe.github.io/post/disneybsdf/>
- WASM BVH: <https://github.com/madmann91/bvh>
- BVH in compute shader (WebGPU): <https://x.com/AddisonPrairie/status/1823934213764341981>
- Dynamic Diffuse Global Illumination: <https://blog.traverseresearch.nl/dynamic-diffuse-global-illumination-b56dc0525a0a>
- GLSL PathTracer Reference: <https://github.com/knightcrawler25/GLSL-PathTracer/tree/master>
- Adventures in Hybrid Rendering: https://diharaw.github.io/post/adventures_in_hybrid_rendering/

### Blue Noise & Sampling
- <https://www.shadertoy.com/view/wltcRS>
- <https://github.com/knightcrawler25/GLSL-PathTracer/blob/master/src/shaders/common/globals.glsl>
- https://github.com/Calinou/free-blue-noise-textures/tree/master/256_256

### Advanced Techniques
- Color Science: <https://www.youtube.com/watch?v=II_rnWU7Uq8>
- TracerBoy - <https://github.com/wallisc/TracerBoy/blob/master/TracerBoy/RaytraceCS.hlsl>
- Lumen Ray Tracing: https://www.youtube.com/watch?v=XIxKo8k81XY
- Path guiding: https://www.youtube.com/watch?v=BS1JLbNqGxI
- https://github.com/Pjbomb2/TrueTrace-Unity-Pathtracer
- OIDN Denoiser: https://blog.traverseresearch.nl/denoising-raytraced-images-using-oidn-f6566d605453

### Asset Sources
- <https://skfb.ly/oMGoU>
- <https://api.physicallybased.info/operations/get-materials>
- <https://repalash.com/archives>
- [High Poly models]<https://sketchfab.com/RaphaelDay/collections/backgrounds-e025877a5574455b8f5863da7dc6fb05>

---

*Last Updated: January 2025*
*Current Version: 1.59.4*
*Project Demo: <https://atul-mourya.github.io/RayTracing/>*

**Contributing:** See [CONTRIBUTING.md] for development guidelines
**Discussions:** Join our community discussions for feature requests and feedback
