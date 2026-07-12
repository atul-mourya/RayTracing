# Tier 2 — Per-Pixel Adaptive Sampling (converged-pixel freeze)

**Status:** planned, not built. Base branch `feat/convergence-early-stop` (Tier 1 committed `3beabdb`; freeze-bias probe instrumentation currently uncommitted on top).
**Scope decision:** production / final-render only. **relErr-only freeze, NO absolute-error floor.** Interactive keeps the Tier-1 whole-frame stop unchanged.

---

## 1. Goal

Stop tracing pixels that have individually converged, so per-frame GPU work shrinks as the image converges — the PBRT-v4 adaptive-sampling model (per-pixel mean/variance → shrink the *camera* queue to active pixels → reuse the wavefront's existing compaction). This is *not* per-ray early termination: every camera sample of an active pixel is traced to completion; we only decline to spawn a new camera ray for a frozen pixel.

## 2. Why this shape (evidence)

- **Architecture is standard & proven.** Matches PBRT-v4 exactly (per-pixel accumulators, once-per-frame variance update, active-pixel compaction, jitter-compatible, reset-on-change). Our engine already has every primitive.
- **Monotonic freeze ⇒ no per-pixel alpha (validated, survives adversarial math).** `accumulationAlpha` is the global `1/(frame+1)` running-mean weight. If a pixel that freezes never resumes within a run, every *still-active* pixel is sampled on every settled frame, so its true sample count == `frame+1` == the global normalizer → global alpha stays exact. Frozen pixels are excluded from the mix (prev-color pass-through); their stale count is irrelevant.
- **The "fixed-slot ray buffer" is the ENABLER, not a blocker.** Invariant `rayID == pixelIndex`; all data buffers (ray/rng/hit/gBuffer/m2) are pixel-indexed. Only `QueueManager.activeIndices` is dense. Tier 2 shrinks only that dense list + the grids sized from it; no data buffer changes.
- **Quality is safe with the right criterion (probe, 3 scenes, 2026-07-12).** A naïve `relErr OR absFloor` freeze bakes **4.3 % of a real GI interior >50 % wrong** — almost entirely the **absFloor freezing dim pixels** that later brighten. Dropping the absFloor (freeze on **relErr only**, tight ~0.02) collapses that to **0.28 % >50 %, 0 % >100 %** on the same scene (genuine rare-path bias is small everywhere: 0.28 % heavy / 0.18 % Diamond / 0 % Cornell). The absFloor is correct for the whole-frame *stop* (OIDN cleans a uniform residual) but wrong for permanently freezing an individual pixel.
- **Honest ROI.** Win is **bounce-0 only** (deep bounces already trimmed by the survivor curve), **tail-only** (after `minSamples`), and **cannibalized by the Tier-1 whole-frame stop** in interactive. It only clearly pays off in **production/final-render**: a long convergence tail to a high sample cap, where freezing progressively cheapens tail frames and frees GPU headroom. A fixed per-frame floor remains (full-screen FinalWrite + full-buffer active-pixel scan + full-region copy + readback) regardless of frozen fraction.

## 3. Per-frame dispatch flow

**Today (interactive & production):**
```
generate(2D) → initActiveIndices(identity seed) → [extend→(sort)→shade→compact→copyback]×bounces → finalWrite(2D) → readback
```

**With Tier 2 enabled (production):**
```
resetFrameCounters(1-thread)         zero ACTIVE_RAY_COUNT + CONVERGED_COUNT
buildActivePixels(1D over maxRays)   frame==0 → seed ALL; else if streak[P]<K → slot=atomicAdd(ACTIVE,1); activeIndices.a[slot]=P
seedEnter(1-thread)                  ENTERING_COUNT = ACTIVE_PIXEL_COUNT = ACTIVE_RAY_COUNT
generate(1D over active count)       tid→pixelID=activeIndices.a[tid]; gx=pixelID%resX, gy=/resX; write rayBuffer[pixelID] etc.
[extend→(sort)→shade→compact→copyback]×bounces   UNCHANGED (already dense-list driven, bounded on ENTERING_COUNT)
finalWrite(2D over ALL pixels)       frozen→pass-through prev color/aux; active→accumulate + Welford + freeze stamp
readback                             ACTIVE_PIXEL_COUNT drives next frame's bounce-0 grid size
```
`generate` shrinks from `w·h` to the active-pixel count; Extend/Shade/Compact inherit the shorter list for free.

## 4. Implementation steps (ordered)

Reuse the probe's `streak` buffer + freeze logic; drop the CCDF-bucket counters and `biasThreshold` (measurement scaffolding).

| # | Step | Files | New buffers/kernels | Risk |
|---|------|-------|---------------------|------|
| 1 | Add `COUNTER.ACTIVE_PIXEL_COUNT`; keep `FROZEN_COUNT` for readback/stop; drop probe buckets. | `QueueManager.js` | counter slot | low |
| 2 | Per-pixel `streak` (u32) becomes the real freeze buffer (pre-alloc at max capacity next to m2). | `PathTracer.js` (alloc/dispose) | reuse probe `_streakAttr` | low |
| 3 | New uniforms: `useAdaptiveFreeze` (bool), `adaptiveFreezeThreshold` (~0.02), `adaptiveFreezeStreakK` (~8). | `UniformManager.js`, `EngineDefaults.js` | 3 uniforms | low |
| 4 | FinalWrite **freeze stamp**: active pixel updates `streak` (relErr<thr → ++, else 0); frozen (`streak≥K`) counts toward CONVERGED_COUNT (frozen ⇒ converged). **relErr ONLY, no absFloor.** | `FinalWriteKernel.js` | — | low |
| 5 | FinalWrite **frozen copy-through**: at top, if `streak[P]≥K` sample `prevAccumTexture`, set `finalColor=prevAccum.xyz`, `outputAlpha=prevAccum.w`, pass aux normal/albedo through, **skip** the accumulation mix + Welford, `textureStore` the prev value. Explicit pass-through (copyToReadTargets re-copies the whole region). | `FinalWriteKernel.js` | — | **med** |
| 6 | Replace `initActiveIndices` with the **3-kernel split** (`resetFrameCounters`, `buildActivePixels`, `seedEnter`). `buildActivePixels`: `frame==0 → seed all`; else frozen-keyed atomicAdd-scatter (reuse `CompactKernel` shape; subgroup-prefix variant to cut atomic contention). Reorder in `render()` to run **before** `generate`. | `PathTracer.js` (kernels + render order), `QueueManager.js` | 3 kernels replace 1 | **med** |
| 7 | `generate` 2D→1D list-driven: bound `tid<ENTERING_COUNT`; `pixelID=activeIndices.a[tid]`; recover `gx/gy` via `resolution.x` stride; write keyed by `pixelID` (unchanged). | `GenerateKernel.js`, `PathTracer.js` (register 1D + dispatch) | generate binds activeIndices RO | **high** |
| 8 | Size bounce-0 grid from **stale `ACTIVE_PIXEL_COUNT`** (readback), `×1.5+1024` margin; **full-size (maxRays) whenever `_curveSizingValid` is false** (post-reset/camera-move) — reuse the existing survivor-curve gate + `_readbackGeneration`. `setDispatchCount` only (no recompile). | `PathTracer.js` (`render()` sizing, `_maybeReadbackCounters`) | — | med |
| 9 | Freeze-state reset: `buildActivePixels frame==0` seeds all + FinalWrite `frame==0` self-inits `streak=0` (mirrors m2 self-init) → race-free clear on reset()/camera-move, no separate clear kernel. Verify `reset()` and camera-move set `_curveSizingValid=false`. | `PathTracer.js`, `PathTracerStage.js` | — | med |
| 10 | Production gating: `PRODUCTION_RENDER_CONFIG.useAdaptiveFreeze=true` (+ threshold/K); `configureForMode` wires the 3 uniforms; interactive leaves it off. | `EngineDefaults.js`, `PathTracerApp.js` | — | low |

## 5. Correctness-critical invariants (do not violate)

1. **Monotonic freeze.** A frozen pixel never un-freezes within a run. Never clear `streak` mid-run except at `frame==0` (reset). Un-freezing breaks the global-alpha correctness.
2. **relErr ONLY for the freeze decision.** No absFloor — it bakes dim-region darkening (probe: 4.3 %→0.28 % >50 %). The absFloor stays only in the Tier-1 whole-frame stop.
3. **FinalWrite frozen pixels pass through** (prev color + alpha + aux); they must be re-emitted every frame (ping-pong + full-region copy), never silently skipped, never read from their stale `rayBuffer` slot.
4. **Dispatch sizing safe by monotonicity.** Within a settled run the frozen set only grows, so a stale active count is always an over-estimate → no scattered-pixel dropout. The reset boundary (count jumps to maxRays) is the only unsafe case → gated by `_curveSizingValid` = full-size.
5. **Atomic ordering.** `ACTIVE_RAY_COUNT` must be zeroed in a dispatch *before* the scatter dispatch — hence the 3-kernel split (not thread-0 of the scatter kernel).
6. **Frozen ⇒ converged for the stop.** Frozen pixels still increment `CONVERGED_COUNT` in the pass-through branch, so the Tier-1 whole-frame stop still fires correctly.
7. **Bounce loop untouched.** Extend/Shade/Compact/sort already iterate `activeIndices` bounded on `ENTERING_COUNT`; feeding a shorter list restricts them with zero code change. Shade stays at its 10-buffer cap with no new bindings.

## 6. Verification plan

- **Image parity (the gate):** render each test scene to a high cap with adaptive freeze ON vs OFF; RMSE per-pixel. Reuse the probe's bake-error CCDF (keep it behind the off-by-default flag) to confirm >50 % band stays ≤~0.3 % on Diamond / Cornell / **24155522 (mandatory — toy scenes hide the bias)**.
- **No scattered dropout:** visually confirm no salt-and-pepper holes during the convergence tail and immediately after a camera move (the reset boundary).
- **Perf:** GPU-timestamp tail-frame cost ON vs OFF on 24155522 at 512²/1024² (GPU-bound) — expect bounce-0/extend to shrink with the frozen fraction; quantify the freed headroom. Confirm the fixed floor (full-screen FinalWrite + scan + copy) as the lower bound.
- **Regression:** interactive mode unchanged (freeze off); 738-test suite + lint 0; no hot-path recompile (only build-time + camera/resize as today).

## 7. Effort, risk, rollback

- **Effort:** ~10 steps across 6 files; steps 5–7 are the real work (FinalWrite pass-through, the 3-kernel split, generate 2D→1D). ~1–2 focused sessions incl. GPU validation.
- **Top residual risks:** generate 2D→1D indexing bug (reads wrong pixel) → caught by image parity; reset-boundary dropout → covered by invariant 4 + full-size gate; a pathological focused-caustic scene beyond the 3 tested → covered by the retained probe.
- **Rollback:** entirely behind `useAdaptiveFreeze` (off everywhere but production). Flipping it off restores exact Tier-1 behavior. No data-format changes; buffers are additive.

## 8. Explicitly out of scope

- Per-pixel alpha / sample redistribution (unnecessary given monotonic freeze).
- Interactive-mode freeze (marginal win under vsync; keep Tier-1 stop only).
- Un-freeze/probe of frozen pixels (would reintroduce per-pixel alpha).
- Indirect dispatch (readback sizing already shrinks the grid; see `project_threejs_indirect_dispatch`).
