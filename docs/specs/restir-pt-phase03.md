# ReSTIR PT — Phase 3 (GRIS path reuse), staged plan + PT-1 spec

> **PHASE 3 COMPLETE (2026-06-13, uncommitted on `feature/restir-di`).** PT-1/2/2b/3a/3b/3c-1/3c-2 all
> implemented + GPU-validated; PT-3d + PT-4 closed by verification/audit (no new mechanism). The full
> deterministic matrix passes every bias band — final table in §"PT-3c — implementation contract".
> Three regressions found + fixed on the closing day (all in §PT-3c status): a WGSL-reserved-keyword
> struct field (`target`→`pHat`) that silently no-op'd every GI kernel; a JS-unroll Metal compile
> blow-up (→ runtime TSL Loop); and a temporal k>1 Jacobian asymmetry that drove an exponential mb4
> reuse explosion (→ same-domain merge with stored pHatOwn). 759/759 unit tests, lint 0 errors.
> Below: the original PT-1 spec + the full staging history.
>
> ---
>
> **Status: PT-1 IMPLEMENTED + GPU-VALIDATED (2026-06-11, uncommitted on `feature/restir-di`).**
> Validation matrix (512², 256 frames/arm, deterministic global-mean vs full BF at equal maxBounces,
> firefly clamp OFF both arms = threshold 1e9; protocol scene + stress scenes; no NaN, no device loss):
>
> | Scene | mb | Canonical-only | Reuse-on (temporal+spatial) |
> |---|---|---|---|
> | Sponza + 20 interior points, env=0 | 1 | −0.190% | −0.682% |
> | Sponza + 20 interior points, env=0 | 4 | **+0.033%** | −0.614% |
> | Sponza + 20 points + HDRI env | 4 | — | **−0.002%** |
> | Sponza all-emissive (23.6k tris, 9% of scene) | 1 | −0.773% | −2.192% ← documented worst case |
> | Sponza all-emissive | 4 | — | +0.810% |
>
> The mb=4 canonical +0.033% confirms the multi-bounce suffix walker is an exact replacement for BF's
> killed continuation. The emissive-mb=1 reuse −2.2% is the predicted d=1 frozen-MIS / L_o-incidence
> approximation at its worst (hit-dominated payload, maximally directional emitters); diluted at depth
> (+0.81% @mb4); PT-2's reconnection re-evaluation is the fix. Temporal engagement: maxM=21 (cap),
> meanM 15.6, 79% of participating pixels accumulating (Phase-2: 35% — the M>0 arm-gating fix stopped
> null canonicals wiping history). 752/752 unit tests, lint clean.
>
> **Implementation pitfall discovered (cost a 15× debug cycle): TSL Fn-parameter mutation does NOT
> persist across statements.** `RandomValue(state)` is a plain-JS inliner doing `state.assign(pcgHash(state))`
> — on a Fn PARAMETER each draw re-hashes the same original value ⇒ every draw identical ⇒ the WRS light
> selection froze ⇒ ~15× broad over-brightness. Fix: the walker derives a LOCAL `.toVar()` stream at entry
> (`pcgHash(rngSeed ^ const)`), hash-decorrelated from the caller's stream (which is deliberately not
> advanced by the walk). Any future Fn that draws randoms MUST copy its rng param to a local var first.
>
> **Design: VETTED.** 5 adversarial lenses (measure/Jacobian, energy partition, MIS pairing,
> Shade-parity line audit, reuse-kernel invariance) all returned sound-with-fixes; every fix is folded in
> below (see §"Adversarial findings folded in"). The core math SURVIVED: suffix Jacobian = 1 (block-
> triangular derivation in the solid-angle product measure — valid ONLY because the suffix is frozen in
> WORLD coordinates by Lo-folding; any local-frame re-parameterization, e.g. PT-3 random replay, breaks
> it), RIS with the realized noisy L_o is unbiased on the extended space (the suffix sampling density
> cancels exactly; requires the IDENTICAL stored Lo at all five touch-points and the single shared BSDF-
> eval path), giScale-once, and the M=1 canonical identity (resolve = f0·cos0·Lo·V/pdf0 = BF's
> continuation, exact because combinedPdf arrives pre-floored at MIN_PDF=0.001 from LightsIndirect.js:378).
> Phase 3 of `restir-pt-roadmap.md` §5:
> reservoirs store full paths; shift mappings + Jacobians; generalized-balance MIS; temporal+spatial path
> reuse. Built on the validated Phase-2 ReSTIR GI (`restir-gi-phase02.md`) — unbiased 1-bounce
> sample-point reuse with the cross-evaluated GRIS combine + reconnection Jacobian already in place.

## Staging (each step individually validatable)

| Step | What | New vs Phase 2 |
|---|---|---|
| **PT-1** | **Multi-bounce suffix radiance** — the reservoir sample becomes a full path with the reconnection vertex fixed at x1; `L_o` carries ALL suffix bounces (GRIS "reconnection shift" instance) | `gi-initial` candidate generation only (suffix walk). Reuse kernels/Jacobian/layout UNCHANGED |
| PT-2 | Reconnection-vertex re-evaluation — store x1's outgoing dir + material handle, re-evaluate `f_{x1}` under shifts (fixes the L_o view-dependence approximation; extends reuse to glossier x1) | Reservoir grows ~1-2 vec4; cross-target eval changes |
| PT-3 | Hybrid shift — random-replay the specular prefix, reconnect at the first *reconnectable* vertex x_k. Needs the RNG-replay primitive (roadmap Phase-0 test) + per-path seed storage | Replay loops inside temporal/spatial; reconnectability criteria (roughness+distance) |
| PT-4 | Generalized balance heuristic over hybrid-shifted paths (full GRIS Alg. 6, K>1 reservoirs) | MIS denominators evaluate shifted targets via replay |

## PT-1 — Multi-bounce suffix walk (reconnection shift at x1)

### Core idea
Phase 2's `gi-initial` traces `x0→x1` and shades x1 with **one** bounce of lighting (`L_o` = NEE@x1 +
emission@x1); the ≥2-bounce indirect is the documented truncation (`restir-gi-phase02.md` §0/§10.5).
PT-1 replaces the inline x1 shade with a **suffix walk**: continue the path from x1 with the engine's own
sampling (`calculateIndirectLighting` per vertex + RR), accumulating per-vertex lighting into `L_o` until
the camera-depth budget (`maxBounces`) is exhausted. The stored sample is then a **full path**
`(x0)→x1→x2→…→x_k` represented compactly as `(x1, n1, L_o)` — the suffix beyond x1 is folded into the
scalar radiance payload, exactly like Falcor's ReSTIR PT caches the post-reconnection suffix contribution.

**Why the reuse kernels don't change:** the shift mapping stays "reconnect my x0 to the stored x1". In the
solid-angle product measure that matches the path pdf (`pdf0·pdf1·…`), the shift moves only the x0 end of
the first segment; the suffix directions (x1→x2, …) are IDENTICAL between base and offset path, so every
suffix factor of the Jacobian is 1 and the total Jacobian remains the Phase-2 `giReconnectionJacobian`
(cos/d² ratio at x1). Temporal/spatial cross-eval (`reservoirCombineGIShifted`), the resolve, the pool
layout (3 vec4), and the M-caps are untouched. The suffix segments' visibility is part of the traced path
and remains valid under the shift (x1…x_k unchanged) — NOT an approximation; only the directional
dependence of the suffix on the x0-side (see "Approximations") is approximate.

### The suffix walker (`rayzee/src/TSL/ReSTIRPTWalk.js`, new)
One Fn, closure-built over the same buffers gi-initial already binds (+`lightStorageNode`), walking from
`(origin = x0+N0·0.001, dir = ω0, pdf0)`. Returns struct `{ x1, n1packed, Lo, hitValid }` (.wrap()'d).
Mirrors `ShadeKernel.js` per-vertex shading EXACTLY (the parity contract — each row cites the Shade anchor):

| # | Per-vertex step | ShadeKernel anchor | Walker treatment |
|---|---|---|---|
| 1 | Miss → env, MIS `balanceHeuristic(prevPdf, envPdf)` gated `useEnvMapIS` | `:179-215` | pre-x1 miss: env **candidate** (x1 = origin + ω·1e5, n1 = −ω, Lo = env·misW). Post-x1: add `throughput·env·misW` to L_o (BF-clamped, row 11), stop |
| 2 | Transparency (`handleMaterialTransparency` with `currentMediumIOR=prevIOR=1`, `pathWavelength=0`, `transTraversals = transmissiveBounces` — must be >0 or glass shades as phantom opaque) | `:409-541` | `isTransmissive`/`isSubsurface` continueRay → **TERMINATE walk** (v1, documented). `isAlphaSkip`: **post-x1** → free bounce, origin = `hitPoint + direction·0.001` (along the RAY, Shade `:524-526`), `throughput *= interaction.throughput`, depth unchanged. **Pre-x1** → continue ONLY when `alphaMode==MASK && enableAlphaShadows==1` (transport and the resolve's shadow-ray semantics provably coincide — deterministic pass at the same texel), throughput UNTOUCHED (transmittance along the reconnection edge is the resolve V's per-domain job); else TERMINATE (BLEND would double-attenuate (1−a)², MASK+shadows-off would V=0 the whole pixel) |
| 3 | Per-vertex normal pipeline — Shade's exact order | `:236,:342-367,:409,:598-602` | sample textures with the UNFLIPPED interpolated normal → `N := matSamples.normal` (perturbed, unflipped) → transparency with that N (its sign drives `entering`) → two-sided flip toward V → flipped N for emissive-NEE/direct/indirect + continuation offset. Reservoir `n1` := flipped INTERPOLATED normal (Phase-2 Jacobian convention) |
| 4 | Emissive hit, MIS `powerHeuristic(prevPdf, calculateEmissiveLightPdf(triIdx, dst, ω, segOrigin, …))` gated (JS `useEmissiveNEE`) && `enableEmissiveTriangleSampling==1 && count>0 && prevPdf>0` — never gated on `lightBVHNodeCount` (Shade's hit arm always uses the flat pdf) | `:549-590` | mirrored at EVERY vertex — **fixes the Phase-2 latent double-count**: gi-initial added x1's emission at FULL weight while Shade retains the MIS-partnered emissive-NEE@x0. Phase 2 ALSO entirely missed emissive-NEE@x1 (opposite sign — `calculateDirectLightingUnified` has no emissive term); rows 4+7 fix both together, so emissive-scene deltas vs Phase 2 are NOT a single-bug signature |
| 5 | BRDF sample: clearcoat → `sampleClearcoat`, else `generateSampledDirection` | `:653-680` | mirrored at suffix vertices AND at gi-initial's x0 candidate generation (Phase 2 ignored the branch in both places) |
| 6 | NEE `calculateDirectLightingUnified(…, bounceIndex=iter, skipDiscreteLighting=false)` | `:690-704` | mirrored (bounce≥1 NEE is never gated, even with DI on) |
| 7 | Emissive-triangle NEE: light-BVH fast path WITH the rough-diffuse skip (`bounceIndex>1 && roughness>0.9 && metalness<0.1`, post-texture-clamp values) / flat-CDF fallback (inherits the skip inside `calculateEmissiveTriangleContribution`), `calculateRayOffset` origin | `:724-824`, `EmissiveSampling.js:543-546` | mirrored INCLUDING the skip — it reproduces BF's deliberate energy loss at rough-diffuse d≥2 vertices (its hit-arm MIS partner stays < 1 with no NEE complement); do NOT be more correct than BF. Needs `lightStorageNode` → gi-initial 7→8 SB, cap 10 ✓ |
| 8 | Indirect: `getImportanceSamplingInfo(material, iter, mc)` → `calculateIndirectLighting` → `bounceDir`, `throughput *= ind.throughput`, `prevPdf := combinedPdf` | `:835-848` | mirrored. `combinedPdf` arrives pre-floored at MIN_PDF=0.001 (`LightsIndirect.js:377-378`) so Shade's `max(·,0.001)` is a no-op — store it unchanged as `prevPdf`; the RIS candidate-weight denominator likewise keeps the same floored `pdf0` (EXACT BF parity — do NOT introduce any new clamp in either place) |
| 9 | RR `handleRussianRoulette(iter, throughput, mc, bounceDir, …)` AFTER the throughput fold, BEFORE the depth check; survive → `throughput /= p`. Walker RR sees suffix-local throughput (no prefix attenuation) → longer walks than BF — unbiased (compensated), variance/cost note | `:848,:874-886` | mirrored |
| 10 | Depth bookkeeping: **init `iter=1, cameraDepth=1, throughput=vec3(1), prevPdf=pdf0` at the first segment** (`ind0.throughput` is NOT folded — the resolve supplies `f0·cos0·W`); `cameraDepth` advances ONLY on opaque scatter; shade-then-terminate at `cameraDepth == maxBounces`; `iter` advances every loop incl. free bounces and drives RR/NEE-bounceIndex/emissive-skip | `:140-143`, `:888-896` | mirrored — `Loop` bound = `maxBounces + transmissiveBounces + maxSubsurfaceSteps` (BF's full free-bounce headroom, `PathTracer.js:295`) |
| 11 | Per-term firefly clamping in BF-equivalent units | `:207-215,:580-588,:710-718,:786-794` | each added term is clamped by the SCALAR suppression factor BF would apply: `bf = ind0.throughput·gi·throughput_suffix·term`; `factor = lum(regularizePathContribution(bf, iter, …))/max(lum(bf),1e-10)`; `Lo += throughput_suffix·term·factor`. Exact for the canonical pixel (suppression is a scalar luminance multiply); source-domain under reuse (same approximation class as everything x0-side). The resolve's wrap is RELAXED to `pathLength = maxBounces` (most lenient depth factor) as a pure reuse-spike guard — without this the old `pathLength=1` wrap clamps 30-70% of above-threshold multi-bounce energy at low frame counts (suppress(a+b) ≠ suppress(a)+suppress(b), the gap-#13 lesson) |

**Deliberate walker omissions (v1, each documented + revisit in PT-2/3):**
- **Transmissive/SSS suffix vertices terminate the walk on the CONTINUING lottery arm only** — the
  (1−t)/(1−s) opaque-rolled arm falls through and shades normally, exactly matching BF's lottery. Glass/
  subsurface seen in *indirect* loses its continuing sub-paths under GI-on (BF keeps them). Replicating
  the medium stack is out of scope. Validation scene (Sponza) has neither.
- **Pre-x1 alpha terminations** (row 2): BLEND or MASK-with-alphaShadows-off on the first segment
  invalidates the candidate (BF keeps that transport) — biased-dark near cutout content in those configs;
  MASK+alphaShadows-on (the Sponza default path) is exact.
- **No displacement refinement at suffix vertices** (Shade `:317-340`) — suffix hits shade the base
  triangle. Negligible; displacement is rare.
- **No STBN at suffix vertices** — plain `RandomValue` pairs (Phase-2 precedent at x1; RNG-quality nuance,
  not bias).

### The x0 reconnectability gate — DETERMINISTIC-OPAQUE (tightened, 2 sites in lockstep)
The Shade kill fires only on the branch of `handleMaterialTransparency` that falls through to opaque
shading, so any STOCHASTIC transparency at x0 (BLEND alpha, MASK below-cutoff, transmission lottery,
subsurface entry) breaks the kill-probability-vs-inject-probability partition: MASK-skip texels got pure
phantom indirect (+1.0·E[indirect]), BLEND +(1−a), transmission t≤0.5 +t, t>0.5 −(1−t) (killed but
declined), SSS +s — a pre-existing Phase-2 bias the protocol scene never exercised. Fix — the gate is now
```
reconnectable = roughness ≥ τ
             && transmission ≤ 0.0  && subsurface ≤ 0.0
             && ( alphaMode == 0  ||  ( alphaMode == 1 && color.a ≥ (alphaTest>0 ? alphaTest : 0.5) ) )
```
(post-texture material values; the MASK cutoff mirrors `MaterialTransmission.js:547`), applied IDENTICALLY
in `ShadeKernel`'s kill and `gi-initial`'s decline. A ray reaching the kill past the transparency block
with MASK already has `a ≥ cutoff`, so the added Shade predicate only excludes the stochastic cases —
their opaque-rolled arms now continue as plain BF (no kill, no injection).

### What changes outside the walker
- `ReSTIRGIInitialKernel.js`: replace the inline x1 shade with the walker call; **M_CANDIDATES 2→1**
  (each candidate is now a full path ≈ one BF sample of cost; ReSTIR PT's canonical count is 1 — temporal/
  spatial reuse supplies the resampling power). NOTE the temporal M-cap (multiplier 20 × per-frame M)
  thereby falls 40→20 in absolute units but keeps the same ≈20-frames-of-history semantics — do NOT
  "compensate" by doubling the multiplier; outlier persistence ~doubles (variance) — re-tune empirically
  only if blotching appears. Env-miss candidate generation moves INSIDE the walker (pre-x1 miss).
- `ShadeKernel.js`: kill gate tightened to the deterministic-opaque predicate (above).
- `ReSTIRGITemporalKernel.js` / `ReSTIRGISpatialKernel.js`: **arm-engagement gates switch from
  `valid` to `M > 0`** — gating the combine on the realized sample (`valid`, i.e. pHat>0) is
  realization-dependent arm selection, biased both directions (skipping history when the canonical drew a
  null sample under-counts; letting the canonical keep m=1 when the neighbor is null over-counts), and
  M_CANDIDATES=1 doubles the null-canonical trigger rate. A null-sample arm flows correctly through
  `reservoirCombineGIShifted` (its p̂=0 zeroes its w-arm while its M still counts in the denominators).
  `M==0` reservoirs (non-reconnectable / miss pixels) still skip — M=0 encodes "pixel not participating"
  and reuse onto a non-killed pixel would double-count. Side fix: a null canonical no longer wipes the
  pixel's temporal history.
- `ReSTIRGIResolveKernel.js`: firefly wrap relaxed to `pathLength = maxBounces` (row 11).
- `ReSTIRInitialKernel.js` (DI): the emissive candidate block gains the missing
  `enableEmissiveTriangleSampling==1` gate — with DI on + the toggle off + emitters present, DI streamed
  the NEE arm while Shade's hit-MIS (and the walker's mirrored weight) assumed it off → 1+w double-count.
- `PathTracer.js _buildRestirGIKernels`: thread `lightStorageNode` + emissive uniforms
  (`enableEmissiveTriangleSampling`, `emissiveTriangleCount`, `emissiveVec4Offset`, `emissiveTotalPower`,
  `emissiveBoost`, `lightBVHNodeCount`) + `maxBounces`/`transmissiveBounces`/`maxSubsurfaceSteps` +
  `enableAlphaShadows` + `globalIlluminationIntensity`/`fireflyThreshold`/`frame` into gi-initial;
  `maxBounces` into gi-resolve.
- `globalIlluminationIntensity`: **NOT applied to L_o in the walker** (only inside the row-11 clamp
  transform, where it cancels). BF gives every depth≥1 term exactly one factor of gi (per-ADD, never
  compounded into throughput — Shade `:706`); the resolve's single multiply provides that factor for
  every L_o term. (Walker-internal giScale would square it.)

### Unbiasedness argument (adversarially verified, corrected scopes)
1. **RIS with a path-valued sample + realized noisy L_o:** unbiased on the extended space
   y = (ω0, ω1, …, u_aux); the auxiliary suffix density q(u|ω0) cancels in the WRS expectation, leaving
   exactly ∫f0·cos0·L_o dω0. REQUIRES: the identical stored Lo at all five touch-points (adoption-p̂,
   finalize, cross-targets, resolve) and one shared BSDF-eval path (`evaluateMaterialResponse` ≡
   `evaluateMaterialResponseFromDots∘computeDotProducts`). Support: `p̂=0` ⇔ contribution=0. ✓
2. **Canonical M=1 identity:** W = 1/pdf0 → resolve adds `f0·cos0·L_o·V/pdf0` = BF's continuation
   estimator exactly (combinedPdf pre-floored at MIN_PDF both places). **V≡1 holds only when x1 is the
   closest hit on the own-pixel edge** — hence the pre-x1 alpha rules in row 2. Reuse arms re-trace the
   edge with NEE shadow-ray semantics (straight-line fractional transmittance through glass that BF's
   refracting transport never had) — pre-existing Phase-2 spatial behavior, glass-free on protocol scenes.
3. **Energy partition:** the deterministic-opaque gate (above) makes the killed set and the injected set
   coincide exactly; the walker replicates every continuation route except the documented terminations.
   giScale once at resolve.
4. **Suffix Jacobian = 1** — block-triangular in the solid-angle product measure; valid only under
   world-space suffix freezing (Lo-folding). The x0-side conversion factor at x1 is the entire Jacobian
   (= Phase-2 `giReconnectionJacobian`).
5. **Shift-invariance scopes (corrected):** suffix MIS is exactly shift-invariant only for **d≥3**.
   All x1-anchored quantities are frozen source-domain in Lo: f_{x1} (the first suffix segment's BSDF),
   pdf@x1 (the d=2 env/emissive MIS prevPdf, the misWeight folded into segment throughput, RR@x1), and
   the d=1 emissive-hit MIS pdf0. The pdf0 bake is bounded by the x0 τ gate (both domains' x0 pass τ);
   the **x1-lobe terms are bounded only by shift-angle × x1 lobe width — NO x1-side roughness gate
   exists** (a mirror at x1 behind a diffuse x0 passes every gate with unbounded view-dependence error;
   same un-gated approximation as Phase 2/Ouyang, now multiplying the whole suffix). PT-2 must re-derive
   BOTH f_{x1} AND the x1 pdfs under the shifted incidence (storing x1's outgoing dir + material handle
   suffices), not just f_{x1}.

### Validation (protocol: `feedback_restir_validation_protocol`)
PT-1 makes the reference **full BF at equal maxBounces** (no more bounce-depth-matched truncation).
Firefly clamp OFF both arms = a very large `fireflyThreshold` (NOT 0 — `applySoftSuppression` at
threshold 0 zeroes everything).
1. **mb=1 FIRST** — must reproduce Phase-2 (≈+0.4%): pins walker init (iter/cameraDepth/throughput),
   the no-ind0.throughput-fold rule, and gate parity in one shot. Then **mb=4** (target ≤ ~1.5%).
   Sponza + 20 interior point lights, env=0, deterministic global-mean + per-pixel RMSE.
2. Same scene, procedural-sky env-on, mb=4 (env-suffix MIS path).
2b. **Emissive-mesh scene** (emissive quads inside the Sponza bbox, env=0) at mb=1 AND mb=4 — exercises
   the d=1 emissive-hit MIS fix, emissive-NEE@x1, and the rough-diffuse skip mirror; no current protocol
   scene covers any of these (how the Phase-2 bug shipped).
3. Reuse on (temporal+spatial): unbiasedness preserved (delta vs reuse-off ≈ 0), M engages
   (note the absolute cap halves with M=1; the frames-of-history semantics is unchanged).
4. Watchdog/perf: gi-initial cost at 1024²·mb4 ≈ one extra path/pixel (megakernel-style walk —
   the pre-wavefront engine ran exactly this shape in production). Measure; no device loss.
5. Someday-scenes for the documented approximations: glossy-x1 (view-dependence magnitude),
   clearcoat-x0, foliage-heavy cutout (pre-x1 alpha terminations), glass-in-indirect.

## PT-2 — Reconnection-vertex re-evaluation (IMPLEMENTED + GPU-VALIDATED 2026-06-11, uncommitted)

> **Results** (512², 256 frames, deterministic global-mean vs full BF, clamp off both arms):
>
> | Scene | mb | PT-1 → PT-2 canonical | PT-1 → PT-2 reuse-on |
> |---|---|---|---|
> | protocol (20 points, env=0) | 1 | −0.190% → **−0.063%** | −0.682% → **−0.559%** |
> | protocol | 4 | +0.033% → **+0.033%** (identical) | −0.614% → −0.615% |
> | all-emissive (23.6k tris) | 1 | −0.773% → **−0.773%** (identical) | −2.192% → −2.086% (temporal-only −1.574%) |
>
> The canonical identities matching PT-1 EXACTLY (at mb=1 where B=0 and at mb=4 where B fully engages)
> prove the A + E·misW + f1·B factorization and the eval-after-store canonicalization are implemented
> correctly. **Diagnosis of the remaining reuse residual:** the per-domain re-derivation only moved
> ~0.1pp ⇒ the dominant carrier is NOT the frozen payload weights but the **temporal x0-collapse**:
> the history arm's W was normalized against p̂(x0_prev) (prev frame's sub-pixel-jittered exact hit)
> while the v1 combine evaluates p̂(x0_cur) with J=1 — close-emitter scenes amplify the mismatch
> quadratically (powerHeuristic) and via lightPdf's d²/cosθ. PT-2's durable value: the reconnection data
> (ω1out + material handle + split payload) is the PT-3 hybrid-shift prerequisite; glossy-x1 reuse now
> re-evaluates f1 under the correct incidence; evaluateCombinedLobePdf is the PT-4 prerequisite.
> 753/753 tests, lint clean, no NaN, no device loss.

## PT-2b — Motion-correct temporal (IMPLEMENTED + GPU-VALIDATED 2026-06-11, uncommitted)

> The x0-collapse fix: the GI primaryHit buffer ping-pongs (2 slots/pixel, parity-strided —
> `GI_PRIMARY_HIT_SLOTS`, `giPrimaryHitIndex`; capture writes at the CURRENT parity), and gi-temporal
> evaluates the history arm's own-domain cross-target at the TRUE previous-frame jittered x0 with the
> real per-arm reconnection Jacobians (cur→prev for denomC, prev→cur for denomS + wS). Prev surface
> reconstruction: x0_prev from the ping-ponged buffer, N_prev from the history normalDepth (already
> decoded for the disocclusion gate), material = the CURRENT pixel's rebuild (same world surface under
> the gate), V_prev = current camera (a prev-camera uniform is a documented refinement — exact in the
> static-camera validation regime; V only enters the BSDF's second-order terms, not the geometric pdfs
> this fixes). DI's primaryHit stays stride-1.
>
> **Results** (same protocol; reuse-on vs full BF):
>
> | Scene | mb | PT-2 | PT-2b |
> |---|---|---|---|
> | protocol (20 points, env=0) | 1 | −0.559% | **−0.172%** |
> | protocol | 4 | −0.615% | **−0.495%** |
> | all-emissive worst case | 1 | −2.086% | **−1.226%** (temporal-only **−0.714%** ≈ canonical −0.773%) |
>
> The temporal carrier is ELIMINATED (temporal-only sits at the canonical level). The remaining
> ~−0.45pp on the emissive worst case is the spatial fold's residual (frozen NEE@x1 realization +
> incidence shift on the A bucket over the spatial radius — the documented approximation classes the
> hybrid shift / NEE re-evaluation address later). 753/753 tests, lint clean, no NaN, no device loss.

### Design (option (a), 4-lens adversarial pass folded in)

### Problem (measured) + the partition argument
Under reuse, everything x1-anchored inside the stored L_o is frozen source-domain. The adversarial pass
PROVED the decomposition (extended-space derivation, confirmed): W is a UCW w.r.t. dω0 × q_src (the
realized suffix sampling density — combinedPdf per vertex × RR × lottery probs — frozen WITH the sample).
Hence: frozen RR@x1 and ALL frozen d≥2 MIS pairs are **exactly unbiased** (both arms frozen together,
weights sum to 1); frozen `combinedPdf1_src` in B is **required** (it is the measure — re-evaluating it
would need PT-3's replay Jacobian); the only genuinely biased frozen pieces are (i) the **d=1
emissive-hit / env MIS weights** — their complementary arm (emissive-NEE@x0 / env-NEE@x0) runs LIVE at
the domain pixel, so the pair no longer partitions unity: a direct energy error, the dominant share of
the measured −2.2% all-emissive mb=1 — and (ii) the **integrand factors** f_{x1}(V1_src) in A's NEE@x1
and on the suffix (second-order; diluted at depth, matching +0.81% @mb4). At mb=1 the B bucket is EMPTY
(every walk ends at x1), so re-evaluating f1·B alone provably cannot touch the worst case ⇒ **option (a)
adopted**: a dedicated E lane + per-domain MIS re-weight.

### Reservoir layout: 3 → 6 vec4 (stride 9 → 18, `ReSTIRLayout.GI_VEC4S_PER_SLOT`)
```
core   = vec4( wSum, W, M, pHatOwn )                       (unchanged)
sample = vec4( x1.xyz, octEncodeNormal(n1) )               // n1 now stored UNFLIPPED (see below);
                                                           // 12-bit oct OK — Jacobian-only consumer
radiA  = vec4( A.rgb, validFlag )                          // frozen d=1 terms: NEE@x1 (+ everything,
                                                           // for non-factorizable x1)
suffix = vec4( B.rgb, ω1oct.x )                            // B = throughputNoF1 · L_suffix (no f_{x1});
                                                           // 0 when walk ended at x1
recon  = vec4( matIdx1, uv1.x, uv1.y, ω1oct.y )            // ω1out across TWO full-f32 oct lanes —
                                                           // 12-bit oct has ~0.02-0.1° error ≈ the GGX
                                                           // lobe width at roughness 0.05 → O(1) f1
                                                           // error exactly on the glossy-x1 target
E      = vec4( Le.rgb, triIdx1 )                           // d=1 emissive-hit: UNWEIGHTED Le + triangle
                                                           // index (lightPdf must be RE-DERIVED per
                                                           // domain — the stored scalar bakes d_src²/cosθ_src)
```
`matIdx1` sentinels: **−1 = env candidate** (E = (envColor.rgb, envPdf-scalar in triIdx1 lane); B=0; the
re-weight routes to `balanceHeuristic`), **−2 = non-factorizable x1** (clearcoat>0 — `evaluateMaterialResponse`
has no clearcoat lobe and strategies 1/4 fold `evaluateLayeredBRDF`; or the LightsIndirect validInput
fallback whose throughput = bare albedo with combinedPdf left at 0): everything frozen into A, B=0, E=0 —
graceful degradation to exact PT-1 semantics. ≥0 = factorizable surface. matIdx as float is exact to 2²⁴;
triIdx1 likewise (24-bit mantissa; emissive scenes are ≪ 16.7M tris).
VRAM: 2× PT-1 — 302 MB @1024² pool, 1.2 GB @2048² (refresh the stale pool/app comments). DI pool
untouched (parameterized by vec4sPerSlot — verified).

### New engine plumbing (prerequisites, both PT-4-reusable)
1. **`evaluateCombinedLobePdf(V, N, material, dir, samplingInfo)`** — factor LightsIndirect.js:337-378
   verbatim into an exported evaluator (deterministic, no draws; includes the MIN_PDF floor). The 2-lobe
   `calculateMaterialPDF` is DISQUALIFIED for the re-weight: its weights are diffuse=(1−m)(1−t)/spec=1−(1−m)²(1−t)
   ⇒ ZERO specular weight at every dielectric x0, ratio errors 1e-4..+56% per term — worse than the −2.2%
   being fixed (the Phase-2 +5.75% kind-mismatch class).
2. **`throughputNoF` float on `IndirectLightingResult`** = cosineWeight·misWeight/samplePdf, assigned
   IN-BRANCH (the strategy-dependent |cos|-vs-max(cos,0) select and the fallback branch are not
   reconstructible from existing fields; never divide throughput by f1 — zero albedo channels NaN).
   Fallback branch ⇒ non-factorizable sentinel.

### The evaluation function (ONE shared helper, used at ALL touch-points)
```
evalLo(domain x0d, V0d at x0d, stored r):
  if matIdx1 == −2 or (B==0 and E==0): return A                          // PT-1 semantics
  ωd  = normalize( x1 − (x0d + N0d·0.001) )                              // the domain reconnection dir
  if dot(n1_geo_consistent, …) hemisphere gate: if dot toward x0d ≤ 0 → return 0  // backside-domain leak:
                                                           // floored dots make f1 nonzero through the
                                                           // surface; apply IDENTICALLY everywhere (p̂=0
                                                           // ⇔ contribution=0 support consistency)
  pdf0d = evaluateCombinedLobePdf( V0d, N0d, mat0d, ωd, samplingInfo0d )  // multi-lobe, MIN_PDF floor
  if matIdx1 == −1:  Eterm = Le · balanceHeuristic( pdf0d, envPdf_stored )
  else:              Eterm = Le · powerHeuristic( pdf0d, calculateEmissiveLightPdf( triIdx1, |x1−x0d|,
                                                          ωd, x0d_offset, … ) )   // BOTH args per-domain
  f1   = 0; if matIdx1 ≥ 0 and lum(B) > 0:
      mat1 = rebuild(matIdx1, uv1) — getMaterial + sampleAllMaterialTextures( …, uv1, n1_UNFLIPPED ) + clamps
      N1   = flip( matSamples1.normal toward V1d = −ωd )                 // the walker's exact order:
                                                           // perturb the UNFLIPPED interpolated normal,
                                                           // THEN flip the perturbed result toward the
                                                           // DOMAIN's V1 (perturb(−n) ≠ −perturb(n))
      f1 = evaluateMaterialResponse( V1d, octDecode2(ω1out), N1, mat1 )
  return A + Eterm + f1·B
```
- **n1 stored UNFLIPPED** — free: the only existing consumer is the Jacobian (abs(dot) — flip-invariant);
  the rebuild NEEDS the unflipped interpolated normal as its perturbation basis.
- **Eval-after-store canonicalization:** gi-initial computes its adoption-p̂/finalize through THIS SAME
  function on the stored (quantized, rebuilt) representation — not the walker's in-register exact values —
  else W is normalized against a target the combine/resolve never reproduce (Eq. 8 violation).
  The canonical-equivalence gate is therefore STATISTICAL (match PT-1's +0.033%/−0.19% within noise).
- **Hoisting:** the mat1 rebuild is domain-independent — per SAMPLE, not per p̂: temporal = 2 rebuilds +
  2 evals/pixel; spatial = 2 rebuilds + 4 evals per fold (running canonical re-rebuilds on adoption);
  resolve = 1+1 placed AFTER the visibility early-outs. SB budget: temporal/spatial need `triangleBuffer`
  (+1 SB → 6) + `materialBuffer`/map arrays (already bound) + emissive uniforms (0 SB) — cap 10 ✓.

### Walker changes
Two accumulators (A; B with the NoF discipline) + E capture: at the d=1 emissive hit store UNWEIGHTED Le
+ triIdx (the canonical weight re-derives through evalLo); at a pre-x1 env miss store envColor + envPdf
(matIdx=−1). B-bucket: at x1's fold multiply by `ind1.throughputNoF`; every later throughput mutation
mirrors into the NoF accumulator (alpha-skip mul, indirect folds, RR div — missing one is silent bias).
addTerm's firefly transform keeps using the FULL (with-f1) BF units for the clamp factor. Clearcoat-x1 /
fallback ⇒ matIdx=−2 freeze-all. d=1 emissive-hit when enableEmissiveTriangleSampling is OFF: full-weight
Le is CORRECT and there is no live NEE partner — fold it into A frozen (E only when the toggle is on).

### Order-of-work + validation gates
0. (cheap, FIRST) **K=0 falsification** on the current PT-1 build: all-emissive mb=1 with spatial K=0
   (temporal-only) — static camera ⇒ V1d≈V1src ⇒ if −2.2% collapses to ≈ canonical −0.77%, the spatial
   fold is confirmed as the carrier (and temporal-only realtime tiers are already clean).
1. evaluateCombinedLobePdf + throughputNoF (engine, additive).
2. Layout 3→6 + core Fns (pack/unpack signature CHANGES so stale sites fail at build) + the
   field-roundtrip unit test (20 sentinel values through every reservoir-constructing Fn) + stride-test
   literals 6/18.
3. Walker restructure; 4. evalLo helper + gi-initial canonicalization; 5. temporal/spatial/resolve.
6. Gates: (i) canonical-equivalence vs PT-1 (+0.033%/−0.19% statistical); (ii) all-emissive mb=1
   reuse-on — target: −2.2% → toward −0.77%; (iii) emissive mb=4 (watch sign — the +0.81% may move);
   (iv) glossy-x1 scene (metallic floor; expect PARTIAL improvement — NEE@x1's frozen f is documented
   residual); (v) env-only mb=1 (decides whether the env E-arm re-weight ships or stays frozen);
   (vi) perf A/B per the harness (reuse-off / K=0 / K=3; ≤10% frame-time regression budget) + VRAM check.

## PT-3 — Hybrid shift (VETTED 2026-06-12 — 3-lens adversarial pass folded in; draft verdicts:
## shift-math sound-with-fixes, replay-parity FLAWED→fixed, arch-cost FLAWED→fixed)

> **STATUS: PT-3a + PT-3b + PT-3c-1 + PT-3c-2 IMPLEMENTED + GPU-VALIDATED (2026-06-13, uncommitted);
> PT-3d + PT-4 CLOSED by verification/audit (no new mechanism — see §PT-3d, §PT-4). The full
> deterministic matrix (bfdet/protocol4/glossy4/emissive) PASSES all bias bands after the temporal
> k>1 same-domain-merge fix — see the table in §PT-3c status. PHASE 3 COMPLETE.**
> PT-3a: stride 21 prefix lane (pre-xi0 seed 16/16, kPrefix≡1), WRS adoption-rand hoist, determinism
> probe PASSED (bit-identical pools — the Phase-0 replay primitive proven). PT-3b: glossy-x0 widening
> (participation = deterministic-opaque AND (roughness≥τ OR mb≥2)); glossy candidates canonical-only via
> the nonReusable bit; target-0 T(y)=⊥ at the reuse call sites. **Also fixed en route: the validation
> harness's broken BF-vs-BF determinism** (early-exit + dynamic-dispatch async-readback timing + the
> cameraOptimizer wall-clock window — 3 mandatory harness settings now in the protocol memory; BF-vs-BF
> and GI-vs-GI re-verified bit-identical via the new puppeteer-core runner). Deterministic baselines:
> protocol mb1 canonical −0.301%/reuse −0.713%, mb4 −0.436%/−0.969%; glossy-Sponza mb4 canonical
> −0.445% (the new coverage is unbiased)/reuse −0.979%; emissive mb1 reuse −2.022%. The ~−0.4% canonical
> floor = the documented walker alpha-termination omission, honestly visible now that BF keeps the
> late-bounce foliage transport the old early-exit dropped.

### Settled by the skeptics (supersedes the draft text below where they conflict)
1. **Measure form (open point 1 SETTLED, with equivalence proof):** the shifted target uses the
   **PSS-prefix form** — replayed segments 0..k−2 carry `f·cos/p^domain` INSIDE the target (pdfs
   re-realized at the domain), the reconnection segment x_{k−1}→x_k stays solid-angle (no /p in the
   target), J = 1 × giReconnectionJacobian. Proven numerically identical to the orthodox solid-angle
   random-replay form (w_S equal), and the k=1 degenerate reduces EXACTLY to the shipped convention
   (pdf0 moves from the RIS weight into the target precisely when bounce 0 changes role from
   reconnection segment to replayed segment). THREE lockstep changes required: (i) the k>1 RIS
   candidate-weight denominator becomes p_{k−1} (the reconnection-segment scatter pdf), not pdf0;
   (ii) gi-initial's finalize-p̂ includes the prefix product (eval-after-store generalized);
   (iii) **the RESOLVE replays the prefix for k>1** (one replay/pixel — count it) and re-anchors the
   visibility ray at x'_{k−1}↔x_k. The prefix product is NEVER folded frozen into A/B/Le for reusable
   candidates (W is a scalar — it cannot carry the RGB prefix factor; freezing it is measure-mixing).
2. **Stratum preservation (the hybrid-shift invertibility condition):** shift validity requires, at
   EVERY replayed prefix pair (x'_{j−1}, x'_j), j<k, that reconnectability is NOT satisfied — an
   early-reconnectable hit ⇒ shift invalid ⇒ p̂=0 (same value in the w-arm AND the m-denominators,
   both from the same replay). Without it the Eq. 11 partition leaks energy both directions.
3. **Prefix RR — scheme (B):** the GENERATION walker disables RR until the first reconnectable vertex
   is found (prefix p_surv ≡ 1) ⇒ "no RR in replay" becomes exactly correct. Energy-neutral,
   variance-only deviation from the Shade-parity row 9 (documented); cost bounded by the k≤4 cap.
4. **Draw parity — NO forking, NO consumption (the draft's both options solved a non-problem):** under
   the measured frozen-Fn-param semantics, interior draws (transparency lottery, NEE, RR,
   generateSampledDirection internals) NEVER advance the stored chain — the only chain advances are
   gi-initial's xi0 pair and the walker's per-OPAQUE-vertex xi pair. Replay alignment is STRUCTURAL;
   k=1 stays bit-identical to the shipped walker. (If NEE draws ever move to walker scope — a separate
   BF-wide change — forking keyed on the opaque-vertex ordinal becomes mandatory then.)
5. **Seed = the per-candidate PRE-xi0 snapshot** (gi-initial's rngState value before the xi0 draws —
   the walker stream alone cannot replay the x0 scatter, and pcgHash is not invertible). Captured in
   kernel scope, split 16/16 into two f32 lanes BEFORE any float-struct crossing, rides the WRS as
   cand fields (loop-end capture would store the losing candidate's seed), reassembled integrally
   (`(u32(hi)<<16)|u32(lo)` — float arithmetic is inexact). Replay re-runs gi-initial's exact draw
   sequence at the domain x0, then re-derives the walker stream as pcgHash(S'_call ^ 0x517cc1b7).
6. **k-selection must not shrink PT-2 coverage:** τ₁/d_min only PREFER a deeper anchor while bounce
   budget remains; at the last shaded vertex fall back to PT-2's k=1-at-x1 semantics (glossy x1 stays
   absorbed by the f1 re-evaluation). Realtime tier (mb=1): k≡1 structurally; tie the τ→0 gate
   widening to mb≥2; compile replay-free temporal/spatial variants keyed on the tier toggle.
7. **validFlip codec** gains the non-reusable bit as +4: {0 invalid; 1 front; 3 back; 5 front-nonreusable;
   7 back-nonreusable}; `giFlipBit := validFlip.mod(4) > 2`; `giIsReusable := validFlip < 4`;
   giIsValid stays ≥1. (A bare +4 would make 5/7 read as back-face through the current >2 decode.)
8. **Non-reusable / shift-failure semantics = target-0 AT THE CALL SITES** (folds always run M-gated;
   pass 0 for the foreign-domain cross-targets) — fold-skipping conditions an arm's UCW on its
   realization, the exact valid→M bug class. evalLo cannot implement this (it doesn't know the domain
   is foreign); also evalLo's E re-weight must take the BOUNCE INDEX of the reconnection-edge origin
   (currently hardcoded int(0)) — k−1 under reanchoring.
9. **PT-3b ships as x1-anchored FREEZE-ALL** (k>1 candidates keep sample=(x1,n1), whole path frozen
   into A at realized weights — unbiased by the PT-1 extended-space argument, V-trace stays valid,
   resolve untouched); reanchoring at x_k + replay land together in PT-3c (incl. the resolve replay).
   Gate widening enlarges the walker-omission surface (mirror-reflecting-glass/foliage now routes
   through walker terminations) — add a glass-behind-mirror scene; needs explicit sign-off.
10. **WRS adoption rands are a LIVE pre-existing issue** (frozen Fn-param draws: the combine's adoption
   rand ≡ caller-snapshot>>8, correlated with spatial's θ draw / the candidate's own direction draw —
   plausibly part of the residual −0.5pp): hoist the adoption rand to KERNEL scope and pass it as a
   plain float param to giReservoirUpdate/reservoirCombineGIShifted. Do this in PT-3a and re-run the
   PT-2b validation matrix (realizations change).
11. **Cost truth:** temporal up to 3 replays/pixel (own-domain p̂ cache in the spare lane — rewritten on
   every adoption — brings it to 2), spatial up to 12/pixel at K=3 (cache canonical@Q across folds
   until adoption; implement the replay as ONE shared TSL Fn, never a JS-closure stamped per site);
   resolve +1. Perf gate (reuse-off/K=0/K=3, ≤10%) at PT-3c entry with k capped at 2 first.
12. **PT-3a determinism probe:** two-dispatch bit-compare needs rng-buffer snapshot/restore (gi-initial
   advances it); ALSO dump one interior draw (e.g. calculateIndirectLighting's selectionRand) to a
   debug lane to settle frozen-vs-advancing callee semantics empirically.
13. Layout: stride 18→21, prefix = vec4(seedLo, seedHi, kPrefix, prefixPHatCache). Mechanics verified a
   3-file change (Core/Layout/tests — write/read helpers are the only pool I/O). Footguns: TSL struct
   constructors zero-fill missing fields SILENTLY (a forgotten seed select in the combine replays a
   DIFFERENT path — wrong-path MIS, no crash); gi-initial's GPU-side candidate constructor is not
   covered by node tests — explicit checklist item. Test-first: extend the roundtrip tripwire to 28
   lanes BEFORE bumping the constant.

### PT-3c — implementation contract (staged 3c-1 / 3c-2; derived from the vetted list + the chain-value analysis)

> **STATUS: 3c-1 DONE + GPU-VALIDATED (2026-06-12); 3c-2 DONE, regression root-caused + fixed
> (2026-06-13). All uncommitted on `feature/restir-di`.**
>
> **3c-1 gates (deterministic, 256f):** BF bit-identical (3.714708728117378); protocol mb1 canonical
> −0.356% / reuse −0.804%, mb4 −0.507% / −1.091%; glossy mb4 canonical −0.509% / reuse −1.091%
> (true deeper anchors live — walker k-selection, ReSTIRGIReplay.js PSS prefix replay, resolve
> re-anchored V, RIS denominator p_{k−1}).
>
> **3c-2 regression post-mortem (the −21.755%):** `GIReplayTargetResult` — the shared k>1 target
> struct in `ReSTIRGIReplay.js` — had a field named `target`, a **WGSL reserved keyword**. TSL emits
> struct field names verbatim ⇒ Dawn rejected the shader module (visible ONLY via
> `device.uncapturederror` — not console, not unit tests) ⇒ every kernel compiling that struct
> (gi-initial, gi-temporal, gi-spatial) got an invalid pipeline whose dispatches **silently no-op** ⇒
> the GI pool stayed all-zero (88M floats, 0 nonzero, M=0) ⇒ gi-resolve `Return()`'d every pixel while
> ShadeKernel's bounce-0 kill still fired ⇒ the entire re-injected 1-bounce GI term dropped — exactly
> −21.755%, identical reuse on/off. The k=1 math was never wrong. Fix: field renamed `target`→`pHat`
> (9 call sites). **Second bug this unmasked:** gi-spatial's K-neighbor fold was a JS-level `for`
> unroll (3× stamping of 4 replay-target call sites) → ~61s Metal pipeline compile → GPU-process
> watchdog **device loss** on the first reuse frame; converted to a runtime TSL `Loop` (body emitted
> once, identical semantics/RNG order) → 27.6s compile, device survives. Kernel compiles: initial
> 2.8s / temporal 4.4s / spatial 27.6s / resolve 0.7s.
>
> **Post-fix gate (bfdet): PASSES** — bfA 3.714708728117378 bit-exact, BF+GI deterministic, protocol
> mb1 canonical −0.356% / reuse −0.804% — **bit-match to the 3c-1 baselines** (k≡1 untouched as
> designed).
>
> **Third bug (2026-06-13, found by the post-fix matrix): temporal k>1 Jacobian asymmetry —
> exponential mb4 reuse blow-up (+294,482% protocol4 / +5,447,528% glossy4).** Canonical arms were
> bit-clean; the explosion lived ONLY in the temporal chain. Per-frame pixel tracing showed a k=2
> reservoir whose survivor pHatOwn stayed BIT-FROZEN for 70+ frames while wSum compounded ×1.5+/frame
> to 1e13 — proof that (a) this app's primary rays are NOT jittered (per-pixel P/N/V/material are
> frame-constants for a static camera; the same-pixel replay is bit-identical every frame), and
> (b) the amplifier is deterministic, not stochastic. Mechanism: the history arm evaluated the SAME
> sample at the SAME world surface through two DIFFERENT reconstructions — exact G-buffer N/material
> at Q vs **quantized prevNormalDepth Nprev + current-frame material at Q′**. A glossy (k>1) replay
> amplifies that input difference into macroscopically different terminal vertices ⇒ a CONSTANT
> per-pixel Jacobian asymmetry jacS≠1. Combine algebra: wS = wSum·jacS·cS/(cS+cC·jacS) — for
> cS/cC=20, ANY constant jacS > 20/19 ≈ 1.053 makes the per-frame multiplier exceed 1 ⇒ exponential
> wSum growth, self-locking once takeS streaks (p → 1 as wS grows). k≤1 arms are immune (Jacobian
> endpoints are the x0 offsets — quantization enters at 1e-6, not through a scatter chain).
> **Fix (ReSTIRGITemporalKernel.js): k>1 temporal arms are a SAME-DOMAIN merge** (the disocclusion
> gate already asserts same world surface): ONE replay at the CURRENT exact domain per arm; the
> history arm's own-domain target = the STORED pHatOwn (the exact value W was normalized against —
> Eq. 8 pairing; capM preserves the lane); Jacobian endpoints stay at the x0 offsets (≈1 static, the
> k≤1-smooth class under motion). Bound: wS ≤ wSum_s·cS/cC always; fixed-point multiplier 20/21 —
> stable. Spatial k>1 needs NO change (same-frame exact rebuilds ⇒ fresh own-domain eval ≡ stored ⇒
> the pairing holds natively). Regression tests: restirGI.test.js §PT-3c-2 (bounded-wS for any
> target/Jacobian magnitudes under the Eq. 8 pairing + the unbounded counterexample).
>
> **FINAL deterministic matrix (2026-06-13, post-fix, 256f/arm, firefly clamp OFF both arms): ALL
> GATES PASS.**
>
> | Plan | BF | Canonical | Reuse | Band |
> |---|---|---|---|---|
> | bfdet (protocol mb1) | 3.714708728117378 bit-exact, BF+GI deterministic | −0.356% ✅ | −0.804% ✅ | exact / <1.0 / <1.5 |
> | protocol4 (mb4) | 4.047686730516657 | −0.507% ✅ | −1.098% ✅ | <1.0 / <1.5 |
> | glossy4 (mb4, mats 0/3/7 metal .9 rough .08) | 4.0395050039329155 | −0.509% ✅ | −1.127% ✅ | <1.0 / <1.5 |
> | emissive (mb1, 23.6k tris) | 0.28372655637080824 | — | −2.807% ✅ | <3.0 (documented worst case) |
>
> 759/759 unit tests (restirGI 21/21), lint 0 errors.
>
> **k>1 temporal validity — adversarial review (2026-06-13, 4-lens skeptic panel, verdict
> "ship it, unbiased for the validated regime").** The panel confirmed the fix kills the explosion and
> that the −0.5pp reuse delta is the documented canonical walker floor (it appears IDENTICALLY in the
> structurally-different spatial kernel ⇒ a shared-evaluator property, not a temporal-merge bias), NOT
> a new darkening bias. Two lenses initially called it "biased" on a supposed canonical cross-term
> asymmetry — overreach: the fix is internally SYMMETRIC (both arms use one fresh current-domain replay
> + a same-domain assertion for the prev-domain target; canonical `pHatCanonAtQprime=tQ.pHat` @ ~257,
> history `pHatShiftAtQprime=stored pHatOwn` @ ~283). The genuine residual is the APPROXIMATION's
> accuracy outside the validated regime, recorded here as caveats — ALL scoped to **static / near-static
> camera, ~97% k≤1 pixels** (the validation regime; only ~340/119000 pixels are k>1):
>   1. **`:257`** canonical k>1 prev-domain target reuses the current-domain replay (same-domain
>      collapse) — exact only when the prev-domain canonical target equals the current; the spatial
>      kernel does two distinct replays (cur+prev) because its rebuilds are same-frame exact.
>   2. **`:283`** history k>1 own-domain target = stored pHatOwn, but applied against the QUANTIZED
>      prevN (12-bit oct) vs the unquantized capture normal — a small cross-domain mismatch on glossy
>      prefixes, masked by J≈1.
>   3. **`:~290` (endpoints x0curOff/x0prevOff)** k>1 Jacobian uses x0 offsets, not the replay terminals
>      x'_{k−1}; primary rays ARE frame-jittered (stratified seed includes frame index) so J is ≈1, not
>      LITERALLY 1 — fine for the smooth surface class, sub-pixel glossy amplification unmodeled.
>      [the original spec claim of terminal-vertex endpoints applies to the SPATIAL kernel only.]
>   4. **`:205-207`** V_prev uses the CURRENT camera (already self-documented static-only).
> **Validation gap to close before any moving-camera release:** a camera-motion sequence + a
> glossy-dense scene (metal ≥.9 rough ≥.08 filling the frame, k>1 ≫ 0.3% of pixels). If reuse stays
> ≤−0.6pp the approximation is confirmed benign; if it grows, switch caveat 1 to two replays and
> caveat 3 to stored replay-terminal endpoints (the deferred +1-vec4 motion-correctness refinement).
>
> **Deferred (post-phase, all non-blocking):** spatial compile-time reduction (prefixPHatCache / k≤2
> cap A/B, perf gate); the 3 reviewer-flagged replay/walker divergences (prevRough init, alpha
> preX1ExactOk gate, |cos| transmission-lobe fold) folded into the next review; the motion-correct
> x'_{k−1} temporal storage (8th vec4, +14% GI pool VRAM) if the validation-gap test shows the J=1
> approximation grows under camera motion.
>
> Diagnosis pattern worth keeping: hook `device.addEventListener('uncapturederror')` +
> `device.lost.then(...)` in the page — silent-zero GPU features are usually invalid pipelines. And
> when a reservoir field is BIT-FROZEN across frames, the domain inputs are frozen — trace per-frame
> with real frameCount before theorizing (the 8-frame "gating" was a dump-cadence artifact).

**Chain-value analysis (the replay foundation, settled):** under the frozen-Fn-param semantics the
caller chain advances ONLY at kernel/walker-scope `RandomValue` calls, and those advances are
pcg-chains of the seed alone — **the chain VALUES are domain-independent** (gi-initial: seed→S1→S2 =
the xi0 pair; adoptRand=pcg(S2) after the walk; walker stream = pcgHash(S2 ^ 0x517cc1b7), then one xi
pair per opaque vertex). The replay therefore reproduces the EXACT same random values at every chain
position from the stored pre-xi0 seed; domain differences enter only through the deterministic
functions (geometry/material) applied to them. The replay SKIPS the NEE/emissive helper calls (their
interior draws never advance the chain — verified mechanism: the measured param-mutation freeze).

**Walker k-selection policy (no-shrink, routing decidable at visit time):** rough x0 (roughness ≥ τ)
⇒ anchor at x1 ALWAYS (k=1, bit-compatible with the shipped PT-2/3b behavior — no τ₁/d_min gates).
Glossy x0 (the PT-3b canonical-only coverage) ⇒ walk with terms routed to a **prefixRadiance**
accumulator (returned to gi-initial, added straight to RAY radiance — gi-initial gains rayBufferRW,
8→9 SB); anchor at the FIRST opaque vertex x_j with roughness(x_{j−1}) ≥ τ AND roughness(x_j) ≥ τ₁
AND |x_j − x_{j−1}| ≥ d_min (prevRough/prevPos tracked; j=1 pair = (x0, x1) can't fire for glossy x0);
anchor terms → A/Le, beyond → B, kPrefix = j; if NO pair qualifies by walk end ⇒ keep the x1-anchored
nonReusable candidate exactly as PT-3b (fallback, zero regression). RR gated on anchor-found (landed,
no-op at k=1).

**The shared replay Fn** (`makeGIPrefixReplay`, closure: bvh/tri/mat/maps; used by gi-initial's
canonical p̂, the resolve, and — 3c-2 — the reuse kernels): args (seedLo, seedHi, kPrefix, domain
x0/N0/V0/mat0, stored x_k/n_k/matIdx_k). Reassemble seed integrally; re-derive xi0=(pcg¹>>8, pcg²>>8);
re-run the x0 sample (clearcoat-or-gsd + calculateIndirectLighting — same calls, same order); per
prefix vertex j=1..k−2: trace, rebuild material, transparency lottery (same call), xi pair, sample,
fold factor f_j·cos_j/p_j^domain (PSS form; p = the realized combinedPdf); **stratum check** at every
replayed pair: reconnectability satisfied early ⇒ return invalid; terminate-class interactions
(transmissive/SSS continue, alpha rules) ⇒ invalid. At x'_{k−1}: reconnection-edge validity
(rough(x'_{k−1}) ≥ τ, stored-x_k roughness ≥ τ₁, dist ≥ d_min), factor f_{k−1}(→x_k)·cos (solid angle,
NO /p). Returns {valid, prefixFactor vec3, xPrev = x'_{k−1}, nPrev}. Target(domain) = prefixFactor ·
evalLo-payload(A + E·misW(domain'=xPrev, bounceIndex=k−1) + f_k·B) — evalLo's E re-weight gains a
bounceIndex param (currently hardcoded 0) and an origin override (x'_{k−1}, not x0).

**3c-1 (canonical k>1, still nonReusable):** walker policy above + replay in gi-initial (canonical p̂
via the replay Fn at the own domain — eval-after-store; RIS weight denominator = p_{k−1}^realized,
which the walker must output) + the resolve k>1 branch (replay; V re-anchored x'_{k−1}↔x_k; contribution
= prefixFactor·f·cos·payload·V·W·gi). Gate: glossy-x0 scenes canonical == BF (the deeper-anchor
transport now matches BF exactly instead of the x1-anchored freeze-all).
**3c-2 (reuse):** giPHat in temporal/spatial branches on kPrefix: ≤1 → current path; >1 → replay-based
target (+bvh in both kernels → 7 SB ✓). **SPATIAL** k>1: genuine fresh own-domain replay per neighbor
(same-frame exact G-buffer rebuild ⇒ the fresh eval ≡ the stored value ⇒ the pairing holds natively),
Jacobian endpoints from the two replays' terminal vertices. **TEMPORAL** k>1: SAME-DOMAIN MERGE
(closing-day fix) — the history own-domain target is the STORED pHatOwn (a fresh replay at the
quantized prev-frame domain diverges through the glossy prefix into a constant J asymmetry → the
exponential reuse explosion), one current-domain replay per arm, J=1 endpoints; sound because the
disocclusion gate asserts the same world surface. nonReusable bit cleared for k>1 candidates whose
anchor pair passed. Deferred: prefixPHatCache own-domain caching; perf gate (k≤2 cap, reuse-off/K0/K3
A/B, ≤10% budget); the motion-correct x'_{k−1} storage refinement for the temporal arm.

## PT-3d — Temporal replay (CLOSED 2026-06-13: verification + the same-domain-merge fix)

The staging row's substance — "the §shift in gi-temporal from the true x0_prev (PT-2b machinery)" —
was delivered by PT-3c-2: `ReSTIRGITemporalKernel.js` branches its giPHat on kPrefix and merges the
disocclusion-gated previous-frame reservoir for k>1. The closing-day matrix exposed the temporal
k>1 Jacobian asymmetry (the exponential mb4 reuse explosion) and its fix — the **same-domain merge**
(history own-domain target = stored pHatOwn, one current-domain replay per arm, J=1 endpoints; the
disocclusion gate guarantees the history pixel is the same world surface). See the §PT-3c status
post-mortem for the full mechanism. The deterministic matrix now PASSES (table in §PT-3c status):
protocol mb1 reuse −0.804% (bit-match to the 3c-1 pre-regression baseline), mb4 −1.098%/−1.127%.
Unit baseline green: 759/759 (restirGI 21/21). Open refinement: the k>1 temporal J=1 endpoint is
EXACT only for the static-camera / sub-pixel-jitter regime the validation covers; storing x'_{k−1}
in an 8th vec4 (+14% GI pool VRAM) would make it motion-correct for fast camera-motion glossy scenes.

## PT-4 — Generalized balance MIS over hybrid-shifted paths (CLOSED 2026-06-13: audit + tests, no new mechanism)

Audit conclusion: the roadmap row's substance — "MIS denominators evaluate shifted targets via replay" —
was already delivered by PT-2 + PT-3c-2. PT-4 closes as verification + this note, not new code.

- **The combine IS the generalized balance.** `reservoirCombineGIShifted` (ReSTIRGICore.js) implements
  Lin 2022 Eq. 11 pairwise: mᵢ(yᵢ) = cᵢ·p̂ᵢ(yᵢ) / Σⱼ cⱼ·p̂ⱼ(yᵢ)·|Jⱼ|, cross-evaluated targets in BOTH
  m-denominators, per-arm Jacobians, confidence (M) weights, W = wSum/p̂_q(survivor) (Eq. 8, no M).
- **The targets ARE hybrid-shifted.** PT-3c-2 routes every k>1 arm's four cross-targets through the
  shared replay-target Fn (`makeGIReplayTarget` — the SAME closure gi-initial's p̂ and the resolve use,
  the Eq. 8 single-target-function requirement) in BOTH reuse kernels; Jacobian endpoints move to the
  replays' terminal vertices x'_{k−1}. nonReusable / replay-failure = target-0 at the call sites
  (T(y)=⊥, zeroed in the w-arm AND the denominators — settled point 8). The combine itself is
  k-agnostic; mixed-k pairs are just asymmetric-J / target-0 instances of Eq. 11.
- **K>1 spatial = sequential pairwise folds, BY DESIGN.** Each fold is a complete two-arm Eq. 11
  partition (running canonical written/re-read per fold). This is the pairwise-MIS instantiation of
  GRIS, unbiased per fold; the simultaneous K-arm Alg. 6 denominator is a variance (not bias)
  refinement costing O(K²) replay-target evals/pixel — rejected unless spatial blotching appears.
- **Verification:** the JS-mirror partition tests extended to the PT-4 cases — partition of unity on
  both arms simultaneously under asymmetric NON-reciprocal Jacobians (the mixed-k shape), and the
  target-0 degeneracies (m→1 on the only producible arm, zero leak into the other arm's partition,
  Eq. 8 survivor algebra) — `tests/unit/core/restirGI.test.js` §4.2/PT-4. Extended on the closing day
  with the §PT-3c-2 bounded-wS regression pair (the Eq. 8 pairing bounds wS ≤ wSum_s·cS/cC for any
  target/Jacobian magnitude + the unbounded counterexample when the own-domain target is re-evaluated
  fresh instead of read from the stored pHatOwn).
- **Final unit baseline (2026-06-13, post PT-4 + PT-3c-2 regression tests): 759/759 (restirGI 21/21).**

## (superseded draft below — kept for the rationale prose)

### Goal + the structural decomposition
Glossy/specular x0 currently gets ZERO ReSTIR coverage (the τ gate declines; Shade keeps plain BF).
PT-3 moves the reconnection vertex to the FIRST RECONNECTABLE vertex x_k (k ≥ 1) and **random-replays**
the prefix x0→…→x_{k−1} from the stored seed when shifting to a new domain. Key architectural
decision (the path-TREE problem): the walker currently folds EVERY vertex's NEE into the payload — a
path tree, whose prefix-vertex NEE terms cannot be reconnection-shifted and would make replay-evaluation
require shadow rays per prefix vertex. **Decomposition: for k>1 candidates the walker writes the
prefix-vertex terms (NEE/emissive at x_1..x_{k−1}) DIRECTLY into RAY radiance (per-pixel BF, never
resampled), and the reservoir sample = the path tree FROM x_k only.** Replay evaluation then needs only
the BSDF chain (scatter + trace per prefix segment, no NEE) — Falcor-class cost. k=1 reduces exactly to
the shipped PT-2 sample (empty prefix, no replay) — the degenerate that keeps all current validation.

### Reservoir layout v3: 6 → 7 vec4 (stride 21)
```
prefix = vec4( seedLo, seedHi, k, spare )   // seed = the walker's 32-bit stream seed split into two
                                            // 24-bit-exact f32 lanes (raw u32 bit patterns through an
                                            // f32 buffer hit the NaN-canonicalization pitfall —
                                            // project_tsl_pitfalls); k = prefix length (k=1 ⇒ no replay)
```
All other lanes keep their PT-2 meaning, REANCHORED at x_k: sample = (x_k, n_k), radiA = A@x_k,
suffix = B (beyond x_k, no f_k), recon = (matIdx_k, uv_k, ω_kout), emis = (Le@x_k hit, triIdx).

### Reconnectability criteria (the GRIS §5 conditions, both edge endpoints)
x_k is reconnectable when: roughness(x_{k−1}) ≥ τ AND roughness(x_k) ≥ τ₁ AND |x_k − x_{k−1}| ≥ d_min
(~1% scene radius). The x0 τ gate is REPLACED by "deterministic-opaque at x0" only (the Shade-kill
transparency partition stays); roughness no longer gates participation — it selects k. Paths that never
reach a reconnectable vertex: candidate stores k=0/invalid → canonical-only (M counts), no reuse.

### The shift (evaluation at a domain ≠ source, k > 1)
1. Re-seed the EXACT walker stream (`pcgHash(seed ^ const)` — same constant) and REPLAY the scatter
   chain from the DOMAIN's x0: per prefix segment, rebuild material at the replayed hit, run the SAME
   draw sequence (transparency lottery, generateSampledDirection/clearcoat, calculateIndirectLighting's
   strategy draws) — PSS replay: the same stream, whatever path results.
2. Shift validity: the replayed prefix must (a) complete k−1 segments without termination (miss /
   transmissive-continue / RR — note RR must NOT run during prefix replay: the stored k bounds the walk,
   draw-parity preserved by consuming the same draws), and (b) land on a vertex pair satisfying the SAME
   reconnectability criteria. Failure ⇒ that arm's shifted target = 0 (drops out of the Eq. 11 partition
   over successful shifts — the same clean mechanism as the disocclusion gates).
3. Target at the domain: p̂ = lum( [Π prefix f·cos/pdf re-evaluated along the replayed chain] ·
   f_{x'_{k−1}}(→x_k)·cos·[A + E·misW(domain') + f_k·B] ) — where domain' for the E re-weight is the
   REPLAYED x_{k−1} (the reconnection edge's new origin). Jacobian = J_prefix(PSS replay) = 1 ×
   giReconnectionJacobian(x_k, n_k; x'_{k−1}, x_{k−1}_src).
4. Cost: temporal = up to 2 replays/pixel, spatial = up to 4/fold (the Eq. 11 cross-terms) — each
   replay = (k−1) × (traverseBVH + material rebuild + sampling-eval). Bound k (e.g. ≤ 4) and measure.

### Draw-parity discipline (the replay foundation — extends the Phase-0 primitive)
The walker's per-vertex draw COUNT must be a deterministic function of the visited state, and the replay
must consume IDENTICALLY: same helpers, same order, same conditional draws (handleMaterialTransparency
draws 2-3 depending on alphaMode/transmission — the replay calls the same Fn). The stream is pure
`pcgHash` chain from the seed ⇒ same seed + same visited state ⇒ same draws (bit-exact, deterministic
GPU fp). NOTE the canonical walk draws NEE randoms at prefix vertices (the prefix-NEE terms written to
radiance) — the REPLAY does not evaluate NEE but MUST consume the same number of draws to stay aligned,
OR (cleaner) the walker draws prefix-NEE randoms from a FORKED stream (`pcgHash(seed ^ vertexIdx ^ NEE_SALT)`)
so the scatter chain's stream is NEE-free and replay alignment is structural. DESIGN POINT for skeptics.

### Staging (each individually validatable)
- **PT-3a (plumbing, zero behavior change):** +prefix vec4 (stride 21, lockstep checklist), walker
  records seed + k (gate unchanged ⇒ k ≡ 1 asserted), GPU determinism probe (two dispatches, same seed
  ⇒ bit-identical reservoirs via getArrayBufferAsync compare) — the Phase-0 replay primitive, finally.
- **PT-3b (canonical-only k>1):** prefix-NEE-to-radiance split, gate widening (glossy x0 participates),
  forked NEE streams, k>1 candidates marked non-reusable (validFlip codec gains a bit). Gate: glossy-x0
  scenes canonical GI == BF (the new coverage is unbiased before any reuse).
- **PT-3c (spatial replay shift):** the §shift in gi-spatial (+bvh → 7 SB ✓), shift-validity partition,
  hybrid Jacobian. Gate: protocol + glossy-floor scenes, reuse-on unbiased; variance win on glossy.
- **PT-3d (temporal replay):** same in gi-temporal from the true x0_prev (PT-2b machinery). Full matrix.

### Adversarial findings folded in (2026-06-11 workflow, 5 lenses, all sound-with-fixes)
Bias-critical: stochastic-transparency x0 partition (→ deterministic-opaque gate); d=1 alpha-skip
V-semantics ((1−a)² / V=0 → row-2 rules); resolve pathLength=1 wrap clamping 30-70% of broadband
multi-bounce energy clamp-on (→ row 11); Phase-2 emissive double-count confirmed (→ row 4).
Correctness: valid→M arm gating; walker init pinning; loop-bound headroom; Shade normal pipeline;
rough-diffuse NEE skip mirror; DI emissive-toggle gate; claim-5 rescoping; emissive-NEE@x1 gap.
Refuted/vacuous: the 0.001-vs-1e-8 clamp "fix" (combinedPdf pre-floored — both clamps dead code);
walker-vs-BF RR/STBN differences (variance-only).
