# RayTracing

Demo here https://atul-mourya.github.io/RayTracing/


## TODO:

### Bug:
- transmission value change does not impact the transmission intensity
- denoiser not working well with full resolution path tracing
- dispersion sometimes too harsh


### Feature:

- add custom floor with shadow catcher
- implement specular color support
- implement sheen color and sheen roughness support
- implement iridescence support
- implement subsurface scattering
- implement auto focus based on object distance
- implement Scene based directional lights support
- caustic support
- jump flood algorithm for non blocking UI interactions
- Object dynamic transformation changes
- Hybrid Rendering
- cleanup path tracer ui panel.
- group post processing effects customization elements in UI

### Refactor:
- WebGPU version using TSL 
- https://github.com/gnikoloff/webgpu-raytracer

### Resources and reads
- Explore Disney BSDF  https://schuttejoe.github.io/post/disneybsdf/
- wasm BVH https://github.com/madmann91/bvh
- BVH in compute shader using webgpu: https://x.com/AddisonPrairie/status/1823934213764341981
- https://blog.traverseresearch.nl/dynamic-diffuse-global-illumination-b56dc0525a0a
- https://github.com/knightcrawler25/GLSL-PathTracer/tree/master
- better blue noise https://www.shadertoy.com/view/wltcRS and https://github.com/knightcrawler25/GLSL-PathTracer/blob/master/src/shaders/common/globals.glsl

### Plan for Hybrid Rendering:
Here's how the hybrid approach works in practice:

- Initial Render: If rasterization is enabled, the scene is first rendered using traditional rasterization techniques. This provides an immediate, albeit less accurate, representation of the scene.
- Low-Resolution Path Tracing: A low-resolution path-traced version of the scene may be computed quickly and blended over the rasterized version.
- High-Resolution Path Tracing: The full resolution path tracing begins, progressively refining the image quality over multiple samples.
- Blending: As the path-traced image improves in quality (i.e., as more samples are computed), it is gradually blended over the initial rasterized or low-resolution path-traced image.
- Final Result: Eventually, the fully path-traced image replaces the initial render, providing a high-quality, physically accurate representation of the scene.




## model sources:
https://skfb.ly/oMGoU
https://api.physicallybased.info/operations/get-materials