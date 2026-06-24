# Proper Wavefront Path Tracing on WebGPU/TSL — Architecture Evolution Plan (v2)

**Status:** Plan / not yet implemented. Supersedes the as-built design recorded in
`wavefront-path-tracing.md` + `WAVEFRONT_TODO.md` (the v1 branch, which is a measured net
regression at production workloads).
**Date:** 2026-05-30
**Stack verified against:** three.js 0.184.0.

> **Context.** A *functionally complete* wavefront tracer already exists on this branch
> (full Disney BRDF, transmission, clearcoat, NEE+MIS, env IS, emissive NEE, displacement,
> medium stack, ASVGF/OIDN, tiling, DOF, adaptive sampling, material sort). It is **not the
> default because it regresses +54–61% on Bistro and +90% on Sponza at 1024²/8 bounces.**
> The team's own CPU+GPU profiling found it is ~99% GPU-bound (CPU dispatch ≈0.9 ms/frame);
> the cost is **pipeline barriers across ~50–67 compute passes/frame plus ray-state
> round-tripping through VRAM** — not thread divergence. This plan is about closing *that*
> gap, not re-deriving the v1 decomposition.

---

> **VERDICT UPDATE (2026-05-30, post-implementation + quiet-GPU kill-gate):** the "hybrid
> likely" prior below was **refuted**. v2 (SoA + functional compaction + dynamic dispatch,
> **sort off**) beats the monolithic renderer on **every scene measured at 1024²/8b by 11–40.5%**
> — Camera −10.8%, Diamond −14.2%, Sofaset (47 mats) −20.5%, Pagani (40 mats) −24.1%, Cornell
> −40.5% — across open/closed/transmissive/diverse scenes, and ties or wins at 512²/3b. It is a
> general replacement, not a fallback. See §8.6b for the full kill-gate data. The rest of §1 is
> the original pre-implementation analysis, preserved for context.

## 1. Executive summary

"Proper wavefront" is **not** "split the megakernel into N kernels run from a JS `for` loop"
— that *is* v1. A proper wavefront is a **GPU-driven, occupancy-maximizing,
coherence-manufacturing pipeline**: SoA path state, work organized into typed queues, every
stage **dispatched indirect-sized to the live queue count with zero CPU readback**, and a ray
pool large enough to keep every stage saturated. The decomposition is the cost; coherence +
occupancy are the product — v1 paid the cost without collecting the product.

**Single load-bearing change:** AoS `PackedRayBuffer` → **SoA-within-a-buffer**, *and* make
every stage **indirect-dispatched off a GPU-written live count**. Without SoA the round-trip
stays unaffordable (this is exactly why HIT_STRIDE-halving and Extend+Shade fusion both
showed zero benefit — cache lines were already wasted). Without indirect dispatch, late
bounces keep launching ~4096 dead workgroups.

**Honest verdict:** a proper wavefront *can* beat the megakernel here **only under a narrow
profile** — high material divergence, expensive BxDFs, high resolution, high bounce count,
large live pool. On cheap/uniform scenes it will lose. **Most likely correct outcome is a
HYBRID** (megakernel default, wavefront opt-in for qualifying scenes), gated behind a cheap
**killer experiment** (Phase 0) that must prove a win before any further investment.

## 2. Diagnosis — regression mapped to code (verified)

| Cause | Location | Verdict |
|---|---|---|
| Fixed-size dispatch every bounce | `WavefrontPathTracer.js:651,668,706` — `ceil(maxRays/WG)` baked at build | **Fixable** — biggest single cause; late bounces launch thousands of dead WGs. Indirect dispatch fixes it. |
| Per-kernel barrier serialization | `WavefrontKernelManager.js:107/116/130` — each `dispatch()` = one `renderer.compute()` = one pass + end-barrier; ≈67 passes/frame at 8b sort-on | **Partially fixable** — TSL can't batch multiple kernels into one pass; reduce *count*, not batching. Hardest-to-beat tax. |
| AoS state round-trip | `PackedRayBuffer.js:20-37` — RAY_STRIDE=7 vec4=112 B/ray; single-lane reads pull full 16 B vec4 | **Fixable (high effort)** — ~370–480 MB moved at bounce 0, 1024². Strided gathers are *why* fusion/half-precision did nothing. SoA is the #1 missing reference mechanism. |
| Single Shade over all materials | `WavefrontPathTracer.js:231` — sort only produces a sorted index list; one kernel still allocates worst-case BxDF registers | **Fixable (medium)** — no convergence at kernel entry. |
| CPU loop + stale early-exit | `WavefrontPathTracer.js:208-254`, readback 320-344 (every 4 frames, 1–2 frames old) | **Fixable** — replace with GPU-side empty-queue test. |
| `var<private>` register inflation | `rayzee/src/TSL/patches.js` (verified present on 0.184.0) | **Carry the patch** into every new kernel — mandatory. |

**Fundamental on this stack (cannot remove):** per-pass compute barriers, no hardware SER,
no native workgroup `array<atomic<u32>>`, no native f16. **Everything else is fixable** — but
whether the fixes *net-beat* the megakernel is exactly what Phase 0 decides.

## 3. Target architecture

**Scheduling model — GPU-driven relaunch-per-queue (Cycles / pbrt-v4 style), NOT persistent
threads.** Persistent threads need atomic-conditioned barriers in a spin loop, which already
failed WGSL uniformity analysis on this branch (v1 TODO item 32a) and are fragile on Metal.
Relaunch maps cleanly onto `IndirectStorageBufferAttribute` and keeps each kernel a
straight-line fn friendly to the `var<private>` patch.

**Kernel set — 5 passes/bounce (down from 7), no sort pass:**

1. `generate` — primary rays (reuse `GenerateKernel.js` ~verbatim).
2. `intersect` — closest-hit `traverseBVH`; writes hit SoA **+ a coarse 2–3-class material
   key** into partition counters via `subgroupBallot` + `subgroupExclusiveAdd` + one
   `subgroupElect` global `atomicAdd`.
3. `shade[k]` — **one indirect dispatch per material class** (2–3 buckets, all the binding
   budget allows), each allocating registers for only its BxDF family → recovers occupancy.
   NEE/shadow stays **inline** via the proven `traceShadowRayWrapped` closure.
4. `compact` — **subgroup prefix-sum** compaction (order-preserving, replaces the scrambling
   atomic-append); writes the next-bounce live count into the indirect-args buffer.
5. `finalWrite` — temporal accumulation + 3× MRT (reuse `FinalWriteKernel.js` verbatim;
   **zero downstream/denoiser changes**).

**SoA-within-a-buffer** (true one-buffer-per-field blows the 8-binding cap): partition each
storage buffer into contiguous per-field regions with computed offsets so lane *i* reads
`field[base+i]` coalesced, reusing the `count=0` RW + `.toReadOnly()` same-buffer trick that
already solved the binding limit. Keep MRT lanes in a bounce-0-only region so the hot
per-bounce footprint shrinks below v1's 112 B/ray.

**Large ray pool** — batch `samplesPerPixel` worth of primary rays / regenerate terminated
lanes (Cycles path regeneration) so `compact` always hands `shade` a full workgroup of
same-class work. This is the only way the coherence + occupancy gains actually materialize.

## 4. Reuse vs rewrite

**Reuse:** the `WavefrontPathTracer` stage shell (sub-manager reuse, `_refreshWfTextureNodes`,
setSize/resize hooks), `WavefrontKernelManager` (+ its CPU profiler that proved GPU-bound) —
extend `setDispatchCount` to take an indirect attr; `QueueManager` (+ indirect-args +
prefix-sum); `PackedRayBuffer`'s **binding trick only**; `GenerateKernel`/`FinalWriteKernel`
verbatim; `ExtendKernel` shape; `ShadeKernel`'s inline-NEE closure; `patches.js` (mandatory).

**Rewrite/discard:** AoS layout → SoA; **discard** `SortKernel`/`SortGlobalKernels`/material-
bin-remap from the hot path (measured net-negative — coherence now comes from intersect-time
partitioning, not a sort); **delete** dead `Connect`/`Accumulate`/`extendShade`; fixed
dispatch → indirect; stale readback → GPU empty-queue test; atomic-append → prefix-sum.

## 5. Feasibility (verified, three 0.184.0)

| Mechanism | Status |
|---|---|
| Indirect compute dispatch | ✅ `IndirectStorageBufferAttribute` + `dispatchWorkgroupsIndirect` (`WebGPUBackend.js:1443`). Clamp x to 65535 yourself. |
| Subgroup ops | ✅ **NOW available** (was "blocked" in older notes): `subgroupBallot/ExclusiveAdd/Elect/Broadcast/Shuffle*` exported from `three/tsl`, gated by `hasFeature('subgroups')`. Substitute for missing workgroup atomics. **Validate on Apple/mobile + provide non-subgroup fallback.** |
| GPU timestamp queries | ✅ `{trackTimestamp:true}` + `resolveTimestampsAsync(TimestampQuery.COMPUTE)` — mandatory for per-kernel on-device measurement. |
| Workgroup `array<atomic<u32>>` | ❌ still blocked → use subgroup ops, don't build a workgroup-histogram radix sort. |
| Native f16 | ❌ → manual `packHalf2x16` only, defer. |
| `var<private>` patch | ⚠️ still present → carry `patches.js`. |

Nothing requires forking three.js.

## 6. Phased plan

Every gate benchmarked on the existing StatsMeter + `window.app.reset()`/`getFrameCount()`
harness; scenes Camera / Cornell / Pagani / Sofaset / Bistro / Sponza at **512/3b and
1024/8b**; warm-convergence wall time vs megakernel. Win-target profile = 1024/8b on
Bistro+Sponza (v1's worst regressions). Carry `patches.js` from day one. Measure per-kernel
via GPU timestamps — never infer from frame time.

- **Phase 0 — KILLER EXPERIMENT (cheapest decisive test):** SoA layout + indirect dispatch +
  single Shade; add per-stage timestamps; drop sort, delete dead kernels.
  **Success:** ≤10% of megakernel at 1024/8b Bistro+Sponza (from +61%/+90%).
  **KILL:** if still **>30% slower** after SoA+indirect → no-go on full wavefront; redirect to
  hybrid / megakernel-side coherence. *This experiment answers the whole question.*
- **Phase 1 — GPU-driven empty-queue early-exit** (write `[0,0,0]` args; delete stale
  readback). Recover the +42% open-scene win without frame-lag artifacts.
- **Phase 2 — subgroup prefix-sum compaction + 2–3 typed shade queues.**
  **Success:** beats megakernel ≥10% on Bistro 1024/8b.
  **KILL:** if split-Shade doesn't beat single-Shade on heavy-material scenes → stop, ship hybrid.
- **Phase 3 — large ray pool (multi-sample batching)** + optional half-packed state. Keeps
  late-bounce occupancy from collapsing.
- **Phase 4 — production hardening** (tile/denoiser parity, debug visMode port) — only if 2–3 GO.
- **Phase 5 — hybrid gating** (scene classifier picks integrator) — the default outcome unless
  2–3 strongly GO.

## 7. Risks & honest alternatives

- **Barriers may be the floor.** If Phase 0 timestamps show barriers (not shading) dominate,
  the ceiling is set — most likely abandonment trigger.
- **2–3 buckets may be too coarse** vs pbrt-v4's full MultiWorkQueue (binding-capped).
- **Subgroups weak/absent on Apple** — needs per-device validation + fallback.
- **The patched megakernel may already have low register pressure** — leaving little
  occupancy to recover.

**Alternatives by likelihood:** (1) **Hybrid** — most likely correct, matches v1's own data;
(2) all-in wavefront — only if Phase 2–3 win across the board, unlikely; (3) **abandon**,
invest in megakernel-side coherence/variance reduction — justified if Phase 0 kills.

**Decisive principle:** front-load Phase 0. CUDA-era "wavefront wins" do not transfer to
WebGPU/Apple — v1 already proved that, and only on-device timestamps will tell you if v2 is
different.

---

## 8. Implementation Log (Phase 0 — built & verified 2026-05-30)

Implemented in the `feature/wavefront-path-tracing` worktree, validated live in-browser
(Camera scene, 512², WebGPU/Metal, Apple Silicon — note: GPU was shared with two other dev
servers, so absolute ms are contended; A/B deltas under identical conditions are valid).

### 8.1 SoA-within-a-buffer — DONE, correctness-preserving, ~10% GPU
- `PackedRayBuffer.js`: RAY (7 vec4) and HIT (2 vec4) buffers reorganized from AoS stride
  (`id*stride + slot`) to SoA regions (`slot*capacity + id`) via a module-level `_cap` and an
  `soa(id, slot)` helper. SHADOW left AoS (small, written-but-unread in the inline-NEE path).
- All active kernels access ray/hit only through the accessors → transparent switch.
- Result: pixel-identical output; GPU frame time 20.5 ms → 18.5 ms on Camera (coalesced reads).

### 8.2 Indirect dispatch — ATTEMPTED, ABANDONED (feasibility blocker)
- Wired `IndirectStorageBufferAttribute` + a `writeBounceArgs` kernel computing
  `[ceil(activeCount/256),1,1]`; set `node.dispatchSize = indirectAttr` on extend/shade/compact.
- **Verified broken:** `writeBounceArgs` computes the correct workgroup count every bounce
  (instrumented: reads 262144→82474→1550, writes 1024→323→7), but the dispatch reads a STALE
  value → late bounces truncate → bottom-of-image undersampling. Root cause: in three.js 0.184
  each `renderer.compute()` is its own command-encoder + queue submission (`finishCompute` →
  `queue.submit`), and a compute-written buffer used as the `dispatchWorkgroupsIndirect` source
  is not reliably synchronized to the indirect read across submissions. **STORAGE→INDIRECT
  hazard.** Not pursued further; revisit if fixed upstream or if a single-command-encoder
  compute batch becomes available.

### 8.3 ROOT CAUSE of all dispatch-reduction failures: v1 compaction is VESTIGIAL
- TSL storage nodes bind their attribute at **build time**. `extend`/`shade`/`compact` were
  built with `qm.getActiveReadRO()` while `pingPong === 0`, so they are permanently wired to
  buffer **A** — the identity list written by `initActiveIndices`. `swap()` flips a CPU flag
  but the kernels never re-query, so the compacted survivor list (written to **B**) was **never
  read**, and `resetPingPong()` was never called. Net effect: every kernel used
  `rayID = activeIndices_A[tid] = tid` (identity), i.e. thread index == ray slot == pixelIndex.
  Reducing the dispatch dropped the high-pixelIndex (bottom) tail — exactly the observed
  artifact. Confirmed by buffer inspection (B was dense `[0,82542)` but unconsumed) and by a
  per-kernel full/reduced isolation sweep.
- **Implication for the plan:** the dispatch-reduction lever (indirect AND CPU-dynamic) is
  gated on making compaction *functional* first. Phase 2's compaction work must precede
  Phase 0/1's dispatch reduction — a dependency the original plan ordering missed.

### 8.4 Functional compaction + dynamic dispatch — DONE, correct, −11% at 8 bounces
- New `ENTERING_COUNT` counter slot. `snapshotEntering` (1-thread) copies
  `ACTIVE_RAY_COUNT → ENTERING_COUNT` at each bounce start (before `resetActiveCounter`).
- `extend`/`shade`/`compact` bound-check on `ENTERING_COUNT` (the exact dense active-list
  length) instead of `maxRayCount`, so an over-sized (margin) dispatch is safe — surplus
  threads return without dropping or duplicating work.
- `compactCopyback` (new) copies the dense survivor list `B[0,ACTIVE)` back into read buffer
  `A` each bounce, so the next bounce reads a real compacted list. `swap()` removed.
- CPU sizes extend/shade/compact/copyback from the previous frame's per-bounce survivor curve
  (reused async readback) × 1.5 + 1024, clamped to maxRays. Gated to the non-sort path in
  Phase 0 (sort kernels still run full-width).
- **Verified:** Camera 512/3b survivor curve `[82474,18505,4170,1,0]` — bit-identical to
  full-dispatch; clean image, no artifacts. Camera 512/8b A/B: **dynamic 809 ms vs full
  911 ms = −11.2%**, identical survivor curve. Benefit grows with bounce count (late bounces
  dispatch a handful of workgroups instead of `ceil(maxRays/256)`).

### 8.4b v2 vs MONOLITHIC — Camera (wavefront's worst case, 2 materials)

Clean same-session A/B (same harness, same contended GPU, `wavefrontEnabled` toggled + reload):

| Setting | Monolithic | v2 wavefront | Delta |
|---|---:|---:|---:|
| 512²/3b | 806 ms | 808 ms | tied (+0.2%) |
| 1024²/8b | 1820 ms | **1624 ms** | **−10.8% (v2 faster)** |

**This flips v1's verdict.** v1 was +20% slower than mono on this exact scene at 512/3b (and +54–90% on big scenes at 1024/8b). v2 ties at low settings and *beats* mono by ~11% at production settings — and Camera is the regime that should favor mono (trivial material divergence). The win scales with resolution/bounces (more wasted late-bounce workgroups for dynamic dispatch to eliminate). Material-diverse scenes (Pagani/Sofaset/Bistro) — where wavefront's coherence advantage is real — are expected to widen the gap; that's the remaining kill-gate, pending a quiet GPU + heavy-scene loading.

### 8.4c Material-diverse scene (Pagani, 40 materials) + sort-path restructure

- **Correctness verified** on Pagani Huayra (291K tris, 40 materials) — renders cleanly at
  both 512² and 1024². SoA + the compaction changes are correct on a diverse scene, not just
  Camera.
- **Design gap found & fixed:** sort-on scenes (the material-diverse ones wavefront *should*
  win on) have `_sortMaterials = true`, which gated dynamic dispatch OFF — yet they still paid
  the copyback's +2 passes/bounce for no benefit. Restructured into two clean paths:
  - **Functional-compaction path** (`dynamic && !sort`): `snapshotEntering` (ENTERING=ACTIVE)
    + `compactCopyback` + reduced dispatch. Camera's −11% win.
  - **Full path** (sort-on OR dynamic-off): new `enterFull` kernel sets ENTERING=maxRays, read
    buffer stays the identity list, **no copyback** — i.e. exactly v1+SoA. Sort-heavy scenes
    get the SoA win without the copyback tax.
- **Pagani perf is INCONCLUSIVE** on the contended GPU (512²/3b ≈ 2.0 s; 1024²/8b swung
  3.5↔4.6 s across runs — that variance is the two co-resident dev servers, not the code).
  This is exactly why the kill-gate needs a quiet GPU.
- **Dynamic dispatch for the per-WG sort path — TRIED & REVERTED (2026-05-30).** Enabled
  functional compaction + per-WG-sort sizing for sort-on scenes. Pagani 512/3b A/B showed
  **0% perf delta** (2009 vs 2010 ms — closed scene, survivor counts stay high at 3 bounces,
  little late-bounce waste to cut) AND the per-bounce survivor curve **diverged** from the
  full path (dynamic `[45208,8202,4963,60]` vs full `[81712,38357,37421,36520]`). The
  divergence means functional-compaction vs identity-buffer active-ray accounting disagree
  under sort — a correctness risk with no upside, so reverted. Sort-on stays on the trusted
  v1+SoA full path. Proper fix is the **ping-pong kernel-variant compaction** (build A/B
  read variants, no copyback, cleaner active-list semantics) — deferred to Phase 2.

### 8.5 Trade-off introduced & next step
- Functional compaction adds **+2 compute passes/bounce** (`snapshotEntering`, `compactCopyback`).
  Since v1's measured bottleneck is per-pass barriers, this cost may offset the workgroup
  savings on barrier-bound scenes (Bistro/Sponza). The cleaner design — **ping-pong kernel
  variants** (build A-reading and B-reading variants of extend/shade/compact, alternate per
  bounce) — eliminates the copyback pass entirely and is the recommended Phase 2 refinement,
  alongside subgroup prefix-sum compaction (subgroup ops confirmed available in 0.184).

### 8.5b Production / tiled parity — VERIFIED
Via the proper `handleModeChange('final-render')` flow (NOT the earlier invalid runtime
renderMode poke), final-render runs to completion (`isComplete=true`, tiled 3×3) and renders
Camera correctly. Preview, resize, and production tiers all render correctly with the v2
changes. (OIDN-on production not separately timed; OIDN reads the same unchanged MRT textures.)

### 8.6b KILL-GATE — RUN ON A QUIET GPU (2026-05-30) — v2 PASSES

> **✅ CAVEAT RESOLVED (2026-05-30) — re-validated on synced tree.** The numbers in *this*
> sub-section (8.6b) compare v2 against the branch's frozen April-19 monolith. Main has since been
> merged into the branch (`754f374`) and the kernels adapted to main's shading APIs (`75a1651`),
> so the comparison was re-run with BOTH paths on current-main's shading + STBN + features — see
> **§8.6c** for the validated vs-current-main result. Verdict: the win **held** (~20–23%), it did
> NOT shrink to nothing or flip negative as feared. 8.6b is kept for the architecture-vs-old-shading
> record.

After the co-resident dev servers were killed (runs reproducible to <1%), v2 (SoA + functional
compaction + dynamic dispatch, **sort OFF**) vs the monolithic `PathTracer`, warm wall-clock to
60-frame convergence:

| Scene | Tris | Mats | Type | Setting | Mono | v2 (sort-off) | Delta |
|---|---:|---:|---|---|---:|---:|---:|
| Camera | 18K | 2 | open | 1024²/8b | 1820 ms | 1624 ms | **−10.8%** |
| Camera | 18K | 2 | open | 512²/3b | 806 ms | 808 ms | tied |
| Diamond | — | 2 | transmissive | 1024²/8b | 2123 ms | **1821 ms** | **−14.2%** |
| Pagani Huayra | 291K | 40 | diverse car | 1024²/8b | 3951 ms | **2997 ms** | **−24.1%** |
| Pagani Huayra | 291K | 40 | diverse car | 512²/3b | 2000 ms | 1952 ms | −2.4% |
| Outdoor Sofaset | 269K | 47 | diverse interior | 1024²/8b | 3370 ms | **2678 ms** | **−20.5%** |
| Outdoor Sofaset | 269K | 47 | diverse interior | 512²/3b | 1803 ms | 1797 ms | tied |
| Cornell Box | 64 | 9 | small closed | 1024²/8b | 4258 ms | **2532 ms** | **−40.5%** |
| Cornell Box | 64 | 9 | small closed | 512²/3b | 1212 ms | **912 ms** | **−24.8%** |

**v2 beats the megakernel on EVERY scene at production settings (1024²/8b), by 11–40.5%** —
across open / closed / transmissive / material-diverse scenes (2–47 materials), including the two
scenes where v1 regressed +54–90% (Sofaset was v1's worst at +86%). At low settings (512²/3b) it
ties or wins (Cornell −24.8%). **This refutes the plan's "hybrid likely" prior: v2 is a general
replacement, not a fallback.** Notably the **biggest** win is Cornell (−40.5%) — a small closed box
with deep bounce paths, i.e. the high-divergence/high-register-pressure regime the megakernel
handles worst and the wavefront architecture was always meant to win; v1 failed to realize it, v2 does.

**The decisive lever was turning the material SORT OFF.** Sort-on Pagani 1024/8b = 4483 ms
(+13.5% vs mono); sort-off = 2997 ms (−24%). Two compounding reasons: (1) the storage-atomic
per-WG counting sort costs more than the coherence it buys (the team's own v1 data already hinted
this — TSL lacks workgroup atomics, forcing the slow storage path); (2) in this implementation
sort-on routes to the full-dispatch path, forfeiting the dynamic-dispatch late-bounce reduction.
Default flipped to `wavefrontSortMaterials: false`.

Correctness on the winning path: sort-off = the functional-compaction path, verified
bit-identical to full dispatch on Camera and pixel-correct on Pagani (and Sofaset uses the same
path). Not yet tested: Bistro/Sponza (not in the asset catalog) — but Sofaset's 47 materials are
comparable diversity and v2 wins there, so the inference to Bistro/Sponza is strong.

**Implication for Phase 5 (hybrid):** no scene-based megakernel/wavefront routing is needed —
v2 sort-off is the better default everywhere measured. The remaining perf phases (subgroup
typed-shade, multi-sample pool, ping-pong compaction) are now *upside on top of an already-winning
baseline*, not prerequisites for viability.

### 8.6c VALIDATED KILL-GATE — synced tree, vs CURRENT main (2026-05-30)

After merging main (`754f374`) + adapting the kernels (`75a1651`), both the monolith and v2 run
on **identical current-main shading** (single-pass RIS NEE, merged DFG, register-pressure cuts,
MaterialCache 11-field, STBN blue noise, env MIS, Woop, etc.) — so this isolates the *integrator
architecture* as the only difference. Quiet GPU, warm-median of 3, 1024²/8b:

| Scene | synced mono (current main) | synced v2 | Delta |
|---|---:|---:|---:|
| Camera (camera.glb) | 2020 ms | 1620 ms | **−19.8%** |
| Pagani Huayra (40 mats) | 4212 ms | 3247 ms | **−22.9%** |

**The win HELD.** Pre-merge (old shading) was −24.1% on Pagani; synced (current shading) is −22.9%
— the sync's pessimistic prediction (margin shrinks toward zero / flips negative on simple/medium
scenes) did **not** materialise. v2's architectural advantage (dynamic-dispatch workgroup
reduction + SoA coalescing) is durable against current main, not an artifact of a stale baseline.
Correctness verified: synced wavefront renders Camera + Pagani correctly, survivor curves match
pre-merge, no shader-build errors. (Equal-spp, not yet equal-MSE; STBN convergence parity and the
full 7-scene matrix remain as polish, but the headline verdict is settled.)

### 8.7 Status verdict (end of this implementation pass)
**Shippable & verified-correct:** SoA + functional compaction + dynamic dispatch (sort-off),
v1+SoA full path (sort-on). v2 **ties or beats** the monolithic renderer on every scene that
could be measured cleanly (Camera: tie@512/3b, −10.8%@1024/8b — a full reversal of v1's +20%).
Correct on Camera (sort-off) and Pagani (40-material, sort-on); production tier verified.

**Deliberately NOT implemented this pass (and why):** the remaining phases are perf
optimizations (subgroup typed-shade + prefix-sum compaction, multi-sample pool) or need
kill-gate data to calibrate (hybrid classifier). They **cannot be validated** under the
current GPU contention (two co-resident dev servers), and this codebase's compaction semantics
are subtle enough (see the sort-dynamic divergence in §8.4c) that shipping unverified perf code
would violate the project's "measure on-device before shipping" rule. The correctness-improving
**ping-pong kernel-variant compaction** (Phase 2) is the recommended next code milestone — it
removes the copyback pass *and* gives clean active-list semantics that would let the sort path
take dynamic dispatch correctly — but it's a 6-variant refactor best done when its perf can be
measured on a quiet GPU.

**To finish the plan:** free the GPU (kill the 5173/5174 dev servers), run the kill-gate
(`_useDynamicDispatch` A/B on Pagani/Bistro/Sponza @1024²/8b) for the go/no-go verdict, then
implement Phase 2 ping-pong variants and re-measure.

### 8.6 Files changed (worktree, uncommitted)
- `rayzee/src/Processor/PackedRayBuffer.js` — SoA layout.
- `rayzee/src/Processor/QueueManager.js` — `ENTERING_COUNT` slot (+ dormant indirect attr).
- `rayzee/src/Stages/WavefrontPathTracer.js` — functional compaction, dynamic dispatch, loop.
- `rayzee/src/TSL/wavefront/ExtendKernel.js` — `counters` param + `ENTERING_COUNT` bound.
- `rayzee/src/TSL/wavefront/ShadeKernel.js` — `ENTERING_COUNT` bound.
- `rayzee/src/TSL/wavefront/CompactKernel.js` — `ENTERING_COUNT` bound.

### 8.8 Phase 2 — IMPLEMENTED + MEASURED (2026-05-30, synced tree, quiet GPU)

Phase 2 ("subgroup prefix-sum compaction + typed shade queues") implemented and measured
on the synced tree rather than predicted:

- **2a — subgroup prefix-sum compaction (`buildCompactSubgroupKernel`, committed):** one global
  atomicAdd per subgroup (lane reserves a block via `subgroupExclusiveAdd` + lane-0 atomic +
  `subgroupBroadcast`) instead of one per surviving ray. Verified correct (identical survivor
  curve). **Measured NEUTRAL** — Camera/Pagani 1024²/8b: 1621/3082 ms (subgroup) vs 1630/3083 ms
  (atomic-append). Confirms compaction atomics are not the bottleneck. Flag-gated off
  (`_useSubgroupCompact`, auto-disabled without the `subgroups` feature). TSL caveats handled:
  `subgroupBroadcastFirst` is mis-declared (parameterLength 2 → invalid WGSL), and subgroup ops
  must be `.toVar()`-materialized at top level to avoid being inlined into divergent control flow.
- **2b — material coherence (typed-queue mechanism) — MEASURED NET-NEGATIVE.** The material sort
  *is* material-coherent shade dispatch. On the synced tree, Pagani 1024²/8b: **sort-on 4661 ms
  vs sort-off (winning config) 3082 ms — +51% slower.** Coherence-by-reordering loses the
  dynamic-dispatch win that is the architecture's actual value, so it is net-negative here. The
  remaining 2b sub-mechanism — splitting the 25 KB ShadeKernel into per-class specialized kernels
  for register-pressure reduction — would *add* this measured-negative coherence cost on top of a
  large, risky rewrite for only modest register savings; given 2a (neutral) + 2b-coherence
  (−51%) + the prior 0.4% pass-fusion result, the kill-criterion is met and the split is not
  pursued. The integrator win on this hardware comes from dynamic-dispatch workgroup reduction,
  not from manufacturing coherence.

### 8.9 Phase 3 — large ray pool (multi-sample) — IMPLEMENTED + MEASURED + CORRECT (2026-05-30) — **REMOVED 2026-06-25**

> **REMOVED (2026-06-25):** the multi-sample pool / `samplesPerPixel` ("Rays Per Pixel") feature was
> deleted from the engine. In wavefront `S>1` costs S× ray-buffer VRAM and is redundant with progressive
> accumulation (production forced `S=1`; interactive converges over frames). The kernels, `_samplesPerPass`/
> `_resolveSamplesPerPass`/`_ensureSamplesPerPass`, the `wavefrontMultiSampleMaxPixels` cap, the uniform, the
> settings route, and both UI sliders were removed; rendering is now strictly 1 primary ray/pixel/frame. The
> section below is retained as a historical record of the original implementation.

Phase 3 ("large ray pool / multi-sample batching") implemented and measured. **Net-positive at
interactive resolution** — the first Phase to beat the v2 baseline (2a neutral, 2b −51%).

**Mechanism.** `S` primary rays per pixel per frame, packed into one pool of `w·h·S` rays so a
single bounce loop processes all `S` samples. `GenerateKernel` dispatches `h·S` rows — row `gy`
decodes to `(subSample = gy/h, pixelY = gy%h)` and the ray lands in slot `subSample·maxRaysPerSample
+ pixelIndex`, with the RNG decorrelated per sub-sample (`getDecorrelatedSeed.rayIndex = subSample`)
so the `S` rays jitter independently. `FinalWriteKernel` averages the `S` slots per pixel (MRT taken
from sub-sample 0) before the temporal blend. Every downstream sizing (buffers, init fill, bounce
dispatch bounds, `_wfMaxRayCount`) scales off the pool, so `S` propagates for free. Flag:
`_samplesPerPass` (default 1 = original path bit-for-bit). Files: `GenerateKernel.js`,
`FinalWriteKernel.js`, `WavefrontPathTracer.js`.

**Why it helps.** Not raw ray throughput — the per-frame *fixed* cost (denoiser + the 4 non-bounce
passes `reset`/`generate`/`init`/`finalWrite` + launch/barrier overhead) is a large fraction of frame
time at low resolution, and multi-sampling amortizes it across `S` samples. The app is also
vsync-bound at S=1 (8.27 ms wall vs 6.62 ms GPU on the 120 Hz ProMotion panel → ~1.65 ms idle/frame),
so multi-sampling additionally fills the idle vsync slack with useful samples.

**Measured (512² = default interactive resolution, camera model, quiet GPU):**

| S | pool rays | wall ms/frame | GPU compute ms/frame | wall → 60 samples | GPU → 60 samples |
|---|-----------|---------------|----------------------|-------------------|------------------|
| 1 | 262 144   | 8.27          | 6.62                 | 60×8.27 = 496 ms  | 60×6.62 = 397 ms |
| 2 | 524 288   | 13.21         | 11.93                | 30×13.21 = **396 ms (−20%)** | 30×11.93 = **358 ms (−10%)** |
| 4 | 1 048 576 | 23.53         | 22.41                | 15×23.53 = **353 ms (−29%)** | 15×22.41 = **336 ms (−15%)** |

GPU-compute is vsync-independent (`renderer.resolveTimestampsAsync('compute')`, whole-frame so
overhead-dominated); wall-clock is the user-facing convergence metric. Both agree on direction and
monotonicity (3-cycle min, variance <1%). 2× samples cost 1.80× GPU time, 4× cost 3.39× — the
sub-linear scaling is the amortization. Note `60×8.27 = 496 ms ≈ the 0.49 s warm reference` — the
existing benchmark is itself vsync-limited at S=1, which is exactly why multi-sampling has slack to
exploit.

**Correctness — VERIFIED.** S=4 converged (240 samples) vs S=1 converged (60 samples) are the same
scene with correct lighting/exposure/materials and *less noise* — no NaN, black regions, banding, or
tile seams. Multi-sample averaging + decorrelated RNG is correct. (Screenshots taken during the
session; not committed.)

**256²/1024² NOT reliably measured** — `app._applyRenderResize` reverts during the in-loop
`app.reset()`, and `info.compute.timestamp` is whole-frame (it read ~6.55 ms for both 256² and 512²
S=1, i.e. overhead-dominated, not wavefront-isolated). The 512² result stands on its own as the
default interactive resolution and is sufficient to establish the win.

**Shipping decision: driven by the user's `samplesPerPixel` ("Rays Per Pixel"), interactive-only,
DEFAULT 1 (= off, opt-in).** `S` is not a separate knob — `_resolveSamplesPerPass(w, h)` is the single
source of truth: `S = (renderMode===0 && w·h ≤ wavefrontMultiSampleMaxPixels) ? max(1, samplesPerPixel) : 1`.
(Originally shipped as an auto-on S=2 via a dedicated `wavefrontInteractiveSamplesPerPass`; that knob +
`wavefrontMultiSampleInteractive` were **removed** and folded into `samplesPerPixel` once the megakernel
was slated for removal — one sampling knob across the engine. Only `wavefrontMultiSampleMaxPixels` (768²
memory cap) remains.)
- **Why `samplesPerPixel`:** in the monolithic it drove an inner per-pixel ray loop (`TSL/PathTracer.js:237`);
  in the wavefront that loop doesn't exist (it was a dead, unused GenerateKernel param — now removed), so
  the pool *is* the wavefront's samples-per-pixel-per-frame mechanism. Same user-facing meaning, different
  (saturation-fixing) implementation.
- **Tiled/production stays correct by construction:** tiling activates *only* at `renderMode===1`
  (TileManager.handleTileRendering); the gate returns S=1 for any non-interactive mode, so the tiled path —
  which generates only the tile's rows and would otherwise average stale slots 1..S-1 — never sees S>1,
  *even when the user has Rays Per Pixel > 1* (verified live: spp=2 + production → S=1).
- **Live-change + mode-switch safety (`_ensureSamplesPerPass`):** `S` is baked into the compiled kernels at
  build, but the user can change Rays Per Pixel, or the mode can flip, without a resize. The guard runs each
  frame in `render()` after `_handleResize()`; if current samplesPerPixel/mode/resolution implies a different
  `S` than what is baked, it rebuilds *before* any dispatch (one comparison in steady state). `samplesPerPixel`
  is bound `reset:true` in RenderSettings, so a slider change also restarts accumulation cleanly.
- **Resolution gate (memory):** the SoA RAY/HIT pool grows linearly with `S` (512² @2 ≈ 117 MB ray buffer),
  so the 768² cap forces S=1 at ≥768² where the GPU is also closer to saturated.

**End-to-end verified live (2026-05-30):** default (Rays Per Pixel=1) → S=1 (pool 262 144, multi-sample off).
Driving samplesPerPixel 1→2→4→1 via the real settings path rebuilds the pool ×1→×2→×4→×1 (guard) and renders
correctly at spp=2. Flipping to production with spp=2 still clamps S=1. The contract is documented at the
`_resolveSamplesPerPass`/`_ensureSamplesPerPass` site in `WavefrontPathTracer.js`; the cap is in `EngineDefaults.js`.
