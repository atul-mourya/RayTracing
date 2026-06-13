# ReSTIR Real-Time 1-spp Mode — Scoping Spec

> **Status:** SCOPED — design + phased plan, ready to build. Produced by a 4-reader understand workflow (render
> modes/accumulation, ASVGF wiring, reservoir lifecycle, perf/VRAM) + a live frame-time measurement.
>
> **Why this exists:** Phase 2 ReSTIR GI is built, correct, unbiased, and fully validated — but provides ~zero
> net benefit in the app's PROGRESSIVE-accumulation mode (temporal reuse is mathematically redundant with
> frame-averaging; spatial's variance reduction is redundant with the firefly clamp + accumulation;
> `project_restir_gi_phase2`). ReSTIR's payoff is REAL-TIME 1-spp: **1 sample/frame during continuous
> navigation, ReSTIR temporal+spatial reuse as the estimator (reservoir persists + reprojects across camera
> moves), ASVGF as the denoiser — no progressive accumulation, no OIDN.** That's the one regime where the whole
> DI+GI ReSTIR investment is unlocked, and it matches the app being a "real-time path tracer."

## 0. Feasibility — already de-risked

- **Perf (measured, 512², this scene):** base path tracer mb8 GI-off = **8.5 ms/frame (118 fps)**; 1-spp + full
  GI ReSTIR (mb1, M=2, temporal+spatial+resolve) = **10.5 ms/frame (95 fps)**. The entire GI stack adds **~2 ms**.
  ASVGF is light (temporal EMA + 5×5 gradient + 3×3 spatial; ~1–2 dispatches) → real-time at 512² is comfortable
  (~60 fps with ASVGF). Higher res needs resolution-scaling/upscaling (already in the engine). The M=8 device-loss
  was a single over-heavy dispatch, NOT a per-frame budget problem.
- **Enabler is small:** the only architectural blocker is that reservoirs `clear()` on every reset (§2); the fix
  is ~5 lines. Temporal reprojection + disocclusion are already built and correct (DI + GI temporal kernels).
- **ASVGF needs no new plumbing:** the ReSTIR-resolved 1-spp color already lands in `pathtracer:color`
  (RADIANCE_ALPHA → FinalWrite → context); ASVGF consumes that the instant it's enabled.

## 1. The mode (a new config tier)

A persistent **`realtime`** tier (NOT the transient CameraOptimizer interaction mode). It renders 1 spp/frame and
displays each frame denoised — continuously, during AND after motion — with no progressive accumulation.

`REALTIME_RENDER_CONFIG` (EngineDefaults.js), entered via `configureForMode('realtime')`:
- `renderMode: 0` (interactive — required by the ReSTIR + ASVGF gates).
- `samplesPerPixel: 1`, `bounces: 1` (camera-depth; GI owns the 1 indirect bounce), reuse on.
- `enableReSTIR: true` AND `enableReSTIRGI: true` (both — §5; lift the Phase-2 mutual exclusion).
- `enableAccumulation: false` (display each 1-spp frame fresh — the FinalWrite gate already supports this via
  the interaction-mode path, FinalWriteKernel.js:85-99).
- `denoiser: 'asvgf'` (`setASVGFEnabled(true)` → co-enables Variance + BilateralFilter, disables EdgeFilter).
- `renderLimitMode: 'time'` → `completionThreshold = Infinity` so it NEVER "completes" into the OIDN/static path.
- `enableOIDN: false`.

The CameraOptimizer interaction mode (1-spp during motion, `accumulationEnabled=false`, `cameraIsMoving=true`) is
the mechanism to borrow for "display fresh 1-spp", but the realtime tier must stay 1-spp ALSO when static (it does
not exit to progressive accumulation), and crucially must NOT fire the reservoir-clearing reset on motion-stop.

## 2. THE KEY ENABLER — reservoir persistence across camera moves

**Problem (the #1 prerequisite, architectural not perf):** `PathTracerStage.reset()` (PathTracerStage.js:663-665)
calls `restirPool.clear()` + `restirGIPool.clear()` UNCONDITIONALLY — zeroing all temporal history. Camera moves
route through `reset(true)` (PathTracerApp.js:264, from the OrbitControls 'change' listener :1385-1390). So today
every camera nudge destroys the reservoir — exactly the history real-time reuse needs to reproject.

**Fix:** thread a **reset reason** through `reset(reason) → pipeline.reset(reason) → stage.reset(reason)`. Skip
`clear()` for `reason==='camera'`; still clear for light/material/scene/geometry edits (the stored radiance —
DI's world light point is re-evaluated fresh so it's fine, but GI's `L_o(x1→x0)` is fixed-world-direction and
becomes STALE on lighting/geometry change → must clear). ~5 lines + arg threading.

**Why reuse stays valid across a camera move (verified):** the disocclusion gate (motion-vector reproject +
normal≥0.9 + linear-depth≤0.1) confirms the reprojected pixel is the SAME world surface point; V/f/visibility are
recomputed fresh at the new view; the stored radiance is view-INDEPENDENT (diffuse `L_o`). Failed gate → fresh
canonical (unbiased, just under-converged). Motion vector + prev-normalDepth are RenderTargets that survive a
reset-without-clear; the frameParity swap is independent of `clear()` → no corruption.

**Jacobian (refined — better than first thought):** `ReSTIRGITemporalKernel.js:191` hardcodes `jacC=jacS=1`. For
the TARGET use case — STATIC scene, MOVING camera — this is **exactly correct, not an approximation**: reprojection
maps the current pixel to the prev pixel that saw the SAME world surface point, so `x0_prev = x0_cur` in world space
→ J=1 exactly (the surface didn't move, only the camera). The Phase-2 spec's "J≠1 under camera motion" worry
conflated camera motion with prefix motion — for a static scene they're decoupled. |J|≠1 only arises with DYNAMIC
GEOMETRY (out of Phase-2 scope; the BVH-refit animation path would need it) or sub-pixel/reprojection-rounding
(negligible). Disocclusion (a genuinely different surface) is gate-rejected → fresh canonical (unbiased). So GI
temporal needs NO Jacobian work for static-scene real-time navigation; the motion-correct `x0_prev` reconstruction
is only a future need for moving GEOMETRY.

## 3. 1-spp render path

Mostly reuses existing machinery:
- `samplesPerPixel=1`, `enableAccumulation=false` → FinalWrite displays the fresh 1-spp frame (no blend) every frame.
- `_resolveSamplesPerPass` already forces S=1 when interactive + ReSTIR (PathTracer.js:467).
- `frameCount` must keep advancing for the firefly-relaxation/STBN/temporal RNG to vary frame-to-frame, but must
  NOT count toward completion (renderLimitMode='time' handles that). Decide: a free-running `frame` uniform for
  RNG/MV decorrelation, decoupled from any "samples accumulated" notion.
- Disable the spatial frame-limit gate (`_restirSpatialFrameLimit`, PathTracer.js:371) so spatial reuse stays
  always-on (the progressive-mode gate that turned it off past frame 8 is meaningless when there's no progressive
  tail to protect).

## 4. ASVGF integration + the double-temporal decision

The resolved 1-spp DI+GI color → `pathtracer:color` → ASVGF (no new plumbing). Enabling ASVGF co-enables
Variance + BilateralFilter, disables EdgeFilter; BilateralFilter's output is what the Compositor displays.

**THE design risk — double temporal reuse.** Both ReSTIR (reservoir history, motion-reprojected, M-capped) AND
ASVGF (single reprojected EMA, `maxAccumFrames` default 32) accumulate + reproject temporally. Stacking both →
excess lag/ghosting on disocclusion + over-smoothing. **Decision (principled split):** ReSTIR OWNS the temporal
estimator (it's unbiased, statistically grounded, disocclusion-gated); ASVGF is demoted to primarily SPATIAL
denoising + a SHORT temporal stabilizer. Concretely: start ASVGF with a SHORT history (`maxAccumFrames` ~6–8, not
32) and `gradientStrength=0` (it misfires on raw 1-spp); if ghosting persists, `setTemporalEnabled(false)` and lean
on BilateralFilter spatial only. This is an empirical tuning call (RT-3/RT-5), measured against ghosting on a
camera-pan and noise on a static hold.

**Mode-switch hygiene:** emit `asvgf:reset` + `_clearDenoiserTextures` on entering/leaving realtime, else stale
`asvgf:output`/`bilateralFiltering:output` shadow `pathtracer:color` in the Compositor fallback chain.

## 5. DI + GI together (lift the Phase-2 mutual exclusion)

Phase 2 ran DI XOR GI per frame (PathTracer.js:225-228) — fine for validation, but the full real-time investment
wants DIRECT via DI-ReSTIR + INDIRECT via GI-ReSTIR simultaneously. Requirements:
- Activate BOTH pools (DI 384 MB + GI 576 MB @2048²; cap at interactive-max — §6) at the `realtime` toggle (GI
  activation is not currently wired into configureForMode — only DI is, PathTracerApp.js:949-969 — add it).
- Re-check the **10-storage-buffer/stage cap**: gi-initial is the tightest at 7 SB; DI passes ≤6; they're separate
  dispatches so the cap is per-pass, not summed — should be OK, but verify each pass at build.
- ShadeKernel already gates DI (bounce-0 discrete NEE) and GI (bounce-0 continuation kill) independently — running
  both means: direct@x0 via DI-resolve, indirect@x0 via GI-resolve, both reading the same primary hit. Verify no
  double-count at the bounce-0 boundary (DI owns direct, GI owns the 1-bounce indirect — disjoint by construction).

**Incremental option:** RT can ship GI-only first (direct via the normal bounce-0 shade, indirect via GI-ReSTIR),
then add DI-ReSTIR. Recommended, to keep each increment validatable.

## 6. Perf + VRAM budget

- **Perf:** measured 10.5 ms @512² for 1-spp + full GI ReSTIR; + ASVGF ≈ 12–15 ms → ~60 fps. M=1 for headroom on
  weaker GPUs (M=2 fine at 512² on strong GPUs; gi-initial dominates — 1 closest-hit + 1 full NEE shade per
  candidate). Measure `getGpuTimePerSample()` on the target scene/GPU before committing M.
- **VRAM:** pools allocate at 2048² regardless of render res (GI 576 MB + DI 384 MB + 2×64 MB primaryHit, atop the
  ~1 GB fixed 2048² MRT baseline). **Add an interactive-max cap** (the single biggest VRAM lever): activate at
  1024² (GI 151 MB / DI 96 MB) or the actual render res. Change point = the `maxDim` arg at `activateAtMax`.

## 7. Phased implementation plan (each step independently validatable)

1. **RT-1 — reservoir persistence.** Thread reset-reason; skip `clear()` on camera-only reset (clear on
   light/material/scene). Validate: dump reservoir M before/after a camera pan — it PERSISTS (reprojects), not
   reset to canonical; image stays unbiased (converges to the same as a full clear). *Smallest, highest-leverage.*
2. **RT-2 — the `realtime` config tier.** `REALTIME_RENDER_CONFIG` + `configureForMode('realtime')` (1-spp,
   accumulation off, renderLimitMode time, GI on + pool activated at interactive-max). Validate: continuous 1-spp
   render during navigation, reservoir reprojects, no crash, framerate.
3. **RT-3 — ASVGF integration. ✅ DONE + VALIDATED.** ASVGF (temporal, maxAccum 32) + Variance + BilateralFilter
   (5×5 à-trous, demodulated) denoise the 1-spp ReSTIR GI output cleanly at **33 fps** on Sponza+20 lights, no device
   loss across a 60-step orbit, history reaches maxAccum on static hold. The two things that looked like RT-3 "bugs"
   were artifacts, not algorithm faults: (a) a **half-float readback decode** error made BilateralFilter look like a
   26000× blowup — it's actually mean 0.5, a correct weighted average; (b) a stale `edgeFiltering:output` was
   **shadowing** `bilateralFiltering:output` in the Compositor fallback chain. Fixed structurally: `RenderStage`
   declares `publishedTextures` and `disable()` drops them; EdgeFilter `setFilteringEnabled` + DenoisingManager
   `setASVGFEnabled`/`setDenoiserStrategy`/`configureASVGFForMode` route through `enable()`/`disable()`. 751/751 tests.
   **KNOWN GAP (→ RT-4):** `setRealtimeMode` is an engine override; the app store's `handleConfigureForPreview →
   configureForMode('interactive')` (appMode stays 'preview') CLOBBERS it back to accumulation+frames+ASVGF-off. Holds
   while idle but a UI re-render reverts it → realtime needs a real UI tier (4th appMode / toggle that suppresses the
   preview-configure effect) to be usable through the normal interaction path.
4. **RT-4 — DI + GI together. ✅ DONE + VALIDATED.** Lifted the exclusion (4 changes: gate removal, Shade-kill↔dispatch
   coupling, S=1 forcing, `setRealtimeMode({di:true})` tier). SB-cap rechecked — fine (Shade=10 SB binds neither pool;
   each ReSTIR pass its own dispatch). Bounce-0 ownership verified disjoint (Shade=emissive+env, DI-resolve=discrete
   direct, GI-resolve=indirect). **Unbiased vs brute-force on Sponza+lights (env=0, mb1, 256 spp deterministic
   global-mean): DI+GI +0.49% = DI(+0.07%) ⊕ GI(+0.46%) — additive, no drop, no double-count.** 751/751 tests. Details
   in [[project_restir_realtime]]. *(UI-tier wiring for the RT-3 clobber gap deferred to RT-5.)*
5. **RT-5 — perf + UI wiring. ✅ DONE + VALIDATED.** **The "CPU-bound 8fps" was a MEASUREMENT ARTIFACT — chrome-devtools-mcp
   throttles `requestAnimationFrame` to ~7 Hz (headless Chrome, intrinsic; `visible`+`focused` yet 7.7Hz).** Measured
   throttle-immune (synchronous CPU timing + sampled trace `GPUTask`): realtime DI+GI 512² ≈ **1.5-3ms CPU-encode +
   ~5.6ms GPU ≈ 75-125fps on real hardware → NO perf bottleneck.** No dispatch-batching / GI-sample work needed.
   Shipped two real items: **(a) autofocus gate** — `CameraManager.updateAutoFocus` was raycasting the full 262k-tri
   scene every frame (~5.2ms CPU); now gated on camera-moved/AF-dirty/smoothing-settled (0ms on static views, helps all
   of preview). **(b) UI-tier wiring** (the clobber fix) — a `realtimeEnabled` toggle in `usePathTracerStore`,
   `handleConfigureForPreview` forks to `setRealtimeMode(true,{di:true})`, teardown guards on final-render/results, a
   "Realtime (ReSTIR)" Switch in PathTracerTab. Validated via real UI clicks: toggle on → DI+GI tier; Preview→Render→
   Preview survives (clobber fixed) with clean production teardown; toggle off → clean interactive. 751/751 tests.
   Details in [[project_restir_realtime]] + the rAF-throttle gotcha in [[project_perf_benchmark_harness]].
   (The motion-correct GI Jacobian is NOT needed — J=1 is exact for static scenes, §2; defer to moving-GEOMETRY + GI.)

**The realtime ReSTIR phase (RT-1..RT-5) is COMPLETE.**

## 8. Risks (ranked) + open questions

1. **Double-temporal (ReSTIR + ASVGF)** — the main tuning risk (§4); mitigated by ReSTIR-owns-temporal + short
   ASVGF history; empirical.
2. ~~Fast-camera GI Jacobian~~ — NOT a risk for static-scene navigation (J=1 is exact, §2); only relevant for moving geometry.
3. **Disocclusion noise** — newly-revealed regions have no history → fresh 1-spp canonical (noisy); ASVGF spatial
   smooths; expected, bounded.
4. **VRAM** — easily capped (§6).
5. **Perf at >512²** — needs resolution-scaling/upscaling (engine has it).
- **Open:** does the realtime tier ALSO offer a "hold-to-converge" (progressive on static) for final-quality stills,
  or stay pure 1-spp? (Keeping it pure avoids re-introducing the progressive-redundancy; a separate 'production'
  click already serves stills.) Recommend: pure 1-spp realtime; production tier unchanged for stills.

## 9. Key references (file:line)
- Modes/accumulation: PathTracerApp.js:938 (configureForMode), EngineDefaults.js:473/481 (configs),
  FinalWriteKernel.js:85-99 (accumulation gate), utils.js:327 (alpha), CameraOptimizer.js (interaction mode).
- Reservoir lifecycle: PathTracerStage.js:663-665 (clear-on-reset), PathTracerApp.js:264/1385 (camera reset path),
  ReSTIRGITemporalKernel.js:191 (J=1), DenoisingManager.js:341-344 (G-buffer gating).
- ASVGF: ASVGF.js, EdgeFilter.js, BilateralFilter.js, Compositor.js, DenoisingManager.js.
- Perf/VRAM: PathTracer.js:356-399 (dispatch), :461-471 (M/S gate); ReSTIRReservoirPool.js (activateAtMax);
  restir-gi-phase02.md:96-98 (VRAM), :108-112 (pass table).
- Memory: `project_restir_gi_phase2`, `project_wavefront_resize_norebuild`, `feedback_restir_validation_protocol`.
