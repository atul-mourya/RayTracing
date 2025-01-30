RayTracing Project TODO
=======================

🐛 Bugs & Issues
----------------

- [ ]  Fix transmission value changes not impacting transmission intensity
- [ ]  Improve denoiser performance with full resolution path tracing
- [ ]  albedomap for denioser not rendering non-albedo maps materials

✨ Core Features
---------------

- [ ]  Custom floor with shadow catcher
- [ ]  Transparent background support
- [ ]  Subsurface scattering implementation
- [ ]  Auto focus based on object distance
- [ ]  Volumetric rendering
- [ ]  Caustic support
- [ ]  High-res environment map selection
- [ ]  Custom environment map support
- [ ]  support download of denoised image
- [ ]  Auto exposure control - https://x.com/chriskwallis/status/1817041601274708240
- [ ]  implement support for point light
- [ ]  implement support for spot light
- [ ]  implement support for IES light
- [ ]  introduce viewports with different intents (preview, final render, etc)

🔧 Performance Improvements
---------------------------

- [ ]  Implement Dynamic BVH update
- [ ]  Implement offscreen canvas rendering - https://threejs.org/manual/#en/offscreencanvas
- [ ]  Refactor lights to use data texture instead of uniform buffer
- [ ]  Implement SDF-based model rendering
- [ ]  experiment with leveraging primary ray from rasterization pass for path tracing
- [ ]  experiment with ray frustum culling
- [ ]  refactor path tracing to use to use define instead of if-else

🎨 UI Enhancements
------------------

- [ ]  Add scene elements management
    - [ ]  Lights control
    - [ ]  Camera settings
    - [ ]  Material editor
- [ ]  upgrade to tailwind 4.0
- [ ]  migrate to react 19.0

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

📚 Research & Resources
-----------------------

### To Explore / Research

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

### Model Sources

-   <https://skfb.ly/oMGoU>
-   <https://api.physicallybased.info/operations/get-materials>

* * * * *

*Project Demo: <https://atul-mourya.github.io/RayTracing/>*
