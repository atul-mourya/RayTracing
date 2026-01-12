# Path Tracer Shader Architecture

Rayzee Path Tracing Engine – Internal Shader Design (PathTracer Stage Only)

---

## Scope & Exclusions

This document covers ONLY the real-time path tracing stage shader system: the fragment shader `pathtracer.fs` and its include graph (`random.fs`, `bvhtraverse.fs`, `material_sampling.fs`, `environment.fs`, plus other supporting include files like `common.fs`, `struct.fs`, `material_*`, `lights_*`, etc.).

Explicitly excluded (refer to separate docs):
- Denoisers (ASVGF, EdgeAwareFiltering)
- Post-processing (Bloom, Tone mapping passes outside shader core)
- Adaptive sampling pass implementation details (we only describe how the path tracer consumes its texture)
- Debug visualization passes beyond in-shader `visMode`

---

## High-Level Overview

The path tracing shader performs Monte Carlo integration of the rendering equation using multiple importance sampling (MIS) across material lobes and (optionally) an importance sampled environment map. It outputs two Multiple Render Targets (MRT):
- `gColor` (rgba): RGB radiance + A channel repurposed as an edge / sharpness flag for later temporal or spatial passes.
- `gNormalDepth` (rgba): Encoded world-space normal (xyz packed to 0–1) + linearized depth (a).

Key features:
- Progressive accumulation with temporal blending (conditional compile via `ENABLE_ACCUMULATION` define).
- Adaptive sampling integration per pixel (variable samples per frame).
- Stratified + selectable random sequence generation (PCG / Halton / Sobol / Blue Noise).
- High-performance stack-based BVH traversal with material visibility caching.
- Physically-based material system with multi-lobe MIS (diffuse, specular, clearcoat, transmission, sheen, iridescence).
- Environment importance sampling using a 2D marginal + conditional CDF texture (with multi-resolution PDF handling).
- Depth of field (physical aperture sampling) and camera jitter for anti-aliasing.
- Firefly mitigation and confidence scoring in environment sampling.
- Edge detection on primary rays for downstream temporal filters.

---

## Include Graph & Modular Breakdown

`pathtracer.fs` orchestrates the render and includes specialized modules:

1. Core Structures & Utilities: `struct.fs`, `common.fs`
2. Random & Sampling Infrastructure: `random.fs`
3. Environment Importance Sampling: `environment.fs`
4. Texture Sampling: `texture_sampling.fs`
5. Geometry: `rayintersection.fs`, `bvhtraverse.fs`, `displacement.fs`
6. Material System:
   - Property access & derived values: `material_properties.fs`
   - BRDF evaluation: `material_evaluation.fs`
   - Sampling strategies: `material_sampling.fs`
   - Transmission: `material_transmission.fs`
   - Fresnel & Clearcoat: `fresnel.fs`, `clearcoat.fs`
7. Lighting System:
   - Core light interfaces: `lights_core.fs`
   - Direct light sampling: `lights_direct.fs`
   - Emissive triangle sampling: `emissive_sampling.fs`
   - Light distribution functions: `lights_sampling.fs`
   - Indirect lighting helpers: `lights_indirect.fs`
8. Path Integrator Core: `pathtracer_core.fs` (contains `Trace` and path recursion logic)
9. Debug Utilities: `debugger.fs`

The modularization allows hot swapping enhancements (e.g., improved MIS or BVH traversal) without touching the main integration loop in `main()`.

---

## Render Targets & Output Semantics

MRT layout inside shader:
```glsl
layout(location = 0) out vec4 gColor;        // (RGB radiance, A = pixelSharpness)
layout(location = 1) out vec4 gNormalDepth;  // (Normal * 0.5 + 0.5, linearDepth)
```

Edge/sharpness flag (alpha of `gColor`) is computed from normal variation, object ID fwidth, and color derivative to assist later temporal rejection (excluded from this doc).

Depth is linearized in shader with a near/far mapping and used by downstream passes for reprojection.

---

## Uniform Groups (JS → GPU Data Flow)

Uniforms are initialized and maintained in `PathTracerPass.js`. Principal categories:

1. Camera & DOF:
   - `cameraWorldMatrix`, `cameraProjectionMatrixInverse`
   - `enableDOF`, `focusDistance`, `focalLength`, `aperture`, `apertureScale`
2. Frame & Control:
   - `frame`, `maxFrames`, `maxBounceCount`, `transmissiveBounces`, `numRaysPerPixel`, `renderMode`
3. Accumulation (conditional define):
   - `previousAccumulatedTexture`, `enableAccumulation`, `accumulationAlpha`, `cameraIsMoving`, `hasPreviousAccumulated`
4. Sampling:
   - `samplingTechnique` (0=PCG,1=Halton,2=Sobol,3=BlueNoise)
   - `blueNoiseTexture`, `blueNoiseTextureSize`
5. Adaptive Sampling:
   - `useAdaptiveSampling`, `adaptiveSamplingTexture`, `adaptiveSamplingMax`
6. Environment:
   - `enableEnvironmentLight`, `environment`, `environmentIntensity`, `environmentMatrix`
   - `useEnvMapIS`, `envCDF`, `envCDFSize`, `envMapTotalLuminance`
   - `useEnvMipMap`, `envSamplingBias`, `maxEnvSamplingBounce`, `fireflyThreshold`, `exposure`, `backgroundIntensity`, `showBackground`
7. Geometry & Material Data Textures:
   - `triangleTexture`, `bvhTexture`, `materialTexture`, `emissiveTriangleTexture`
   - Sizes: `triangleTexSize`, `bvhTexSize`, `materialTexSize`, `emissiveTriangleTexSize`
   - Counts: `totalTriangleCount`, `emissiveTriangleCount`
8. Light Buffers:
   - `directionalLights`, `pointLights`, `spotLights`, `areaLights`
9. Material Sampler Arrays (actual textures):
   - `albedoMaps`, `emissiveMaps`, `normalMaps`, `roughnessMaps`, `metalnessMaps`, `bumpMaps`, `displacementMaps`
10. Debug:
   - `visMode`, `debugVisScale`

All uniform updates that influence sampling or accumulation trigger a reset (frame counter back to 0) to avoid temporal contamination.

---

## Data Textures & GPU Layouts

### Triangle Data (`triangleTexture`)
Compact, vec4-aligned 8-slot layout (32 floats per triangle):
1. posA.xyz
2. posB.xyz
3. posC.xyz
4. normalA.xyz
5. normalB.xyz
6. normalC.xyz
7. uvA.xy, uvB.xy
8. uvC.xy, materialIndex, meshIndex

### BVH Nodes (`bvhTexture`)
Three vec4 slots per node:
1. boundsMin.xyz, leftChildIndex
2. boundsMax.xyz, rightChildIndex
3. (leaf only): triStart, triCount, padding, padding

Traversal reduces reads by only fetching slot 3 for leaf nodes.

### Material Data (`materialTexture`)
Packed per-material properties across multiple pixels. Select subsets are accessed hot-path:
- Base: color (rgb), metalness, emissive (rgb), roughness, ior, transmission, thickness, emissiveIntensity
- Volumetric & attenuation: attenuationColor (rgb), attenuationDistance, dispersion
- Visibility & classification: visible, sheen, sheenRoughness, sheenColor (rgb)
- Specular & iridescence: specularIntensity, specularColor (rgb), iridescence, iridescenceIOR, iridescenceThicknessRange (2 floats)
- Clearcoat: clearcoat, clearcoatRoughness
- Alpha and side flags: opacity, side, transparent, alphaTest, alphaMode, depthWrite
- Normal/bump/displacement scaling: normalScale (vec2), bumpScale, displacementScale
- Texture transform matrices stored later (multiple 3x3 blocks)

Visibility fetch is optimized: two targeted slots are read and cached per ray (see `bvhtraverse.fs`).

### Emissive Triangles (`emissiveTriangleTexture`)
Optional texture storing emissive triangle indices & energy for direct emissive sampling (details in lights modules).

### Environment CDF (`envCDF`)
2D texture encoding marginal CDF (last row) and conditional CDF + corresponding PDFs in channels (R/G). Used for importance sampling inversion in `environment.fs`.

---

## Execution Flow (Shader `main()`)

1. Compute `screenPosition` (NDC) and initialize pixel accumulator.
2. Derive base RNG seed per pixel/frame via `getDecorrelatedSeed`.
3. Determine per-pixel sample count:
   - Start with `numRaysPerPixel`.
   - If adaptive sampling active and past warmup frames, read `adaptiveSamplingTexture` → possibly reduce to 0 (converged) or clamp within `[1, adaptiveSamplingMax]`.
   - Guarantee at least one sample if accumulation fallback unavailable.
4. Loop over samples:
   - Derive stratified (and optionally blue noise) jitter for subpixel AA → jittered primary ray origin.
   - Generate camera ray (`generateRayFromCamera`) with DOF blur if enabled.
   - Either call `TraceDebugMode` (visual diagnostic) or full `Trace` path integrator.
   - For first primary sample: record hit normal / color / object ID for edge detection and MRT normal/depth.
   - Accumulate radiance and sample count.
5. Average accumulated radiance.
6. Edge detection via derivatives (`fwidth`) on normal/object/color → set alpha channel.
7. Temporal accumulation blend if enabled: previous accumulated color + new sample weighted by `accumulationAlpha` (disabled during interaction / camera motion).
8. Output `gColor` and `gNormalDepth`.

The recursive or iterative bounce loop resides inside `Trace` (from `pathtracer_core.fs`), which performs:
   - Intersection via `traverseBVH`
   - Material classification & caching
   - Direct light / emissive evaluation
   - Environment hit termination or continuation
   - Russian roulette or depth termination using `maxBounceCount` & `transmissiveBounces`
   - MIS between emissive, material lobes, environment contributions

---

## Random Sampling Architecture (`random.fs`)

### Techniques
`samplingTechnique` selects generator:
0. PCG (high quality, general-purpose)
1. Halton (low-discrepancy, Owen-scrambled)
2. Sobol (Owen-scrambled 32-bit direction vectors)
3. Blue Noise (spatial/temporal correlated dithering)

### Hybrid Strategies
- Stratified sampling subdivides pixel into grid cells for multi-sample anti-aliasing.
- Blue noise integration: progressive slice selection for temporal stability; Cranley-Patterson rotation for decorrelation.
- Fast RNG path (`RandomValueFast`) used in non-critical jitter to save cycles (e.g., DOF disk sampling).

### Seeding
`getDecorrelatedSeed(pixelCoord, rayIndex, frame)` mixes multiple large primes and combined hashes (PCG + Wang) to avoid frame-to-frame correlation.

### Multi-Dimensional Interface
`getRandomSampleND` returns up to 4D sample vectors with technique-specific mapping, feeding BRDF sampling, DOF, and other stochastic processes.

---

## BVH Traversal (`bvhtraverse.fs`)

Highlights:
- Reduced stack size (24) for typical scene depth; iterative explicit stack.
- Axis-aligned ray handling avoids division by zero using large sentinel values.
- Texture access minimization: fetch node slots 0–1 for bounds, slot 2 only for leaf.
- Early pruning: compare min distance of child bounds with current closest hit distance.
- Near/far ordering pushes far child first → processes near child immediately (depth-first).
- Per-ray visibility cache (`visCache`) prevents redundant material visibility fetches (≈30% texture read reduction).
- Two-stage visibility:
  1. Fast check (cached) for early rejection.
  2. Full side culling (front/back/double) only if potential closest hit.
- Shadow ray early termination path (any hit suffices).

### Intersection
`RayTriangle` imported from `rayintersection.fs` performs barycentric intersection returning distance, normal, and barycentrics after interpolation of per-vertex normals & UVs.

---

## Material Sampling & Evaluation (`material_sampling.fs` + related modules)

### Classification & PathState Caching
`getOrCreateMaterialClassification` caches classification (metallic, transmissive, smooth, etc.) and invalidates dependent caches if material changes between bounces.

### BRDF Weights
`calculateBRDFWeights` computes per-lobe base weights using roughness, metalness, IOR, sheen color intensity and cached derived factors. Results stored in `PathState` for reuse within the same bounce chain.

### Multi-Lobe MIS Sampling
`sampleMaterialWithMultiLobeMIS` selects one lobe based on normalized weights (diffuse, specular, clearcoat, transmission, sheen, iridescence). For each lobe:
- Direction sampling: cosine hemisphere, GGX importance sampling (VNDF or standard), microfacet transmission, or fallback diffuse.
- Per-lobe PDF computed (GGX: `D * G1 * VoH / (NoV * 4)`; diffuse: `NoL / π`; transmission simplified as opposite hemisphere; sheen approximated diffuse; clearcoat uses distinct roughness).
- Global MIS weight computed (`calculateMultiLobeMISWeight`) by evaluating hypothetical PDFs of all lobes for the sampled direction; power heuristic applied.

### Single-Lobe Fast Path
`generateSampledDirection` provides an optimized path for materials below complexity thresholds (no significant clearcoat/transmission/iridescence), reducing overhead by avoiding full multi-lobe enumeration.

### Transmission
`sampleMicrofacetTransmission` (from `material_transmission.fs`) handles refractive events, with total internal reflection fallback to specular reflectance and dispersion support (thin approximation).

### Fresnel & Special Effects
- Energy-conserving Fresnel through Schlick or IOR-based factor.
- Clearcoat second specular lobe with independent roughness.
- Sheen adds grazing-angle coloration (scaled by maximum sheenColor component).
- Iridescence weight influences MIS and color shift (thickness + IOR).

### Evaluation
`evaluateMaterialResponse(V, L, N, material)` combines diffuse (Lambert), microfacet specular (GGX D/G/F), transmission, sheen, clearcoat, and iridescence contributions ensuring proper albedo/mask weighting. PDFs are stabilized with `MIN_PDF` guard to avoid NaNs.

---

## Environment Importance Sampling (`environment.fs`)

### CDF-Based Sampling
- 2D sampling via inversion of marginal (row) and conditional (column) CDF stored in `envCDF`.
- Binary search reduced to 8 iterations (handles up to 256 entries efficiently) with interpolation to prevent bright-spot bias.

### Direction Conversion
`directionToUV` and `uvToDirection` map between spherical and UV space applying an `environmentMatrix` rotation (user settable for HDRI rotation).

### Quality & Mip Selection
- Bounce & material classification choose mip level (`getEnvironmentMipLevel`) and adaptive bias (`determineEnvSamplingQuality`).
- Branch-free material quality index reduces ALU divergence (integer arithmetic).
- Higher bounces → coarser mip (blur) improving convergence and reducing noise.

### PDF Calculation
`calculateEnvironmentPDFWithMIS(direction, roughness)` uses roughness-dependent mip LOD sampling; luminance normalized by `envMapTotalLuminance`; spherical Jacobian applied; clamped to prevent extremes.

### Multi-Resolution MIS
Different mip levels approximate environment roughness contribution—rough surfaces use blurred env radiance for better importance distribution.

### Firefly Mitigation
Importance (luminance / pdf) clamped only on deep bounces (after bounce 4) with gentle scaling preserving highlights.

### Conditional Use
`shouldUseEnvironmentSampling` decides environment path continuation based on bounce index & material transmission dominance.

---

## Adaptive Sampling Integration

Adaptive sampling pass produces `adaptiveSamplingTexture` (RGBA containing normalized sample counts, convergence flags). In shader:
```glsl
vec4 samplingData = texture(adaptiveSamplingTexture, texCoord);
if (samplingData.b > 0.5) return 0; // Converged pixel
```
`getRequiredSamples` translates normalized value to integer within `[1, adaptiveSamplingMax]`. Early exit sets per-pixel samples to zero only when accumulation fallback available; otherwise forces at least one sample to prevent stale output.

This mechanism restricts further sampling in converged regions, freeing GPU cycles for noisy areas; path tracing logic treats a zero-sample pixel as reusing prior accumulated result.

---

## Accumulation & Temporal Blending

When `ENABLE_ACCUMULATION` define is active:
- Shader receives `previousAccumulatedTexture` and blends:
  `finalColor = previous + (current - previous) * accumulationAlpha;`
- Alpha computed CPU-side (`PathTracerUtils.calculateAccumulationAlpha`) factoring frame count, tile progression, and interaction resets.
- Accumulation disabled during camera interaction (`cameraIsMoving` / interaction mode), preventing low-quality smear; re-enabled immediately after exit with prior result retained.

Edge flag (A in `gColor`) *always* recalculated, ensuring temporal passes have accurate structural guides even on converged or reused pixels.

---

## Edge Detection (Primary Ray Feature Extraction)

Uses `fwidth` over normal components and object ID plus color derivative presence to classify pixelSharpness:
- High normal gradient
- Object ID discontinuity
- Non-zero color derivative
If any condition is met → alpha = 1, else 0. This feeds later reconstruction filters (not described here).

---

## Debug Modes (`visMode`)

Several visualization branches short-circuit standard path tracing (e.g., mode 5 returns stratified jitter pattern). Non-zero modes may invoke `TraceDebugMode` for heatmaps (triangle/box test counts, distances, etc.). These are intentionally isolated to avoid polluting main integrator performance pathways.

---

## Performance Optimization Strategies

| Area | Technique | Benefit |
|------|-----------|---------|
| BVH Traversal | Fewer texture reads (slots 0–1 early) | Reduced memory bandwidth |
| BVH Visibility | Per-ray material visibility cache | ~30% fewer material texture fetches |
| RNG | Fast RNG for non-critical samples | Lower ALU cost |
| Material Sampling | PathState caching of classification & BRDF weights | Avoid recomputation per bounce |
| MIS | Multi-lobe PDF evaluation with power heuristic | Lower variance across complex materials |
| Environment | Branch-free quality/mip selection | Reduced divergence |
| Adaptive Sampling | Early per-pixel sample cull | Focus resources on high variance regions |
| Accumulation | Debounced camera movement disabling blending | Prevents temporal instability |
| DOF | Early exit when ineffective settings | Saves lens sampling cost |
| Data Access | Aligned vec4 texture packing | Coalesced GPU memory reads |

Additional micro-optimizations include minimal PDF floor (`MIN_PDF`), early termination for very close hits (`dst < 0.001`), and fallback uniform environment sampling if CDF invalid.

---

## Error & Stability Guards

- Minimum PDF clamps prevent division by zero / NaNs in MIS weight computation.
- Pole region handling (`sinTheta` clamps, epsilon UV limits) avoids singularities in environment spherical mapping.
- Transmission fallback (total internal reflection) uses small PDF to maintain normalization consistency.
- Visibility cache reset each ray to avoid cross-ray contamination.
- Adaptive sampling ensures at least one sample to prevent stale output when no accumulation available.

---

## Extension Points

Safe areas to extend without disrupting current architecture:
1. Add new material lobe (e.g., subsurface) by integrating into classification, BRDF weight calculation, and multi-lobe MIS structures.
2. Enhance environment sampling with alias table or hierarchical importance map — replace CDF inversion functions while keeping `sampleEnvironmentWithContext` interface.
3. Introduce spectral sampling by extending material data texture (wavelength-dependent factors) and RNG dimension generation.
4. Add per-triangle custom attributes (e.g., vertex motion vectors) by expanding triangle texture layout and adjusting interpolation in `RayTriangle`.
5. GPU-side adaptive sampling heuristics — write new guide texture each frame and reuse `getRequiredSamples` path.

---

## Summary

The path tracer shader architecture emphasizes modularity, data locality, and variance reduction through combined strategies: multi-lobe MIS, environment importance sampling, adaptive per-pixel sample allocation, and robust accumulation control. Optimizations focus on minimizing memory bandwidth (BVH & material caches), reducing divergence (branch-free arithmetic), and stabilizing temporal results (edge tagging, interaction-aware accumulation). This foundation delivers real-time progressive path tracing quality while remaining extensible for advanced effects.

---

## Glossary (Selected Terms)

- MIS: Multiple Importance Sampling to combine PDFs from different strategies with reduced variance.
- VNDF: Visible Normal Distribution Function sampling for GGX improving specular convergence.
- CDF: Cumulative Distribution Function used to invert probability distributions for sampling.
- DOF: Depth of Field – simulates lens aperture blur.
- Firefly: Extremely bright outlier sample due to low PDF / high radiance.
- PathState: Per-path temporary cache storing classification and BRDF weights.

---

End of document.

---

## Sampling & Bounce Decision Flow (Diagram)

Mermaid-style logic (conceptual – not executed by build system):

```text
                 +-------------------+
                 | Generate Primary  |
                 | Ray (DOF optional)|
                 +---------+---------+
                           |
                           v
                   +---------------+
                   | traverseBVH() |  Miss?
                   +-------+-------+
                           | hit
                miss       v
        +----------------------+            +-----------------------+
        | Environment Sample? |<----------- | shouldUseEnvironment()|
        +----------+-----------+            +-----------+-----------+
                   | yes                                 | no
                   v                                     v
            +--------------+                    +----------------------+
            | sampleEnvironment |                | classifyMaterial()   |
            +------+-------+----+                +-----------+----------+
                   | value,pdf                              |
                   v                                        v
             +------------+                     +-----------------------------+
             | Accumulate |<--------------------| Multi-lobe MIS sampling     |
             +-----+------+                     | (generateSampledDirection / |
                   | path terminated            |  sampleMaterialWithMultiLobe)|
                   | (max bounce / RR / miss)   +-----------------------------+
                   v                                        |
          +-----------------------+                         v
          | Next Bounce Setup     |<---------------- evaluateMaterialResponse
          | (update PathState)    |                         |
          +-----------+-----------+                         |
                      | continue if depth < max / pdf ok    |
                      +-------------------------------------+
```

Key decision gates:
- Miss → environment contribution (if enabled) else black.
- Hit → material classification drives lobe selection strategy.
- Continuation requires: bounceIndex < maxBounceCount AND (russian roulette passes if enabled) AND transmissive constraints.

---

## Hot Path Performance Checklist

Use this before large refactors or when optimizing GPU time:

1. BVH Traversal
   - [ ] Are node texture reads minimized (slot 2 only for leaves)?
   - [ ] Visibility cache still per-ray reset? (Avoid cross-ray contamination)
   - [ ] Early exit threshold (`dst < 0.001`) appropriate for scene scale?
2. Material Sampling
   - [ ] PathState caches (`classificationCached`, `weightsComputed`) still invalidated only on material change?
   - [ ] Multi-lobe MIS weight computation not doing redundant `classifyMaterial` calls?
   - [ ] PDFs clamped with `MIN_PDF` to avoid denormals?
3. RNG
   - [ ] Fast RNG (`RandomValueFast`) used only in non-critical contexts (DOF, jitter) to preserve quality?
   - [ ] Blue noise sampling avoids unnecessary modulo ops or branches?
4. Environment Sampling
   - [ ] Binary search iteration count (8) matches current CDF resolution; adjust if resolution increases beyond 256 columns.
   - [ ] Mip selection arithmetic remains branch-free.
   - [ ] Firefly clamp thresholds tuned for HDR maps (verify luminance distribution).
5. Adaptive Sampling
   - [ ] Zero-sample pixels only occur when accumulation is valid; else forced min sample.
   - [ ] `adaptiveSamplingMax` consistent with CPU-side heuristics.
6. Accumulation
   - [ ] Accumulation disabled instantly on camera movement or interaction mode enter.
   - [ ] `accumulationAlpha` progression stable for both progressive and tiled modes.
7. Memory / Bandwidth
   - [ ] No per-sample dynamic allocations; all targets pre-created.
   - [ ] Texture filtering modes (Nearest for blue noise/CDF, etc.) remain optimal.
8. Divergence Minimization
   - [ ] Branch-free material quality index still intact in environment sampling.
   - [ ] Lobe selection uses cumulative thresholds rather than deep if ladders.
9. Numerical Stability
   - [ ] Depth linearization near/far consistent with camera settings.
   - [ ] Guard epsilons (`1e-6`, `1e-4`) not removed by aggressive code cleanup.
10. Debug Paths
   - [ ] `visMode` early exits do not execute expensive loops.
   - [ ] Stats counters optional and not compiled in release (if defines used externally).

---

## Diff-Friendly Summary For Refactors

When changing shader code, watch the following anchors to avoid accidental behavior shifts:

| File | Critical Symbols / Blocks | Purpose |
|------|---------------------------|---------|
| `pathtracer.fs` | `main()`, MRT declarations, `getRequiredSamples`, accumulation block | Entry point, sample loop, adaptive sampling, accumulation |
| `pathtracer_core.fs` | `Trace`, `TraceDebugMode`, path loop termination logic | Bounce iteration, termination, MIS assembly |
| `bvhtraverse.fs` | `traverseBVH`, `isTriangleVisibleCached`, stack logic | Acceleration structure traversal & visibility culling |
| `material_sampling.fs` | `sampleMaterialWithMultiLobeMIS`, `calculateMultiLobeMISWeight` | Multi-lobe sampling & PDF combination |
| `material_evaluation.fs` | `evaluateMaterialResponse` | Combines BRDF components |
| `environment.fs` | `sampleEnvironmentWithContext`, `calculateEnvironmentPDFWithMIS` | HDR env sampling & PDF computation |
| `random.fs` | `getDecorrelatedSeed`, `getStratifiedSample`, `sampleBlueNoise2D` | Stochastic sampling quality & distribution |

Common defines / guards:
- `ENABLE_ACCUMULATION` – toggles temporal blend path.
- `MAX_SPHERE_COUNT` – influences loops over analytic primitives (if any active).
Numerical constants to keep consistent:
- `MIN_PDF`, epsilon thresholds in environment & BVH.
- Prime numbers in RNG seeding (altering them can affect noise stability).

Refactor heuristic:
1. Change localized helper (e.g., GGX sampling) → run visual convergence test (specular highlight stability, firefly incidence).
2. Modify traversal / visibility → count texture reads (Chrome WebGL Profiler or internal counters) before and after.
3. Adjust environment PDF or mip heuristics → test bright HDRI, check exposure invariance and importance distribution (no clustering at poles).
4. Reorder lobe sampling thresholds → compare variance (samples to reach stable rough glossy reflection) across same seed runs.

Recommended regression scenes:
- High transmission + clearcoat object under HDRI.
- Dense triangle forest with mixed front/back/double sided materials.
- Emissive-heavy scene (ensure emissive sampling still weighted correctly).
- Low bounce count interior (check environment termination correctness).

---
