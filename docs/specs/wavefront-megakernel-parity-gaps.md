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

**Remaining:** #4 (+#11 coupled — bounce-counter rework), #6 (transparent-bg alpha), #7 (adaptive RR),
#8 (nested-medium coeff stack), #9 (OIDN aux extend-through-specular), #10 (adaptive sample count),
#12 (low-throughput stochastic kill), #13 (per-term firefly suppression — #1's term now per-term).

Verdict: NOT at parity. The default interactive config (emissive-tri NEE off-focus, transmissiveBounces=5,
outward normals) masks several gaps — emissive / glass / imported-asset / transparent-bg / HDRI / SSS
scenes diverge from `main`.

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
