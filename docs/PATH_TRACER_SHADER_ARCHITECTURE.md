# Path Tracer Shader Architecture

Rayzee Path Tracing Engine – Internal Shader Design (PathTracer Stage Only)

---

## Scope & Exclusions

This document covers the real-time path tracing stage shader system for the **WebGPU backend (TSL)**. The legacy WebGL/GLSL backend (`rayzee/src/Shaders/`) has been fully removed — the codebase is now WebGPU-only.

TSL (Three Shading Language) is a JavaScript-based shader authoring system that compiles to WGSL at runtime via Three.js's WebGPU backend. All 25 shader modules live in `rayzee/src/TSL/`.

Explicitly excluded (refer to separate docs):
- Denoisers (ASVGF, EdgeAwareFiltering, BilateralFiltering)
- Post-processing (Bloom, Tone mapping, AutoExposure)
- Screen Space Radiance Caching (SSRC — separate stage)
- Adaptive sampling pass implementation details (we only describe how the path tracer consumes its texture)
- Debug visualization passes beyond in-shader `visMode`
- Backend switching and state management (see `PIPELINE_ARCHITECTURE.md`)

---

## High-Level Overview

The path tracing shader performs Monte Carlo integration of the rendering equation using multiple importance sampling (MIS) across material lobes and (optionally) an importance-sampled environment map or light BVH for direct lighting. It outputs three Multiple Render Targets (MRT):

- `gColor` (rgba): RGB radiance + A channel repurposed as an edge/sharpness flag for temporal/spatial passes.
- `gNormalDepth` (rgba): World-space normal (xyz, 0–1 packed) + linear ray distance (a).
- `gAlbedo` (rgba): Denoiser albedo buffer (RGB) + alpha.

Key features:
- Progressive accumulation with temporal blending.
- Adaptive sampling integration per pixel (variable samples per frame).
- Stratified + selectable random sequence generation (PCG / Halton / Sobol / Blue Noise).
- High-performance stack-based BVH traversal with material visibility caching.
- Physically-based material system with multi-lobe MIS (diffuse, specular, clearcoat, transmission, sheen, iridescence).
- Environment importance sampling using a 2D marginal + conditional CDF texture (with multi-resolution PDF handling).
- Light BVH for stochastic emissive triangle sampling via tree traversal.
- Depth of field (physical aperture sampling) and camera jitter for anti-aliasing.
- Firefly mitigation and confidence scoring in environment sampling.
- Edge detection on primary rays for downstream temporal filters.

---

## Module Map (`rayzee/src/TSL/`)

Every TSL file uses `Fn()`, `If()`, `Loop()`, `.toVar()`, `.assign()`, and proxy-enhanced structs. No raw `wgslFn()` is used in the hot path.

| TSL Module | Key Exports | Role |
|---|---|---|
| `PathTracer.js` | `pathTracerMain()`, `getRequiredSamples()`, `dithering()`, `computeNDCDepth()` | Main sample loop, MRT outputs, accumulation |
| `PathTracerCore.js` | `Trace()`, `TraceResult` struct | Bounce loop, russian roulette, BRDF sampling |
| `BVHTraversal.js` | `traverseBVH()` | Stack-based BVH traversal |
| `RayIntersection.js` | `RayTriangle()` | Möller–Trumbore ray-triangle intersection |
| `MaterialSampling.js` | `sampleMaterialWithMultiLobeMIS()`, `generateSampledDirection()` | Multi-lobe MIS, GGX, VNDF sampling |
| `MaterialEvaluation.js` | `evaluateMaterialResponse()` | Combines BRDF components |
| `MaterialProperties.js` | `calculateBRDFWeights()` | BRDF weight calculation, PDF computation |
| `MaterialTransmission.js` | `sampleMicrofacetTransmission()` | Refraction, volumetric transmission |
| `Clearcoat.js` | `sampleClearcoat()` | Clearcoat BRDF layer |
| `Environment.js` | `sampleEnvironmentWithContext()`, `calculateEnvironmentPDFWithMIS()` | HDR importance sampling, direction↔UV |
| `EmissiveSampling.js` | `sampleEmissiveTriangle()` | NEE from emissive triangles (non-BVH path) |
| `LightBVHSampling.js` | `sampleLightBVHTriangle()` | Stochastic light BVH traversal for emissive sampling |
| `LightsCore.js` | Light data structs | Light type definitions (Directional, Point, Spot, Area) |
| `LightsDirect.js` | `evaluateDirectLighting()` | Direct lighting with shadow rays |
| `LightsIndirect.js` | `evaluateIndirectLighting()` | Multi-strategy MIS for GI |
| `LightsSampling.js` | `selectAndSampleLight()` | Light selection, unified direct lighting |
| `Fresnel.js` | `schlickFresnel()` | Schlick Fresnel, IOR↔F0 |
| `Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `sampleBlueNoise2D()` | PCG, Halton, Sobol, Blue Noise |
| `TextureSampling.js` | `sampleMaterialTexture()` | UV transforms, material texture arrays |
| `Displacement.js` | `sampleDisplacement()` | Height sampling, ray-marched displacement |
| `Debugger.js` | `TraceDebugMode()` | Debug visualization modes |
| `Struct.js` | `Ray`, `HitInfo`, `RayTracingMaterial`, `EmissiveSample`, etc. | GPU-side struct definitions |
| `Common.js` | `getDatafromDataTexture()`, constants | Shared constants, texture data accessors |
| `SSRC.js` | SSRC cache fetch | Screen Space Radiance Caching integration (consumed by PathTracerCore) |
| `structProxy.js` | `structProxy()` factory | Proxy factory for dot-notation struct access in TSL |

---

## Render Targets & Output Semantics

MRT layout (3 outputs per ping-pong pair, managed by `PathTracer.js`):

```
textures[0] = gColor      // RGB accumulated radiance + A = pixelSharpness (edge flag)
textures[1] = gNormalDepth // World-space normal (xyz, 0..1) + linear ray distance (a)
textures[2] = gAlbedo     // Albedo (RGB) + alpha — for denoiser input
```

Edge/sharpness flag (alpha of `gColor`) is computed from normal variation, object ID `fwidth`, and color derivative to assist temporal rejection.

Depth in `gNormalDepth.a` stores **linear ray distance** (hit.dst), NOT NDC depth. Downstream passes must reconstruct world position via camera ray + linear depth.

---

## Uniform Groups (JS → GPU Data Flow)

Uniforms are initialized and maintained in `PathTracer.js` (~3000 lines). Principal categories:

1. **Camera & DOF:**
   - `cameraWorldMatrix`, `cameraProjectionMatrixInverse`, `cameraViewMatrix`, `cameraProjectionMatrix`
   - `enableDOF`, `focusDistance`, `focalLength`, `aperture`, `apertureScale`

2. **Frame & Control:**
   - `frame`, `maxBounces`, `samplesPerPixel`, `maxSamples`, `transmissiveBounces`, `renderMode`

3. **Accumulation:**
   - `previousAccumulatedTexture`, `enableAccumulation`, `accumulationAlpha`, `cameraIsMoving`, `hasPreviousAccumulated`

4. **Sampling:**
   - `samplingTechnique` (0=PCG, 1=Halton, 2=Sobol, 3=BlueNoise)
   - `blueNoiseTexture`, `blueNoiseTextureSize`

5. **Adaptive Sampling:**
   - `useAdaptiveSampling`, `adaptiveSamplingTexture`, `adaptiveSamplingMax`

6. **Environment:**
   - `enableEnvironment`, `environment`, `environmentIntensity`, `environmentMatrix`
   - `useEnvMapIS`, `envCDF`, `envCDFSize` (`envResolution`), `envTotalSum` (`envMapTotalLuminance`)
   - `useEnvMipMap`, `envSamplingBias`, `maxEnvSamplingBounce`, `fireflyThreshold`, `exposure`, `backgroundIntensity`, `showBackground`

7. **Lighting:**
   - `numDirectionalLights`, `numPointLights`, `numSpotLights`, `numAreaLights`
   - `directionalLights`, `pointLights`, `spotLights`, `areaLights`
   - `globalIlluminationIntensity`

8. **Emissive Triangles:**
   - `enableEmissiveTriangleSampling`, `emissiveTriangleCount`, `emissiveTotalPower`, `emissiveBoost`
   - `emissiveTriangleTexture`, `emissiveTriangleTexSize`

9. **Light BVH:**
   - `lightBVHNodeCount` — number of nodes in the light BVH
   - `lightBVHStorageNode` — StorageBuffer containing packed BVH node data

10. **Geometry & Material Data Textures:**
    - `triangleTexture`, `bvhTexture`, `materialTexture`
    - Sizes: `triangleTexSize`, `bvhTexSize`, `materialTexSize`
    - Counts: `totalTriangleCount`

11. **Material Sampler Arrays (actual textures):**
    - `albedoMaps`, `emissiveMaps`, `normalMaps`, `roughnessMaps`, `metalnessMaps`, `bumpMaps`, `displacementMaps`

12. **Debug:**
    - `visMode`, `debugVisScale`

All uniform updates that influence sampling or accumulation trigger a pipeline reset (frame counter back to 0) to avoid temporal contamination.

---

## Data Textures & GPU Layouts

### Triangle Data (`triangleTexture`)
Compact, vec4-aligned 8-slot layout (32 floats per triangle, from `Constants.js`):
1. posA.xyz (pad)
2. posB.xyz (pad)
3. posC.xyz (pad)
4. normalA.xyz (pad)
5. normalB.xyz (pad)
6. normalC.xyz (pad)
7. uvA.xy, uvB.xy
8. uvC.xy, materialIndex, meshIndex

### BVH Nodes (`bvhTexture`)
Three vec4 slots per node:
1. boundsMin.xyz, leftChildIndex
2. boundsMax.xyz, rightChildIndex
3. (leaf only): triStart, triCount, padding, padding

Traversal reduces reads by only fetching slot 3 for leaf nodes.

### Material Data (`materialTexture`)
Packed per-material properties across multiple pixels (27 floats per material). Hot-path subsets:
- Base: color (rgb), metalness, emissive (rgb), roughness, ior, transmission, thickness, emissiveIntensity
- Volumetric & attenuation: attenuationColor (rgb), attenuationDistance, dispersion
- Visibility & classification: visible, sheen, sheenRoughness, sheenColor (rgb)
- Specular & iridescence: specularIntensity, specularColor (rgb), iridescence, iridescenceIOR, iridescenceThicknessRange
- Clearcoat: clearcoat, clearcoatRoughness
- Alpha and side flags: opacity, side, transparent, alphaTest, alphaMode, depthWrite
- Normal/bump/displacement scaling: normalScale (vec2), bumpScale, displacementScale

### Emissive Triangles (`emissiveTriangleTexture`)
Texture storing emissive triangle indices and energy for direct emissive sampling. Used by `EmissiveSampling.js` (uniform CDF path) and as a fallback when Light BVH is disabled.

### Light BVH (`lightBVHStorageNode`)
StorageBuffer containing packed BVH node data built by `LightBVHBuilder.js`. Structure: each node holds child indices (or leaf triangle info), bounding box, and accumulated power metrics for stochastic traversal weight computation.

### Environment CDF (`envCDF`)
2D texture encoding marginal CDF (last row) and conditional CDF + corresponding PDFs in channels (R/G). Used for importance sampling inversion in `Environment.js`.

---

## Execution Flow (Shader `pathTracerMain()`)

1. Compute `screenPosition` (NDC) and initialize pixel accumulator.
2. Derive base RNG seed per pixel/frame via `getDecorrelatedSeed`.
3. Determine per-pixel sample count:
   - Start with `samplesPerPixel`.
   - If adaptive sampling active and past warmup frames, read `adaptiveSamplingTexture` → possibly reduce to 0 (converged) or clamp within `[1, adaptiveSamplingMax]`.
   - Guarantee at least one sample if accumulation fallback unavailable.
4. Loop over samples:
   - Derive stratified (and optionally blue noise) jitter for subpixel AA → jittered primary ray origin.
   - Generate camera ray via `cameraWorldMatrix` + `cameraProjectionMatrixInverse` with DOF blur if enabled.
   - Either call `TraceDebugMode` (visual diagnostic) or full `Trace` path integrator.
   - For first primary sample: record hit normal / color / object ID for edge detection and MRT normal/depth/albedo.
   - Accumulate radiance and sample count.
5. Average accumulated radiance; apply dithering.
6. Edge detection via `fwidth` on normal/object/color → set alpha channel.
7. Temporal accumulation blend if enabled: previous accumulated color + new sample weighted by `accumulationAlpha` (disabled during interaction / camera motion).
8. Output `gColor`, `gNormalDepth`, and `gAlbedo`.

The iterative bounce loop resides inside `Trace` (from `PathTracerCore.js`), which performs:
   - Intersection via `traverseBVH`
   - Material classification & caching
   - Direct light / emissive evaluation (uniform sampling or Light BVH)
   - Environment hit termination or continuation
   - Russian roulette or depth termination using `maxBounces` & `transmissiveBounces`
   - MIS between emissive, material lobes, environment contributions

---

## Light BVH Architecture (`LightBVHSampling.js`)

The Light BVH accelerates emissive triangle sampling by organizing emissive triangles into a power-weighted BVH. This replaces uniform CDF sampling for scenes with many emissive objects.

### Stochastic Tree Traversal
`sampleLightBVHTriangle()` performs a single-path stochastic descent:
1. Start at root node.
2. At each internal node: compute selection probability for each child based on accumulated power and distance² to shading point.
3. Sample one child proportional to its weight; track the traversal probability.
4. At leaf: sample a triangle proportional to its power within the leaf.
5. Return `EmissiveSample` with position, normal, power, and composite PDF for MIS.

### Integration
Light BVH sampling is selected when `lightBVHNodeCount > 0`. The composite PDF accounts for both tree-traversal probabilities and per-triangle sampling. MIS weight combines this with the BRDF lobe PDF.

### Builder
`LightBVHBuilder.js` (in `rayzee/src/Processor/`) constructs the BVH off-thread using SAH-like power splitting. `PathTracer.setLightBVHData()` uploads the packed node buffer.

---

## Random Sampling Architecture (`Random.js`)

### Techniques
`samplingTechnique` selects generator:
- `0` — PCG (high quality, general-purpose)
- `1` — Halton (low-discrepancy, Owen-scrambled)
- `2` — Sobol (Owen-scrambled 32-bit direction vectors)
- `3` — Blue Noise (spatial/temporal correlated dithering)

### Hybrid Strategies
- Stratified sampling subdivides pixel into grid cells for multi-sample anti-aliasing.
- Blue noise integration: progressive slice selection for temporal stability; Cranley-Patterson rotation for decorrelation.
- Fast RNG path (`RandomValueFast`) used in non-critical jitter to save cycles (e.g., DOF disk sampling).

### Seeding
`getDecorrelatedSeed(pixelCoord, rayIndex, frame)` mixes multiple large primes and combined hashes (PCG + Wang) to avoid frame-to-frame correlation.

### Multi-Dimensional Interface
`getRandomSampleND` returns up to 4D sample vectors with technique-specific mapping, feeding BRDF sampling, DOF, and other stochastic processes.

---

## BVH Traversal (`BVHTraversal.js`)

Highlights:
- Reduced stack size (24) for typical scene depth; iterative explicit stack.
- Axis-aligned ray handling avoids division by zero using large sentinel values.
- Texture access minimization: fetch node slots 0–1 for bounds, slot 2 only for leaf.
- Early pruning: compare min distance of child bounds with current closest hit distance.
- Near/far ordering pushes far child first → processes near child immediately (depth-first).
- Per-ray visibility cache (`visCache`) prevents redundant material visibility fetches (~30% texture read reduction).
- Two-stage visibility:
  1. Fast check (cached) for early rejection.
  2. Full side culling (front/back/double) only if potential closest hit.
- Shadow ray early termination path (any hit suffices).

### Intersection
`RayTriangle` from `RayIntersection.js` performs barycentric intersection returning distance, normal, and barycentrics after interpolation of per-vertex normals & UVs.

---

## Material Sampling & Evaluation

### Classification & PathState Caching
`getOrCreateMaterialClassification` caches classification (metallic, transmissive, smooth, etc.) and invalidates dependent caches if material changes between bounces.

### BRDF Weights
`calculateBRDFWeights` computes per-lobe base weights using roughness, metalness, IOR, sheen color intensity and cached derived factors. Results stored in `PathState` for reuse within the same bounce chain.

### Multi-Lobe MIS Sampling
`sampleMaterialWithMultiLobeMIS` selects one lobe based on normalized weights (diffuse, specular, clearcoat, transmission, sheen, iridescence). For each lobe:
- Direction sampling: cosine hemisphere, GGX importance sampling (VNDF or standard), microfacet transmission, or fallback diffuse.
- Per-lobe PDF computed (GGX: `D * G1 * VoH / (NoV * 4)`; diffuse: `NoL / π`).
- Global MIS weight via `calculateMultiLobeMISWeight` evaluating hypothetical PDFs of all lobes; power heuristic applied.

### Single-Lobe Fast Path
`generateSampledDirection` provides an optimized path for materials below complexity thresholds (no significant clearcoat/transmission/iridescence), reducing overhead by avoiding full multi-lobe enumeration.

### Transmission
`sampleMicrofacetTransmission` handles refractive events, with total internal reflection fallback to specular reflectance and dispersion support (thin approximation).

### Evaluation
`evaluateMaterialResponse(V, L, N, material)` combines diffuse (Lambert), microfacet specular (GGX D/G/F), transmission, sheen, clearcoat, and iridescence contributions ensuring proper albedo/mask weighting. PDFs are stabilized with `MIN_PDF` guard to avoid NaNs.

---

## Environment Importance Sampling (`Environment.js`)

### CDF-Based Sampling
- 2D sampling via inversion of marginal (row) and conditional (column) CDF stored in `envCDF`.
- Binary search reduced to 8 iterations (handles up to 256 entries efficiently) with interpolation to prevent bright-spot bias.

### Direction Conversion
`directionToUV` and `uvToDirection` map between spherical and UV space applying an `environmentMatrix` rotation (user settable for HDRI rotation).

### Quality & Mip Selection
- Bounce & material classification choose mip level and adaptive bias.
- Branch-free material quality index reduces ALU divergence (integer arithmetic).
- Higher bounces → coarser mip improving convergence.

### PDF Calculation
`calculateEnvironmentPDFWithMIS(direction, roughness)` uses roughness-dependent mip LOD; luminance normalized by `envTotalSum`; spherical Jacobian applied; clamped to prevent extremes.

### Firefly Mitigation
Importance (luminance / pdf) clamped only on deep bounces (after bounce 4) with gentle scaling preserving highlights.

---

## Adaptive Sampling Integration

The `AdaptiveSampling` stage produces `adaptiveSamplingTexture` (RGBA containing normalized sample counts and convergence flags). In shader:

```js
// TSL equivalent
const samplingData = texture(adaptiveSamplingTexture, texCoord);
If(samplingData.z.greaterThan(0.5), () => { /* converged — skip */ });
```

`getRequiredSamples` translates normalized value to integer within `[1, adaptiveSamplingMax]`. Zero-sample pixels only occur when accumulation fallback is valid; otherwise forces at least one sample to prevent stale output.

---

## Accumulation & Temporal Blending

- Shader receives `previousAccumulatedTexture` and blends:
  `finalColor = previous + (current - previous) * accumulationAlpha`
- Alpha computed CPU-side (`calculateAccumulationAlpha` from `utils.js`) factoring frame count, tile progression, and interaction resets.
- Accumulation disabled during camera interaction (`cameraIsMoving`), preventing low-quality smear; re-enabled immediately after exit with prior result retained.

Edge flag (A in `gColor`) *always* recalculated, ensuring temporal passes have accurate structural guides even on converged or reused pixels.

---

## Edge Detection (Primary Ray Feature Extraction)

Uses `fwidth` over normal components, object ID, and color derivative to classify `pixelSharpness`:
- High normal gradient → edge
- Object ID discontinuity → edge
- Non-zero color derivative → edge

If any condition is met → alpha = 1, else 0. This feeds ASVGF and EdgeAwareFiltering stages.

---

## TSL Authoring Patterns

### Function Definition
```js
const myFunction = Fn(([param1, param2]) => {
    const result = float(0.0).toVar();
    If(param1.greaterThan(0.0), () => {
        result.assign(param1.mul(param2));
    });
    return result;
});
```

### Key Patterns vs GLSL

| Aspect | GLSL (removed) | TSL (current) |
|---|---|---|
| Language | Text `.fs` files | JS functions → WGSL |
| Structs | `struct HitInfo { ... }` | `structProxy()` with Proxy |
| Uniforms | `uniform float exposure` | `uniform(1.0, 'float')` node objects |
| Loops | `for (int i = 0; ...)` | `Loop(count, ({ i }) => { ... })` |
| Branching | `if (x > 0)` | `If(x.greaterThan(0), () => { ... })` |
| If/Else chains | `if/else if/else` | `If().ElseIf().Else()` — must chain, not separate `If()` blocks |
| MRT | `layout(location=0) out vec4` | Return object `{ gColor, gNormalDepth, gAlbedo }` |
| Includes | `#include <module.fs>` | ES module `import` |

> **Critical**: Use chained `If().ElseIf().Else()` for exclusive branches. Separate `If()` blocks generate independent WGSL `if` statements where inactive branches can contaminate output through texture samples.

### Uniform Management

Uniforms are `uniform()` node objects managed by `PathTracer.js`:

```js
// PathTracer.js constructor
this.maxBounces = uniform(DEFAULT_STATE.bounces, 'int');
this.exposure = uniform(DEFAULT_STATE.exposure, 'float');
this.cameraWorldMatrix = uniform(mat4());

// Setter methods update uniform values
setMaxBounces(bounces) {
    this.maxBounces.value = bounces;
}
```

### outputNode vs colorNode
Always use `material.outputNode = shader()` (not `material.colorNode`) for technical render passes that store data in the `.w` channel. `colorNode` forces `alpha=1.0` for opaque materials, destroying any data in the alpha channel (depth, history length, validity flags).

---

## Debug Modes (`visMode`)

Non-zero modes may invoke `TraceDebugMode` for heatmaps (triangle/box test counts, distances, etc.) or short-circuit standard path tracing entirely (e.g., mode 5 returns stratified jitter pattern). Intentionally isolated to avoid polluting main integrator performance.

| Mode | Visualization |
|---|---|
| 1–2 | BVH traversal statistics (triangle/box tests) |
| 3 | Ray distance |
| 4 | Surface normals |
| 5 | Stratified jitter pattern |
| 6 | Environment luminance heat map |
| 7 | Environment importance sampling PDF |

---

## Performance Optimization Strategies

| Area | Technique | Benefit |
|---|---|---|
| BVH Traversal | Slots 0–1 read first, slot 2 only for leaves | Reduced memory bandwidth |
| BVH Visibility | Per-ray material visibility cache | ~30% fewer material texture fetches |
| Light BVH | Power-weighted stochastic traversal | O(log N) emissive sampling vs O(N) CDF |
| RNG | Fast RNG for non-critical samples | Lower ALU cost |
| Material Sampling | PathState caching of classification & BRDF weights | Avoid recomputation per bounce |
| MIS | Multi-lobe PDF evaluation with power heuristic | Lower variance across complex materials |
| Environment | Branch-free quality/mip selection | Reduced divergence |
| Adaptive Sampling | Early per-pixel sample cull | Focus resources on high-variance regions |
| Accumulation | Camera movement disabling blending | Prevents temporal instability |
| DOF | Early exit when ineffective settings | Saves lens sampling cost |
| Data Access | Aligned vec4 texture packing | Coalesced GPU memory reads |

---

## Error & Stability Guards

- Minimum PDF clamps (`MIN_PDF`) prevent division by zero / NaNs in MIS weight computation.
- Background pixel guard: `gNormalDepth` uses default `(0,0,1)` normal + `linearDepth=1.0` for miss rays (`objectNormal = vec3(0)` → `normalize` → NaN without guard).
- Pole region handling (`sinTheta` clamps, epsilon UV limits) avoids singularities in environment spherical mapping.
- Transmission fallback (total internal reflection) uses small PDF to maintain normalization consistency.
- Visibility cache reset each ray to avoid cross-ray contamination.
- Adaptive sampling ensures at least one sample to prevent stale output when no accumulation available.

---

## Extension Points

Safe areas to extend without disrupting current architecture:

1. **Add new material lobe** (e.g., subsurface): integrate into classification, BRDF weight calculation, and multi-lobe MIS in `MaterialSampling.js` and `MaterialEvaluation.js`.
2. **Enhance environment sampling** with alias table or hierarchical importance map — replace CDF inversion functions while keeping `sampleEnvironmentWithContext` interface.
3. **Introduce spectral sampling** by extending material data texture (wavelength-dependent factors) and RNG dimension generation.
4. **Add per-triangle custom attributes** (e.g., vertex motion vectors) by expanding triangle texture layout (`Constants.js`) and adjusting interpolation in `RayIntersection.js`.
5. **GPU-side adaptive sampling heuristics** — write new guide texture each frame and reuse `getRequiredSamples` path.
6. **Migrate to compute shaders** — currently fragment-shader based; compute pipelines may yield 3-5x gains via explicit occupancy control.

---

## Glossary

- **MIS**: Multiple Importance Sampling — combines PDFs from different strategies with reduced variance.
- **VNDF**: Visible Normal Distribution Function sampling for GGX improving specular convergence.
- **CDF**: Cumulative Distribution Function used to invert probability distributions for sampling.
- **DOF**: Depth of Field — simulates lens aperture blur.
- **Firefly**: Extremely bright outlier sample due to low PDF / high radiance.
- **PathState**: Per-path temporary cache storing classification and BRDF weights.
- **Light BVH**: Bounding Volume Hierarchy over emissive triangles for power-proportional sampling.
- **SSRC**: Screen Space Radiance Caching — indirect lighting cache reused across frames.
- **TSL**: Three Shading Language — JS-based shader system that compiles to WGSL at runtime.

---

## Sampling & Bounce Decision Flow

```text
              +-------------------+
              | Generate Primary  |
              | Ray (DOF optional)|
              +---------+---------+
                        |
                        v
                +---------------+
                | traverseBVH() |
                +-------+-------+
                   hit /     \ miss
                      v       v
         +--------------+   +------------------------+
         | classify     |   | Environment Sample?    |
         | Material()   |   | (if enabled, else black)|
         +------+-------+   +------------------------+
                |
                v
     +-----------------------------+
     | Multi-lobe MIS sampling     |
     | (generateSampledDirection / |
     |  sampleMaterialWithMultiLobe)|
     +------+---------------------+
            |
            v
     +---------------------------+
     | Direct Lighting           |
     | - Environment IS          |
     | - Light BVH (if enabled)  |
     | - Emissive triangles      |
     +------+--------------------+
            |
            v
     +----------------------+    +------------+
     | evaluateMaterial     |--->| Accumulate |
     | Response()           |    +-----+------+
     +----------------------+          |
                                        | path terminated
                                        | (max bounce / RR / miss)
                                        v
                              +-----------------------+
                              | Next Bounce Setup     |
                              | (update PathState)    |
                              +-----------------------+
```

Key decision gates:
- Miss → environment contribution (if enabled) else black.
- Hit → material classification drives lobe selection strategy.
- Continuation requires: `bounceIndex < maxBounces` AND (russian roulette passes) AND transmissive constraints.

---

## Hot Path Performance Checklist

Before large refactors or when optimizing GPU time:

1. **BVH Traversal**
   - [ ] Node texture reads minimized (slot 2 only for leaves)?
   - [ ] Visibility cache still per-ray reset? (avoid cross-ray contamination)
   - [ ] Early exit threshold (`dst < 0.001`) appropriate for scene scale?

2. **Material Sampling**
   - [ ] PathState caches (`classificationCached`, `weightsComputed`) invalidated only on material change?
   - [ ] Multi-lobe MIS weight computation not doing redundant `classifyMaterial` calls?
   - [ ] PDFs clamped with `MIN_PDF` to avoid denormals?

3. **RNG**
   - [ ] Fast RNG (`RandomValueFast`) used only in non-critical contexts (DOF, jitter)?
   - [ ] Blue noise sampling avoids unnecessary modulo ops or branches?

4. **Environment Sampling**
   - [ ] Binary search iteration count (8) matches current CDF resolution; adjust if >256 columns.
   - [ ] Mip selection arithmetic remains branch-free.
   - [ ] Firefly clamp thresholds tuned for HDR maps.

5. **Light BVH**
   - [ ] Traversal PDF tracking accumulates correctly (product of per-node probabilities)?
   - [ ] `lightBVHNodeCount == 0` path falls back to emissive CDF sampling gracefully?
   - [ ] Node buffer updated via `setLightBVHData()` on scene change?

6. **Adaptive Sampling**
   - [ ] Zero-sample pixels only occur when accumulation is valid; else forced min sample.
   - [ ] `adaptiveSamplingMax` consistent with CPU-side heuristics.

7. **Accumulation**
   - [ ] Accumulation disabled instantly on camera movement or interaction mode enter.
   - [ ] `accumulationAlpha` progression stable for both progressive and tiled modes.

8. **Memory / Bandwidth**
   - [ ] No per-sample dynamic allocations; all targets pre-created.
   - [ ] Texture filtering modes (Nearest for CDF, etc.) remain optimal.

9. **Numerical Stability**
   - [ ] Background pixels guard against `normalize(vec3(0))` NaN in `gNormalDepth`.
   - [ ] Guard epsilons (`1e-6`, `1e-4`) not removed by aggressive cleanup.

10. **Debug Paths**
    - [ ] `visMode` early exits do not execute expensive loops.

---

## Diff-Friendly Summary For Refactors

When changing shader code, watch these anchors:

| File | Critical Symbols | Purpose |
|---|---|---|
| `PathTracer.js` | `pathTracerMain()`, `getRequiredSamples()`, accumulation block | Entry point, sample loop, adaptive sampling, accumulation |
| `PathTracerCore.js` | `Trace()`, `TraceResult`, path loop termination | Bounce iteration, termination, MIS assembly |
| `BVHTraversal.js` | `traverseBVH()`, `isTriangleVisible()`, stack logic | Acceleration structure traversal & visibility culling |
| `MaterialSampling.js` | `sampleMaterialWithMultiLobeMIS()`, `calculateMultiLobeMISWeight()` | Multi-lobe sampling & PDF combination |
| `MaterialEvaluation.js` | `evaluateMaterialResponse()` | Combines BRDF components |
| `Environment.js` | `sampleEnvironmentWithContext()`, `calculateEnvironmentPDFWithMIS()` | HDR env sampling & PDF computation |
| `LightBVHSampling.js` | `sampleLightBVHTriangle()`, traversal PDF product | Light BVH stochastic descent & PDF tracking |
| `Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `sampleBlueNoise2D()` | Stochastic sampling quality & distribution |
| `PathTracer.js` | MRT setup, uniform declarations, `setLightBVHData()` | Stage orchestration, uniform management |

Numerical constants to keep consistent:
- `MIN_PDF`, epsilon thresholds in environment & BVH.
- Prime numbers in RNG seeding (altering them affects noise stability).

Refactor heuristic:
1. **Localized helper change** (e.g., GGX sampling) → run visual convergence test (specular highlight stability, firefly incidence).
2. **Traversal / visibility change** → count texture reads before and after.
3. **Environment PDF or mip heuristics** → test bright HDRI, check exposure invariance and importance distribution.
4. **Lobe sampling threshold reorder** → compare variance across same seed runs.

Recommended regression scenes:
- High transmission + clearcoat object under HDRI.
- Dense triangle forest with mixed front/back/double sided materials.
- Emissive-heavy scene (ensure emissive sampling still weighted correctly — compare Light BVH vs CDF paths).
- Low bounce count interior (check environment termination correctness).

---

End of document.
