RayTracing Project TODO
=======================

🐛 Bugs & Issues
----------------

- [ ]  active catalog item not being highlighted in the UI
- [ ]  drag and drop models retriggers the rendering blocking the UI and bvh generation delay
- [ ]  on model load, the canvas size changes
- [ ]  some meshes in outliner shows as group and i'm not able to activate material editor ( example bistro )
- [ ]  fullscreen canvas not working

✨ Core Features
---------------

- [ ]  Implement support for bumpmap
- [ ]  Transparent background support
- [ ]  Subsurface scattering implementation
- [ ]  Volumetric rendering
- [ ]  Caustic support
- [ ]  Auto exposure control - https://x.com/chriskwallis/status/1817041601274708240
- [ ]  Implement support for point light
- [ ]  Implement support for spot light
- [ ]  Implement support for IES light
- [ ]  Introduce tessalation free displacement mapping
- [ ]  Implement SDF-based model rendering
- [ ]  Implement Dynamic BVH update


🔧 Performance Improvements
---------------------------

- [ ]  Implement offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ]  Refactor lights to use data texture instead of uniform buffer
- [ ]  Experiment with leveraging primary ray from rasterization pass for path tracing
- [ ]  Experiment with ray frustum culling
- [ ]  Refactor path tracing to use define instead of if-else

🎨 UI Enhancements
------------------
- [ ]  Add dynamic lights addition and removal
- [ ]  Add dynamic camera addition and removal
- [ ]  Add dynamic object addition and removal
- [ ]  improve focus control - https://x.com/thefrontendcat/status/1885422008344903980

🔄 Major Refactoring
--------------------

- [ ]  Develop WebGPU version using TSL
    -   Reference: <https://github.com/gnikoloff/webgpu-raytracer>
- [ ]  Implement offscreen canvas rendering for non-blocking UI

🚀 Hybrid Rendering Implementation Plan
---------------------------------------

1.  Initial Render
    - [ ]  Implement rasterization-based first pass
    - [ ]  Set up initial scene representation
2.  Low-Resolution Path Tracing
    - [ ]  Implement quick low-res path tracing
    - [ ]  Set up blending with rasterized version
3.  High-Resolution Path Tracing
    - [ ]  Progressive refinement system
    - [ ]  Sample computation optimization
4.  Blending System
    - [ ]  Implement gradual blend between renders
    - [ ]  Quality-based transition controls

    https://claude.site/artifacts/5787ba64-d876-4b5c-a7ca-7bb7bbcf3765

📚 Research & Resources
-----------------------

### To Explore / Research

-   using rasterization to for enhanced ray tracing: https://chatgpt.com/share/67ff4b6a-ff0c-8003-89db-2a41cbec6cfd
-   Disney BSDF: <https://schuttejoe.github.io/post/disneybsdf/>
-   WASM BVH: <https://github.com/madmann91/bvh>
-   BVH in compute shader (WebGPU): <https://x.com/AddisonPrairie/status/1823934213764341981>
-   Dynamic Diffuse Global Illumination: <https://blog.traverseresearch.nl/dynamic-diffuse-global-illumination-b56dc0525a0a>
-   GLSL PathTracer Reference: <https://github.com/knightcrawler25/GLSL-PathTracer/tree/master>
-   Blue Noise Implementation:
    -   <https://www.shadertoy.com/view/wltcRS>
    -   <https://github.com/knightcrawler25/GLSL-PathTracer/blob/master/src/shaders/common/globals.glsl>
-   Color Science: <https://www.youtube.com/watch?v=II_rnWU7Uq8>
-   Examples: https://erichlof.github.io/THREE.js-PathTracing-Renderer/
-   explore different types and formats of blue noise textures: https://github.com/Calinou/free-blue-noise-textures/tree/master/256_256
-   Variable Rate Shading (VRS)
-   Real-Time OIDN denoising
-   TracerBoy - <https://github.com/wallisc/TracerBoy/blob/master/TracerBoy/RaytraceCS.hlsl>
-   https://www.youtube.com/watch?v=XIxKo8k81XY - Lumen DOES NOT Use Ray Tracing the Way You Think it Does
-   temporal variance adaptive sampling - https://chatgpt.com/c/680133d4-ed24-8003-b664-dd4fef735429
-   path guiding - https://www.youtube.com/watch?v=BS1JLbNqGxI

### Model Sources

-   <https://skfb.ly/oMGoU>
-   <https://api.physicallybased.info/operations/get-materials>
-   <https://repalash.com/archives>

* * * * *

*Project Demo: <https://atul-mourya.github.io/RayTracing/>*
