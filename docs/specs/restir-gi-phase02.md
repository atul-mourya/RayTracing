# ReSTIR GI — Phase 2 Implementation Spec (Unbiased, Interactive-Only, Reconnection-Shift)

> **Status:** VETTED — implementation-ready. Produced by an understand→design→adversarial-verify workflow:
> 5 independent readers (engine indirect path, the shipped DI impl, the GRIS/Ouyang shift math, the old
> `ReSTIR`-branch GI prototype, SB/VRAM constraints) → 3 adversarial skeptics on the bias-critical parts. The
> skeptics caught **three** errors in the first draft, all fixed below: (1) the reconnection Jacobian must also
> appear in the MIS-denominator cross-terms, not only the resampling weight (§4.2); (2) GI temporal needs the
> full cross-evaluated combine, not DI's collapse (§4.3); (3) the double-count gate must **kill the bounce-0
> continuation ray**, not extend `skipDiscreteLighting`, and GI-resolve must carry `globalIlluminationIntensity`
> (§1/§3/§6). Three independent derivations of the Jacobian agree (§5). Supersedes the biased
> `ReSTIR:src/core/Stages/ReSTIRGIStage.js` prototype (Alg-4 + **missing** Jacobian).
>
> **Builds on:** the shipped, validated **unbiased ReSTIR DI** (`feature/restir-di`,
> `docs/specs/restir-di-phase01.md`). GI reuses DI's reservoir-pool class, pack/unpack discipline, the GRIS
> combine *structure*, the exact-jittered primary-hit buffer, the disocclusion gates, and the hard-won
> shadow-ray-offset rule (`P + N·0.001`, never `calculateRayOffset`'s ~`N·1e-4` — `project_restir_shadow_offset_bias`).

## 0. Scope & non-goals

**In scope (Phase 2 = ReSTIR GI, Ouyang et al. 2021):**
- **1-bounce indirect** reuse. Reservoir sample `y = (x1, n_{x1}, L_o(x1→x0))` — the first indirect-bounce hit
  ("sample point") + the radiance leaving it toward the primary hit.
- **Reconnection shift ONLY** (keep my prefix `x0`, reconnect to the source's `x1`). Jacobian = the
  geometry-term ratio at the shared vertex `x1` (§5).
- **Unbiased GRIS** generalized-balance / cross-evaluated MIS (Lin 2022 Alg. 6 / Eq. 11) — **never Algorithm 4**.
- Interactive-only (`INTERACTIVE_RENDER_CONFIG`); asserted OFF in production.

**Explicitly deferred:** hybrid/random-replay shift (specular/glossy `x0`) → Phase 3; multi-bounce path
reservoirs → Phase 3; unified DI+GI reservoirs → Phase 4 (Phase 2 runs DI **or** GI per frame); production reuse → Phase 5.

**A scope consequence to internalize (verified):** Phase-2 GI reuses **one** outgoing bounce at `x1`
(direct@x1 + emissive@x1). It therefore estimates only the **first** indirect bounce; the ≥2-bounce indirect
through `x0` is intentionally NOT captured. This dictates the validation reference (§8) — GI must be compared
against a **bounce-depth-matched** brute force, never full-GI BF.

## 1. The central problem: capturing `L_o(x1→x0)` + the double-count gate

The wavefront has **no separate indirect accumulator**. `ShadeKernel` adds direct/env/emissive into one running
`RAY.RADIANCE_ALPHA` at every bounce, then picks `bounceDir`, folds `f·cos·misW/pdf` into `throughput`, and
writes the continuation ray (`ShadeKernel.js:831-877`). The 1-bounce indirect is **never added at bounce 0** —
it rides `throughput` into the bounce-1 dispatch, where the continuation ray's hit accumulates it.

**Capture (Strategy 1 — self-contained, no wavefront surgery):** `gi-initial` **traces its own** `x0→x1` ray
and shades `x1` itself:
1. From the exact captured `x0` (reuse DI's `primaryHitBuffer`), BSDF/cosine-sample `ω0` at `x0`; `traverseBVH`
   → `x1` (closest hit). On env-miss the candidate's `L_o` = env radiance along `ω0`.
2. Shade `x1` with the engine's real `calculateDirectLightingUnified` (NEE: one light + emissive, `x1`'s own
   shadow ray) + `x1` emission → `L_o(x1→x0)`. **Use the real unified NEE, not a hand-rolled Lambertian** (the
   prototype's bug — it ignored non-diffuse BSDFs at `x1`).
3. Store `{x1, n_{x1}, L_o}`; `p̂ = luminance(f(x0,ω0)·⟨n0·ω0⟩·L_o)`; source pdf = the BSDF/cosine pdf at `x0`
   (folded into the RIS weight; initial pass only).

**The double-count gate — KILL THE CONTINUATION RAY (NOT `skipDiscreteLighting`).** *(Adversarial fix #3 — the
first draft's "extend skipDiscreteLighting" was a no-op: that flag suppresses an addition at bounce 0, but the
indirect has no bounce-0 addition.)* When `enableReSTIRGI` AND `bounceIndex==0` AND the hit `isReconnectable`
(§3), after the indirect block computes `bounceDir`/`throughput` **and before the Russian-roulette test**,
deactivate the ray and `Return` (exactly like the existing RR-kill / depth-kill, `ShadeKernel.js:850-868`):
```js
If( enableReSTIRGI.equal(int(1)).and( bounceIndex.equal(int(0)) ).and( isReconnectable ), () => {
    writeRayRadiance( rayBufferRW, rayID, currentRadiance );   // keep direct@x0 + env-NEE@x0 + emissive@x0
    writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~RAY_FLAG.ACTIVE ) ) );
    rngBufferRW.element( rayID ).assign( rngState );
    Return();
} );
```
This removes the entire suffix transport from `x0` (the 1-bounce indirect *and* deeper bounces); `gi-resolve`
re-injects the resampled **1-bounce** estimate. Terms already added before the continuation block
(direct@x0 `:706`, env-NEE@x0, emissive-hit@x0 `:576`) are **retained**; env-on-primary-miss `Return`s earlier
(`:227`) and is unaffected. **Verify `gi-resolve` adds ONLY `f·cos·L_o·V·W` (never an env term)** — env stays
out of the reservoir (DI discipline), so env@x0 must not be double-counted.

- **Gate on `bounceIndex==0`, NOT `cameraDepth==0`** (verified): glass/SSS-then-diffuse pixels reach their first
  opaque hit at `bounceIndex>0`, so they fall through to BF indirect — matching that `gi-initial` only captured
  the genuine primary `x0` from `primaryHitBuffer`. Transmissive `x0` (`transmission>0.5`) `Return`s in the
  transparency block *before* the indirect block, so it is auto-excluded — `gi-initial` must likewise decline on it.

## 2. GI reservoir struct + pool

The sample is a world **point** `x1` + its **normal** (required for the Jacobian) + the stored **radiance** `L_o`
(cannot be re-derived analytically — unlike DI's `lightSampleId`). **3 vec4 = 48 B/slot** (vs DI's 32 B):
```
GIReservoir (3 vec4):
  core   = vec4( wSum, W, M, pHatOwn )                 // identical roles to DI core
  sample = vec4( x1.x, x1.y, x1.z, octEncode16(n1) )   // sample point + oct-encoded normal (1 f32)
  radi   = vec4( Lo.r, Lo.g, Lo.b, validFlag )         // captured incoming radiance + validity
```
- `n1` oct-encoded into one f32 lane; world `x1` stays **Float32** (HalfFloat loses the mm precision the `d²`
  Jacobian needs — the prototype's mistake). `validFlag` replaces DI's `RESTIR_ID_NONE` sentinel.
- `x0` is **NOT** stored — read `primaryHitBuffer[pixel]` (current), reprojected-prev primaryHit (temporal), or
  `primaryHitBuffer[neighbor]` (spatial). This supplies the Jacobian's source-side `x0_r` / `x0_prev`.

**Pool delta:** `VEC4S_PER_SLOT 2→3`; `SLOTS_PER_PIXEL` stays 3 (cur/prev + snapshot S for the race-free spatial
gather). `reservoirSlotIndex` stride **`*6→*9`, `slotBit*2→*3`** — change in **lockstep** with `VEC4S_PER_SLOT`
(the documented corruption footgun; assert stride parity in a unit test). Reuse `primaryHitBuffer` unchanged.

**VRAM:** 144 B/px → 576 MB @2048². GI **replaces** DI's pool in interactive mode; production stub stays 16 B
(`deactivate()`) so production is unaffected. **If VRAM-tight:** pre-allocate at the *interactive* max resolution
(not 2048²), or drop to 2 ping-pong slots (96 B/px). Validate with the VRAM tracker.

## 3. Pass pipeline (5 passes, `bounceIndex==0`-gated, mirrors DI)

Gate: `restirGIActive = renderMode===0 && enableReSTIRGI && pool.isActivated()`. Dispatch mirrors the DI block
(`PathTracer.js:344-369`). Per-pass storage-buffer counts (HARD cap 10):

| Pass | Does | SB |
|---|---|---|
| `restirGICapture` | store exact jittered `x0` (reuse DI `restirCapture` verbatim) | 3 |
| `restirGIInitial` | canonical RIS over M candidates: trace `x0→x1`, shade `x1` (real unified NEE+emissive) → `L_o`, `p̂`, WRS | **8** ← tightest (bvh+tri+mat+hit+rng+reservoir+primaryHit+lightStorageNode) |
| `restirGITemporal` | reproject + disocclusion gate, M-cap, cross-eval + Jacobian combine → snapshot slot S | 5 |
| `restirGISpatial` | K-neighbor gather from S, cross-eval + per-arm Jacobian combine → cur, frame-gated | 5 |
| `restirGIResolve` | ONE visibility ray `x0→x1` + add `gi·f·⟨n0·ω0⟩·L_o·V·W` into `RAY.RADIANCE_ALPHA` | 6 |

`gi-initial` at 8 SB is the watch-item (margin 2; `lightStorageNode` for emissive-mesh NEE is the only new buffer
vs DI). If it ever grows, **split** into `gi-trace`(6) + `gi-shade-x1`(6). Temporal/spatial need **no bvh/tri** —
the Jacobian is analytic from stored `x1`+`n1` (no trace) — which is what keeps them in budget.

**`isReconnectable` MUST be one shared helper** *(adversarial fix #3d)* called identically in `gi-initial`,
`gi-resolve`, AND the `ShadeKernel` continuation-kill, reading the **same post-texture-sample roughness**
(`material.roughness.clamp(0.05,1)` after `sampleAllMaterialTextures`) and the **same τ uniform**. Divergence
creates per-pixel gaps (dark: continuation killed but resolve declines) or overlaps (bright double-count) along
roughness-map / material edges.

## 4. Target function & the GRIS combine

### 4.1 Target (identical across initial/temporal/spatial/resolve — the DI cardinal rule)
With `ω = normalize(x1 − x0)`:
```
p̂(x0, y) = luminance( f_{x0}(ω_o, ω) · max(dot(n_{x0}, ω), 0) · L_o(x1→x0) )       (GI-1)
```
- `f_{x0}` = Disney BSDF at the primary hit (`evaluateMaterialResponseFromDots`, no cosine baked in).
- **TRUE clamped cosine** `max(dot,0)` — never `computeDotProducts().NoL` (the 0.001 floor biases every `mᵢ`).
- Visibility of `x0→x1` is **EXCLUDED** (applied once at resolve — §6). `L_o` reused unchanged under the shift
  (the 1-bounce reconnection approximation; validity bounded by the roughness reconnectability gate).

### 4.2 The combine — `reservoirCombineGIShifted` (cross-evaluated, **Jacobian in BOTH the weight AND the denominators**)
*(Adversarial fix #1: the first draft put `|J|` only in `wₛ`; that is BIASED for J≠1 — GRIS Eq. 11 requires the
per-cross-term Jacobian in the MIS denominators so every term lives in one consistent measure.)*
For canonical `C` (my domain `q`, no shift, J=1) + one shifted reservoir `S` (source domain `q'`):

**Four fresh targets** (recomputed from stored world points every fold — NEVER stored `pHatOwn`):
`p̂C@q = p̂(x0_q,Y_C)`, `p̂C@q' = p̂(x0_q',Y_C)`, `p̂S@q = p̂(x0_q,Y_S)`, `p̂S@q' = p̂(x0_q',Y_S)`.

**Two Jacobians** (at *different* samples — **NOT reciprocals**; `J(x1,n;tgt,src) = (|dot(n,t̂gt)|/|dot(n,ŝrc)|)·(|src−x1|²/|tgt−x1|²)`, GI-J §5):
- `|J_S| = J(x1_S, n1_S; x0_q, x0_q')` — shifted sample mapped `q'→q` (also used in `wS`).
- `|J_C| = J(x1_C, n1_C; x0_q', x0_q)` — canonical sample mapped `q→q'` (the cross-term factor the draft missed).

```
denomC = cC·(p̂C@q)   + cS·(p̂C@q')·|J_C|        mC = cC·(p̂C@q)  / denomC
denomS = cS·(p̂S@q')  + cC·(p̂S@q)·|J_S|         mS = cS·(p̂S@q') / denomS
wC = canonical.W · (p̂C@q) · mC                  // canonical in own domain, J=1
wS = shifted.W   · (p̂S@q) · mS · |J_S|          // shifted arm carries |J_S|
newWSum = wC + wS ;  takeS = newWSum·rand < wS
W = newWSum / p̂(survivor)       // Eq. 8, NO M ;   M = cC + cS
```
`cC = C.M`, `cS = S.M`. Setting `|J|≡1` reduces this **exactly** to DI's `reservoirCombineSpatialUnbiased`
(verified term-by-term) — DI is the J=1 degenerate, which is why DI's validation never exposed the missing
Jacobian. Guard all denominators `> 1e-10`; clamp the `J` cos-ratio (floor `1e-4`) and `d²` (floor `1e-8`).

### 4.3 Temporal uses the SAME cross-evaluated combine (resolved)
*(Adversarial fix #2.)* DI temporal *collapsed* to `mᵢ=cᵢ/Σc` because it reprojected the sample into the current
pixel and re-evaluated under the **same** target `p̂_q` (shared target, J=1). For GI the reconnection to the stored
`x1` from `x0_cur` vs `x0_prev` makes the source target a **different function** (the prefix enters the BSDF lobe
+ cosine non-multiplicatively) with `J≠1` under any camera motion → the shared-target precondition **fails**, so
the collapse is **biased**, not merely suboptimal. **Decision: use `reservoirCombineGIShifted` (full cross-eval +
Jacobian) for temporal too**, treating the reprojected-prev reservoir as a "neighbor" at `q'`=reprojected-prev,
with `x0_prev = primaryHitBuffer[reprojected-prev]` (a NEW read GI temporal needs that DI did not). Static camera
(`x0_cur==x0_prev`) is the degenerate `J=1` case where cross-eval+J auto-reduces to the collapse — verify that
reduction as a unit test.

## 5. The reconnection Jacobian (THE bias trap)

Three independent derivations agree. For source sample point `x1` reused at my pixel (my prefix `x0_q`, source
prefix `x0_r`), at the **shared vertex `x1`**:
```
|J_{r→q}|  =  ( cos θ_{x1}^q / cos θ_{x1}^r ) · ( d_r² / d_q² )                  (GI-J)
```
`ω_q = normalize(x0_q − x1)`, `ω_r = normalize(x0_r − x1)`; `cos θ_{x1}^q = |dot(n_{x1}, ω_q)|`,
`cos θ_{x1}^r = |dot(n_{x1}, ω_r)|`; `d_q = |x0_q − x1|`, `d_r = |x0_r − x1|`. **Role-swap gives the reverse:**
`|J_{q→r}| = 1/|J_{r→q}|` (the same sample's forward/back maps are reciprocal — but the two cross-Jacobians in
§4.2 are at *different* samples, so they are not). **Why this form:** the cos-at-`x0` and `1/d²` are re-evaluated
inside `p̂` (GI-1) and cancel against the source's own-domain target; only the `x1`-side `cos/d²` survives. DI is
the `J=1` degenerate (fixed light point). TSL: the shared `jac(x1,n1,tgt,src)` helper in §4.2.

**Reconnectability criteria** (keep `|J|` bounded + the shift valid; a reservoir failing ANY gate drops out
cleanly — `c→0`, partition-of-unity preserved over survivors; **never clamp `J` itself** — that biases):
1. **Roughness ≥ τ at `x0`** (~0.2–0.3, re-tune). Near-specular `x0` → `p̂→0` + `J·W` variance explodes → exclude
   (Phase 3 hybrid handles specular). The single `isReconnectable` helper (§3) owns this test.
2. **Min distance** `d_q ≥ d_min` (and `d_r ≥ d_min`), ~1% scene radius — bounds `d_r²/d_q²`.
3. **Grazing reject** `cos θ_{x1} ≥ cos_min` (~1e-2) both sides — bounds the cos ratio.
4. **Prefix consistency** — DI's disocclusion gate (normal `dot ≥ 0.9`, relative depth ≤ 0.1) on `x0`.

## 6. Edge visibility + the resolve contribution (unbiased, BF-matching)

Reconnection-edge visibility `V(x0↔x1)` is **excluded from `p̂`** (unshadowed everywhere — mandatory for
`Σmᵢ=1`: same unshadowed `p̂` in every `mᵢ` numerator AND denominator) and applied **once, to the survivor**, at
resolve. *(Adversarial fix #3c: GI replaces a **bounce-1** term, so it MUST carry `globalIlluminationIntensity` —
unlike DI's bounce-0 resolve, which correctly has no scale.)*
```
L_indirect(q) = globalIlluminationIntensity · f_{x0}(ω_o,ω_q) · max(dot(n0,ω_q),0) · L_o · V(x0↔x1) · W   (GI-resolve)
```
- ADD into `RAY.RADIANCE_ALPHA` via `regularizePathContribution(contribution, pathLength=1.0, fireflyThreshold,
  frame)` — **`pathLength = 1`, not 0** (the replaced term lived at bounce 1; the firefly threshold is
  depth-dependent). Apply `globalIlluminationIntensity` **exactly once** (here, not also in `gi-initial`'s `L_o`).
- **Shadow-ray origin = `x0 + n0·0.001`** (match the BF indirect ray, `ShadeKernel.js:870`), `shadowDist =
  |x1−x0| − 0.001` (offset the far end too). `traverseBVHShadow` has **no tMin** — the offset is the sole
  self-shadow guard; `calculateRayOffset`'s `~N·1e-4` reproduces the −1.6% DI dark bias.
- `x1`'s **own** NEE visibility was resolved at candidate time (baked into stored `L_o`) — distinct from the
  reconnection-edge visibility applied here.

## 7. Integration & enable gate

New `enableReSTIRGI` uniform (mirror `enableReSTIR`): default off; `INTERACTIVE_RENDER_CONFIG` may enable;
**asserted OFF in production** (`configureForMode`). DI and GI mutually exclusive in Phase 2. Pool lifecycle
identical to DI (16-B stub off; `activateAtMax`/`deactivate` at the idle mode-toggle; `swap()` once/frame;
`clear()` on `pipeline:reset`). Both `gi-initial`'s trace and `gi-resolve`'s visibility ray use `x0 + n0·0.001`.

## 8. Implementation order (each step individually validatable, mirroring how DI was built)

1. **Pool + struct** (3 vec4, stride `*9`, oct-normal pack/unpack) + the stride-parity unit test. No behavior yet.
2. **`gi-initial` + `gi-resolve` only** (NO reuse): RIS → resolve, with the continuation-kill gate.
   **Validate against a BOUNCE-DEPTH-MATCHED BF** *(adversarial fix #3b)* — a 2-segment BF (primary hit → one
   scatter → that vertex's direct+emissive only, its continuation killed), NOT full-GI BF. Against full BF,
   GI-on is *correctly* darker by the ≥2-bounce indirect (the deliberate truncation) and a "global-mean ≈ 0"
   gate would falsely fail. Deterministic global-mean ≈ 0 + per-pixel RMSE vs the matched reference proves
   capture + target + gating + giScale + the BF-offset, before any shift/Jacobian.
3. **`gi-temporal`** (cross-eval + Jacobian). Validate: still converges to the matched BF (Jacobian correctness —
   diffuse-box energy conservation FIRST), M grows past cap, variance win at low spp.
4. **`gi-spatial`** (K-neighbor cross-eval + per-arm Jacobian, frame-gated like DI). Validate: converges, extra
   low-spp variance win, no converged-tail penalty (the DI frame-gate lesson).
5. **Re-tune** M, K, radius, roughness τ, `d_min` empirically (CUDA-era tunings regress on WebGPU/Apple).

## 9. Bias-trap checklist (every one a documented prior failure)

- [ ] **Algorithm 4**: use the cross-evaluated GRIS combine (§4.2), never `b.W·p̂·b.M + 1/M`.
- [ ] **Jacobian — both places**: `|J|` on the shifted arm's `wₛ` AND on each MIS-denominator cross-term
      (`|J_C|` on denomC, `|J_S|` on denomS); store `n1` (the prototype omitted it → uncomputable J).
- [ ] **Reusing stored `pHatOwn`**: recompute all 4 cross-`p̂` fresh from stored points.
- [ ] **Double-count gate**: KILL the bounce-0 continuation ray at reconnectable hits (NOT `skipDiscreteLighting`);
      gate on `bounceIndex==0`; one shared `isReconnectable` for both kernels; resolve adds no env term.
- [ ] **giScale**: `gi-resolve` multiplies by `globalIlluminationIntensity` (bounce-1 term) + firefly `pathLength=1`.
- [ ] **BF reference**: bounce-depth-matched 1-bounce indirect, never full-GI BF.
- [ ] **Shadow offset**: `x0 + n0·0.001`, both ends; never `calculateRayOffset`.
- [ ] **Unshadowed target**: same unshadowed `p̂` in every `mᵢ`; V once on survivor.
- [ ] **Sub-pixel `x0`**: reuse DI's exact-jittered `primaryHitBuffer`.
- [ ] **Real NEE at `x1`** (`calculateDirectLightingUnified`), **Float32 `x1`**, **ADD into `RAY.RADIANCE_ALPHA`**
      (never overwrite `pathtracer:color`).

## 10. Open questions (resolved items kept for the record)

1. ~~Temporal collapse vs cross-eval~~ **RESOLVED (§4.3):** full cross-eval+J for both; collapse is biased under motion.
2. ~~Jacobian only in `wₛ` vs in the denominator~~ **RESOLVED (§4.2):** per-cross-term `|J|` in the denominators
   is required (GRIS Eq. 11); `wₛ`-only is biased for J≠1.
3. **`L_o` view-dependence:** the reconnection reuses `L_o(x1→x0_r)` as `L_o(x1→x0_q)`. The `x1` roughness gate
   bounds the error; quantify on a glossy-`x1` scene during step 3 validation.
4. **VRAM at 2048² (576 MB):** decide interactive-max pre-allocation vs 2-slot frugal mode per device.
5. **Multi-bounce indirect (≥2):** intentionally dropped in Phase 2 (the truncation in §0/§8). Revisit in Phase 3
   (full path reservoirs) — until then the GI preview is missing higher-order bounce energy by design.

## References
- ReSTIR GI (Ouyang et al. 2021): sample-point reuse, the reconnection Jacobian (Eq. 10).
- GRIS / ReSTIR PT (Lin et al. 2022): Alg. 6 generalized balance heuristic + shift maps/Jacobians (Eq. 11, §5.1–5.2).
- `docs/specs/restir-di-phase01.md` (validated DI precedent), `docs/specs/restir-pt-roadmap.md` §5 Phase 2.
- Memory: `project_restir_shadow_offset_bias`, `feedback_restir_validation_protocol`, `project_restir_pt_roadmap`.
