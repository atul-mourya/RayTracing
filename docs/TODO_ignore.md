RayTracing Project TODO
=======================

🐛 Bugs & Issues
----------------

✨ Core Features
---------------

- [ ]  Subsurface scattering implementation
- [ ]  Volumetric rendering
- [ ]  Caustic support for direct lights
- [ ]  Implement support for IES light
- [ ]  Implement SDF-based model rendering
- [ ]  Implement Dynamic BVH update
- [ ]  Implement Shadow Catcher
- [ ]  Implement ground projection environment mapping
- [ ]  Implement Bidirectional Path Tracing mode



🔧 Performance Improvements
---------------------------

- [ ]  Implement offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ]  Experiment with leveraging primary ray from rasterization pass for path tracing
- [ ]  Experiment with ray frustum culling

🎨 UX Enhancements
------------------
- [ ]  Add dynamic camera addition and removal
- [ ]  Add dynamic object addition and removal
- [ ]  Estimated time remaining
- [ ]  More to do https://claude.ai/chat/70c8cdf7-519e-4d1f-a889-c226c707dd46

BVH Construction Improvements
-----------------------------
- [ ]  BVH update / refit - https://claude.ai/share/e55132c8-758a-4117-b5ae-04d73e67351b
- [ ]  Experiment with 4-way branching for GPU traversal
- [ ]  Consider PLOC only if you need maximum performance and can invest in the more complex implementation

🔄 Major Refactoring
--------------------
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

Adventures in Hybrid Rendering: https://diharaw.github.io/post/adventures_in_hybrid_rendering/

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
-   https://github.com/Pjbomb2/TrueTrace-Unity-Pathtracer
-   Behind the scene - OIDN Denoiser https://blog.traverseresearch.nl/denoising-raytraced-images-using-oidn-f6566d605453

### Model Sources

-   <https://skfb.ly/oMGoU>
-   <https://api.physicallybased.info/operations/get-materials>
-   <https://repalash.com/archives>
-   [HIGH Poly models]<https://sketchfab.com/RaphaelDay/collections/backgrounds-e025877a5574455b8f5863da7dc6fb05>

* * * * * *

*Project Demo: <https://atul-mourya.github.io/RayTracing/>*
