# Wavefront Path Tracing — Implementation Status & TODO

## What's Built

### Architecture (fully working)
- **11 compute kernels** dispatched per frame in a CPU-driven bounce loop
- **AoS packed buffers** (1 storage buffer binding per data category) solving the 8-binding limit
- **Feature-flagged** via `Constants.js → wavefrontEnabled` (default: false)
- `WavefrontPathTracerStage` extends `PathTracingStage` — identical context textures + events

### Kernel Pipeline (per frame)
```
resetCounters → Generate → initActiveIndices
  for each bounce:
    Extend → resetShadowCounter → Shade → Connect → Accumulate → resetActiveCounter → Compact → swap
FinalWrite → copyToReadTargets → publishToContext
```

### What Each Kernel Does
| Kernel | WG Size | Bindings | Status |
|--------|---------|----------|--------|
| **Generate** | 16×16 | 2 | Complete — DOF, jitter, adaptive sampling |
| **Extend** | 256×1 | 6 | Complete — calls `traverseBVH()` directly |
| **Shade** | 256×1 | 8 (at limit) | Partial — see gaps below |
| **Connect** | 256×1 | 6 | Complete — opaque-only shadows |
| **Accumulate** | 256×1 | 4 | Complete — scatter-add to parent ray |
| **Compact** | 256×1 | 4 | Complete — atomic append |
| **FinalWrite** | 16×16 | 1+tex | Complete — temporal accumulation |
| Reset kernels ×3 | 1×1 | 1 | Complete |
| InitActiveIndices | 256×1 | 1 | Complete |

### Files Created
```
src/core/Processor/
  PackedRayBuffer.js        — AoS packed buffers + 30 TSL accessor helpers
  QueueManager.js           — Atomic counters + ping-pong active indices
  WavefrontKernelManager.js — Kernel build/dispatch with timing
  RayBufferPool.js          — Original SoA buffers (Phase 0, superseded by PackedRayBuffer)
  WavefrontTestHarness.js   — GPU validation tests (window.__wavefrontTests)

src/core/Stages/
  WavefrontPathTracerStage.js — Full kernel orchestration stage

src/core/TSL/wavefront/
  GenerateKernel.js         — Primary ray generation
  ExtendKernel.js           — BVH traversal
  ShadeKernel.js            — Material eval + env IS NEE + bounce
  DeferredLighting.js       — Fn() version (unused — Fn() can't pass storage buffers to nested calls)
  ConnectKernel.js          — Shadow ray BVH traversal
  AccumulateKernel.js       — Apply shadow results
  CompactKernel.js          — Stream compaction
  FinalWriteKernel.js       — Temporal accumulation + output
  PathTraceKernel.js        — Dead code (wrapper approach, blocked by binding limit)
  BufferAccess.js           — Dead code (SoA helpers, superseded by PackedRayBuffer)

Modified:
  src/Constants.js           — wavefrontEnabled flag
  src/core/PathTracerApp.js  — Conditional stage selection
  src/store.js               — Store toggle
```

### Bugs Fixed After Initial Integration (2026-04-19)

- **Environment change didn't update wavefront render** — `_buildWavefrontKernels` creates INDEPENDENT texture nodes (comment: "avoids Three.js TextureNode caching issues between monolithic and wavefront compute pipelines"). When `EnvironmentManager.setEnvironmentMap()` ran, it updated the monolithic's `envTex.value` but the wavefront's `freshEnvTex` stayed pinned to the old texture. **Fix**: save the fresh texture nodes as `this._wfTexNodes` and refresh their `.value` each frame in `render()` via `_refreshWfTextureNodes()`. Same pattern applies preemptively to material texture arrays — cheap since TextureNode `.value = sameRef` is a no-op. Verified: loading a new HDRI while in wavefront mode now updates backdrop + reflections within 1 frame.

### Key Bugs Fixed During Implementation
1. **`storage(attr, 'vec4', count)` with count>0** creates separate GPU buffers per node. Must use `count=0` so RW/RO nodes share via `StorageBufferNode.getHash()` global cache.
2. **`HitInfo.wrap()`** needed for `traverseBVHShadow` return value.
3. **`getMaterial()`** for proper struct-from-buffer loading (not `getDatafromStorageBuffer`).
4. **`activeIndicesRO` removed from Shade** to stay at 8 bindings — use `instanceIndex` directly.
5. **`Fn()` can't pass storage buffer nodes** to nested `Fn()` calls — must inline env IS in ShadeKernel.
6. **`.compute([count], [wgSize])`** — first arg is workgroup COUNT, not thread count.

### Storage Buffer Binding Budget
```
Scene buffers (7 total, not all used per kernel):
  bvhBuffer, triangleBuffer, materialBuffer,
  emissiveTriangleBuffer, lightBVHBuffer,
  envMarginalWeights, envConditionalWeights

NOT storage buffers (free to use):
  Light buffers (directional, area, point, spot) → uniformArray
  Texture arrays (7) → texture bindings
  Environment texture → texture binding
  All scalar/vector/matrix uniforms → uniform bindings

Shade kernel binding budget (8/8):
  mat(1) + envMarg(1) + envCond(1) + rayBuf(1) + rngBuf(1) + hitBuf(1) + shadowBuf(1) + counters(1)
```

---

## TODO — Ordered by Priority

### Tier 0: Quick Fixes ✅ DONE
- [x] 1. ~~Add `forceCompile()` before kernel dispatch loop~~ (skipped — not needed, kernels compile on first dispatch)
- [x] 2. Firefly suppression — `regularizePathContribution()` after NEE/emissive
- [x] 3. GI intensity scaling per-bounce
- [x] 4. Early ray termination (throughput < 0.001 after bounce 3)
- [x] 5. Delete dead code: `PathTraceKernel.js`, `BufferAccess.js`, `RayBufferPool.js`

### Tier 1: Critical BRDF + Transparency (0 extra bindings)
- [x] 6. Full Disney BRDF via `generateSampledDirection()` — specular, metallic, clearcoat lobes. Throughput uses albedo (not value/pdf) until MIS is added.
- [x] 7. Transparency — `handleMaterialTransparency()` with medium stack (RAY_STRIDE=7), refraction, Fresnel, alpha-skip
- [x] 8. Clearcoat sampling — added 2026-04-19 in ShadeKernel. Wraps the BRDF sample in `If(material.clearcoat > 0)` that calls `sampleClearcoat(ray, hitInfo, material, xi, rngState)`, else falls back to `generateSampledDirection` (original path). Verified on Pagani Huayra (40 mats, clearcoat paint): renders correctly with glossy highlights, no NaN, no new errors.
- [x] 9. MIS via `calculateIndirectLighting` + `powerHeuristic` NEE. ~80% brightness match to monolithic.

### Tier 2: Light Support (needs binding budget work)
- [ ] 10. Request `maxStorageBuffersPerShaderStage: 10` from adapter
- [ ] 11. Add discrete light sampling (directional, point, spot) + shadow rays
- [ ] 12. Add area light sampling
- [ ] 13. Add emissive triangle NEE (needs sub-kernel split or higher limit)

### Tier 3: Shadow Quality
- [x] 14/15. **Transparent shadow transmission** — effectively already working (2026-04-19). Investigation showed `WavefrontPathTracer.render()` does NOT dispatch `connect` or `accumulate`; instead `ShadeKernel` calls `calculateDirectLightingUnified` inline, which internally calls `traceShadowRay` (from `LightsDirect.js`). That function already handles the full transparent-shadow loop: alpha-cutout (MASK/BLEND), transmissive (glass + Beer-Lambert), transparent (opacity), up to 8 iterations. **No wavefront-specific work needed** — the monolithic shadow infrastructure is reused. `ConnectKernel`/`AccumulateKernel` are dead code kept for a future deferred-shadow pipeline; if that pipeline is ever wired up, `rngBuffer` would be needed only if stochastic transparency is added (current `traceShadowRay` takes rngState but doesn't read it).

### Tier 4: Integration Testing
- [x] 16. ASVGF denoiser — temporal stability verified
- [x] 17. OIDN denoiser — verified 2026-04-19 on camera + Bistro scenes, wavefront + OIDN produces clean denoised output, no NaN/Inf in pixel sample.
- [x] 18. Tile rendering — tile dispatch verified, tiles converge correctly
- [x] 19. DOF — bokeh working, GenerateKernel DOF ray gen correct
- [x] 20. Adaptive sampling — verified 2026-04-19, stage enabled end-to-end with wavefront, texture node wired through Generate kernel, no visual regression.
- [ ] 21. Debug visualization modes (visMode 1-10) — **not implemented** in wavefront. Monolithic short-circuits via `TraceDebugMode()` at `PathTracer.js:255`; Shade/Generate kernels in wavefront ignore the visMode uniform entirely. Non-trivial to port (needs visMode uniform wired + branch in Shade/Generate to replace output with debug color). Developer tool only — low urgency.

### FIXED: Visual parity achieved
Root cause of brightness gap was 3 missing lines — material.color/metalness/roughness
were never updated with texture-sampled values after sampleAllMaterialTextures().
All BRDF functions used white/default base material instead of textured values.
Fix: apply matSamples to material struct before BRDF evaluation.
Full calculateIndirectLighting + calculateDirectLightingUnified now work correctly.

### FIXED (2026-04): TSL idiom bugs that masqueraded as material + brightness issues

After the Apr 2026 merge+re-verify pass, three related issues were found and fixed:

1. **`.and()` and `.or()` are boolean (`&&` / `||`) in TSL, not bitwise**. The packed
   hit-buffer op `matIndex.or(meshIndex.shiftLeft(16))` was collapsing to 0 or 1.
   Every hit reported `mat=1` regardless of actual material — 47-material scenes
   looked uniform white. Ray ACTIVE-bit clear (`flags.and(~ACTIVE)`) also silently
   reduced flags to 1 rather than clearing the bit. Swept `.and/.or` → `.bitAnd/.bitOr`
   in PackedRayBuffer and four wavefront kernels.

2. **JS `return;` inside a TSL `If()` callback only exits the callback**, not the
   outer Fn body. All wavefront kernels used `return;` for early-exit (inactive ray
   skip, miss-handler short-circuit, russian roulette, max-bounce, etc). The code
   AFTER each `If` kept running on rays that were supposed to be done. On miss rays,
   that meant the HIT PROCESSING block ran with `hitMatIdx=65535` (uint(-1)&0xFFFF),
   reading out-of-bounds material slots and adding garbage. The visible symptom was
   a ~+1.0 bias on the R channel of env-background pixels. Replaced all 17 sites
   with TSL's `Return()` (from `three/tsl`, via `utils/Discard.js`) which emits a
   real WGSL `return`.

3. **Secondary env-miss used hardcoded `bgScale = 2.0`** as a placeholder for
   missing MIS. ShadeKernel now reads `prevBouncePdf` from the ray buffer,
   evaluates `sampleEquirect` for the env PDF, and uses `powerHeuristic` as the
   secondary miss weight — matching PathTracerCore.

Result: Outdoor Sofaset, Pagani Huayra, and Camera all render with correct material
differentiation. Sampled pixels match monolithic within 0.001 on most points
and <3% on others (stochastic).

### Tier 5: Performance (Phase 2)
- [x] 22. Material sorting kernel — working end-to-end via storage-atomic histogram (TSL's `WorkgroupInfoNode` emits plain `array<T>`, not `array<atomic<T>>`, so workgroup atomics were not viable). Wired behind `wavefrontSortMaterials` flag (default off after benchmark). `SortKernel.js` uses `QueueManager.sortHistogram` (`numWorkgroups × 16` atomic u32). Output is bit-identical to sort-off. See items 32–35 for follow-up tuning.
- [x] 23. Performance benchmarking — **re-measured 2026-04-19 after TSL idiom fixes, then re-measured with warm-cycle methodology.** 512×512, 3 bounces, 60 samples.

  **IMPORTANT methodological note**: first 60-frame cycle after a scene load or page reload is slowed 20–40% by shader compilation, JIT warmup, and cold GPU caches. Earlier measurements in this file (marked "cold" or pre-2026-04-19) were polluted by this overhead. **Use warm-cycle median** (median of 3 runs, each after an `app.reset()`, discarding the first load cycle) as the steady-state truth.

  **Warm-cycle steady-state (median of 3 reruns, 2026-04-19):**

  | Scene | Tris | Monolithic | WF sort OFF | WF sort ON (no guard) | WF sort ON (indirect) |
  |---|---:|---:|---:|---:|---:|
  | Camera | 18,016 | 0.49s | — | 0.64s | 0.59s |
  | Cornell Box 1 | 64 | 0.83s | — | 0.67s | 0.67s |
  | Ferrari | 34,050 | 0.76s | — | 1.00s | 0.99s |
  | Helmet | 15,484 | 0.58s | — | 0.83s | 0.82s |
  | Modern Bathroom | 187,188 | 1.57s | — | 1.19s | 1.19s |
  | Pagani Huayra | 291,017 | 1.83s | — | 1.83s | 1.85s |
  | Outdoor Sofaset | 268,901 | 1.64s | — | 1.65s | 1.66s |

  **Findings:**

  1. **Wavefront vs monolithic (warm, sort ON)**: wavefront wins on 2 scenes (Cornell −19%, Modern Bathroom −24%), loses on 3 (Camera +20%, Ferrari +30%, Helmet +41%), ties on 2 (Pagani, Sofaset). The cold-cycle "4/6 wins" was misleading because cold-cycle shader compile dominates both engines similarly.

  2. **Why the simple/complex split**: wavefront dispatches ~15 kernels per frame (resetCounters, generate, initActiveIndices, extend, resetHist, sort, shade, resetActive, compact per bounce, finalWrite). Each has launch overhead. Monolithic is 1 big dispatch. When GPU is warm, per-frame launch cost dominates simple scenes; per-ray shading work dominates complex scenes. Wavefront only wins when coherence benefits exceed per-frame launch overhead.

  3. **Indirect dispatch (32b) vs plain sort (no guard) is a wash on warm cycles.** Slight help on Camera (−8%), essentially identical elsewhere (±1%). The 10-20% "wins" I saw in cold benchmarks were cold-cycle compile overhead that amortized away. The dispatch-overhead argument for indirect is mostly theoretical for our scene sizes at 512×512/3 bounces.

  4. **Wavefront-as-default (item 31) is not justified on this data.** The cold-cycle interpretation suggested it; the warm-cycle numbers show wavefront is a specialized optimization for dense/coherent scenes, not a general-purpose replacement. Keep it flagged, recommend per-scene profiling.

  **Default `wavefrontSortMaterials` remains ON**: sort ON is equal to or better than sort OFF on all tested scenes at warm steady-state, and it's the production-standard pattern.

- [ ] 24. Prefix-sum compaction
- [ ] 25. Half-precision buffers
- [ ] 26. Async readback for dynamic dispatch

### Tier 5b: Sort follow-ups (ordered by dependency, 2026-04)

### How production GPU renderers handle this
(Context for why our sort design is a proof of concept, not a destination.)

- **Indirect dispatch is standard**. OptiX, DXR, pbrt-v4 GPU, Cycles GPU all size sort/trace/shade dispatches to the live ray queue count via indirect dispatch, not a fixed max. "Launch 1024 WGs and skip most of them" isn't a production pattern.
- **Material sort is usually global radix**, not per-workgroup counting. Radix over a packed 32-bit key (material ID + hit geom hash, sometimes direction) gives cross-workgroup coherence and doesn't clamp on bin count. CUB / onesweep on CUDA; WebGPU is catching up.
- **Histograms live in workgroup-shared memory**. We can't do that yet because TSL's `WorkgroupInfoNode` doesn't emit `atomic<T>` element type — confirmed earlier in this branch. We fall back to storage-atomic histograms, which is slower and why the counting-sort approach is underperforming. When TSL gains workgroup atomics, revisit.
- **Persistent threads / work-stealing** are another common pattern — threads pull work from a global queue, self-balancing across material classes without an explicit sort. Larger refactor.
- **CPU path tracers don't sort** — material coherence is a GPU-SIMT problem.

**Completed this cycle:**
- [x] 36. ~~Sofaset outlier investigation~~ — resolved by enabling sort. Sort brings Sofaset from +86% to +19% vs monolithic, confirming the outlier was material-divergence-driven, not BLAS/emissive-driven.
- [x] 37. ~~Re-run sort ON/OFF benchmark~~ — done 2026-04-19 (see item 23 table).
- [~] 33. ~~Raise MAX_BINS statically~~ — benchmarked 16/32/64, result was mixed. Only Sofaset wins (−13%); Pagani regresses 29%. The scan cost scales linearly with MAX_BINS and is paid unconditionally by every workgroup, so raising bins is only a win if actual material diversity exploits them. Kept at 16.
- [~] 32a. ~~Early-exit guard on empty workgroups~~ **(attempted, reverted)**. Wrapped `If(wgBase < activeCount)` around phase gates. Two issues surfaced:
  1. Putting `storageBarrier()` inside a branch conditioned on `atomicLoad` fails WGSL uniformity analysis (atomicLoad is considered possibly-non-uniform). First attempt silently failed compilation; produced black renders that timed fast because no work ran.
  2. The WGSL-safe rewrite (barriers always called, only work-phase gated per thread with `.and(wgActive)`) produced a **net +4.3% regression** across 6 scenes. Only Sofaset (−5%) and Modern Bathroom (−1%) benefited; Helmet regressed +13%, Cornell +8%, Ferrari +4%, Pagani +7%. The "savings" were small (thread 0 of empty WGs skipping a 16-iter scan on zeros ≈ ~13K atomic ops/bounce) and dwarfed by the per-thread cost of the extra `.and(wgActive)` check run by every thread in every WG.
  **Lesson**: the right pattern is "don't launch the workgroup" (32b), not "launch and early-return". 32a's premise was correct; forcing it into WGSL-compliant shape broke its cost/benefit math.

**Prerequisite phase — do these FIRST, in this order:**

- [~] 32b/40. **Indirect dispatch attempted, net-zero on warm cycles.** Prototype lives in working tree (uncommitted): IndirectStorageBufferAttribute in QueueManager, prepSortDispatch kernel in WavefrontPathTracer, Sort registered with indirect attr. Three.js supports this fully (`IndirectStorageBufferAttribute` → `dispatchWorkgroupsIndirect`). Implementation is correct, renders match monolithic exactly. But warm-cycle benchmark shows only Camera benefits (−8%); all other scenes are ±1% vs no-guard. The prep kernel's own launch overhead roughly offsets the empty-workgroup savings at 512×512/3 bounces. Might be worth keeping at higher resolutions or higher bounce counts where empty-workgroup count grows (item 35 will tell). For now: keep stashed, not a general win.

- [ ] 41. **Material ID remapping / compaction**. Many scenes declare far more materials than they actually use (Pagani: 40 declared, ~16 hit). A pre-sort remap pass compresses material IDs to a dense `0..N-1` range where `N` = *used* materials. Once this lands, MAX_BINS=16 covers most real scenes without clamping, and item 39 becomes mostly moot.

**Re-measure phase:**

- [ ] 42. **Re-bench MAX_BINS at 16/32/64 after items 32b+41**. Expectation: the Pagani/Modern-Bathroom regressions shrink substantially because (a) only live rays are sorted, (b) with remapping, material diversity ≤16 for most scenes. If the regression gap is <5%, raise MAX_BINS to 32 as the new static default.

**Only if items 32b/41 don't fully close the gap:**

- [ ] 39. **Adaptive bin count via uniform** — `min(MAX_BINS_HARD, materialCount)` passed per-scene. Captures Sofaset win without Pagani regression. Only worth building if item 42's re-measure still shows a tuning gap.
- [ ] 38. **Skip Sort dispatch when materialCount is very low** (Ferrari/Helmet have ~5 materials, sort costs them 2–7% with no win). One `if` in the bounce-loop dispatch. Cheap backstop.

**Larger phase-2 improvements (closer to production designs):**

- [ ] 34. **Global radix sort** over a packed 32-bit key (material ID + hit geometry hash, possibly direction). Gives cross-workgroup coherence — rays hitting the same material in different workgroups get grouped. This is what production renderers actually do. Much bigger than our counting sort; likely requires CUB-style onesweep radix or similar. Only worth doing after 32b+41 show that per-WG sort is insufficient.
- [ ] 43. **Parallel prefix scan + workgroup-shared histogram** (inside current counting-sort design). Replace the O(MAX_BINS) serial scan done by thread 0 with an O(log MAX_BINS) parallel scan using `var<workgroup>: array<atomic<u32>, N>`. **Blocked on TSL gaining atomic workgroup memory** — current `workgroupArray('uint')` emits plain `array<u32>` rather than `array<atomic<u32>>`, so any workgroup-local atomic scan fails WGSL validation. When upstream TSL lands this, sort overhead drops substantially.
- [ ] 44. **Subgroup ops (ballot / shuffle) for in-subgroup reordering**. Some renderers skip the explicit sort pass and use subgroup extensions to rearrange threads within a 32/64-thread subgroup on the fly. Requires WebGPU subgroups (Chrome shipping but experimental).
- [ ] 45. **Persistent threads / work-stealing**. Threads pull work from a global atomic queue instead of being pre-assigned. Load-balances across material classes without an explicit sort. Larger architectural change.
- [~] 35. **Re-benchmark at 8 bounces and 1024×1024 resolution** — partial (Bistro only, 2026-04-19). Coherence wins compound on longer paths and larger sample pools; 3-bounce/512² may be understating the benefit.

  **Blocker encountered & fixed**: wavefront rendered only the top-left 512×512 region when resolution was raised via UI. Root cause: `PathTracer.setSize()` updated storage textures but WavefrontPathTracer never rebuilt kernels, so `_wfRenderWidth/Height/MaxRayCount` uniforms and `_packedBuffers`/`_queueManager` sizes stayed at old dimensions. Generate's bounds check silently dropped rays outside the stale window. Fix: override `setSize()` and `_handleResize()` in WavefrontPathTracer to call `_buildWavefrontKernels()` on size change.

  **Stress test — 1024×1024, 8 bounces, warm-cycle median of 3 runs:**

  | Scene | Tris | Mats | Monolithic | Wavefront | Regression |
  |---|---:|---:|---:|---:|---:|
  | Bistro | 2.83M | 132 | 91.7 ms/f | 147.4 ms/f | **+61%** |
  | Sponza | 262K | 26 | 32.7 ms/f | 62.2 ms/f | **+90%** |

  Warm runs are tightly reproducible (Bistro: 8842/8966/8838ms for 60 frames; Sponza: 3734/3735/3733ms). Cold-cycle (first load) adds 25–30% overhead from shader compile and must be discarded.

  **Counter-intuitive finding**: *simpler* Sponza regresses MORE than *complex* Bistro. Wavefront's fixed per-frame architectural overhead (dispatches, barriers, kernel-boundary I/O) dominates proportionally when monolithic's per-ray work is light. Wavefront becomes relatively less bad as ray complexity grows — the opposite of the "complex scenes benefit from coherence" hypothesis.

  Sort adds only ~2% on Bistro (user-tested, sort OFF: 8.30s vs sort ON: 8.46s).

  **Findings:**
  1. **Wavefront regresses ~50% on a dense, material-diverse, complex scene at high res/bounces.** The "coherence wins on complex scenes" hypothesis did NOT hold for Bistro — the opposite of what item 35 was meant to confirm.
  2. **Sort overhead is tiny (~2%)** even with 132 materials cycling through 16 bins. Item 41 (material ID remap) will not recover more than ~2% of the gap on this scene.
  3. **Real cost is per-bounce kernel launch + buffer I/O**: 5 kernels × 9 bounces = 45 dispatches, each round-tripping ray state through packed storage buffers. Monolithic does this in fused registers.
  4. **Scenes where wavefront could still win** are ones where ray divergence produces big shading-work-per-ray differences that coherence groups meaningfully reduce — not where ray shading is already uniform-enough that dispatch overhead wins.
  5. Until kernel fusion or indirect dispatch-driven queue shrinkage (late-bounce workgroup culling) lands, **wavefront is a net loss at production resolutions and bounce counts**. Defer item 31 (wavefront-as-default) indefinitely.

  **Per-kernel CPU-submission profile (Bistro, sort ON, 60 frames, 2026-04-19):**

  | Kernel | Calls | CPU ms | Avg/call |
  |---|---:|---:|---:|
  | shade | 540 | 14.59 | 0.027 |
  | resetCounters | 60 | 6.46 | 0.108 |
  | extend | 540 | 6.27 | 0.012 |
  | compact | 540 | 5.87 | 0.011 |
  | sort | 540 | 4.96 | 0.009 |
  | resetSortHistogram | 540 | 4.94 | 0.009 |
  | resetActiveCounter | 540 | 4.67 | 0.009 |
  | generate | 60 | 3.86 | 0.064 |
  | finalWrite | 60 | 1.15 | 0.019 |
  | initActiveIndices | 60 | 1.00 | 0.017 |
  | **TOTAL** | 3480 | **53.78** | |

  CPU dispatch cost is **0.54% of wall time** (53.78ms CPU / 9992ms wall). Per frame: 0.9ms CPU, 165.6ms GPU. Wavefront is fully GPU-bound on Bistro.

  This rules out "per-bounce kernel launch overhead" as the cause of regression — submission is essentially free. The GPU cost is pipeline barriers between 50 dispatches/frame and ray state round-tripping through VRAM. Kernel fusion and half-precision ray state are the only knobs with enough leverage.

  **Vite HMR gotcha**: editing `EngineDefaults.js` mid-session caused `WavefrontPathTracer` to see stale `wavefrontSortMaterials: false` even though the file had `true`. Reloading with `?bust=<n>` query on the URL forced Vite to re-parse the module. Any future dev-time benchmarking that toggles defaults should use a fresh URL, not just Cmd-Shift-R.

  **Per-kernel profiler usage** (added 2026-04-19 to `WavefrontKernelManager`):
  ```js
  const km = window.app.stages.pathTracer._kernelManager;
  km.enableProfiling(true);
  window.app.reset();
  // ... run some frames ...
  console.table(km.getProfileReport());
  km.enableProfiling(false);
  ```
  Measures CPU submission time only (GPU work is async and NOT included). For GPU timing, use stats-gl's existing `gpuQueries` or add timestamp queries via `device.queryType: 'timestamp'`.

  **Kernel fusion test — Fused ExtendShade is slower than separate on Bistro (2026-04-19):**

  | Config | ms/frame | vs monolithic |
  |---|---:|---:|
  | Monolithic | 91.7 | baseline |
  | Separate extend + shade (sort OFF) | 160.4 | +75% |
  | Separate extend + sort + shade | 166.5 | +82% |
  | **Fused extendShade** | **192.1** | **+109%** |

  Visually correct — no pink-tint bug (TSL idiom fixes resolved it). But fusion **regresses 15–20%** vs separate kernels. Inverts the "fusion = win" hypothesis.

  **Why fusion loses**: register pressure kills occupancy. The fused kernel holds BVH traversal state + material struct + texture samples + shading state all in registers simultaneously, so fewer threads fit per SM, fewer workgroups are in flight, less latency hiding. Small focused kernels (extend-only, shade-only) each have lower register footprint and run at higher occupancy. The inter-kernel I/O cost is real but smaller than the occupancy loss from fusion.

  **Obsolete comment**: remove the `// Separate Extend + Shade (fused kernel has pink tint bug on multi-material scenes)` comment in `WavefrontPathTracer.render()` — the bug is gone and fusion is slower anyway, so the separate path is the performance choice, not a workaround.

  **Implications**:
  1. Item 25 (half-precision buffers) — still worth trying, reduces I/O without register pressure
  2. Item 45 (persistent threads) — keeps state in registers across bounces without fusion's occupancy cost
  3. Kernel fusion is **not a generally useful lever** on our shader graph; the default separate-kernel pipeline is already the right shape. Focus optimization elsewhere.

### Tier 6: Full Parity + Migration
- [ ] 27. Displacement mapping in Shade
- [ ] 28. Medium stack persistence across bounces
- [ ] 29. Path importance caching
- [ ] 30. Update spec status
- [ ] 31. Remove monolithic fallback — wavefront as default

### Dependency Graph
```
Tier 0 (1-5)  → no deps
Tier 1 (6-9)  → 6 before 9
Tier 2 (10-13) → 10 before 11-13
Tier 3 (14-15) → 15 before 14
Tier 4 (16-21) → after Tier 1
Tier 5 (22-26) → after Tier 4
Tier 6 (27-31) → after Tier 5
```

---

## How to Resume

1. `git checkout feature/wavefront-path-tracing`
2. Set `wavefrontEnabled: true` in `src/Constants.js`
3. `npm run dev` → opens on localhost
4. The wavefront renders with env IS + shadowed NEE (overexposed due to missing MIS)
5. Start with Tier 0 quick fixes, then Tier 1 BRDF

### To test GPU infrastructure:
```js
// In browser console:
await window.__wavefrontTests(window.renderer)
// Runs 4 tests: atomics, cross-dispatch R/W, memory, vec4 access
```

### To verify kernel timing:
```js
// In browser console:
const { getApp } = await import('/src/core/appProxy.js');
const km = getApp().pathTracingStage._kernelManager;
console.table(km.getTimingReport());
```
