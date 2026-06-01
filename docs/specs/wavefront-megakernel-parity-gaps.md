# Wavefront ↔ Megakernel Parity Gaps

Audit (2026-06) comparing the wavefront kernels (HEAD) against the megakernel main loop
(`git show main:rayzee/src/TSL/PathTracerCore.js`) — the megakernel is the behavioral spec.
Shared per-lobe helpers (Disney, transmission, Subsurface, LightsSampling, Environment, Clearcoat,
EmissiveSampling) are byte-identical and used by both; gaps are in the **orchestration** that the
single mega-loop did and the kernel split dropped/changed.

**Fixed:**
- env contribution missing `regularizePathContribution` — commit `60ef717` (megakernel `PathTracerCore.js:780`).
- **Batch 1** (commit `ccb49e2`): gaps **#1** (emissive-hit MIS), **#2** (two-sided normal flip), **#3**
  (transmissiveBounces uniform), **#5** (env balance heuristic), **#14** (sheenRoughness clamp). Line-faithful
  megakernel ports; bathroom production OIDN verified clean, lint/730 tests/build green.
- **#12** (commit `ae984a7`): removed the uncompensated low-throughput hard kill — the compensated RR right
  after it already absorbs low-throughput rays unbiased (megakernel PathTracerCore.js:315).
- **#4 + #11** (commit `1b19d4b`): split the conflated bounce counter — `cameraDepth` (opaque-scatter only →
  maxBounces termination; fixes glass interiors darkening) vs `bounceIndex` = loop-iteration uniform (true path
  length → RR/firefly/giScale/MIS; fixes SSS depth freeze). Verified: production diamond render rich+clean (20
  bounces + 8 transmissive + OIDN, no darkening/blob regression); adversarial review confirmed all 24 counter
  sites correctly classified vs the megakernel; lint/730 tests/build green.
- **#6 + #9**: spare RAY_FLAG bits 16/17 carried across bounces. **#6** transparent-bg alpha: `HAS_HIT_OPAQUE`
  (bit 16) set when a ray passes the transparency-continue to the opaque shading path; alpha now **inits to 1**
  in GenerateKernel (megakernel PathTracerCore.js:554) and the miss branch zeroes it only on
  env-escape-without-opaque — so glass-over-sky exports see-through, glass-over-object stays opaque, and a ray
  dying inside geometry (SSS walk termination) stays solid. **#9** OIDN aux extend-through-specular: `AUX_LOCKED`
  (bit 17); the bounce-0 gBuffer write now stores only the primary DEPTH with a default aux, and an aux-extend
  block after the two-sided flip overwrites normal/albedo (preserving primary depth via an idempotent snorm
  read-modify-write) through mirror/glass until the first non-specular hit. Verified live: transparent-bg glass
  discrimination correct (sky transparent / ground opaque / glass-over-ground opaque); SSS object solid in
  transparent-bg; clean OIDN production diamond render (no blobs/halos/aux corruption). Adversarial review (3
  lenses: flag-persistence / megakernel-parity / gBuffer-RMW) caught the SSS alpha regression (init-1 fix
  applied + re-verified); lint/730 tests/build green. Non-transparent path provably inert (FinalWrite forces
  alpha 1; Generate `select(false,1,0)=0` matches the old init). NOTE (non-bug, both reviewers `isRealBug:false`):
  the wavefront captures primary DEPTH at bounce 0 *before* the transparency continue, so a glass/SSS primary
  stores the surface depth; the megakernel captures firstHitDistance *after* the Continue and leaves it at 1e10.
  Pre-existing (predates #9), low impact, arguably an improvement (matches the megakernel comment's stated
  intent) — left as-is.

- **#13** (uncommitted as of 2026-06-02): per-term firefly suppression. Wrapped the direct-light add in
  `regularizePathContribution` (megakernel PathTracerCore.js:1164) — it was the only raw contribution — and
  removed the cumulative catch-all that re-suppressed the running radiance (`suppress(a+b) ≠ suppress(a)+suppress(b)`
  + re-suppressed prior-bounce radiance). All 5 radiance contributions (env-miss / emissive-hit / direct-light /
  emissive-NEE light-BVH / emissive-NEE flat-CDF) are now wrapped exactly once, matching the megakernel's
  no-catch-all structure. Verified: clean production OIDN render of the Modern Bathroom + puresky HDRI (the
  known firefly/blob scene) — no blobs or firefly speckle on the white walls/ceiling/vanity; lint/730 tests/build green.

- **#7** (uncommitted as of 2026-06-02): adaptive Russian roulette restored. `handleRussianRoulette` re-added to
  `PathTracerCore.js` (adapted to take the already-computed `MaterialClassification` `mc` directly instead of the
  megakernel's classification cache), wired into ShadeKernel replacing the flat `clamp(maxThroughput,0.05,0.95)`
  test. Material-importance boosts (smooth-metal/transmissive/emissive get deeper budgets) + dynamic minBounces +
  env-direction importance + exponential depth decay; `depth = bounceIndex` (path length, gap #4); rayDirection =
  the continuation dir for env-facing importance. Subsumes the #12 compensated low-throughput kill. Unbiased
  (compensated) — terminates smarter → less noise/sample. Verified: production OIDN bathroom render clean
  (no darkening — energy conserved), preview + ASVGF render clean; lint/728 tests/build green.

**Closed by design / won't-fix (2):**
- **#8** (SKIPPED — documented limitation, user decision 2026-06-02): nested-medium coeff stack. A faithful fix
  needs per-level sigmaA + sigmaS/g in the per-ray GPU buffer (the wavefront can't keep them in registers like
  the megakernel) — +14% to +57% ray-buffer VRAM on EVERY scene to fix a depth≥2-only case (glass-in-glass,
  SSS-in-glass). Recompute-on-pop is ruled out (reading the full material every in-medium bounce tanks the common
  transmissive path). Not worth the always-on VRAM for a rare case. **Limitation:** nested/overlapping media
  (depth≥2) shade the parent with the inner medium's stale sigmaA/sigmaS/g (single non-overlapping objects
  unaffected).
- **#10** (REMOVED — the dedicated adaptive-sampling feature was deleted, user decision 2026-06-02): the wavefront
  is progressive (1 SPP/frame accumulated) and already skips converged pixels, so samples already concentrate on
  noisy pixels over frames — adaptive sampling by a different, architecture-appropriate mechanism. The megakernel's
  per-frame multi-sample loop has no wavefront equivalent without a dynamic-ray-allocation redesign for negligible
  progressive benefit. Rather than complete the half-implemented feature, it was removed cleanly: deleted
  `Stages/AdaptiveSampling.js`, `getRequiredSamples`, the GenerateKernel carry-forward skip + stream-compact-append,
  the `useAdaptiveSampling`/`adaptiveSamplingMin`/`adaptiveSamplingMax` uniforms, `ShaderBuilder.adaptiveSamplingTexNode`,
  the DenoisingManager adaptive methods, EngineDefaults/RenderSettings entries, and the app UI/store/viewport
  controls. Variance stage retained (feeds BilateralFilter/ASVGF). Generate now always traces every pixel →
  `initActiveIndices`. Verified: preview + ASVGF + production paths render clean, UI loads without the controls;
  lint/728 tests/build green. See [[project_wavefront_alpha_init]].

Verdict: all 14 numbered gaps + the env-firefly OIDN bug resolved — 12 fixed, #8 documented as a rare-case
limitation (depth≥2 nested media), #10 removed as redundant with the progressive accumulation model. emissive /
glass / imported-asset / transparent-bg / HDRI / SSS-aux / firefly / RR scenes match `main` on common content.

## HIGH

1. **Emissive-hit MIS weight dropped** (emissive-tri NEE / direct-lighting / firefly). When a BRDF/indirect ray lands on an emissive triangle the wavefront adds emission at full weight; the same emitter is also sampled by emissive-tri NEE the prior bounce → no power-heuristic balance → emissive geometry / area lights ~2× too bright + noisier on secondary bounces. `prevBouncePdf` is already in the ray buffer (used for env MIS).
   - mega `PathTracerCore.js:1117-1141` (`powerHeuristic(prevBouncePdf, calculateEmissiveLightPdf(...))`, wrapped in regularize) · wave `ShadeKernel.js:521-530` (raw add, no MIS, no regularize; `calculateEmissiveLightPdf` not imported)
   - fix: import `calculateEmissiveLightPdf`; compute `emissiveMISWeight = select(enableEmissiveTriangleSampling==1 && emissiveTriangleCount>0 && prevBouncePdf>0, powerHeuristic(prevBouncePdf, emissivePdf), 1.0)`; multiply + wrap in regularize.

2. **Two-sided shading-normal flip missing** (material-eval). Megakernel flips `N` toward the viewer when `dot(N,V)<0`; wavefront doesn't → double-sided / inward-normal imported (GLB/PBRT) meshes shade fully **black** (all NoL terms collapse). Single-sided is protected by inline back-face culling.
   - mega `PathTracerCore.js:1054-1056` · wave `ShadeKernel.js:533-606` (no flip)
   - fix: `If(dot(N,V).lessThan(0.0), () => N.assign(N.negate()))` after N finalized (~342/347) + V computed (533), before sampling/direct lighting.

3. **Transmissive-bounce budget hardcoded to 5** (transmission). GenerateKernel inits the per-ray refraction budget to literal `uint(5)`; the `transmissiveBounces` uniform is never passed to generate (production=8) → glass opaque/dark prematurely; UI slider inert.
   - mega `PathTracerCore.js:606` (`transmissiveBounces.toVar()`) · wave `GenerateKernel.js:140` (literal 5); not in buildGenerateKernel params
   - fix: pass `transmissiveBounces` into buildGenerateKernel + use it in the `writeMediumStack` init; drop the dead ShadeKernel param.

4. **Transmissive (+alpha-skip) bounces charged to camera-depth counter** (RR/termination). Megakernel marks transmission as a *free bounce* (doesn't advance `effectiveBounces`, the counter `maxBounces` gates on); wavefront increments the single per-ray counter → a window-refraction spends 2 of maxBounces before any GI bounce → glass interiors dark / lose transmitted GI.
   - mega `PathTracerCore.js:868-874,1025-1029,657-661` · wave `ShadeKernel.js:511,776`
   - fix: add a separate camera-bounce counter not advanced on free bounces; gate termination on it.

## MEDIUM

5. **Env-hit MIS uses power vs megakernel's balance heuristic** (env). Implicit env-hit weighted with power heuristic against env-IS pdf, but env NEE (shared) uses balance → inconsistent partition → energy bias on HDRI-lit glossy/rough secondary bounces.
   - mega `PathTracerCore.js:774` (`balanceHeuristic`) · wave `ShadeKernel.js:182` (`powerHeuristic`)
   - fix: use `balanceHeuristic` at ShadeKernel.js:182.

6. **transparentBackground alpha decided at bounce 0 only** (env/transmission). Eagerly sets alpha=1 on any bounce-0 hit; glass/cutout in front of camera → exports as solid opaque matte instead of see-through (PNG-alpha/compositing). Megakernel tracks `hasHitOpaqueSurface` and sets alpha=0 on env-escape at any depth.
   - mega `PathTracerCore.js:555,786-792,1006-1008,1042-1043` · wave `ShadeKernel.js:366-370,209-213`
   - fix: per-ray `hasHitOpaqueSurface` flag; defer alpha on continueRay; alpha=0 on env-escape when `!hasHitOpaqueSurface`.

7. **Adaptive RR replaced by flat throughput-max test** (RR). Wavefront uses `clamp(maxComponent(throughput),0.05,0.95)` at bounce≥3; `handleRussianRoulette` (material-importance boosts, dynamic minBounces, depth decay, emissive floor) never called. Still unbiased but different noise/convergence (terminates smooth-metal/transmissive/emissive chains earlier).
   - mega `PathTracerCore.js:1320-1332,302-450` · wave `ShadeKernel.js:757-774`
   - fix: import + call `handleRussianRoulette` (reuse the `classifyMaterial` already at ShadeKernel.js:535).

8. **Nested-medium SSS/volume coefficients not restored on exit** (SSS/transmission). sigmaA + SSS sigmaS/g are a SINGLE per-ray slot (only IOR is 3-deep); every enter overwrites, pop only decrements depth → nested media (depth≥2, e.g. SSS∩glass) shade the parent with the inner medium's stale coeffs. Single non-overlapping objects unaffected.
   - mega `PathTracerCore.js:585-597,684-697` (3-deep) · wave `PackedRayBuffer.js:26-27,294-317` + `ShadeKernel.js:237-240,431-437,480-481`
   - fix: promote sigmaA + sigmaS/g to a 3-deep stack (like IOR); write/read by depth.

9. **OIDN aux (normal/albedo) captured at primary hit only** (accumulation). Writes G-buffer unconditionally at bounce 0 with the first hit's own normal/albedo, even on mirror/glass; megakernel keeps overwriting through specular until the first non-specular hit (`auxLocked`) → degraded denoise (lost detail/halos) on glass/mirror. (Depth intentionally primary-hit on both.)
   - mega `PathTracerCore.js:563,559-561,1300-1318` · wave `ShadeKernel.js:352-364`
   - fix: per-ray `auxLocked` flag; overwrite aux normal/albedo through specular until first non-specular hit.

10. **Adaptive sampling never raises sample count for noisy pixels** (sampling). `getRequiredSamples()` used only as a `==0` skip test; a value >1 (noisy pixel) ignored; `adaptiveSamplingMax` inert. Megakernel runs up to N samples/frame on high-variance pixels. Still converges, just slower on caustics/high-freq GI.
   - mega `main PathTracer.js (TSL):~191-219` · wave `GenerateKernel.js:78-98,116`
   - fix: drive per-frame sample count from getRequiredSamples (needs variable per-pixel samples in the fixed-slot scheme).

11. **RR/firefly/giScale depth counter frozen across SSS steps** (RR/firefly). The single stored bounce counter doesn't advance on SSS surface boundaries / walk-scatter, but the megakernel loop counter does → after an SSS walk, RR depth + firefly pathLength + giScale evaluated at a lower effective depth. SSS-only; coupled to gap #4's counter rework.
   - mega `PathTracerCore.js:649` (+RR/regularize/giScale feeds) · wave `ShadeKernel.js:281,511`
   - fix: maintain a path-length counter advancing on SSS steps (separate from the camera-bounce counter).

## LOW

12. **Deterministic sub-0.001 throughput kill = darkening bias** (RR). Hard-deactivates a ray when maxThroughput<0.001 at bounce≥3, no survival prob / no compensation → true (deterministic) energy loss on deep GI tails. Megakernel handles it stochastically + compensated (unbiased).
    - mega `PathTracerCore.js:315-320` · wave `ShadeKernel.js:741-754`
    - fix: make it compensated-probabilistic (or fold into handleRussianRoulette).

13. **Per-term vs catch-all firefly suppression for direct-light + emissive-hit terms** (firefly). Megakernel wraps each contribution per-term; wavefront adds direct-light + emissive-hit raw, then soft-suppresses the whole running radiance once/bounce (and re-suppresses prior-bounce radiance). `suppress(a+b)≠suppress(a)+suppress(b)` → weaker/inconsistent clamping. (env-miss + emissive-NEE ARE per-term and match.)
    - mega `PathTracerCore.js:1138-1141,1164-1166` (per-term, no cumulative) · wave `ShadeKernel.js:609-612,521-530` raw + catch-all `721-724`
    - fix: per-term wrap the direct-light + emissive-hit adds; remove the cumulative catch-all.

14. **`sheenRoughness` not clamped before sheen sampling** (material-eval). Megakernel clamps sheenRoughness to [0.05,1.0]; wavefront clamps only base roughness/metalness → at sheenRoughness~0 the sheen lobe samples as a mirror (alpha=0) while its PDF self-clamps → sample/PDF mismatch (variance, no NaN). Uncommon (default 1.0).
    - mega `PathTracerCore.js:1060` · wave `ShadeKernel.js` opaque path (no clamp)
    - fix: `matSamples.sheenRoughness.assign(clamp(.,0.05,1.0))` alongside the roughness clamp (~334).
