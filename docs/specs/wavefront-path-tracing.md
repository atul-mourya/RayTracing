# Wavefront Path Tracing — Technical Specification

**Status:** Proposal
**Author:** Rayzee Team
**Date:** 2026-03-24
**Scope:** Replace the monolithic per-pixel compute kernel with a multi-kernel wavefront architecture

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Background](#2-background)
3. [Architecture Overview](#3-architecture-overview)
4. [Ray Buffer Layout](#4-ray-buffer-layout)
5. [Kernel Specifications](#5-kernel-specifications)
6. [Queue Management & Stream Compaction](#6-queue-management--stream-compaction)
7. [Material Sorting](#7-material-sorting)
8. [Pipeline Integration](#8-pipeline-integration)
9. [MRT & Denoiser Compatibility](#9-mrt--denoiser-compatibility)
10. [Memory Budget](#10-memory-budget)
11. [Three.js TSL Constraints](#11-threejs-tsl-constraints)
12. [Migration Strategy](#12-migration-strategy)
13. [Performance Expectations](#13-performance-expectations)
14. [Risks & Mitigations](#14-risks--mitigations)
15. [Appendix](#appendix)

---

## 1. Motivation

### Current Architecture: Monolithic Mega-Kernel

The path tracer today runs a **single compute kernel** (`PathTracer.js` → `ShaderComposer.setupCompute()`) where each thread traces a full path: ray generation → BVH traversal → material evaluation → direct lighting → bounce → repeat up to `maxBounces`. Workgroup size is 16×16 (256 threads).

### Problems

| Problem | Impact | Root Cause |
|---------|--------|------------|
| **Warp/subgroup divergence** | 30-60% occupancy loss | Threads in the same subgroup follow different BVH paths (left vs. right child), hit different material types (diffuse vs. glass vs. emissive), and terminate at different bounce depths via Russian roulette |
| **Register pressure** | Reduced occupancy, potential register spilling | The full kernel carries ~200 live values across ray state, hit data, material cache, BRDF weights, RNG state, MIS bookkeeping, and accumulation buffers simultaneously |
| **Instruction cache thrashing** | Stalls on complex scenes | The compiled WGSL shader exceeds 15K instructions; the GPU instruction cache cannot hold the full kernel, causing re-fetches during each divergent branch |
| **Memory access incoherence** | L2 cache miss rate >40% on deep BVH | Adjacent threads traverse unrelated BVH subtrees after 2-3 bounces, destroying spatial locality for texture fetches (BVH nodes, triangles, materials) |
| **Scaling ceiling** | Cannot add features without regression | Each new material lobe, light type, or effect (fog, displacement, SSS) widens the mega-kernel, compounding all issues above |

### Wavefront Solution

Decompose the mega-kernel into **focused micro-kernels** that each process a buffer (queue) of rays performing the same operation. This:

- **Eliminates inter-thread divergence** within each kernel (all threads do the same work type)
- **Reduces register pressure** per kernel (each kernel only needs its specific state)
- **Improves memory coherence** (rays hitting similar BVH regions are naturally grouped after intersection)
- **Enables material sorting** (group rays by material type before shading)
- **Scales linearly** with new features (new material → new shade kernel, no impact on traversal)

---

## 2. Background

### Reference

- Laine, Karras, Aila — *Megakernels Considered Harmful: Wavefront Path Tracing on GPUs* (HPG 2013)
- NVIDIA OptiX 7+ wavefront scheduling
- AMD Radeon Rays wavefront implementation
- Pharr, Jakob, Humphreys — *Physically Based Rendering* §15.3 (wavefront integrator)

### Key Insight

GPU throughput is maximized when all threads in a warp/subgroup execute the **same instruction**. A monolithic path tracer violates this because each bounce introduces material-dependent branching. By splitting work into phases and sorting rays between phases, we recover near-perfect warp utilization.

---

## 3. Architecture Overview

### Kernel Pipeline (per sample iteration)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Per-Sample Iteration                         │
│                                                                     │
│  ┌──────────┐    ┌───────────┐    ┌────────┐    ┌───────────────┐  │
│  │ Generate  │───▶│  Extend   │───▶│  Sort  │───▶│    Shade      │  │
│  │ (rays)    │    │ (BVH)     │    │(mat id)│    │ (per-material)│  │
│  └──────────┘    └───────────┘    └────────┘    └───────┬───────┘  │
│                                                         │           │
│                  ┌───────────┐    ┌────────┐            │           │
│                  │  Connect  │◀───│ Shadow │◀───────────┘           │
│                  │ (shadow)  │    │ Queue  │     (shadow rays)      │
│                  └─────┬─────┘    └────────┘                        │
│                        │                                            │
│                  ┌─────▼──────┐                                     │
│                  │ Accumulate │──▶ next bounce or terminate         │
│                  └────────────┘                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Kernels Summary

| # | Kernel | Input | Output | Threads |
|---|--------|-------|--------|---------|
| 1 | **Generate** | Frame uniforms, pixel coords | Ray buffer (primary rays) | 1 per pixel |
| 2 | **Extend** | Ray buffer | Hit buffer (intersection data) | 1 per active ray |
| 3 | **Sort** | Hit buffer | Sorted indices by material ID | 1 per active ray |
| 4 | **Shade** | Hit buffer + sorted indices | New ray buffer (bounce/refract) + shadow queue + radiance accumulation | 1 per active ray |
| 5 | **Connect** | Shadow queue | Visibility results | 1 per shadow ray |
| 6 | **Accumulate** | Visibility results + pending radiance | Final pixel color buffer | 1 per shadow ray |

### Bounce Loop

```
for bounce = 0 to maxBounces:
    Extend(rayBuffer)              // BVH traversal
    Sort(hitBuffer)                // Sort by materialID
    Shade(hitBuffer, sorted)       // Material eval + generate shadow rays + bounce rays
    Connect(shadowQueue)           // Shadow ray traversal
    Accumulate(shadowResults)      // Add direct lighting contribution
    Compact(rayBuffer)             // Remove terminated rays → next bounce
```

The Generate kernel runs once per sample. The loop body runs per bounce. After compaction, the ray count monotonically decreases as paths terminate (miss, absorption, Russian roulette).

---

## 4. Ray Buffer Layout

### Design Principles

- **Structure-of-Arrays (SoA)** over Array-of-Structures for GPU cache line utilization
- **StorageBuffers** (not StorageTextures) for variable-length queues
- **Ping-pong** buffers where read-after-write hazards exist across dispatches
- **Compact encoding** to minimize bandwidth (16-bit where sufficient)

### Primary Ray Buffer

Each active ray occupies a fixed slot indexed by `rayID ∈ [0, maxRays)`.

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `origin` | `vec3<f32>` | Buffer A | Ray origin (world space) |
| `direction` | `vec3<f32>` | Buffer B | Ray direction (normalized) |
| `throughput` | `vec3<f32>` | Buffer C | Path throughput (RGB) |
| `radiance` | `vec3<f32>` | Buffer D | Accumulated radiance (RGB) |
| `pixelIndex` | `u32` | Buffer E | Flat pixel index (`y * width + x`) for scatter-write |
| `rngState` | `vec4<u32>` | Buffer F | Per-ray PCG state (4× u32 for decorrelated streams) |
| `bounceAndFlags` | `u32` | Buffer G | `[bits 0-7: bounce count] [bit 8: active] [bit 9: specular] [bit 10: inside medium] [bits 11-15: ray type]` |
| `pdf` | `f32` | Buffer H | PDF of the last sampled direction (for MIS) |
| `lastNormal` | `vec3<f32>` | Buffer I | Surface normal at last hit (for next-event estimation) |

**Total per ray:** 15 floats + 5 uints = **80 bytes**

### Hit Buffer

Written by Extend kernel, read by Sort and Shade.

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `hitDistance` | `f32` | Buffer J | Ray parameter `t` (`1e30` = miss) |
| `triangleIndex` | `u32` | Buffer K | Index into triangle data texture |
| `barycentrics` | `vec2<f32>` | Buffer L | Barycentric coordinates (u, v) |
| `materialIndex` | `u32` | Buffer M | Material ID (extracted from triangle data) |
| `meshIndex` | `u32` | Buffer M | Mesh ID (packed with materialIndex) |
| `geometricNormal` | `vec3<f32>` | Buffer N | Face normal (for backface detection) |

**Total per hit:** 6 floats + 3 uints = **36 bytes**

### Shadow Queue

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `shadowOrigin` | `vec3<f32>` | Buffer O | Shadow ray origin (offset from surface) |
| `shadowDirection` | `vec3<f32>` | Buffer P | Direction to light |
| `shadowMaxDist` | `f32` | Buffer Q | Maximum distance (to light source) |
| `pendingRadiance` | `vec3<f32>` | Buffer R | Radiance to add if unoccluded |
| `parentRayID` | `u32` | Buffer S | Links back to the path for pixel scatter |

**Total per shadow ray:** 10 floats + 1 uint = **44 bytes**

### First-Hit Buffer (MRT Data)

Written only by Shade kernel at bounce 0. Read once by Accumulate to populate denoiser inputs.

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `worldNormal` | `vec3<f32>` | Buffer T | Shading normal at primary hit |
| `linearDepth` | `f32` | Buffer T.w | Camera-space linear depth |
| `albedo` | `vec3<f32>` | Buffer U | Surface albedo (for OIDN) |
| `objectID` | `u32` | Buffer U.w | Object/mesh identifier |

---

## 5. Kernel Specifications

### 5.1 Generate Kernel

**Purpose:** Create primary camera rays with optional DOF and anti-aliasing jitter.

```
Dispatch: [ceil(width / 16), ceil(height / 16), 1]
Workgroup: [16, 16, 1]
```

**Inputs (uniforms):**
- Camera matrices: `cameraWorldMatrix`, `projectionMatrixInverse`
- Frame index, resolution, DOF parameters
- Tile offset (for tiled rendering mode)
- Blue noise texture, frame-seeded RNG

**Outputs:**
- Ray buffer: `origin`, `direction`, `pixelIndex`, `rngState`, `bounceAndFlags`
- Initialize: `throughput = vec3(1.0)`, `radiance = vec3(0.0)`, `pdf = 1.0`
- Active ray counter: `atomicAdd(activeRayCount, 1)`

**Algorithm:**
```
gx, gy = global thread ID + tile offset
if (gx >= width || gy >= height) return

pixelIndex = gy * width + gx
rng = initPCG(pixelIndex, frame, sampleIndex)

// Sub-pixel jitter (stratified)
jitter = stratifiedSample2D(rng)
uv = (vec2(gx, gy) + jitter) / resolution

// Camera ray (pinhole or thin lens)
rayDir = normalize(mat3(cameraWorld) * (invProj * vec4(ndc, 1.0)).xyz)
rayOrigin = cameraPosition

if (enableDOF) {
    focalPoint = rayOrigin + rayDir * focusDistance
    lensOffset = concentricDiskSample(rng) * aperture
    rayOrigin += mat3(cameraWorld) * vec3(lensOffset, 0.0)
    rayDir = normalize(focalPoint - rayOrigin)
}

writeRay(rayID, origin, direction, pixelIndex, rng, flags=ACTIVE)
```

**Preserves from current implementation:**
- Stratified jitter from `Random.js`
- DOF with physical aperture from `PathTracer.js`
- Blue noise anti-aliasing pattern

---

### 5.2 Extend Kernel (BVH Traversal)

**Purpose:** Find the closest intersection for each active ray. This is the most bandwidth-intensive kernel.

```
Dispatch: [ceil(activeRayCount / 256), 1, 1]
Workgroup: [256, 1, 1]  // 1D for ray-parallel processing
```

**Inputs:**
- Ray buffer (`origin`, `direction`, `bounceAndFlags`)
- BVH data texture, triangle data texture
- Active ray indices (compacted from previous bounce)

**Outputs:**
- Hit buffer (`hitDistance`, `triangleIndex`, `barycentrics`, `materialIndex`, `geometricNormal`)

**Algorithm:**
```
rayID = activeRayIndices[globalThreadID]
if (rayID == INVALID) return

ray = loadRay(rayID)
hit = traverseBVH(ray.origin, ray.direction)  // Existing BVHTraversal.js logic

writeHit(rayID, hit.distance, hit.triangleIndex, hit.bary, hit.materialID, hit.faceNormal)
```

**BVH traversal reuse:** The core `traverseBVH()` function from `BVHTraversal.js` is reused with minimal modification — it already uses a 32-deep stack and 512-iteration limit. The key difference is that **all threads in a subgroup now traverse for rays with similar origins** (after the first bounce, rays hitting the same object tend to traverse similar BVH subtrees).

**Optimization — Persistent Threads (future):**
Instead of 1:1 thread-to-ray mapping, use persistent threads that pull rays from a shared work queue. This balances load when some rays require significantly more BVH steps than others.

---

### 5.3 Sort Kernel (Material Sorting)

**Purpose:** Reorder ray indices by `materialIndex` so that the Shade kernel processes rays with the same material type together, maximizing warp coherence.

```
Dispatch: [ceil(activeRayCount / 256), 1, 1]
Workgroup: [256, 1, 1]
```

**Algorithm — Radix Sort (8-bit key):**

Material indices are typically < 256, so a single-pass 8-bit radix sort suffices.

```
Phase 1 — Local Histogram (per workgroup):
    sharedHistogram[256] = 0
    barrier()
    matID = hitBuffer[activeRayIndices[tid]].materialIndex
    atomicAdd(sharedHistogram[matID], 1)
    barrier()

Phase 2 — Global Prefix Sum:
    // Separate 1-workgroup reduction kernel over per-WG histograms
    // Produces global offsets per material bin

Phase 3 — Scatter:
    globalOffset = prefixSum[matID] + localOffset
    sortedIndices[globalOffset] = activeRayIndices[tid]
```

**Simplification for small material counts (<16):**
Use a counting sort with shared memory atomics — simpler and faster than full radix sort. The histogram fits in 16 × sizeof(u32) = 64 bytes of shared memory.

**When to skip sorting:**
- Bounce 0 (primary rays): All rays are unsorted but material coherence is naturally high (screen-space locality → similar objects)
- Scenes with ≤ 2 materials: Sorting overhead exceeds divergence cost
- Configurable via `enableMaterialSort` uniform

---

### 5.4 Shade Kernel (Material Evaluation)

**Purpose:** Evaluate material response, compute direct lighting contribution, generate shadow rays, and spawn bounce rays.

```
Dispatch: [ceil(activeRayCount / 256), 1, 1]
Workgroup: [256, 1, 1]
```

This is the most complex kernel but has **minimal divergence** because rays are sorted by material type. Within a material type, all threads execute the same BRDF code.

**Inputs:**
- Ray buffer (throughput, pdf, lastNormal, rngState)
- Hit buffer (hitDistance, triangleIndex, barycentrics, materialIndex)
- Sorted indices from Sort kernel
- Material data texture, material texture arrays
- Light data (directional, area, point, spot buffers)
- Environment map + CDF

**Outputs:**
- Updated ray buffer (new origin, direction, throughput for bounce ray)
- Shadow queue (shadow ray origin, direction, maxDist, pendingRadiance)
- Updated active flags (terminate on miss, absorption, Russian roulette)
- First-hit buffer (only at bounce 0)
- Atomic shadow ray counter

**Algorithm:**

```
sortedIdx = sortedIndices[globalThreadID]
rayID = sortedIdx
hit = loadHit(rayID)

// --- Miss ---
if (hit.distance >= 1e30) {
    if (enableEnvironment) {
        envRadiance = sampleEnvironmentMap(ray.direction)
        ray.radiance += ray.throughput * envRadiance
    }
    ray.flags &= ~ACTIVE  // Terminate
    writeRay(rayID, ray)
    if (bounce == 0) writeFirstHit(rayID, MISS)
    return
}

// --- Surface setup ---
position = ray.origin + ray.direction * hit.distance
(shadingNormal, texCoords) = interpolateAttributes(hit)
material = loadMaterial(hit.materialIndex, texCoords)

// --- First-hit MRT data ---
if (bounce == 0) {
    writeFirstHit(rayID, shadingNormal, hit.distance, material.albedo, hit.meshIndex)
}

// --- Direct lighting (Next Event Estimation) ---
(lightDir, lightDist, lightRadiance, lightPdf) = sampleLight(position, shadingNormal, rng)
if (lightPdf > 0) {
    brdfResponse = evaluateBRDF(material, ray.direction, lightDir, shadingNormal)
    misWeight = powerHeuristic(lightPdf, brdfPdf)
    pendingRadiance = ray.throughput * brdfResponse * lightRadiance * misWeight / lightPdf

    // Enqueue shadow ray
    shadowID = atomicAdd(shadowRayCount, 1)
    writeShadowRay(shadowID, offsetPosition, lightDir, lightDist, pendingRadiance, rayID)
}

// --- BRDF sampling (bounce ray) ---
(bounceDir, bouncePdf) = sampleBRDF(material, ray.direction, shadingNormal, rng)
brdfEval = evaluateBRDF(material, ray.direction, bounceDir, shadingNormal)
ray.throughput *= brdfEval / bouncePdf

// --- Russian roulette ---
if (bounce >= 3) {
    survivalProb = min(max(ray.throughput.r, ray.throughput.g, ray.throughput.b), 0.95)
    if (rng.next() > survivalProb) {
        ray.flags &= ~ACTIVE
        writeRay(rayID, ray)
        return
    }
    ray.throughput /= survivalProb
}

// --- Prepare bounce ray ---
ray.origin = offsetPosition(position, shadingNormal, bounceDir)
ray.direction = bounceDir
ray.pdf = bouncePdf
ray.bounce += 1
ray.flags |= ACTIVE
writeRay(rayID, ray)
```

**Material-Specific Sub-Kernels (future optimization):**

For maximum coherence, the Shade kernel can dispatch to material-specific sub-kernels:

| Material Type | Sub-Kernel | BRDF Lobes |
|--------------|-----------|------------|
| Diffuse/Opaque | `ShadeDiffuse` | Lambertian + GGX specular |
| Glass/Transmissive | `ShadeGlass` | Microfacet transmission + Fresnel |
| Emissive | `ShadeEmissive` | Direct emission (no bounce) |
| Clearcoat | `ShadeClearcoat` | Base BRDF + clearcoat lobe |
| Thin-film | `ShadeThinFilm` | Interference + base |

This is an optimization for Phase 2 (see [Migration Strategy](#12-migration-strategy)). Phase 1 uses a single Shade kernel with material branching, which is still significantly better than the current mega-kernel because rays are **pre-sorted**.

---

### 5.5 Connect Kernel (Shadow Ray Traversal)

**Purpose:** Test shadow ray visibility. Uses the existing `traverseBVHShadow()` early-exit traversal.

```
Dispatch: [ceil(shadowRayCount / 256), 1, 1]
Workgroup: [256, 1, 1]
```

**Inputs:**
- Shadow queue (origin, direction, maxDist)
- BVH data texture, triangle data texture

**Outputs:**
- Visibility result buffer: `u32` per shadow ray (1 = visible, 0 = occluded)

**Algorithm:**
```
shadowID = globalThreadID
if (shadowID >= shadowRayCount) return

shadow = loadShadowRay(shadowID)
occluded = traverseBVHShadow(shadow.origin, shadow.direction, shadow.maxDist)
visibilityBuffer[shadowID] = occluded ? 0 : 1
```

**Optimization — Shadow ray coherence:**
Shadow rays to the same light source from nearby surface points have similar directions and origins. After material sorting in Shade, shadow rays are naturally grouped by surface region, improving BVH traversal coherence.

---

### 5.6 Accumulate Kernel

**Purpose:** Apply shadow test results to accumulate direct lighting, and write final pixel values after all bounces complete.

```
Dispatch: [ceil(shadowRayCount / 256), 1, 1]
Workgroup: [256, 1, 1]
```

**Inputs:**
- Shadow visibility results
- Shadow queue (pendingRadiance, parentRayID)
- Ray buffer (radiance, pixelIndex)

**Outputs:**
- Updated ray radiance (scatter-add via atomics or deterministic reduction)
- Final pixel accumulation buffer (after last bounce)

**Algorithm:**
```
shadowID = globalThreadID
if (shadowID >= shadowRayCount) return

if (visibilityBuffer[shadowID] == 1) {
    shadow = loadShadowRay(shadowID)
    // Atomic add to ray's accumulated radiance
    atomicAddF32(rayRadiance[shadow.parentRayID].r, shadow.pendingRadiance.r)
    atomicAddF32(rayRadiance[shadow.parentRayID].g, shadow.pendingRadiance.g)
    atomicAddF32(rayRadiance[shadow.parentRayID].b, shadow.pendingRadiance.b)
}
```

**Final Write Kernel** (dispatched once after all bounces):

```
Dispatch: [ceil(totalRays / 256), 1, 1]
Workgroup: [256, 1, 1]

rayID = globalThreadID
pixel = rayBuffer.pixelIndex[rayID]
radiance = rayBuffer.radiance[rayID]

// Scatter-write to output StorageTexture
px = pixel % width
py = pixel / width

// Accumulation with previous frames
if (enableAccumulation && hasPreviousFrame) {
    prev = textureLoad(prevAccumTex, ivec2(px, py))
    alpha = accumulationAlpha
    result = mix(prev.rgb, radiance, alpha)
} else {
    result = radiance
}

textureStore(writeColorTex, uvec2(px, py), vec4(result, 1.0))
textureStore(writeNDTex, uvec2(px, py), firstHitBuffer[rayID].normalDepth)
textureStore(writeAlbedoTex, uvec2(px, py), vec4(firstHitBuffer[rayID].albedo, 1.0))
```

---

## 6. Queue Management & Stream Compaction

### Active Ray Count Tracking

Each kernel reads and writes ray counts via **atomic counters** stored in a small StorageBuffer:

```
struct QueueCounters {
    activeRayCount: atomic<u32>,      // Rays alive for next bounce
    shadowRayCount: atomic<u32>,      // Shadow rays generated by Shade
    newRayCount: atomic<u32>,         // Rays generated by Generate
    terminatedCount: atomic<u32>,     // Rays terminated this bounce
}
```

### Stream Compaction (between bounces)

After Shade marks rays as inactive, compaction produces a dense array of active ray indices for the next Extend dispatch.

**Algorithm — Parallel Prefix Sum:**

```
Phase 1 — Per-workgroup scan:
    isActive = (rayBuffer.flags[tid] & ACTIVE) ? 1 : 0
    sharedScan = inclusivePrefixSum(isActive)  // within workgroup
    if (lastThread) workgroupTotals[wgID] = sharedScan[WG_SIZE - 1]

Phase 2 — Workgroup-level prefix sum:
    // Single workgroup scans workgroupTotals array
    globalOffsets = inclusivePrefixSum(workgroupTotals)

Phase 3 — Scatter:
    globalIndex = globalOffsets[wgID - 1] + sharedScan[localID] - 1
    if (isActive) activeRayIndices[globalIndex] = tid
    if (lastThread of last WG) activeRayCount = globalOffsets[lastWG]
```

**Simplified approach (Phase 1 implementation):**
Use atomic counter with simple append:
```
if (ray.flags & ACTIVE) {
    idx = atomicAdd(activeRayCount, 1)
    activeRayIndices[idx] = rayID
}
```

This has atomic contention but is simpler. Switch to prefix sum if profiling shows it as a bottleneck.

### Counter Reset

A tiny **ResetCounters** kernel (1 thread) zeroes the atomic counters before each bounce iteration:
```
Dispatch: [1, 1, 1]
Workgroup: [1, 1, 1]

atomicStore(shadowRayCount, 0)
atomicStore(activeRayCount, 0)  // Shade kernel will re-populate
```

---

## 7. Material Sorting

### Why Sort?

After BVH traversal, adjacent ray indices may hit completely different materials. Without sorting, a 32-wide subgroup executing the Shade kernel may have threads evaluating 10+ different material types — each taking a different branch through the BRDF code. Sorting by `materialIndex` ensures subgroups are material-coherent.

### Sort Granularity

| Material Count | Strategy |
|----------------|----------|
| 1-4 | Skip sorting entirely |
| 5-16 | Counting sort with shared memory (16-bin histogram) |
| 17-256 | Single-pass 8-bit radix sort |
| 257+ | Two-pass radix sort (unlikely in practice) |

### Counting Sort Implementation

```
// Phase 1: Local histogram
shared histogram[MAX_MATERIALS]  // zeroed
barrier()
matID = hitBuffer[rayID].materialIndex
atomicAdd(histogram[matID], 1)
barrier()

// Phase 2: Local prefix sum
shared prefixSum[MAX_MATERIALS]
if (localID < MAX_MATERIALS) {
    prefixSum[localID] = histogram[localID]
    // Inclusive scan within shared memory
}
barrier()

// Phase 3: Scatter to sorted indices
offset = atomicAdd(histogram[matID], -1) - 1  // Decrement for unique position
sortedIndices[prefixSum[matID] - offset - 1] = rayID
```

### Adaptive Sorting

Sort decision made per-bounce:

```
if (activeRayCount < 1024) skip      // Too few rays to benefit
if (uniqueMaterialCount <= 2) skip    // Negligible divergence
if (bounce == 0) skip                 // Primary hits are screen-coherent
else sort()
```

---

## 8. Pipeline Integration

### New Stage: `WavefrontPathTracerStage`

Replaces `PathTracingStage` as a `PipelineStage` subclass. Internally manages the multi-kernel dispatch loop.

```
class WavefrontPathTracerStage extends PipelineStage {
    // Sub-components (same composition pattern as current PathTracingStage)
    uniforms: UniformManager          // Reused as-is
    materialData: MaterialDataManager  // Reused as-is
    environment: EnvironmentManager    // Reused as-is
    renderTargets: StorageTexturePool  // Reused for final output
    tileManager: TileRenderingManager  // Reused for tiled mode

    // New: Wavefront-specific
    rayBufferPool: RayBufferPool       // Manages SoA storage buffers
    kernelManager: KernelManager       // Builds and dispatches compute nodes
    queueManager: QueueManager         // Active ray indices + shadow queue

    executionMode = PipelineStage.ExecutionMode.ALWAYS

    render(context) {
        this._updateUniforms()

        // Generate primary rays
        this.kernelManager.dispatchGenerate(this.tileManager.currentTile)

        // Bounce loop
        for (let bounce = 0; bounce < this.maxBounces; bounce++) {
            this.kernelManager.dispatchExtend()

            if (this.enableMaterialSort && bounce > 0) {
                this.kernelManager.dispatchSort()
            }

            this.kernelManager.dispatchShade(bounce)
            this.kernelManager.dispatchConnect()
            this.kernelManager.dispatchAccumulate()
            this.kernelManager.dispatchCompact()

            // Early exit if no active rays remain
            // (Read back activeRayCount — see §11 for async readback strategy)
        }

        // Final write to output StorageTextures
        this.kernelManager.dispatchFinalWrite()
        this.renderTargets.copyToReadTargets(this.renderer)

        // Publish to pipeline context (same interface as current stage)
        context.setTexture('pathtracer:color', this.renderTargets.getReadTextures().color)
        context.setTexture('pathtracer:normalDepth', this.renderTargets.getReadTextures().normalDepth)

        this.emit('pathtracer:frameComplete', { frame: this.frame, samples: this.spp })
    }
}
```

### Event Compatibility

All existing events are preserved:

| Event | Emitter | Consumers | Change |
|-------|---------|-----------|--------|
| `pathtracer:frameComplete` | WavefrontPathTracerStage | ASVGF, Variance, Pipeline | None |
| `camera:moved` | WavefrontPathTracerStage | MotionVector, NormalDepth | None |
| `tile:changed` | WavefrontPathTracerStage | TileHighlight | None |
| `asvgf:reset` | WavefrontPathTracerStage | ASVGF | None |
| `pipeline:reset` | Pipeline | All stages | None |

### Context Texture Keys

Output texture keys remain identical:
- `pathtracer:color` — RGBA accumulated radiance
- `pathtracer:normalDepth` — Normal (RGB) + linear depth (A)
- `pathtracer:albedo` — Surface albedo (RGB)

**Downstream stages (ASVGF, EdgeAwareFiltering, AdaptiveSampling, OIDN, DisplayStage) require zero changes.**

---

## 9. MRT & Denoiser Compatibility

### First-Hit Data Collection

The current mega-kernel writes MRT data inline during bounce 0. In wavefront mode, this happens in the **Shade kernel at bounce 0**:

```
// In Shade kernel:
if (bounce == 0 && hit.distance < 1e30) {
    firstHitNormalDepth[rayID] = vec4(
        shadingNormal * 0.5 + 0.5,   // Encoded normal
        linearDepth                    // Same as current: computeNDCDepth()
    )
    firstHitAlbedo[rayID] = vec4(material.albedo, 1.0)
}
```

The **FinalWrite kernel** transfers this from per-ray buffers to the output StorageTextures in the same pixel layout as today.

### ASVGF Compatibility

ASVGF reads:
- `pathtracer:color` — ✅ Same output
- `pathtracer:normalDepth` — ✅ Same encoding (normal * 0.5 + 0.5, linear depth in alpha)
- Motion vectors from MotionVectorStage — ✅ Unaffected (separate stage)

### OIDN Compatibility

OIDN reads:
- Color buffer — ✅ Same output
- Albedo buffer — ✅ Same encoding
- Normal buffer — ✅ Same encoding

**Critical:** The NaN guard for background pixels (`normalize(vec3(0))` → NaN) is handled the same way: background rays in Shade kernel write `normal = vec3(0, 0, 1)`, `depth = 1.0`.

### Adaptive Sampling Compatibility

AdaptiveSamplingStage reads variance data and outputs a per-pixel sampling guidance texture. The wavefront Generate kernel reads this texture to conditionally skip converged pixels:

```
// In Generate kernel:
if (useAdaptiveSampling) {
    guidance = textureLoad(adaptiveSamplingTex, ivec2(px, py))
    if (guidance.z > 0.5) return  // Pixel converged, skip
}
```

---

## 10. Memory Budget

### Per-Resolution Buffer Sizes

At 1920×1080 (2,073,600 pixels), 1 SPP:

| Buffer | Per-Ray Bytes | Total (MB) | Count |
|--------|--------------|------------|-------|
| Ray origin | 12 | 23.7 | 1 |
| Ray direction | 12 | 23.7 | 1 |
| Ray throughput | 12 | 23.7 | 1 |
| Ray radiance | 12 | 23.7 | 1 |
| Pixel index | 4 | 7.9 | 1 |
| RNG state | 16 | 31.6 | 1 |
| Bounce + flags | 4 | 7.9 | 1 |
| PDF | 4 | 7.9 | 1 |
| Last normal | 12 | 23.7 | 1 |
| **Ray subtotal** | **88** | **173.8** | |
| Hit distance | 4 | 7.9 | 1 |
| Triangle index | 4 | 7.9 | 1 |
| Barycentrics | 8 | 15.8 | 1 |
| Material+mesh index | 8 | 15.8 | 1 |
| Geometric normal | 12 | 23.7 | 1 |
| **Hit subtotal** | **36** | **71.1** | |
| Shadow origin | 12 | 23.7 | 1 |
| Shadow direction | 12 | 23.7 | 1 |
| Shadow max dist | 4 | 7.9 | 1 |
| Pending radiance | 12 | 23.7 | 1 |
| Parent ray ID | 4 | 7.9 | 1 |
| **Shadow subtotal** | **44** | **86.9** | |
| Active ray indices | 4 | 7.9 | 2 (ping-pong) |
| Sorted indices | 4 | 7.9 | 1 |
| First-hit normal+depth | 16 | 31.6 | 1 |
| First-hit albedo | 16 | 31.6 | 1 |
| Queue counters | 16 | 0.00002 | 1 |
| **Overhead subtotal** | | **87.0** | |
| **TOTAL** | | **~419 MB** | |

### Comparison with Current Architecture

| | Current (Mega-kernel) | Wavefront |
|---|---|---|
| StorageTextures (3× RGBA32F) | 3 × 32 MB = 96 MB | 3 × 32 MB = 96 MB (output) |
| Render targets (ping-pong) | 2 × 96 MB = 192 MB | 2 × 96 MB = 192 MB |
| Ray/hit/shadow buffers | 0 MB | ~419 MB |
| Register file per thread | High (spilling likely) | Low (no spilling) |
| **Effective GPU memory** | ~288 MB + register spill | ~707 MB |

**Memory delta:** +419 MB for ray buffers. This is within budget for discrete GPUs (2GB+ VRAM) and most integrated GPUs (shared memory).

### Memory Reduction Strategies

1. **Half-precision throughput/radiance:** `vec3<f16>` halves 4 buffers (saves ~95 MB)
2. **Octahedral normal encoding:** 2 floats instead of 3 (saves ~16 MB across normal buffers)
3. **Combined bounce+flags+materialHint:** Already packed in single u32
4. **Shadow queue sizing:** Shadow rays ≤ active rays; can share buffer memory with terminated rays
5. **Tiled rendering:** In tile mode, only allocate buffers for tile size (e.g., 256×256 = 65K rays → 5.5 MB total)

### Tiled Mode Memory (256×256 tile)

| Buffer | Size |
|--------|------|
| Ray buffers | 5.6 MB |
| Hit buffers | 2.3 MB |
| Shadow buffers | 2.8 MB |
| Indices + first-hit | 2.8 MB |
| **Total** | **~13.5 MB** |

---

## 11. Three.js TSL Constraints

### Challenge 1: Storage Buffers in TSL

Three.js TSL exposes StorageTextures via `textureStore()`/`textureLoad()`, but **storage buffers** (needed for SoA ray data) require `StorageBufferAttribute` or `StorageInstancedBufferAttribute`.

**Approach:**
```javascript
import { storage, storageObject } from 'three/tsl';

// Create typed array for buffer
const rayOriginData = new Float32Array(maxRays * 3);
const rayOriginAttr = new StorageBufferAttribute(rayOriginData, 3);
const rayOriginNode = storage(rayOriginAttr, 'vec3', maxRays);

// In compute Fn:
const origin = rayOriginNode.element(rayID);  // Read
rayOriginNode.element(rayID).assign(newOrigin); // Write
```

### Challenge 2: Atomic Operations

WebGPU supports `atomicAdd`, `atomicMax`, `atomicOr` etc. on `atomic<u32>` and `atomic<i32>`. TSL exposes these via:

```javascript
import { atomicFunc } from 'three/tsl';

const counterBuffer = new StorageBufferAttribute(new Uint32Array(4), 1);
const counterNode = storage(counterBuffer, 'uint', 4);

// In compute:
atomicFunc('atomicAdd', counterNode.element(0), uint(1));
```

**Limitation:** No native `atomicAdd` for `f32`. For float accumulation in the Accumulate kernel, options:
1. **Fixed-point atomics:** Multiply by 2^16, atomicAdd as u32, divide back
2. **Per-ray accumulation:** Each path accumulates its own radiance (no cross-ray atomics needed for bounce rays). Only shadow ray contributions need scatter-add.
3. **Deterministic write:** Since each shadow ray maps to exactly one parent ray, and shadow rays from the same parent are sequential, use a per-ray lock or ordered writes.

**Recommended:** Option 2 — accumulate radiance in the ray buffer (no atomics for bounce rays). For shadow rays, use fixed-point atomics or a single shadow ray per light per bounce (current behavior), which means each parent ray has at most 1 shadow ray → no contention.

### Challenge 3: Indirect Dispatch

WebGPU supports `dispatchWorkgroupsIndirect` but Three.js TSL does not expose it yet. The dispatch count must be known on the CPU.

**Workaround — CPU readback of active ray count:**

```javascript
// After compaction kernel, read back counter
const counterReadback = new Float32Array(1);
await renderer.readStorageBufferAsync(counterBuffer, counterReadback);
const activeCount = counterReadback[0];

// Set dispatch for next kernel
extendKernel.setCount([Math.ceil(activeCount / 256), 1, 1]);
```

**Performance impact:** One async readback per bounce (~0.1ms latency). Acceptable for ≤20 bounces.

**Future:** When Three.js adds indirect dispatch support, replace with GPU-driven dispatch counts.

### Challenge 4: Multiple Compute Dispatches Per Frame

The wavefront approach requires 6-8 `renderer.compute()` calls per bounce × up to 20 bounces = up to 160 dispatches per frame. Three.js WebGPU backend batches these into a single command encoder, but:

- Each `renderer.compute()` call creates a new compute pass
- No explicit barrier API — implicit barriers between passes
- Potential overhead from pass creation

**Mitigation:**
- WebGPU guarantees memory coherence between dispatches in the same command buffer
- Three.js batches all compute calls before the frame's render call
- Profile and report if dispatch overhead > 5% of frame time

### Challenge 5: StorageTexture Cross-Dispatch Reads

Per existing project knowledge: StorageTextures read as zeros across dispatches. The wavefront architecture uses **StorageBuffers** for ray/hit/shadow data (not StorageTextures), which do NOT have this limitation. StorageTextures are only used for the final pixel output (same as current architecture).

### Challenge 6: Dynamic Buffer Sizing

Ray buffers must be sized for `maxRays = width * height * samplesPerPixel`. On resolution change:

```javascript
setSize(width, height) {
    const maxRays = width * height;
    if (maxRays > this.allocatedMaxRays) {
        this.rayBufferPool.resize(maxRays);
        this.rebuildComputeNodes();  // StorageBuffer size change requires recompilation
    }
}
```

**Strategy:** Over-allocate by 25% to absorb small resolution changes without recompilation. Round up to next power-of-2 for buffer sizes.

---

## 12. Migration Strategy

### Phase 0 — Foundation (Non-breaking)

**Goal:** Establish buffer infrastructure without changing rendering output.

1. Create `RayBufferPool` class managing SoA StorageBuffers
2. Create `KernelManager` class for building/dispatching compute nodes
3. Create `QueueManager` class for active ray tracking
4. Write unit tests: buffer read/write roundtrip, atomic counters, compaction correctness
5. Add `wavefrontEnabled` feature flag in `Features.js`

**Deliverables:** New classes in `src/core/Processor/`, no existing code modified.

### Phase 1 — Core Wavefront (Feature-flagged)

**Goal:** Working wavefront path tracer behind feature flag, matching current output.

1. Implement `WavefrontPathTracerStage` extending `PipelineStage`
2. Port Generate kernel (from `PathTracer.js` ray generation)
3. Port Extend kernel (from `BVHTraversal.js`)
4. Implement single unified Shade kernel (from `PathTracerCore.js` + `MaterialSampling.js` + `LightsSampling.js`)
5. Implement Connect kernel (from `traverseBVHShadow`)
6. Implement Accumulate + FinalWrite kernels
7. Implement stream compaction (simple atomic append)
8. Wire into `PassPipeline` with feature flag toggle
9. Visual comparison testing: wavefront vs. mega-kernel on reference scenes

**Success criteria:** Pixel-identical output (within floating-point tolerance) on Cornell Box, Sponza, material test scenes.

### Phase 2 — Optimization

**Goal:** Realize wavefront performance benefits.

1. Implement material sorting (counting sort for ≤16 materials, radix sort otherwise)
2. Profile each kernel — identify bandwidth vs. compute bottlenecks
3. Implement half-precision ray buffers where safe
4. Add persistent threads for Extend kernel (load balancing)
5. Implement adaptive sort skip (bounce 0, few materials)
6. Optimize compaction with parallel prefix sum
7. Add per-material Shade sub-kernels for top 3-4 material types

### Phase 3 — Advanced Features

**Goal:** Leverage wavefront architecture for features impractical in mega-kernel.

1. **Ray reordering** by BVH node for Extend coherence
2. **Spectral rendering** (wavelength-dependent paths, separate queues per wavelength)
3. **Path guiding** (learned directional distributions per spatial cell)
4. **Shader Execution Reordering (SER)** when WebGPU exposes it
5. **Multi-sample wavefront** (process N samples per pixel in one frame)
6. **Subsurface scattering** via dedicated scatter kernel
7. **Volume rendering** via dedicated volume traversal kernel

---

## 13. Performance Expectations

### Theoretical Analysis

| Metric | Mega-kernel (current) | Wavefront (Phase 1) | Wavefront (Phase 2) |
|--------|----------------------|---------------------|---------------------|
| Subgroup utilization | 40-70% (material divergence) | 70-85% (unsorted) | 90-98% (sorted) |
| Register usage per thread | ~200 VGPRs | ~60-80 VGPRs per kernel | ~40-60 VGPRs |
| Occupancy | 2-4 waves/CU | 6-10 waves/CU | 8-12 waves/CU |
| L2 cache hit rate (BVH) | 50-60% | 60-70% (ray coherence) | 75-85% (sorted) |
| Kernel dispatch overhead | 1 dispatch | 6-8 per bounce | 6-8 per bounce |
| Memory bandwidth | Low (register-heavy) | Higher (buffer I/O) | Optimized (half-prec) |

### Expected Speedup Ranges

| Scene Type | Expected Speedup | Why |
|------------|-----------------|-----|
| Simple (1-2 materials, low bounces) | 0.8-1.2× | Dispatch overhead may offset small divergence gains |
| Moderate (5-10 materials, 8 bounces) | 1.5-2.5× | Material sorting recovers significant subgroup utilization |
| Complex (20+ materials, 12+ bounces) | 2.0-4.0× | Maximum divergence recovery + occupancy improvement |
| Glass-heavy (transmission/refraction) | 2.5-5.0× | Transmission paths are longest-diverging in mega-kernel |

### When Wavefront is Slower

- **Very low bounce count (1-2):** Dispatch overhead dominates
- **Single material scenes:** No divergence to recover
- **Very small resolution:** Not enough rays to fill GPU
- **Memory-limited GPUs (<2GB):** Buffer allocation pressure

**Mitigation:** Keep mega-kernel as fallback (existing `PathTracingStage`). Auto-select based on scene complexity and GPU capability.

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Three.js TSL lacks storage buffer atomics** | Medium | High — blocks Accumulate kernel | Use fixed-point atomics on u32 buffers; or restrict to 1 shadow ray per bounce (no contention) |
| **Dispatch overhead > 5% frame time** | Medium | Medium — reduces net gain | Merge Sort+Shade into single kernel; reduce bounces in interactive mode |
| **Async readback latency stalls GPU** | Low | Medium — pipeline bubble | Use previous frame's ray count (1 frame latency); or fixed max dispatch |
| **Memory exceeds mobile GPU budget** | Medium | High — regression on iGPU | Tiled mode default on mobile; half-precision buffers; adaptive buffer sizing |
| **TSL compiler rejects complex buffer access** | Low | High — blocks implementation | Simplify buffer access patterns; fall back to StorageTexture encoding if needed |
| **Visual differences vs. mega-kernel** | Medium | Low — expected for reordered operations | Floating-point reordering tolerance; reference image comparison suite |
| **Three.js breaking changes to compute API** | Medium | Medium — maintenance burden | Pin Three.js version during development; abstract compute API behind `KernelManager` |
| **Shader recompilation on buffer resize** | Medium | Medium — stutter on resolution change | Over-allocate buffers; round to power-of-2 sizes |

---

## Appendix

### A. Kernel Dependency Graph

```
Generate ──────────────▶ Extend ──▶ Sort ──▶ Shade ──┬──▶ Connect ──▶ Accumulate
                            ▲                         │                    │
                            │                         │                    │
                            └──── Compact ◀───────────┴────────────────────┘
                                    │
                            (loop back to Extend if activeRays > 0)
```

### B. Buffer Lifetime Chart

```
Kernel:     Generate   Extend   Sort    Shade   Connect  Accumulate  Compact
            ────────   ──────   ────    ─────   ───────  ──────────  ───────
Ray origin:    W         R               R/W                           R
Ray dir:       W         R               R/W                           R
Throughput:    W                          R/W                           R
Radiance:      W                          R/W              R/W          R
PixelIndex:    W                                                        R
RNG:           W                          R/W                           R
Flags:         W                          R/W                           R
Hit dist:                 W       R        R
TriIndex:                 W       R        R
Bary:                     W                R
MatIndex:                 W       R        R
GeoNormal:                W                R
Shadow orig:                               W        R
Shadow dir:                                W        R
Shadow dist:                               W        R
Pending rad:                               W                 R
ParentRayID:                               W                 R
Visibility:                                         W        R
FirstHitND:                                W                           R*
FirstHitAlb:                               W                           R*
ActiveIdx:     W          R       R        R                           R/W

W = Write, R = Read, R/W = Read-then-Write, R* = Read in FinalWrite only
```

### C. Workgroup Size Rationale

| Kernel | Workgroup | Why |
|--------|-----------|-----|
| Generate | 16×16×1 | Screen-space coherence; matches current path tracer |
| Extend | 256×1×1 | 1D ray-parallel; maximizes occupancy for BVH traversal |
| Sort | 256×1×1 | Histogram + scatter; 256 threads = 256-bin histogram in shared memory |
| Shade | 256×1×1 | 1D over sorted rays; material coherence within subgroups |
| Connect | 256×1×1 | 1D over shadow rays; same as Extend (BVH traversal) |
| Accumulate | 256×1×1 | 1D over shadow rays; simple scatter-add |
| Compact | 256×1×1 | 1D prefix sum; standard parallel pattern |
| FinalWrite | 16×16×1 | Screen-space output; matches StorageTexture layout |

### D. Uniform Reuse Map

| Uniform (from UniformManager) | Used By Kernels |
|------------------------------|-----------------|
| `cameraWorldMatrix` | Generate |
| `projectionMatrixInverse` | Generate |
| `frame`, `resolution` | Generate, FinalWrite |
| `maxBounces` | Bounce loop (CPU) |
| `samplesPerPixel` | Bounce loop (CPU) |
| `enableDOF`, `aperture`, `focusDistance` | Generate |
| `enableEnvironment`, `environmentIntensity` | Shade |
| `useEnvMapIS` | Shade |
| `numDirectionalLights`, light buffers | Shade |
| `enableAccumulation`, `accumulationAlpha` | FinalWrite |
| `renderMode`, `tileInfo` | Generate |
| `useAdaptiveSampling` | Generate |
| BVH texture, triangle texture | Extend, Connect |
| Material data texture, texture arrays | Shade |
| Environment texture, CDF textures | Shade |

### E. Feature Flag Integration

```javascript
// src/core/Features.js
export const FEATURES = {
    WAVEFRONT_PATH_TRACING: false,  // Enable wavefront architecture
    WAVEFRONT_MATERIAL_SORT: true,  // Enable material sorting (requires wavefront)
    WAVEFRONT_HALF_PRECISION: false, // Use f16 for throughput/radiance buffers
    WAVEFRONT_PERSISTENT_THREADS: false, // Persistent thread Extend kernel
};

// src/core/Pipeline/PassPipeline.js
if (FEATURES.WAVEFRONT_PATH_TRACING) {
    this.addStage(new WavefrontPathTracerStage(renderer, scene, camera));
} else {
    this.addStage(new PathTracingStage(renderer, scene, camera));
}
```

### F. File Structure (Proposed)

```
src/core/
├── Stages/
│   ├── PathTracingStage.js            # Existing (kept as fallback)
│   └── WavefrontPathTracerStage.js    # New: orchestrator
├── Processor/
│   ├── RayBufferPool.js               # New: SoA buffer management
│   ├── KernelManager.js               # New: compute node build/dispatch
│   └── QueueManager.js                # New: active indices + compaction
├── TSL/
│   ├── wavefront/
│   │   ├── GenerateKernel.js          # New: primary ray generation
│   │   ├── ExtendKernel.js            # New: BVH traversal
│   │   ├── SortKernel.js              # New: material sorting
│   │   ├── ShadeKernel.js             # New: material eval + NEE
│   │   ├── ConnectKernel.js           # New: shadow traversal
│   │   ├── AccumulateKernel.js        # New: radiance accumulation
│   │   ├── CompactKernel.js           # New: stream compaction
│   │   └── FinalWriteKernel.js        # New: pixel output
│   ├── BVHTraversal.js                # Existing (shared with Extend/Connect)
│   ├── PathTracerCore.js              # Existing (Shade kernel extracts from this)
│   ├── MaterialSampling.js            # Existing (shared with Shade)
│   ├── LightsSampling.js              # Existing (shared with Shade)
│   └── ...                            # Other existing TSL modules unchanged
```

### G. Glossary

| Term | Definition |
|------|-----------|
| **Wavefront** | A batch of rays processed together by a single kernel dispatch |
| **Stream compaction** | Removing inactive elements from an array to produce a dense array of active elements |
| **SoA** | Structure of Arrays — each field stored in its own contiguous buffer (vs. AoS where all fields are interleaved) |
| **NEE** | Next Event Estimation — sampling light sources directly rather than waiting for a random bounce to hit them |
| **MIS** | Multiple Importance Sampling — combining light sampling and BRDF sampling PDFs for lower variance |
| **Subgroup** | Hardware-level group of threads (32 on NVIDIA, 32/64 on AMD) that execute in lockstep (SIMT) |
| **Occupancy** | Ratio of active warps to maximum warps a compute unit can host; limited by register and shared memory usage |
| **Mega-kernel** | A single large shader that performs all path tracing operations per thread |
| **Persistent threads** | A pattern where threads loop, pulling work from a shared queue, rather than being assigned fixed work |
