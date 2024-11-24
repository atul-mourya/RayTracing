# RayTracing

Demo here https://atul-mourya.github.io/RayTracing/


## TODO:

### Bug:
- texture matrix transforms for metalnessmap not working

### Feature:

- auto focus based on object distance
- Scene based directional lights support
- scene based camera support,
- caustic support
- SAH based BVH
- wasm BVH https://github.com/madmann91/bvh
- BVH in compute shader using webgpu: https://x.com/AddisonPrairie/status/1823934213764341981
-  jump flood algorithm for non blocking UI interactions
- Object dynamic transformation changes
- material dynamic changes
- Hybrid Rendering
-  sheen, sheen roughness, etc
-  Explore Disney BSDF 
//https://schuttejoe.github.io/post/disneybsdf/

- oidn denioser https://github.com/DennisSmolek/Denoiser
- cleanup path tracer ui panel.
- group post processing effects customization elements in UI

### Refactor:
- WebGPU version using TSL 
- https://github.com/gnikoloff/webgpu-raytracer

### Resources and reads
https://blog.traverseresearch.nl/dynamic-diffuse-global-illumination-b56dc0525a0a
https://github.com/knightcrawler25/GLSL-PathTracer/tree/master


### Plan for Hybrid Rendering:
Here's how the hybrid approach works in practice:

- Initial Render: If rasterization is enabled, the scene is first rendered using traditional rasterization techniques. This provides an immediate, albeit less accurate, representation of the scene.
- Low-Resolution Path Tracing: A low-resolution path-traced version of the scene may be computed quickly and blended over the rasterized version.
- High-Resolution Path Tracing: The full resolution path tracing begins, progressively refining the image quality over multiple samples.
- Blending: As the path-traced image improves in quality (i.e., as more samples are computed), it is gradually blended over the initial rasterized or low-resolution path-traced image.
- Final Result: Eventually, the fully path-traced image replaces the initial render, providing a high-quality, physically accurate representation of the scene.




## model sources:
https://skfb.ly/oMGoU