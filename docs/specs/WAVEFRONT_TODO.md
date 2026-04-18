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
- [ ] 8. Add clearcoat sampling — `sampleClearcoat()` branch
- [x] 9. MIS via `calculateIndirectLighting` + `powerHeuristic` NEE. ~80% brightness match to monolithic.

### Tier 2: Light Support (needs binding budget work)
- [ ] 10. Request `maxStorageBuffersPerShaderStage: 10` from adapter
- [ ] 11. Add discrete light sampling (directional, point, spot) + shadow rays
- [ ] 12. Add area light sampling
- [ ] 13. Add emissive triangle NEE (needs sub-kernel split or higher limit)

### Tier 3: Shadow Quality
- [ ] 14. Transparent shadow transmission in ConnectKernel
- [ ] 15. Add `rngBuffer` to ConnectKernel for stochastic transparency

### Tier 4: Integration Testing
- [x] 16. ASVGF denoiser — temporal stability verified
- [ ] 17. OIDN denoiser — verify no NaN (not tested yet)
- [x] 18. Tile rendering — tile dispatch verified, tiles converge correctly
- [x] 19. DOF — bokeh working, GenerateKernel DOF ray gen correct
- [ ] 20. Adaptive sampling — not tested yet
- [ ] 21. Debug visualization modes (visMode 1-7) — not tested yet

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
- [x] 23. Performance benchmarking — 512×512, 3 bounces, 60 samples, across 5 scenes (Cornell/Ferrari/Helmet/Modern Bathroom/Pagani Huayra, 64–291K tris):

  | Scene | Tris | sort OFF | sort ON | Δ |
  |---|---:|---:|---:|---:|
  | Cornell Box 1 | 64 | 0.96s | 1.20s | +25% |
  | Ferrari | 34,050 | 1.03s | 1.20s | +17% |
  | Helmet | 15,484 | 1.09s | 1.24s | +14% |
  | Modern Bathroom | 187,188 | 1.60s | 1.75s | +9% |
  | Pagani Huayra | 291,017 | 2.17s | 2.17s | 0% |

  Gap narrows monotonically with scene complexity; break-even at ~290K tris. Sort dispatch is roughly fixed-cost (~0.15s/frame of work) while coherence benefit scales with material diversity, so crossover is predictable. Default flag OFF until a net-positive regime is identified.
- [ ] 24. Prefix-sum compaction
- [ ] 25. Half-precision buffers
- [ ] 26. Async readback for dynamic dispatch

### Tier 5b: Sort follow-ups (after benchmark 2026-04)
- [ ] 32. Swap dispatch order so Compact runs before Sort, not after. Current flow is Extend → Sort → Shade → Compact; Sort currently processes dead rays too. Running Compact first means Sort's `activeCount` shrinks each bounce — smaller workload at later bounces.
- [ ] 33. Raise `MAX_BINS` from 16 → 32 or 64 in SortKernel + QueueManager histogram allocation. Scenes with >16 distinct materials currently clamp to bin 15, so their sort degenerates to no-op beyond that. Cheap change, broadens applicability.
- [ ] 34. Global (cross-workgroup) sort for full material coherence, not just per-workgroup. Needs a two-pass prefix-sum across workgroups. Only worth doing once per-WG sort proves net-positive on some scene.
- [ ] 35. Re-benchmark at 8 bounces and at 1024×1024 resolution. Coherence wins compound on longer paths and larger sample pools; 3-bounce/512² may be understating the benefit.

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
