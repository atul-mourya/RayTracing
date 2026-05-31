# Wavefront Ray-State Packing — Spec

Status: **in progress** — Tier 1 + Tier 2 shipped. Created 2026-06-01.

## Progress

- ✅ **Tier 1 (commit `479b959`)** — derive `pixelIndex`/`sampleIndex` from `rayID`; bit-pack
  `perRayBounces|sssSteps` into `ORIGIN_META.w`; delete the `PATH_META` vec4. `RAY_STRIDE` 10→9.
  Live-verified bit-exact on camera + Stanford Bunny (diffuse GI, S=4 multi-sample, **glass**, **SSS**).
- ✅ **Tier 2 (commit `fb429d7`)** — dropped the pow2 capacity over-allocation (`requiredCapacity` =
  `ceil(maxRays·1.25)`, no `nextPow2`). Capacity @2048² 8.39M→5.24M (−37.5%), applies to all
  capacity-keyed buffers (ray/hit/shadow/queues). Latency-neutral, lossless.
- **Achieved so far:** RAY buffer @2048² **1280 MiB → 720 MiB (−44%)** vs the original stride-10/pow2.
- ✅ **Shade binding freed (commit `5a9dedc`)** — device `maxStorageBuffersPerShaderStage` = 10 and Shade
  was at **exactly 10** (bvh, tri, mat, envCDF, light, ray, rng, hit, counters, activeIndices), blocking
  any new buffer. Instead of merging envCDF into the light buffer (which would couple the env + geometry
  lifecycles), moved the env-CDF to an **R32F texture** ((W+1)×H — conditional at texel (cx,cy), marginal
  in column W). Textures have a separate, larger binding budget, so Shade drops to **9 storage bindings**
  with no lifecycle coupling. Env IS verified correct (camera + diffuse bunny NEE renders unchanged).
- ✅ **G-buffer move (Step 4, commit `4574890`)** — `NORMAL_DEPTH`+`ALBEDO_ID` (RAY slots 4,5, write-once
  first-hit, read only by FinalWrite) moved to a separate per-pixel `gBuffer` (AoS, 2 vec4/pixel; written
  by Generate/Shade bounce-0 gated to sub-sample 0; read by FinalWrite). `RAY_STRIDE` 9→7. Uses the Shade
  slot freed by envCDF→texture (Shade now 10 storage = device limit). Honest accounting: at production
  (S=1) it's ~**total-neutral** (the 2 slots relocate to a same-size separate binding), but the **largest
  binding (RAY) shrinks 9→7 = −22%** (587 MiB @2048²; −54% vs the original stride-10/pow2), which is what
  matters for the per-binding `maxStorageBufferBindingSize` limit on low-end adapters. It's also smaller at
  S>1 (gBuffer is W×H, not ×S) and is the **prerequisite for the Tier-3 G-buffer packing** (oct normal +
  unorm8 albedo → 2 vec4 → 1 vec4, halving the gBuffer). 3-reviewer adversarial pass: no correctness bugs;
  production OIDN denoise clean (OIDN consumes the gBuffer albedo+normal).
- ⏳ **Tier 3 — G-buffer + per-ray lossy packing** (gated A/B): octahedral `direction` (slot 1) + the
  gBuffer normal; f16 `throughput`; unorm8 albedo — each behind a benchmark + visual diff. Keep `radiance`
  + `origin` f32.
- ⏳ **Medium/SSS sparse split (Step 7)** — still pending the allocator design spike.

## Problem

The wavefront persists per-ray state to GPU storage buffers between per-bounce compute kernels
(Generate → Extend → [Sort] → Shade → Compact → FinalWrite). The dominant memory cost is the **RAY
buffer**: at 2048² it is **~1.3 GB** (capacity `nextPow2(2048²·1.25)` = 8,388,608 rays × `RAY_STRIDE`=10 vec4 × 16 B).
The whole wavefront buffer set is ~2.4 GB.

Two consequences:
- **VRAM pressure** — the single 1.3 GB RAY binding is ~10× WebGPU's mandatory-minimum
  `maxStorageBufferBindingSize` (128 MiB) and ~30% of an 8 GB GPU; a real liability on
  laptop/integrated/mobile adapters.
- **Resolution-change latency** — growing the resolution reallocates these buffers and forces a full
  rebuild/recompile of all 21 kernels (~2.4 s cold). See the separate resolution-change-latency note.

The megakernel never paid this: it ran the whole path per pixel in one invocation with state in
**registers**; its only persistent per-pixel storage was the ~200 MB MRT output textures (which the
wavefront also has). The ~2 GB of ray-state buffers is **inherent to wavefront** (state must survive
between kernel dispatches) — so the lever is making that state *smaller*.

## Key insight (drives the whole design)

The SoA buffer allocates **every slot at `pow2(maxRays·1.25)`**, regardless of how few rays actually
use a field. So a field used by 1% of rays still costs 100% of the rows. Therefore:

> The dominant win is **structural** (move write-once and sparse fields *out* of the per-bounce
> buffer), not bit-packing. Bit-packing is a secondary, gated win.

The `pow2·1.25` rounding itself is a free **~2×** (8.39M allocated for a 4.19M need at 2048²) — capping
allocation at the exact render size halves the whole set with zero precision cost.

## Current layout (`rayzee/src/Processor/PackedRayBuffer.js`)

`RAY_STRIDE`=10 vec4 (160 B/ray), SoA-within-a-buffer (`field slot` of element `id` at `id + slot*_cap`):

| slot | name | contents | notes |
|---|---|---|---|
| 0 | ORIGIN_PIXEL | `vec4(origin.xyz, pixelIndex)` | origin needs f32 (0.001 self-isect offset) |
| 1 | DIR_FLAGS | `vec4(direction.xyz, bounceFlags)` | direction is a unit vector |
| 2 | THROUGHPUT_PDF | `vec4(throughput.xyz, pdf)` | |
| 3 | RADIANCE_ALPHA | `vec4(radiance.xyz, alpha)` | radiance accumulates over SPP |
| 4 | NORMAL_DEPTH | `vec4(encodedNormal.xyz, linearDepth)` | **MRT — read only by FinalWrite** |
| 5 | ALBEDO_ID | `vec4(albedo.xyz, objectID)` | **MRT — read only by FinalWrite; objectID dead** |
| 6 | MEDIUM_STACK | `vec4(packed(stackDepth\|trans<<8\|wavelength<<16), ior1, ior2, ior3)` | in-medium only |
| 7 | MEDIUM_SIGMA_A | `vec4(sigmaA.xyz, _)` | in-medium only; `.w` dead |
| 8 | PATH_META | `vec4(perRayBounces, sssSteps, sampleIndex, _)` | 3 small ints in 16 B; `.w` dead |
| 9 | SSS_SIGMA_S | `vec4(sigmaS.xyz, g)` | SSS only; `sigmaS==0` ⇒ glass |

`HIT_STRIDE`=2 vec4 (32 B): `DIST_TRI_BARY`, `NORMAL_MAT`. `SHADOW_STRIDE`=3 vec4 (48 B): origin/dist,
dir/parent, pendingRadiance. (HIT is transient; SHADOW is populated only by emissive-NEE rays.)

### Verified facts (grep-confirmed in this repo)

- `readRayNormalDepth`/`readRayAlbedoID` are read **only** by `FinalWriteKernel.js:69-70`; written only at
  Generate-init + Shade bounce-0. Their downstream sink is the W×H output StorageTextures (what
  ASVGF/MotionVector/OIDN/EdgeFilter read) — slots 4,5 are pure per-ray *staging*.
- `objectID` (slot 5.w) is **dead**: written by `ShadeKernel.js:350`, FinalWrite stores `1.0` into the
  albedo texture's `.w`; no stage reads it.
- `RAY_FLAG.INSIDE_MEDIUM` (`QueueManager.js:25`, bit 10) is **defined but never written or read**.
- `ExtendKernel.js:54` reads only `readMediumStack(...).stackDepth > 0` (the in-medium traversal flag).
- `MEDIUM_SIGMA_A.w` and `PATH_META.w` are written `0` and never read (`PackedRayBuffer.js:289,299`).
- `maxRaysPerSample = w*h` (`PathTracer.js:443`), so `pixelIndex` and `sampleIndex` are derivable from `rayID`.

## Research summary

| Source | Takeaway |
|---|---|
| Laine/Karras/Aila, *Megakernels Considered Harmful* (NVIDIA 2013) | State in DRAM is intentional; **212 B/path**; cap a **fixed live-ray pool** (~1M) sized to GPU capacity, not full-frame pixels. |
| PBRT-v4 Ch.15 *Wavefront* (Pharr et al. 2023) | Split state into **separate typed queues by lifetime** (RayWorkItem / ShadowRayWorkItem / MaterialEvalWorkItem / Medium*Queue), not one fat struct. SoA for coalescing. |
| Blender Cycles integrator state | "Keep state as small as possible": `uint16`/`uint8` counters, `PackedSpectrum`, **shadow state in a separate struct**. |
| **NVIDIA, Indiana Jones path tracer (2025)** | Cut live state **222 B → 84 B (−62%) for a 24% GPU-time win**: `throughput float3→half3`, `radiance float4→half4`, `direction float3→uint32`, `counters 32-bit→uint16` — visually identical. Almost exactly this menu. |
| Cigolle et al. *Survey of Efficient Representations for Independent Unit Vectors* (JCGT 2014); Tyler 2023; Narkowicz 2014 | Octahedral encoding: oct32 < 0.01° angular error; oct16 ~0.35° (fine for secondary, marginal for primary mirrors). |
| arXiv 2505.24653 (2025) | Ray-stream tracing + 8-bit quantized structures + octahedral to cut RT memory traffic. |
| RGB9E5 (DGriffin91); E. Lopez *Art of Packing Data* (2022); WGSL packing builtins | Shared-exponent HDR pack (unsigned), bit-pack capacities, `pack2x16unorm/float`, `pack4x8unorm`. |

Caveat: the 212 B (Laine) and ~364 B (Cycles) figures are aggregates/field-type estimates, not
published per-field totals — directionally useful (our 160 B is in-regime), not exact baselines.

## Proposed layout — `RAY_STRIDE` 10 → 6 vec4 (160 → 96 B, −40%)

Three tiers by risk.

### Tier 1 — lossless (bit-exact; no benchmark needed)
- **Drop dead lanes**: `objectID` (5.w), `MEDIUM_SIGMA_A.w`, `PATH_META.w`.
- **Collapse PATH_META** (slot 8 → gone): bit-pack `perRayBounces`(8b)|`sssSteps`(8b) into one u32 lane;
  **derive** `sampleIndex = rayID / maxRaysPerSample` and `pixelIndex = rayID % maxRaysPerSample` (= `rayID`
  at S=1). Both are read by Shade (STBN tap, `_pixelCoord`); reconstruction is exact.

### Tier 2 — structural (the GB; relocate, keep f32 first so the move is lossless)
- **G-buffer split**: move `NORMAL_DEPTH` + `ALBEDO_ID` (slots 4,5) to a **W×H per-pixel buffer** written
  by Shade bounce-0, read by FinalWrite. They don't belong in the `pow2·1.25`-inflated per-ray buffer.
  The W×H buffer is *not* capacity-inflated and *not* ×S. (−32 B/ray.)
- **Medium/SSS split**: move slots 6,7,9 to a **side buffer gated by `RAY_FLAG.INSIDE_MEDIUM`** — idle for
  ~all rays on opaque scenes. Extend reads the `INSIDE_MEDIUM` flag (newly written by Shade push/pop)
  instead of slot-6 `stackDepth`.

### Tier 3 — lossy (gated behind empirical A/B; ship only if visually identical + fps holds)
- `direction` (slot 1.xyz) → **octahedral oct32** via `pack2x16unorm` (3 floats → 1); renormalize on decode.
- `throughput`+`pdf` (slot 2) → **f16** (`pack2x16float`). Feeds RR/firefly thresholds — validate energy/variance.
- **Keep `radiance` (slot 3) and `origin` (slot 0) f32** — radiance compounds quantization over many SPP
  (banding/energy drift; RGB9E5 is also unsigned); origin needs sub-mm precision for the 0.001 offset.

### Final always-resident RAY (6 vec4)
`ORIGIN(f32x3)+spare | DIR(oct32)+flags | THROUGHPUT(f16x3)+pdf | RADIANCE(f32x3)+alpha-bit | PATH_META(u32)+medium-pool-index | (pad)`
— G-buffer (4,5) → W×H side buffer; medium/SSS (6,7,9) → sparse side buffer.

## Memory math (@2048², the dominant RAY binding)

| | RAY buffer | whole wavefront set |
|---|---|---|
| Now | 1.342 GB | ~2.4 GB |
| 6 vec4 + side buffers | **0.805 GB** | **~0.92 GB** (−31% net, −40% on RAY) |
| + f16 throughput (Tier 3) | 0.738 GB | ~0.85 GB |
| + drop pow2 over-alloc (cap at exact res) | ~0.40 GB | — |

Side buffers added: W×H G-buffer (1 vec4/pixel) = 4.19M × 16 B = **0.067 GB** (not inflated, not ×S);
sparse medium pool ≈ 0 on opaque scenes, ≤~0.05 GB if conservatively capped. Net still drops because
they are W×H or <5%-of-rays sized, not `pow2(maxRays·1.25)`×every-slot. (S>1 multiplies the RAY buffer by
S; the W×H G-buffer stays W×H.)

## Implementation plan (ordered, smallest-safe-first; each independently shippable + verifiable)

1. **Drop dead lanes** (objectID, pads). Bit-exact A/B. (Shares vec4s — doesn't shrink stride yet, unblocks #2.)
2. **Collapse PATH_META** + derive `sampleIndex`. Update `writePathMeta`/`readPathBounces`/`readSssSteps`/
   `readSampleIndex` in `PackedRayBuffer.js`. A/B at S=1 and S>1 (STBN taps must stay distinct).
3. **Derive `pixelIndex`** from `rayID` (drop slot 0.w). A/B at S=1 and S>1.
4. **Relocate G-buffer** (slots 4,5 → W×H buffer, **f32, pure move**, lossless). Handle Generate's
   carry-forward ND write (`GenerateKernel.js:105`, rayID) → must land in the pixel / sub-sample-0 slot.
   `RAY_STRIDE` 10→8. Verify ASVGF/MotionVector/OIDN textures unchanged + Shade ≤ `maxStorageBuffersPerShaderStage`.
5. **Octahedral direction** (gated). Renormalize on decode. **Benchmark** (Extend decodes every ray every
   bounce) + visual diff on mirrors. Ship only if fps neutral-or-better and identical.
6. **f16 throughput/pdf** (gated, build flag). Validate energy/variance vs f32 reference **with firefly clamp
   disabled** (per project memory). Keep radiance + origin f32.
7. **Medium/SSS split.** Sub-step (a) safer: collapse slots 6,7,9 widths in place (IOR/sigmaA/sigmaS f16,
   g snorm8, bit-packed control word) — 4 vec4 → ~2, still per-ray-indexed. Sub-step (b) riskier: write
   `RAY_FLAG.INSIDE_MEDIUM` in Shade push/pop, switch Extend to read the flag, move medium data to a sparse
   pool (atomic-bump allocator on medium-enter). Validate on glass + dispersion + nested-IOR(3) + SSS.
8. **HIT/SHADOW packing** (secondary): HIT geoNormal oct32 + bary unorm16; SHADOW dir oct32 + drop dead
   `RADIANCE.w`. Smaller absolute win.

## Correctness risks & caveats

- **Benchmark every lossy/structural step on the actual WebGPU/Apple GPU.** Packing trades VRAM traffic
  for unpack ALU on the already-bandwidth-bound Extend/Shade path; theoretical wins can regress here
  (standing project rule: validate GPU perf empirically; this branch is GPU-barrier/VRAM-bound).
- **Binding budget**: Shade is the tightest stage. Adding the G-buffer write to Shade costs a binding —
  enumerate Shade's real `storage()` bindings vs the device `maxStorageBuffersPerShaderStage` before #4/#7.
  (The PackedRayBuffer header's "8 bindings at the limit" note looks stale — confirm.)
- **G-buffer carry-forward**: the W×H buffer is per-PIXEL; the adaptive carry-forward ND write must index
  `pixelIndex` / sub-sample-0, or carried-forward normals/depth corrupt under S>1.
- **Medium side-buffer**: medium state is correctness-critical and must persist across SSS free-bounce
  continuations and transmissive push/pop. The sparse allocator's determinism across the random walk is
  unproven — do sub-step (a) (in-place width collapse) first; attempt the allocator only after a design spike.
- **`radiance` stays f32** (accumulation), **`origin` stays f32** (self-intersection offset). Non-negotiable.
- **Octahedral**: use oct32 for direction (oct16's 0.35° shows on primary mirror reflections); always renormalize.

## Open questions (resolve before the gated steps)

- Actual fraction of in-medium rays on representative scenes (sets the medium-split payoff: ~0 on opaque,
  near-zero net on heavy glass).
- Does `app/src` or the OIDN GPU path read RAY slots 4/5/5.w directly (vs the published textures)? The
  research grep covered `rayzee/src` only.
- Is f16 throughput safe across the full production SPP range (NVIDIA validated half on single denoised
  frames, not thousands-of-SPP progressive accumulation)?
- Could the medium side-buffer stay per-ray-indexed (lossless, no allocator) — saving access bandwidth but
  not storage — as a lower-risk first cut?

## Citations

- Megakernels Considered Harmful (Laine/Karras/Aila 2013) — https://research.nvidia.com/sites/default/files/pubs/2013-07_Megakernels-Considered-Harmful/laine2013hpg_paper.pdf
- PBRT-v4 Ch.15 Wavefront Rendering on GPUs — https://www.pbr-book.org/4ed/Wavefront_Rendering_on_GPUs/Path_Tracer_Implementation
- Blender Cycles integrator state_template.h — https://github.com/blender/cycles/blob/main/src/kernel/integrator/state_template.h
- NVIDIA, Path Tracing Optimization in Indiana Jones (SER + live-state reductions, 2025) — https://developer.nvidia.com/blog/path-tracing-optimization-in-indiana-jones-shader-execution-reordering-and-live-state-reductions/
- Minimizing RT Memory Traffic through Quantized Structures and Ray Stream Tracing (arXiv 2025) — https://arxiv.org/pdf/2505.24653
- Cigolle et al., A Survey of Efficient Representations for Independent Unit Vectors (JCGT 2014) — https://jcgt.org/published/0003/02/01/paper-lowres.pdf
- Tyler, Analyzing Octahedral Encoded Normals (2023) — https://liamtyler.github.io/posts/octahedral_analysis/
- Narkowicz, Octahedron Normal Vector Encoding (2014) — https://knarkowicz.wordpress.com/2014/04/16/octahedron-normal-vector-encoding/
- RGB9E5 shared-exponent formats (DGriffin91) — https://github.com/DGriffin91/shared_exponent_formats
- E. Lopez, The Art of Packing Data (2022) — https://www.elopezr.com/the-art-of-packing-data/
- WGSL packing builtins — https://webgpu.rocks/wgsl/functions/packing/

Related: [[project_wavefront_progress]], `docs/specs/wavefront-path-tracing.md`, and the firefly-clamp /
GPU-perf-validation project notes.
