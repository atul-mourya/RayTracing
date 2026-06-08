# ReSTIR DI — Phase 0 + Phase 1 Implementation Spec (Unbiased, Interactive-Only)

> **Status:** VETTED — implementation-ready. Produced by a design + adversarial-verification workflow (3/3 independent MIS skeptics confirmed the GRIS core sound and surfaced the interface bias-traps now resolved in §7). Load-bearing feasibility/bias claims spot-checked against source: Shade 10/10 saturation (`ShadeKernel.js:3`), directLight firefly site (`ShadeKernel.js:674,695`), NoL floor (`Common.js:153`). Supersedes the three shelved Algorithm-4 attempts.
> **Date:** 2026-06-07
> **Owner:** rendering / path-tracer
> **Parent roadmap:** `docs/specs/restir-pt-roadmap.md` (this file is the Phase 0/1 content that roadmap references; it did not exist before).
> **Engine:** Rayzee wavefront path tracer — WebGPU / TSL / three.js r184 (pinned).
> **Scope of this doc:** Phase 0 (RNG-replay determinism substrate) + Phase 1 (unbiased ReSTIR DI: canonical RIS + temporal reuse over the 4 analytic light types). Spatial reuse, environment-in-reservoir, and the area-light positional shift are **explicitly deferred** to separately-gated follow-ups (§7, §11).

---

## Table of contents
0. [Decision recap + scope](#0-decision-recap--scope)
1. [Binding budget reality + per-pass plan](#1-binding-budget-reality--per-pass-plan)
2. [Reservoir struct + GPU pool](#2-reservoir-struct--gpu-pool)
3. [The unbiased estimator math](#3-the-unbiased-estimator-math)
4. [Pass DAG + PathTracer integration + production gating](#4-pass-dag--pathtracer-integration--production-gating)
5. [Phase 0 + Phase 1 checklists](#5-phase-0--phase-1-checklists)
6. [Validation / acceptance gate](#6-validation--acceptance-gate)
7. [Open risks the verifiers flagged + resolutions](#7-open-risks-the-verifiers-flagged--resolutions)
8. [File-touch summary](#8-file-touch-summary)

---

## 0. Decision recap + scope

### 0.1 The locked decision

ReSTIR DI (direct illumination) is implemented as:

1. **INTERACTIVE-ONLY.** Wired into `INTERACTIVE_RENDER_CONFIG` (`renderMode === 0`); **asserted OFF** in `PRODUCTION_RENDER_CONFIG` (`renderMode === 1`, the progressive accumulator). Three enforcement layers (§4.4).
2. **UNBIASED FROM DAY ONE.** Uses GRIS generalized-balance / pairwise-MIS reweighting (the unbiased "Algorithm 6" of Lin et al. 2022 GRIS, generalizing the unbiased contribution weights of Bitterli et al. 2020), **NOT** the biased Bitterli "Algorithm 4" (`bWeight = b.W · p̂ · b.M` + `1/M_total`). All three prior repo attempts used Algorithm 4 and were shelved because per-pixel bias + temporal correlation defeated the progressive accumulator (it converged to the *wrong* image at an `N^-0.1` floor instead of `N^-0.5`).

### 0.2 What "unbiased" buys, and why it is the whole point

The interactive accumulator is a `1/(frame+1)` running mean over per-frame radiance (`FinalWriteKernel.js:57-95`, `accumulationAlpha = calculateAccumulationAlpha`, `PathTracerStage.js:1125`). A **per-pixel-biased** estimator's error survives that mean — averaging biased frames converges to a biased image. An **unbiased** estimator's per-frame error is zero-mean, so the running mean converges to the true image. This is the *only* property that lets ReSTIR coexist with the accumulator, and it is non-negotiable.

> **Per-pixel vs global-mean unbiasedness (the trap that killed all 3 priors).** The prior Alg-4 attempt was already *global-mean*-unbiased (+0.2% total energy) yet failed on *per-pixel* RMSE (`N^-0.1` floor; `project_restir_di_option_a.md`). The math here targets per-pixel unbiasedness, and the validation gate (§6) is **per-pixel RMSE vs an independent-frame reference with the firefly clamp disabled** — the only measurement that distinguishes "unbiased" from "global-mean-unbiased but per-pixel-biased".

### 0.3 Phase 1 scope — the de-risked v1 (what the adversarial review converged on)

Every adversarial verdict agreed: the *math core is sound*, but the spec-as-originally-drafted was **not implementable unbiased on this codebase** because of interface faults (firefly clamp, the 10-buffer ceiling on Shade, the area-light direction-storage Jacobian, the spatial foreign-target re-evaluation, the NoL floor, the env scope, the multi-sample mode, the G-buffer/material availability). Rather than paper over these, **Phase 1 ships the subset where every one of those faults is avoidable**, and defers each unsafe piece to its own gated step:

| In Phase 1 (unbiased, safe) | Deferred (separately gated) | Why deferred |
|---|---|---|
| Canonical per-pixel RIS over **directional / area / point / spot** lights | **Spatial reuse** (`restirSpatial`) | Needs the *neighbor's* full material + normal to re-evaluate `p̂_i(y_c)` honestly; the G-buffer stores only normal/depth/albedo — not material index. A scalar substitute breaks `Σ mᵢ = 1` and re-biases (§7-R4). Ship after a per-pixel material handle exists. |
| **Temporal reuse** (canonical + 1 reprojected prev-frame reservoir) | **Environment in the reservoir** | `sampleLightWithImportance()` does not produce env candidates; env is a separate deterministic Veach-MIS term (§7-R5). Env NEE stays on its own un-gated path in Phase 1. |
| **Light-POINT storage** (area measure → J=1 by re-eval) | **Direction-only / octahedral env storage** | Direction-only loses distance `d` for positional lights → wrong sample at reuse (§7-R3). |
| Unbiased GRIS pairwise MIS combine | — | — |
| Forced **S=1** (single sample/pixel) when ReSTIR on | Multi-sample (S>1) + ReSTIR | Reservoirs are per-pixel; S>1 would lose direct light on sub-samples 1..S-1 (§7-R1). |

> **Why temporal-only is the correct v1:** temporal reuse re-evaluates the prev sample at the **current** pixel, where the material *is* recoverable (re-read the hit's material index → `materialBuffer` → `sampleAllMaterialTextures`). It needs **no foreign-pixel geometry**, so the partition-of-unity is exact and the Jacobian=1 reasoning is intact. It exercises the *full* unbiased MIS apparatus on the subset where the canonical-at-neighbor foreign-target evaluation (the spatial fault) never arises. Spatial reuse is then a clean, individually-validatable add-on once a material handle is in the G-buffer.

### 0.4 The sample, the domain, and the measure (stated precisely — the verifiers caught the original conflation)

- The **sample** `y` is a single **light-side point** for direct illumination at a **primary (bounce-0) hit**: a point on an area/emissive light, or the world position of a point/spot light, or a far point along a directional sample. It is stored in **world space** (§2) so its unshadowed contribution `f·G·Le` can be recomputed at a *different* pixel.
- ReSTIR DI replaces **only the discrete-light NEE sub-term** (the `directLight` from `calculateDirectLightingUnified` produced via `sampleLightWithImportance`) **at bounce 0 only**. It does **not** replace:
  - **Environment NEE** (separate deterministic path, `LightsSampling.js:~963-1005`) — left untouched, still fires at bounce 0.
  - **Emissive-triangle NEE** (separate light-BVH path, `ShadeKernel.js:~704-810`) — left untouched.
  - **BRDF-sampled MIS** (the BRDF side of the light/BRDF MIS, and the emissive-hit term) — left untouched. **Double-count avoidance:** §3.7.
  - **Indirect bounces (≥1)** — classic NEE, no ReSTIR.
- **Measure (verified against source):** the engine's analytic-light pdfs are all in **solid-angle measure**. Specifically `sampleRectAreaLight` returns `ls_pdf = lightDistSq / (area·cosAngle) · lightSelectionPdf` (`LightsSampling.js:127`) — the `d²/(area·cos)` factor *is* the area→solid-angle Jacobian, already baked in. So every candidate's source pdf `p(x)` and the target `p̂` are evaluated in solid-angle measure. (This corrects the original spec's "area measure on the light" justification — see §3.6.)

---

## 1. Binding budget reality + per-pass plan

### 1.1 The hard constraint (measured, cannot be raised)

**10 storage buffers per shader stage MAX** on Apple Metal-3 (already at the adapter ceiling; *not* raisable via `requiredLimits`). The budget is **per-pass** — each wavefront kernel binds only its own buffers. Storage **textures** and **sampled RenderTarget textures** do **NOT** count against the 10 (they are separate binding classes).

### 1.2 The Shade pass is SATURATED at 10/10 — ReSTIR cannot touch it

`ShadeKernel.js:2-3` (verified): `10 storage-buffer bindings: bvh, tri, mat, light, ray, rng, hit, gBuffer, counters, activeIndices`. **Zero headroom.** Therefore:

- **No reservoir buffer may be added to Shade.** All reservoir state lives in **dedicated ReSTIR passes**.
- The reservoir pool binds as **1 storage-buffer node per pass** (single `vec4`-stride buffer; §2). When a pass must read one ping-pong slot and write another, it binds **two node-views over the same GPU allocation** (the `PackedRayBuffer.js:76-79` `.ro`/`.rw` trick) → counts as 2 bindings but addresses disjoint slots.

### 1.3 Per-pass binding audit (Phase 1 = 3 ReSTIR passes; spatial deferred)

Legend: **SB** = storage buffer (counts vs the 10 cap). Textures/uniforms do not count.

#### `restirInitial` — canonical RIS candidate generation (after bounce-0 hit+material resolve)
Builds a fresh per-pixel reservoir from `M` candidate lights (M≈8–32, re-tune). Target `p̂` = **unshadowed** luminance of `f·|n·ωᵢ|·Le` (no shadow ray here; visibility deferred to `restirResolve`). Candidate generation reuses `sampleLightWithImportance()` (`LightsSampling.js:259`), which reads the 4 light buffers.

| # | Binding | mode | purpose |
|---|---|---|---|
| 1 | `hitBufferRO` | ro | bounce-0 dist/triIdx/bary/normal/**matIdx** |
| 2 | `rayBufferRO` | ro | primary ray origin/dir → reconstruct world hit `P`, view `ωₒ` |
| 3 | `rngBufferRW` | rw | RIS adoption stream |
| 4 | `materialBuffer` | ro | BRDF eval for `p̂` (Disney lobes) |
| 5 | `directionalLightsBuffer` | ro | candidate source |
| 6 | `areaLightsBuffer` | ro | candidate source |
| 7 | `pointLightsBuffer` | ro | candidate source |
| 8 | `spotLightsBuffer` | ro | candidate source |
| 9 | `reservoir.rw` | rw | write current-parity reservoir |

**SB = 9 ≤ 10.** ✅ (1 free) — material array textures + envCDF are textures (0 SB). `triangleBuffer`/`bvhBuffer` NOT bound (no trace here). Emissive-triangle candidates are **excluded** from the reservoir (stay in Shade) precisely to avoid `triangleBuffer`+light-BVH pushing this to 11 (§7-R5).

#### `restirTemporal` — temporal reuse (GRIS, unbiased)
Reprojects the prev-frame reservoir via the motion vector, runs an **explicit disocclusion gate** (depth+normal compare; §7-R6 — MotionVector's own validity flag is bounds-only), M-caps the history, and combines via the pairwise MIS rule (§3.4). Re-evaluates `p̂` at the **current** pixel — material recoverable from `hitBufferRO`'s matIdx.

| # | Binding | mode | purpose |
|---|---|---|---|
| 1 | `hitBufferRO` | ro | current `P,n,ωₒ,matIdx` |
| 2 | `rayBufferRO` | ro | reconstruct current `P`, `ωₒ` |
| 3 | `rngBufferRW` | rw | combine adoption RNG |
| 4 | `materialBuffer` | ro | `p̂` at current pixel for the merged sample |
| 5 | `reservoir.ro` | ro | **prev-parity** reservoir (reprojected) |
| 6 | `reservoir.rw` | rw | **cur-parity** reservoir (restirInitial output, merged in place) |

**SB = 6 ≤ 10.** ✅ Motion vector (`motionVector:screenSpace`, a sampled RT) and prev-frame `normalDepth` history (`StorageTexturePool.getReadTextures().normalDepth`) are read via `texture()` → **0 SB**.

#### `restirResolve` — shadow test + add into RAY.RADIANCE_ALPHA
Reads the finalized reservoir, traces **one** shadow ray to the chosen light point, computes `f·|n·ωᵢ|·Le·V·W`, and **adds it into the ray's `RAY.RADIANCE_ALPHA`** with the *same* firefly wrapper Shade uses (so the production accumulator picks it up with zero FinalWrite changes).

| # | Binding | mode | purpose |
|---|---|---|---|
| 1 | `bvhBuffer` | ro | `traverseBVHShadow` |
| 2 | `triangleBuffer` | ro | shadow-ray triangle test |
| 3 | `materialBuffer` | ro | shadow alpha/side-cull + final BRDF eval |
| 4 | `hitBufferRO` | ro | hit `P`/`n`/matIdx for shadow origin + BRDF |
| 5 | `rayBufferRW` | rw | **add contribution into RADIANCE_ALPHA** |
| 6 | `rngBufferRW` | rw | (optional) area-light point resample for the shadow target |
| 7 | `reservoir.ro` | ro | read finalized reservoir |

**SB = 7 ≤ 10.** ✅ Light emission for the shadow target is recovered from the **stored world light-point** + `lightSampleId` (re-derive `Le` analytically) — analytic light buffers are NOT re-bound. Env emission would need the env texture (a texture, 0 SB) — but env is out of the reservoir in Phase 1.

### 1.4 Densest-pass verdict

| Pass | SB | headroom |
|---|---|---|
| `restirInitial` | **9** | 1 |
| `restirTemporal` | 6 | 4 |
| `restirResolve` | 7 | 3 |
| *(Shade, untouched)* | 10 | 0 |
| *(deferred) `restirSpatial`* | 7 (with `gBufferRO` for honest foreign-target) | 3 |

**No ReSTIR pass exceeds 10.** The budget thesis is verified-sound (BUDGET VERDICT: "every ReSTIR pass stays ≤9").

---

## 2. Reservoir struct + GPU pool

### 2.1 Final reservoir struct (Phase 1, light-POINT storage, packed)

The single load-bearing change vs the salvage: the sample is **world-self-describing** (a light point), so `p̂` can be re-evaluated at a foreign pixel; and it carries the **sample's own-domain target** `pHatOwn` for the MIS numerator. The salvage's `visibility`/`frameAge`/`dirX`/`dirY` are **dropped** — the visibility cache is itself an Algorithm-4 bias source (it bleeds light across occlusion boundaries; the salvage's own comment admits it), and direction-only storage is the area-light bias (§7-R3).

```js
// rayzee/src/TSL/ReSTIRCore.js
export const Reservoir = struct( {
    // ── RIS state ──
    lightSampleId: 'float',  // encoded lightType*100 + indexWithinType; RESTIR_ID_NONE sentinel
    wSum:          'float',  // Σ resampling weights (RIS numerator, running)
    W:             'float',  // UCW: unbiased contribution weight (finalized post-combine)
    M:             'float',  // confidence weight (capped sample count)

    // ── sample y, world-self-describing (NEW — enables foreign-pixel p̂ re-eval) ──
    samplePosX:    'float',  // world position of the light sample point
    samplePosY:    'float',  //   area/emissive: the sampled point on the light
    samplePosZ:    'float',  //   point/spot:   the light world position
                             //   directional:  shadingPos + dir·LARGE (a far point)
    pHatOwn:       'float',  // p̂ of y at the sample's OWN (producing) pixel — the MIS-numerator
                             //   term p̂_i(y_i). Set ONCE at restirInitial. NEVER overwritten by
                             //   combine. (Verifier-mandated split, §7-R2.)
} );
// 8 floats = 2 vec4 (core + aux) = 32 bytes / reservoir.
```

**Field semantics & the two cross-pass invariants (the verifiers' top bias risk, §7-R2):**

| Field | Role | Invariant |
|---|---|---|
| `lightSampleId` | light identity (type·100+idx); re-derive `Le` + analytic geometry without storing radiance | — |
| `wSum` | RIS numerator | — |
| `W` | **UCW.** After combine: `W = wSum / p̂_canonical(chosen)` — **NO `1/M`** (the M-normalization lives inside the per-sample MIS weights `mᵢ`, §3) | finalized only |
| `M` | confidence weight; feeds the balance-heuristic denominator `Σ_j c_j p̂_j` | capped (temporal) |
| `samplePos{X,Y,Z}` | world light point; lets `p̂` be re-evaluated at any pixel (direction = `normalize(samplePos − P)`, `d = |samplePos − P|`) | immutable per chosen sample |
| `pHatOwn` | `p̂_i(y_i)` — target of the sample at *its own* producing pixel. Used as the **MIS numerator** for that sample. | **Set ONCE at restirInitial; carried as immutable sample metadata; NEVER overwritten by any combine.** The current-pixel target `p̂_canonical(y)` (for `W` and the MIS denominator self-term) is computed **FRESH** at finalize — it is a *different quantity* and must not reuse this field. |

> **Why `pHatOwn` must be split out (verifier MIS verdict #3, the silent re-bias):** if one field is overloaded to mean both "own-domain target (MIS numerator `p̂_i(y_i)`)" and "current-pixel target (for `W`)", then after a reservoir passes through one combine its stored target gets overwritten to the *current-pixel* value, and the next frame reads it as a neighbor's *own-domain* value — two different quantities. That makes `Σ_i mᵢ ≠ 1` and silently reintroduces bias. The fix is the explicit split: `pHatOwn` is write-once sample metadata; the canonical (current-pixel) target is always recomputed fresh at finalize.

### 2.2 GPU layout — vec4-stride, double-buffered, 1 binding/pass

8 floats = **2 vec4** (core + aux). Double-buffered (temporal) → **2 slots/pixel = 4 vec4 = 64 bytes/pixel**. One `StorageInstancedBufferAttribute(Float32Array, 4)` wrapped in `storage(attr, 'vec4')` ⇒ **1 binding** per pass.

```
Per pixel p (row-major, pixelIdx = y·width + x), 4 vec4 contiguous:
  [ slot0.core, slot0.aux, slot1.core, slot1.aux ]
   core = vec4( lightSampleId, wSum, W, M )
   aux  = vec4( samplePosX, samplePosY, samplePosZ, pHatOwn )

baseIdx(p, slotBit) = pixelIdx*4 + slotBit*2     // salvage reservoirSlotIndex, unchanged
  buffer.element(baseIdx)     → core
  buffer.element(baseIdx + 1) → aux
```

```js
export const reservoirSlotIndex = Fn( ( [ pixelX, pixelY, width, slotBit ] ) => {
    const pixelIdx = pixelY.mul( width ).add( pixelX );
    return pixelIdx.mul( int( 4 ) ).add( slotBit.mul( int( 2 ) ) );
} );
```

### 2.3 Per-pass slot table + ping-pong contract (closes the verifiers' "spatial race / parity ambiguity")

Reservoirs MUST be storage **buffers** (a StorageTexture read in a *prior* dispatch returns zeros on this stack). Ping-pong is a single `int` uniform `frameParity`, flipped **once per frame after `finalWrite`** — this is a **net-new mechanism**, NOT a mirror of the SoA buffers (the wavefront renderer explicitly does *not* ping-pong its SoA buffers: `PathTracer.js:309` "No swap: pingPong stays 0"). Correcting the original spec's false "mirrors existing cadence" claim (BUDGET VERDICT #4).

Let `cur = parity`, `prev = parity ^ 1`. Phase-1 passes (spatial omitted):

| Pass | reads slot | writes slot | notes |
|---|---|---|---|
| `restirInitial` | — | `cur` | fresh canonical reservoir |
| `restirTemporal` | `prev` (reprojected) + `cur` (canonical) | `cur` | merge prev into cur in place; `prev` is read-only |
| `restirResolve` | `cur` | — (writes `RAY.RADIANCE_ALPHA`) | reads the finalized cur reservoir |
| *(frame end)* `pool.swap()` | — | — | `frameParity ^= 1` → this frame's `cur` becomes next frame's `prev` (the temporal feedback) |

`restirTemporal` reads `prev` and writes `cur` (disjoint slots, no hazard). `restirResolve` reads only `cur`. After `swap()`, next frame's `restirTemporal` reads this frame's `cur` as its `prev` — the intended temporal chain. **When spatial is added (deferred):** it reads `cur` neighbors and must write to a slot disjoint from its reads to avoid the gather read-after-write hazard; the resolved approach is a documented per-pass (read,write,parity) extension of this table, not an ad-hoc dead-slot reuse. (§7-R4.)

### 2.4 Exact bytes/pixel + VRAM

```
per reservoir : 8 floats × 4 B          =  32 B
per pixel     : 2 slots × 32 B          =  64 B    (double-buffered)
512²  (gate)        : 64 × 262 144       ≈  16.0 MB
1080p (1920×1080)   : 64 × 2 073 600     ≈ 126.6 MB
1440p (2560×1440)   : 64 × 3 686 400     ≈ 225.0 MB
2048² (max preset)  : 64 × 4 194 304     = 256.0 MB
```

256 MB at the 2048² ceiling — within the roadmap §2 ≈100 B/pixel headroom (64 B used). **One binding** ⇒ every ReSTIR pass has ≥3 free storage slots.

> **VRAM-claim reconciliation (TSL VERDICT #3 flagged a 2-vec4-vs-3-vec4 contradiction across the input docs):** the Phase-1 struct is **2 vec4 = 64 B/pixel = 256 MB @2048²**, *not* 3 vec4. The original "3 vec4 / store Le·G" plan is **rejected** because: (a) storing the light *point* + `lightSampleId` lets `Le` be re-derived analytically without a light-buffer bind, so no separate `Le·G` float is needed; (b) `restirTemporal`/`restirResolve` re-read the material from `hitBufferRO`'s matIdx at the *current* pixel anyway, so they do not need light buffers (their audits hold at 6/7 SB without the extra vec4). The single extra scalar beyond the salvage's 8 is `pHatOwn`, which replaces the dropped `visibility`/`frameAge` within the same 32-byte budget.

### 2.5 Lazy allocation — zero VRAM in production

`ReSTIRReservoirPool` (port the salvage pattern, hardened against the verified resize footgun: `node.value`-swap to *grow* a storage buffer is non-viable in-flow — it only sticks at idle; `project_wavefront_resize_norebuild`).

```js
// rayzee/src/Processor/ReSTIRReservoirPool.js (deltas from salvage)
const VEC4S_PER_SLOT = 2, SLOTS_PER_PIXEL = 2, FLOATS_PER_VEC4 = 4;

export class ReSTIRReservoirPool {
    constructor() {
        this.width = 0; this.height = 0;
        this._activated = false; this._frameParity = 0;
        this.frameParityUniform = uniform( 0, 'int' );
        this.resolutionUniform  = uniform( new Vector2( 0, 0 ), 'vec2' );
        this._createStub();                 // 1 vec4 → node exists for graph compile (~16 B)
    }
    _createStub() {
        this.attr = new StorageInstancedBufferAttribute( new Float32Array( FLOATS_PER_VEC4 ), 4 );
        this.node = storage( this.attr, 'vec4' );        // .rw view (read-write current)
        this.nodeRO = this.node.toReadOnly?.() ?? this.node; // .ro view over SAME attr (prev slot)
    }
    // PRE-ALLOCATE-AT-MAX: size once to MAX_STORAGE_TEXTURE_SIZE², never grow. Resolution
    // changes ride the resolution uniform + bounds-cull (StorageTexturePool over-alloc pattern).
    activateAtMax( maxDim ) {               // maxDim = MAX_STORAGE_TEXTURE_SIZE (2048)
        if ( this._activated ) return;
        this._allocate( maxDim, maxDim );   // one-shot, at an idle toggle point
        this._activated = true;
    }
    setSize( w, h ) { this.width = w; this.height = h; this.resolutionUniform.value.set( w, h ); } // uniform only; never reallocates once activated
    _allocate( w, h ) {
        const vec4Count = w * h * VEC4S_PER_SLOT * SLOTS_PER_PIXEL;
        this.attr = new StorageInstancedBufferAttribute( new Float32Array( vec4Count * FLOATS_PER_VEC4 ), 4 );
        this.node.value = this.attr; this.node.count = vec4Count;   // SAFE: one-shot at idle, NOT per-frame
        if ( this.nodeRO !== this.node ) { this.nodeRO.value = this.attr; this.nodeRO.count = vec4Count; }
    }
    swap()  { this._frameParity ^= 1; this.frameParityUniform.value = this._frameParity; }
    clear() { if ( this.attr ) { this.attr.array.fill( 0 ); this.attr.needsUpdate = true; } } // on pipeline:reset
    deactivate() { this._createStub(); this._activated = false; }   // production / flag-off → reclaim VRAM (256 MB → 16 B)
    isActivated() { return this._activated; }
}
```

- **Production VRAM = 16 bytes** (the stub). The full buffer is never allocated while `renderMode === 1`.
- `node.value`-swap fires **only** in `activateAtMax`/`deactivate` — both at quiescent mode-toggle points coincident with a kernel rebuild, never inside `render()`. Respects the verified resize footgun.
- **Pre-allocate-at-max** (not per-resolution realloc) because resolution sliders fire mid-session and each realloc is a `node.value` swap that only sticks at idle. Allocate once at 2048²; pixels ≥ current `w×h` are simply never touched (bounds-cull). Cost: 256 MB pinned whenever interactive-ReSTIR is on; zero in production.

---

## 3. The unbiased estimator math

Notation follows Bitterli et al. 2020 ("Spatiotemporal Reservoir Resampling", ReSTIR DI) and Lin et al. 2022 ("Generalized Resampled Importance Sampling", GRIS). The continuous-domain proof was confirmed **sound** by all three MIS verdicts; the corrections below are at the discretization/storage interface, where the actual bias enters.

### 3.1 The integrand and the target function

Direct illumination at a primary hit (outgoing `ωₒ`, normal `n`, BSDF `f`):

```
L_direct = ∫_lights  f(ωₒ, ωᵢ) · ⟨n·ωᵢ⟩ · Le(x) · V(x)  dx          ... (integrand)
```

**Target function** `p̂` — the unnormalized distribution we resample proportional to. Per Bitterli §3.2, `p̂ ∝ unshadowed integrand`:

```
p̂(x) = luminance( f(ωₒ, ωᵢ(x)) · ⟨n·ωᵢ(x)⟩ · Le(x) )                 ... (1)
```

where:
- `f` = `evaluateMaterialResponseFromDots(material, dots)` (`MaterialEvaluation.js:28`) — BRDF value, no cosine baked in.
- **`⟨n·ωᵢ⟩` = `max(dot(n, ωᵢ), 0)` — a TRUE clamped cosine, computed explicitly. DO NOT use `computeDotProducts().NoL`** — that floors NoL at `0.001` (`Common.js:153`, verified), which keeps `p̂ > 0` for back-facing samples that geometrically cannot exist at this pixel, injecting a nonzero floor into the balance-heuristic denominator `Σ_j c_j p̂_j(yᵢ)` and perturbing every `mᵢ` (a genuine small bias). **(Verifier MIS verdict #6.)** Use a dedicated `pHatCosine = max(dot(n, ωᵢ), 0)` so that a sample below the hemisphere yields `p̂ = 0` and is cleanly excluded (its `mᵢ` numerator and denominator term both vanish).
- `Le(x)` = analytic light emission (distance attenuation / cone / gobo / IES already folded in).
- `luminance(·)` = `dot(c, vec3(0.2126, 0.7152, 0.0722))` (`Common.js:83`).
- **`V` (visibility) is excluded from `p̂`** (standard ReSTIR DI, Bitterli §5.1): the unshadowed target is cheap (no shadow ray during resampling). Unbiasedness is preserved because `V ≤ 1` is a multiplicative factor applied **once at the final shade** (Eq. 18), and the chosen sample's `W` is computed against the *same* unshadowed `p̂` every candidate is weighted against. **Enforcement requirement:** the *same* unshadowed `p̂` must be used in **every** `mᵢ` numerator AND denominator at every pixel; mixing a shadowed `p̂` into one term breaks `Σ mᵢ = 1`. Assert in code review.

**Source pdf** `p(x)` — the pdf of the technique that generated a candidate. The WRS selector returns it directly: `p(x) = lightSample.pdf` from `sampleLightWithImportance()` (`LightsSampling.js:259`) = (discrete WRS selection prob) × (per-light solid-angle sampling pdf), `= selectedImportance/totalWeight · p_geometry`. **`p(x)` is the SOURCE pdf, NOT `p̂`** — RIS needs both; never conflate them. **For unbiased reuse, `p(x)` is needed ONLY in the initial RIS pass** (folded into `wᵢ`); temporal/spatial reuse needs only `p̂` (the target) and the carried `W` — so the importance-heuristic's pixel-dependence (`p(x)` varies by neighbor normal/material) is **never** a bias source here (it would be in a naive port). **(Verifier MIS verdict #2 — keep this front-and-center.)**

### 3.2 Initial RIS (Pass 1) — streaming WRS over M candidates

Draw `M` i.i.d. candidates `x₁…x_M ~ p`. RIS resampling weight (Bitterli Eq. 6):

```
wᵢ = p̂(xᵢ) / p(xᵢ)                            ... (3a)   [1/M folded into finalize]
```

Streaming WRS (`reservoirUpdate`, salvage Alg. 2, **reused unchanged in shape**): keep `wSum = Σ wᵢ`, adopt candidate `i` with prob `wᵢ / wSum`. On adoption, store the candidate's world `samplePos` and its `pHatOwn = p̂(xᵢ)`.

Finalize the canonical UCW (Bitterli Eq. 7):

```
            wSum
W_y  =  ─────────────                          ... (3b)
           p̂(y)
```

> **Note on the `1/M`:** Bitterli Eq. 6 puts `1/M` in `wᵢ`; equivalently drop it and write `W = wSum/(M·p̂(y))`. **Both are identical for the initial pass.** They DIVERGE under multi-reservoir combination: the unbiased estimator (§3.4) replaces the `1/M` AND the `·M` with per-reservoir MIS weights `mᵢ` — see §3.5. `restirInitial`'s finalize uses `W = wSum/(M·p̂)` (M = candidates actually streamed, counting `continue`-skipped invalid candidates as not-streamed); the combine finalize uses `W = wSum/p̂` (Eq. 8). These compose correctly because the `mᵢ` weights in the combine absorb the confidence normalization — derivation in §3.5.1.

### 3.3 Temporal reuse (Pass 2) — reproject, RE-EVALUATE at current pixel, M-cap, combine

After the canonical reservoir `R_c` is built at pixel `q`:

1. **Reproject** `q → q' = q + motion(q)` via `MotionVector` (`motionVector:screenSpace` RT; prev view-proj at `MotionVector.js:416`).
2. **Disocclusion gate (implement it here — do NOT rely on MotionVector's validity flag, which is bounds-only; §7-R6).** Read prev-frame `normalDepth` history (`StorageTexturePool.getReadTextures().normalDepth`) and reject if `q'` is off-screen OR depth/normal at `q'` deviate beyond threshold from the current surface. On rejection the temporal reservoir does not participate (`c_temporal = 0`, keeping `Σ mᵢ = 1` over the survivors).
3. **Read** `R_t` from the `prev` slot at `q'`.
4. **M-cap** the history: `c_t = min(R_t.M, RESTIR_TEMPORAL_M_CAP_MULTIPLIER · R_c.M)`, multiplier ≈ 20. Bounds history correlation (the thing that defeated the accumulator). **Legal in GRIS** — confidence weights `c_i` may be any positive value; the cap only adjusts variance/correlation, never the expectation.
5. **RE-EVALUATE the temporal sample's target at the CURRENT pixel** — the DI shift map, the single most-important correctness step:

```
p̂_q( R_t.y )  =  luminance( f_q(ωₒ, ωᵢ(y)) · max(n_q·ωᵢ(y), 0) · Le(y) )    ... (5)
```

`y` is the same light point; `ωᵢ(y) = normalize(R_t.samplePos − P_q)`, `d = |R_t.samplePos − P_q|`; `f_q`, `n_q`, `ωₒ` are the **current** pixel's BSDF/normal/view (material from `hitBufferRO` matIdx → `materialBuffer`). **Never reuse a stored current-pixel `p̂` from last frame — recompute it.** This is why DI's Jacobian is 1 (§3.6).

6. **Combine** via §3.4. The temporal partner's own-domain target is `R_t.pHatOwn` (write-once, set at the producing frame's `restirInitial`). The combine needs `p̂_q(y_t)` (Eq. 5, the temporal sample at the current pixel) and `p̂_q(y_c) = R_c.pHatOwn` (canonical sample at current pixel — its own pixel, so `pHatOwn` *is* the current-pixel value). Crucially, **both cross-evaluations are at the SAME (current) pixel `q`** for temporal-only reuse — no foreign-pixel geometry, so the partition-of-unity is exact with the budgeted state. **(This is exactly why temporal-only is the safe v1; §0.3.)**

### 3.4 THE UNBIASED COMBINATION — generalized balance heuristic / pairwise MIS

This is the crux. First the biased rule to delete, then the unbiased rule to implement, then the exact unbiasing term.

#### 3.4.1 The BIASED Bitterli Algorithm 4 (DELETE — what the salvage `reservoirCombine` does)

`ReSTIR-DI:rayzee/src/TSL/ReSTIRCore.js` `reservoirCombine` merges `b` into `a` with:

```
w_b  =  b.W · p̂_a(b.y) · b.M          ← Bitterli Algorithm 4              ... (BIASED-7)
W_final = wSum / (M_total · p̂_a(chosen)),   M_total = a.M + b.M
```

**Why biased (Bitterli §4.2):** Alg-4 weights each reservoir's contribution by its **confidence `M` alone** (`· b.M`) and normalizes by **`1/M_total`** — the count of samples, NOT the sum of probabilities under which `y` could have arisen. When `b`'s sample was drawn from a *different* target (different geometry/BSDF) and could rarely/never be produced as a canonical sample at `a`, Alg-4 over-counts it. Result: light **leaks across occlusion/orientation boundaries** (the salvage comment literally says "bleeds light across occlusion boundaries"), and the bias does **not** vanish under accumulation (the measured `N^-0.1` floor: cap=1→0.019 RMSE, cap=20→0.063).

#### 3.4.2 The UNBIASED rule — GRIS pairwise MIS (Lin 2022 Alg. 6)

For reservoirs `R_1…R_K` being combined (canonical + temporal), with confidence weights `c_i` (= capped `M_i`), chosen samples `y_i`, UCWs `W_i`, produce one survivor `y` by streaming WRS where reservoir `i`'s contribution weight is:

```
wᵢ  =  mᵢ(yᵢ) · p̂_canonical(yᵢ) · Wᵢ                                  ... (UNBIASED-7)
```

and the final reservoir weight is:

```
W_y  =  ( 1 / p̂_canonical(y) ) · wSum                                ... (8)
```

(`wSum = Σ wᵢ` accumulated). **The only structural difference from BIASED-7 is the factor `mᵢ(yᵢ)` replacing `b.M`** (and the `1/M_total` dropping from finalize). `mᵢ` is the resampling MIS weight — a generalized balance heuristic.

#### 3.4.3 The generalized balance heuristic `mᵢ` — THE EXACT UNBIASING TERM

Per GRIS Eq. 16 / Bitterli Eq. 9:

```
                cᵢ · p̂ᵢ( yᵢ )
mᵢ( yᵢ )  =  ─────────────────────────                                 ... (9)
                Σⱼ  cⱼ · p̂ⱼ( yᵢ )
```

where:
- `p̂ᵢ(yᵢ)` = reservoir `i`'s **own-domain** target at its sample `yᵢ` = the **write-once `R_i.pHatOwn`** (§2.1). For the canonical reservoir this is `R_c.pHatOwn`.
- `p̂ⱼ(yᵢ)` = **every** participating reservoir's target evaluated at the **same** sample `yᵢ`. For temporal-only over `{c, t}`, the denominator at `y_t` is `c_c·p̂_q(y_t) + c_t·p̂_t(y_t)`, where `p̂_q(y_t)` is Eq. 5 (temporal sample at current pixel) and `p̂_t(y_t) = R_t.pHatOwn`.
- `c_i` = confidence weight = capped `M_i`.

**The denominator `Σⱼ cⱼ · p̂ⱼ(yᵢ)` is the exact term that makes the estimator unbiased.** It asks, for sample `yᵢ`, across all reservoirs that could have generated it, what is the confidence-weighted total target density. Substituting Eq. 9 into UNBIASED-7, `p̂_canonical(yᵢ)` partially cancels and the per-reservoir contributions sum to an unbiased estimate because **`Σᵢ mᵢ(y) = 1` for every reachable `y`** (partition of unity, Veach 1995). Algorithm 4 replaces this entire denominator with the constant `1/M_total`, which is **not** a partition of unity over the per-reservoir domains — hence its bias.

> **Pinpoint, stated unmissably:**
> - **BIASED (Alg-4, salvage, DELETE):** `wᵢ = b.W · p̂_a(b.y) · b.M`, global `1/M_total`.
> - **UNBIASED (GRIS, IMPLEMENT):** `wᵢ = mᵢ(yᵢ) · p̂_canonical(yᵢ) · Wᵢ`, with `mᵢ = cᵢ·p̂ᵢ(yᵢ) / Σⱼ cⱼ·p̂ⱼ(yᵢ)`.
> - **The fix:** the per-reservoir confidence-COUNT `b.M` and the global `1/M_total` are REPLACED by the per-sample MIS weight `mᵢ`, whose denominator sums the confidence-weighted target pdf of EVERY participating reservoir at that sample. That denominator's partition-of-unity (`Σ mᵢ = 1`) IS the unbiasedness. `reservoirFinalize` therefore drops the `M` from its denominator: `W = wSum / p̂(chosen)`.

#### 3.4.4 The canonical reservoir's weight — pairwise form, NO bolted-on 1/K

For temporal-only (`K = 2`: canonical `c` + temporal `t`), the pairwise weights are:

```
                  c_t · p̂_t( y_t )
m_t( y_t )  =  ──────────────────────────────────              (temporal)   ... (10a)
                c_t · p̂_t(y_t) + c_c · p̂_q(y_t)

                  c_c · p̂_q( y_c )
m_c( y_c )  =  ──────────────────────────────────              (canonical)  ... (10b)
                c_c · p̂_q(y_c) + c_t · p̂_t(y_c)
```

where `p̂_q(y_c) = R_c.pHatOwn` (canonical sample at its own = current pixel) and `p̂_t(y_c)` is the canonical sample evaluated **under the temporal reservoir's target** — but for **temporal reuse the temporal "domain" is the SAME pixel `q`** (we reproject the *sample*, not the shading point), so `p̂_t(y_c) = p̂_q(y_c) = R_c.pHatOwn` and `m_c + m_t = 1` holds directly with `c_c, c_t` as the only weights. **No separate additive `1/K` defensive term.**

> **The `1/K` correction (verifier MIS verdict #8 — likely-biased-high-on-canonical):** the original spec's Eq. 10b bolted a flat `1/K` ON TOP of the pairwise sum. That does **not** preserve `Σ mᵢ = 1` — it over-weights the canonical and brightens systematically. **Defensiveness in GRIS Alg. 6 comes from the guaranteed-nonzero own-target term INSIDE the pairwise structure** (the canonical is compared against each partner and gets its share from each comparison), NOT from an extra additive term. The canonical reservoir is **always included** (the fresh per-pixel RIS reservoir is one of the combined reservoirs — Bitterli §5 / GRIS §5.3 defensive sampling), which guarantees any sample the current pixel *can* generate has nonzero combined probability; that inclusion is the defensiveness, and Eq. 10b already encodes it. The equal-sample convergence gate (§6) will catch any residual 1/K-style brightening as a *systematic* offset (not a noise floor).

#### 3.4.5 Cross-pass UCW composition (verifier MIS verdict #2 #8 — prove `W` stays a valid UCW)

`restirInitial` finalizes `W_c = wSum_c/(M_c·p̂_c)` (Eq. 3b). `restirTemporal`'s combine accumulates `wSum' = m_c·p̂_q(y_c)·W_c + m_t·p̂_q(y_t)·W_t` and finalizes `W' = wSum'/p̂_q(y_survivor)` (Eq. 8). Substituting `W_c` and `W_t` (each themselves a valid UCW of its source's RIS stream) into UNBIASED-7, and using `Σ m = 1`, `E[W' · p̂_q(y) · f̂(y)] = ∫ f·cos·Le` per the GRIS recursion theorem (Lin 2022 Thm 1). The `M`-in-finalize of Pass 1 vs `no-M` of the combine compose correctly **because** the `m_i` weights in the combine carry the confidence normalization that Pass-1's `1/M` represented. **Phase-0/1 unit test (§5):** numerically verify `Σ_i m_i = 1` on a hand-built 2-reservoir case (canonical + temporal) with distinct `c`, `p̂` — this is the cheapest guard against the `pHatOwn`-overload and `1/K` bugs.

### 3.5 (reserved — folded into 3.4.5)

### 3.6 The DI shift map and its Jacobian = 1 (with the CORRECT justification)

For DI with a shared light sample, the shift is trivial. **All light types in this engine integrate in SOLID-ANGLE measure** (verified: `sampleRectAreaLight` bakes the `d²/(area·cos)` area→solid-angle Jacobian into its pdf, `LightsSampling.js:127`). Reusing the sample at a different pixel means re-connecting to the **same light point**, giving the **same direction** (for the connecting segment) in solid-angle measure ⇒ **Jacobian J = 1**.

> **Correction (verifier MIS verdict #5 / verdict #4):** the original spec justified area-light J=1 with "area measure, identical light point" — the WRONG mechanism for this codebase (the engine pdf is solid-angle, not area). The CORRECT reason is: **the engine expresses every light pdf in solid-angle measure, the connecting direction is shared, so J=1.** The conclusion is right; the implementer must know `p̂` is in solid-angle measure so the geometry term `cosθ_light/d²` lives **inside** the re-evaluated target (Eq. 5), not in a separate Jacobian.
>
> **The non-negotiable condition for J=1:** `p̂` MUST be re-evaluated per pixel (Eq. 5/6 recompute `Le·f·cos` against the current pixel using `samplePos`). If any optimization ever caches `p̂` across the shift instead of re-evaluating, J≠1 silently and bias returns. Assert/comment this at every re-eval call site.
>
> **Why light-POINT storage (not direction) is required for area/point/spot (§7-R3):** the salvage stored a *direction* (octahedral `dirX/dirY`). Re-using a direction at a new shading point does NOT hit the same area-light point — it hits a *different* point or misses, so re-deriving `Le` from a stored direction is a different (or invalid) area-measure sample with J≠1. Storing the **world point** and re-deriving `direction = normalize(point − P)`, `d = |point − P|` per pixel is what makes J=1 actually hold. Direction-only is correct ONLY for directional/env (true infinite-distance directions) — which is why env, if added later, can store a direction, but Phase-1 analytic lights store a point.

**Natural invalidation (mᵢ → 0 cleanly):**
- **Orientation:** if `max(n_q·ωᵢ(y), 0) = 0` (light below the current hemisphere) then `p̂_q(y) = 0` (with the TRUE clamped cosine, §3.1) → that reservoir's `wᵢ = 0` and its `mᵢ` numerator/denominator term vanish. The sample cannot survive — correct. (This is why the floored `NoL` must NOT be used: it would leave `p̂ > 0` for an impossible sample.)
- **Visibility:** occlusion at the current pixel kills the *contribution* at shade time (`V=0`, Eq. 18) — correct/unbiased — but does NOT zero the unshadowed `p̂_q(y)`, so `mᵢ` is unaffected. Light leak is prevented by the **final shadow ray**, not by `mᵢ`.
- **Disocclusion (temporal):** hard-gated before combine (§3.3 step 2) — the reservoir drops out (`c=0`), keeping `Σ mᵢ = 1` over the survivors.

### 3.7 Composition with the surviving MIS terms (double-count avoidance — verifier verdict #4)

ReSTIR replaces ONLY the discrete-light NEE term at bounce 0. The surviving terms that still write into `RAY.RADIANCE_ALPHA`:
- **BRDF-sampled MIS term** (the BRDF side of light/BRDF MIS in `calculateDirectLightingUnified`, plus the emissive-hit term in the main loop): **left firing.** Double-count risk: the BRDF-sampled path can hit an analytic *area* light and its power-heuristic MIS weight was computed against the *light-sampling* pdf. **Resolution for Phase 1:** ReSTIR DI is restricted to the discrete light *selection+sampling* sub-term; the BRDF-sampled side keeps its existing power-heuristic weight against the analytic light pdf (unchanged), and ReSTIR's `restirResolve` contribution uses the *light-side* MIS weight only. Because both sides retain their respective MIS weights against the *same* analytic light pdf convention, they remain a valid 2-strategy MIS partition (light side now estimated via reservoir UCW instead of single-sample, but the per-strategy MIS weight is unchanged). **Validation:** the §6 equal-sample convergence gate on a scene with glossy area-light highlights specifically tests for double-count brightening; if `RMSE_RS(4096)` plateaus above `RMSE_BF(4096)` on highlights, the MIS weights are inconsistent and must be reconciled before merge.
- **Environment NEE** + **emissive-triangle NEE**: separate additive terms, untouched (§7-R5). Consequence: the "one shadow ray for the ENTIRE direct-lighting estimate" claim is **false** in Phase 1 — env and emissive-tri keep their own shadow rays. ReSTIR provides one shadow ray for the *analytic-discrete-light* estimate only.

### 3.8 Final shaded estimate (Pass 3 — restirResolve)

After temporal combine yields the final reservoir (survivor `y`, weight `W_y`, Eq. 8), trace **one** shadow ray (`traceShadowRay()`, `LightsDirect.js:65`) toward the world point `R.samplePos` and shade:

```
L_discreteDirect(q)  =  f_q(ωₒ, ωᵢ(y)) · max(n_q·ωᵢ(y), 0) · Le(y) · V(y) · W_y    ... (18)
```

`= f·cos·Le/p̂_q(y) · wSum · V` (since `W_y = wSum/p̂_q(y)`). One shadow ray for the entire *analytic-discrete-light* estimate, regardless of M. This **replaces** the bounce-0 `directLight` add inside `ShadeKernel.js:693-701` (which is **gated off** when ReSTIR is on; §4.3) and is **added into `RAY.RADIANCE_ALPHA`** with the identical `regularizePathContribution` firefly wrapper and `throughput·L·giScale` (giScale=1 at bounce 0) shape.

---

## 4. Pass DAG + PathTracer integration + production gating

### 4.1 Governing integration facts (verified — corrects the original spec's false claims)

| Fact | Source | Consequence |
|---|---|---|
| **G-buffer is written INSIDE ShadeKernel** (line 376 miss / 604 hit), NOT in Extend. Extend writes only the raw hit via `writeHitPacked` (dist/tri/bary/normal/matIdx). | `ExtendKernel.js:59`, `ShadeKernel.js:376,604` | The "dispatch ReSTIR *between* Extend and Shade" claim is **FALSE** — the G-buffer doesn't exist there, and the raw hit lacks position/material/view. **ReSTIR passes run AFTER bounce-0 Shade** (the hit + G-buffer + material resolve all exist). They reconstruct `P = rayOrigin + rayDir·hitDist`, `ωₒ = −rayDir`, `material = sampleAllMaterialTextures(materialBuffer[hitMatIdx], …)`. |
| Bounce-0 HIT data survives Shade (Shade reads, doesn't overwrite the hit it needs) | `ShadeKernel.js` | `restirInitial` can read the bounce-0 hit after Shade(0). |
| G-buffer stores ONLY packed normal/depth/albedo — NO position, NO material index, NO `ωₒ` | `PackedRayBuffer.js:152` | Material/position come from the **HIT buffer** (matIdx) + ray reconstruction, NOT the G-buffer. (This is why **spatial** reuse — which needs a *neighbor's* material — is deferred; §7-R4.) |
| `rayID = subSample·(w·h) + pixelIndex`; reservoirs indexed per-PIXEL | `GenerateKernel.js:64` | ReSTIR runs on sub-sample 0; `pixelIndex = rayID % (w·h)`. With S>1 the non-zero sub-samples must NOT lose direct light → force S=1 (§7-R1). |
| Accumulator = `mix(prevAccum, sampleColor, 1/frameCount)` reading `RAY.RADIANCE_ALPHA` | `FinalWriteKernel.js:57-95`, `PathTracerStage.js:1125` | ReSTIR output **added into `RAY.RADIANCE_ALPHA`** ⇒ **zero FinalWrite changes**. |
| `getDecorrelatedSeed`, `pcgHash`, `RandomValue` are TSL/`wgslFn`; `RandomValue(state)` mutates a `.toVar()` uint in place, returns scalar `[0,1)` | `Random.js:134,502` | Combine adoption draws pass `rngState.toVar()` by reference. **No RNG replay needed** — the chosen sample (world point + id + `pHatOwn`) is stored; temporal re-evaluates `p̂` deterministically from stored data + material (re-eval consumes no RNG). |

### 4.2 Pass DAG (Phase 1 — 3 bounce-0-only passes; spatial deferred)

```
 resetCounters
 generate            ── writes rays + per-pixel G-buffer stub (sub-sample 0)
 initActiveIndices
 ┌─ bounce 0 ──────────────────────────────────────────────────────────────┐
 │  extend            ── BVH closest-hit → HIT buffer (dist/tri/bary/n/matIdx)│
 │  shade             ── material eval + bounce gen + NEE; writes G-buffer    │
 │                       *** bounce-0 discrete-light directLight term GATED   │
 │                           OFF when (bounceIndex==0 && enableReSTIR)        │
 │                           at ShadeKernel.js:693-701 — env + emissive-tri   │
 │                           NEE + BRDF-MIS STAY ON ***                       │
 │                                                                            │
 │  [NEW] restirInitial   RIS: M analytic-light candidates → reservoir(cur)   │
 │  [NEW] restirTemporal  reproject + disocclusion-gate + M-cap + GRIS combine│
 │  [NEW] restirResolve   1 shadow ray → add f·cos·Le·V·W into RADIANCE_ALPHA │
 │                                                                            │
 │  resetActiveCounter / compact / compactCopyback / snapshotBounceCount      │
 └────────────────────────────────────────────────────────────────────────┘
 bounce 1…N           ── normal extend→shade (no ReSTIR; indirect only)
 finalWrite           ── temporal accumulate (reads RADIANCE_ALPHA), MRT write
 [pool.swap()]         ── frameParity ^= 1 (net-new; NOT a mirror of SoA ping-pong)
```

**Insertion point in `PathTracer.js`:** inside the bounce loop, **only when `bounce === 0 && enableReSTIR.value && renderMode.value === 0`**, dispatched immediately **after** `km.dispatch('shade')` and **before** `km.dispatch('resetActiveCounter')`. Bounces ≥1 skip all ReSTIR passes. `pool.swap()` is called once after `km.dispatch('finalWrite')`.

### 4.3 The Shade gate (corrects the verifier-flagged blanket-guard wording)

**Gate the bounce-0 discrete-light add ONLY** — pass `enableReSTIR` + `bounceIndex` into `buildShadeKernel` and wrap the `directLight` accumulation at `ShadeKernel.js:693-701`:

```js
// CORRECT: gate only the discrete-light term, only at bounce 0
If( bounceIndex.equal( int( 0 ) ).and( enableReSTIR ).not(), () => {
    currentRadiance.assign( vec4(
        currentRadiance.xyz.add(
            regularizePathContribution( throughput.mul( directLight ).mul( giScale ),
                float( bounceIndex ), fireflyThreshold, int( frame ) ) ),
        currentRadiance.w ) );
} );
// env NEE, emissive-tri NEE, BRDF-MIS, indirect bounces: UNCHANGED (always run)
```

> **The wording bug (BUDGET VERDICT #3):** the original file-touch table said "gate behind `enableReSTIR.not()`" — a **blanket** guard that would also suppress *indirect-bounce* NEE (which ReSTIR does NOT replace) and env/emissive NEE. The guard MUST be `(bounceIndex == 0 && enableReSTIR)`. `directLight` here is the *whole* `calculateDirectLightingUnified` result (dir+area+point+spot+env); since env is NOT in the reservoir (§7-R5), env NEE must keep flowing — so in Phase 1 the gate suppresses the discrete-analytic portion only. **Implementation requirement:** `calculateDirectLightingUnified` must be split so the **discrete-analytic** contribution and the **env** contribution are separable, and only the discrete-analytic part is gated. (If a clean split is infeasible in one pass, the fallback is: leave `calculateDirectLightingUnified` fully on but have `restirResolve` *replace* rather than *add* — out of scope for Phase 1; the split is the chosen path.)

### 4.4 Production gating — three enforcement layers (defense in depth)

`enableReSTIR` (bool uniform, default `false`), declared in `EngineDefaults.js` ENGINE_DEFAULTS, wired in `RenderSettings.js` SETTING_ROUTES, owned in `PathTracerStage` uniforms (via `UniformManager`).

1. **Config-level (the real switch):** `INTERACTIVE_RENDER_CONFIG.enableReSTIR = true`; `PRODUCTION_RENDER_CONFIG.enableReSTIR = false`. `configureForMode()` (`PathTracerApp.js:938-955`) batch-applies the config and sets the uniform per mode.
2. **Runtime assert + force-off in `configureForMode`:**
   ```js
   if ( config.renderMode === 1 ) {
       this.stages.pathTracer.setUniform( 'enableReSTIR', false );
       this.stages.pathTracer.restirPool.deactivate();   // 256 MB → 16 B
   }
   console.assert( !( config.renderMode === 1 &&
       this.stages.pathTracer.uniforms.get('enableReSTIR').value ),
       'ReSTIR DI must be OFF in production' );
   ```
3. **Dispatch-site + handler guard:** the 3 passes are dispatched only when `bounce === 0 && enableReSTIR.value && renderMode.value === 0` (so in production they cost **zero** GPU time and the pool stays a stub). `handleEnableReSTIR` (RenderSettings) clamps the value to `false` and warns when `renderMode === 1`, so even a UI poke can't enable it in production.

**Pool activation gate (in `configureForMode` / on flag flip):**
```js
if ( renderMode === 0 && enableReSTIR && !pool.isActivated() ) pool.activateAtMax( MAX_STORAGE_TEXTURE_SIZE );
if ( renderMode === 1 || !enableReSTIR ) { restirEnabledUniform.value = 0; pool.deactivate(); }
```

**Forced S=1 (the multi-sample blocker, §7-R1):** when `enableReSTIR` flips on in interactive, force `samplesPerPixel = 1` and rebuild kernels via the existing `_resolveSamplesPerPass`/`_ensureSamplesPerPass` path. ReSTIR and the multi-sample pool are **mutually exclusive**; document this in the UI handler. (Per-(pixel,subSample) reservoirs would 4× the VRAM to ~1 GB at 2048² — over budget.)

### 4.5 Reset + accumulator coherence

- `pool.clear()` on `pipeline:reset` (camera/light/material edit) — every reservoir zeroed, hooked into the existing `reset()` (`PathTracerStage.js:1051`, `frameCount → 0`, `accumulationAlpha → 1.0`).
- **Camera-move (1-spp ReSTIR regime):** on reset, each post-reset frame is effectively 1-spp; temporal reuse rebuilds from the motion-reprojected prior frame; the `1/frameCount` accumulator only averages once frames converge on a static camera. The temporal M-cap (20×) bounds how fast a static-camera reservoir saturates. **Because the GRIS combine is unbiased, the accumulator converges to the true mean** — the failure mode of all 3 prior Alg-4 attempts (per-pixel bias surviving the mean) is eliminated by construction.

---

## 5. Phase 0 + Phase 1 checklists

### 5.1 Phase 0 — RNG-replay determinism substrate

> **Why first:** the replayable-RNG substrate is the prerequisite for any future random-replay/hybrid shift (roadmap §2/Phase 3). Phase 1 DI does NOT replay RNG (it stores the sample), but the substrate must be **provable and CI-enforced** before any reuse code is trusted, and it pins the exact seed contract `GenerateKernel.js` uses.

**The verified seed contract (corrects the audit's rayID assumption):** the bounce-0 stream begins at `seed = pcgHash( getDecorrelatedSeed( pixelCoord, subSample, frame ) )` (`GenerateKernel.js:65-66`), and the first `RandomValue()` draw is `pcgHash(seed)`. **The replay key is `(pixelCoord, subSample, frame)` — `subSample ∈ [0,S)`, NOT the global `rayID`** (which folds in `subSample·w·h`). Any replay seeded from the global rayID silently desyncs.

| # | Phase 0 task | Status |
|---|---|---|
| 0.1 | [x] Port the salvage `ReSTIRReservoirPool` to `rayzee/src/Processor/ReSTIRReservoirPool.js`: stub→`activateAtMax`(one-shot, not per-resize realloc), `.ro`/`.rw` node views over one attr, `swap()`/`clear()`/`deactivate()`, `frameParity` int uniform. | ✅ done + verified (w74xqf1o0) |
| 0.2 | [x] Port the salvage struct primitives to `rayzee/src/TSL/ReSTIRCore.js` with the **Phase-1 struct** (drop `visibility`/`frameAge`/`dirX`/`dirY`; add `samplePos{X,Y,Z}`+`pHatOwn`): `Reservoir`, `emptyReservoir`, `packCore`/`packAux`/`unpackReservoir`, `reservoirSlotIndex`, `reservoirUpdate` (sig: carry `candPos`+`candPHat`), `reservoirCapM`, light-id encode/decode. **Discard** `reservoirCombine`/`reservoirCombineSpatial` (Alg-4) and `encodeOctahedral`/`decodeOctahedral` (direction storage). Added `reservoirCombineUnbiased` + `reservoirFinalizeInitial`. | ✅ done + verified (w74xqf1o0) |
| 0.3 | [ ] **RNG mirror unit test** `tests/unit/core/rngReplay.test.js` (vitest, CI): JS `Uint32Array` mirror of `pcgHash`/`wang_hash`/`getDecorrelatedSeed`/`RandomValue`-draw (byte-identical to the WGSL, `Random.js:89/103/134/502`). Assert: (a) **replay determinism** — `seed0 = pcgHash(getDecorrelatedSeed(128.5,72.5,0,7))`, `drawN(seed0,16) === drawN(seed0,16)` bit-identical; (b) **golden vector** — first 4 u32 states + 4 f32 draws hard-coded (generated once from the mirror, pasted in); (c) **decorrelation** — seeds for 4 neighboring keys pairwise distinct, mean of 4096 draws ≈ 0.5±0.05; (d) **sub-sample-key contract** — `sub=0` vs `sub=1` (same pixel/frame) yield different seeds, comment pointing at `GenerateKernel.js:59,65`. | ✅ done + verified byte-identical to WGSL (w74xqf1o0) |
| 0.4 | [ ] **GPU↔CPU equivalence** (chrome-devtools, manual gate run once per `Random.js`/three-version change): a debug-only `rngProbe` compute kernel (registered only under a `debugRNGProbe` uniform) writes `getDecorrelatedSeed`/`pcgHash` results for `pixelCoord ∈ {(128.5,72.5),(129.5,72.5)}`, `sub ∈ {0,1}`, `frame=7` into a 16-element `StorageInstancedBufferAttribute`; async-readback; assert every u32 == the Layer-A golden literal. (Catches Dawn/WGSL codegen drift the CPU test can't see. **Gates the whole project** — shift-map replay is meaningless if GPU and CPU disagree.) | ⏳ deferred → lands with first kernel (task 1.4) |
| 0.5 | [ ] **Partition-of-unity unit test** (vitest): hand-build a 2-reservoir case (canonical + temporal) with distinct `c`, `p̂`; compute `m_c`, `m_t` per Eq. 10a/10b; assert `m_c + m_t == 1` (within 1e-6). The cheapest guard against the `pHatOwn`-overload (§7-R2) and `1/K` (§3.4.4) bugs. | ✅ done + verified — both traps asserted failing-on-purpose (w74xqf1o0) |

### 5.2 Phase 1 — unbiased ReSTIR DI passes (dependency order)

| # | Phase 1 task | Depends on | Status |
|---|---|---|---|
| 1.1 | [ ] Add `enableReSTIR` flag: `EngineDefaults.js` ENGINE_DEFAULTS (`false`); `INTERACTIVE_RENDER_CONFIG.enableReSTIR=true` / `PRODUCTION_RENDER_CONFIG.enableReSTIR=false`; `RenderSettings.js` SETTING_ROUTES + `handleEnableReSTIR` (clamp false in production, `reset:true`); `UniformManager` uniform; `PathTracerStage` ownership + force-S=1 on flip. | — |  |
| 1.2 | [ ] Own the pool in `PathTracerStage`; gate `activateAtMax`/`deactivate` in `configureForMode` (§4.4); `pool.clear()` in `reset()`; `pool.setSize()` in resize path; `pool.swap()` after `finalWrite`. | 1.1, 0.1 |  |
| 1.3 | [ ] **`reservoirCombineUnbiased`** in `ReSTIRCore.js` — pairwise GRIS MIS (Eq. 9/10a/10b), `mᵢ = cᵢ·pHatOwnᵢ / Σⱼ cⱼ·p̂ⱼ(yᵢ)`, NO `1/K`, immutable return (`.wrap()` at call sites). **`reservoirFinalize`** → `W = wSum / p̂(chosen)` (drop the `M`); compute the current-pixel `p̂` FRESH, never from `pHatOwn`. | 0.2, 0.5 |  |
| 1.4 | [ ] **`ReSTIRInitialKernel.js`** (9 SB, §1.3): reconstruct `P`/`ωₒ`/`material` from HIT+ray+materialBuffer; loop M candidates via `sampleLightWithImportance`; `p̂` with **true clamped cosine** (§3.1); store world `samplePos` + `pHatOwn`; finalize `W=wSum/(M·p̂)`; write `cur` slot. | 1.2, 1.3 |  |
| 1.5 | [ ] **`ReSTIRTemporalKernel.js`** (6 SB, §1.3): reproject via `motionVector:screenSpace`; **explicit disocclusion gate** (read prev `normalDepth` history, compare depth+normal — §7-R6); read `prev` slot; M-cap (×20); re-eval `p̂_q(y_t)` (Eq. 5, true cosine); `reservoirCombineUnbiased`; write `cur`. | 1.4 |  |
| 1.6 | [ ] **`ReSTIRResolveKernel.js`** (7 SB, §1.3): read finalized `cur` reservoir; re-derive `Le` from `lightSampleId`+`samplePos`; `direction=normalize(samplePos−P)`, `dist=|samplePos−P|`; **one** `traceShadowRay`; `f·cos·Le·V·W`; **add into `RAY.RADIANCE_ALPHA`** with `regularizePathContribution`. | 1.4 |  |
| 1.7 | [ ] **Shade gate** (`ShadeKernel.js:693-701`): split `calculateDirectLightingUnified` so the discrete-analytic term is separable; gate ONLY it behind `(bounceIndex==0 && enableReSTIR)` (§4.3); env + emissive-tri + BRDF-MIS stay on. Pass `enableReSTIR`+`bounceIndex` into `buildShadeKernel`. | 1.1 |  |
| 1.8 | [ ] **Register + dispatch** in `PathTracer._buildWavefrontKernels`: register the 3 kernels; dispatch after `shade`, before `resetActiveCounter`, only when `bounce===0 && enableReSTIR.value && renderMode.value===0`; `pool.swap()` after `finalWrite`. Assert interactive-only in `_buildWavefrontKernels`. | 1.4, 1.5, 1.6, 1.7 |  |
| 1.9 | [ ] LSP diagnostics clean; `check-tsl` skill on all new TSL files (register-lean: minimize `.toVar()` for the `var<private>` opt-out; `.wrap()` on every struct-returning Fn read field-wise; clamp dot→[0,1] before any pow on decoded normalDepth). | 1.4–1.8 |  |
| 1.10 | [ ] Run the §6 acceptance gate; re-tune `M`, temporal M-cap empirically on the actual Apple/WebGPU stack (prior M=8 cost a 12× fps regression on the megakernel — expect to re-tune; `feedback_validate_gpu_perf_claims`). | 1.8 |  |

---

## 6. Validation / acceptance gate

Run entirely through the chrome-devtools perf harness against `window.app` (dev server `:5173`). **Not a vitest** — the engine has no pixel-readback; RMSE is computed **in-page** from `app.screenshot()`.

### 6.1 Preconditions (assert before any measurement)
- `app.configureForMode('interactive')` → `renderMode===0`. **Hard-assert ReSTIR is OFF in production:** flip to `production`, set `enableReSTIR=true`, assert the engine forces it back to `false` and the pool deactivates. Restore interactive.
- Same camera, resolution (512², harness default), `maxSamples`, scene for every arm. **Disable ASVGF/OIDN/EdgeFilter** (denoisers mask bias AND variance).
- **`fireflyThreshold = 1e9` on BOTH arms (THE non-negotiable corrective — verifier MIS verdict, FATAL validation).** The bounce-0 directLight is wrapped in `regularizePathContribution` (a nonlinear multiplicative firefly clamp, `ShadeKernel.js:695`). It clamps a *lower-variance* estimator (ReSTIR) **less** than brute-force NEE, so the two converged images will NOT match even though both are unbiased pre-clamp — exactly the confound that produced the prior false "+24.6% better / +9% biased bright" reading (`project_firefly_clamp_bias`, `project_restir_di_option_a.md`). Treat the clamp as out-of-estimator: disable it for both arms during the gate.

### 6.2 Stress scene
**Many small lights with partial occlusion** — the regime ReSTIR DI improves and where Alg-4 bias is visible. Concrete: a ground plane + a grid of **64–256 small emissive quads/area-lights** at varying intensity + a few occluders casting overlapping shadows (so reuse must respect visibility). Include at least one **glossy** surface lit by an area light (tests the §3.7 double-count). Checked into the perf-test assets so arms are byte-identical.

### 6.3 The two arms
- **Arm BF** (reference + baseline): brute-force analytic-light NEE, `enableReSTIR=false`.
- **Arm RS:** identical config, `enableReSTIR=true` (unbiased GRIS, temporal-only).

### 6.4 Reference + in-page RMSE primitive
`REF` = Arm BF accumulated to deep convergence (≥4096 effective spp), captured via `app.screenshot()`, decoded to a pixel array in-page. RMSE over RGB (ignore A) on the tonemapped 8-bit output (the pragmatic available signal; sufficient to distinguish "converges to REF" from "plateaus at a bias floor").

```js
// via mcp__chrome-devtools__evaluate_script
async function captureLinearPixels() {
  const url = window.app.screenshot({ type: 'image/png' });          // PathTracerApp.js:1044
  const img = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0); return ctx.getImageData(0,0,img.width,img.height).data;
}
function rmse(a,b){ let s=0,n=0; for(let i=0;i<a.length;i+=4) for(let k=0;k<3;k++){const d=(a[i+k]-b[i+k])/255;s+=d*d;n++;} return Math.sqrt(s/n); }
```

> **Measure vs INDEPENDENT-frame count, NOT accumulated-frame count (verifier ARCHITECTURE flaw / biasRisks).** With temporal M-cap=20 a reservoir persists ~20 frames, so accumulated frames are correlated and variance falls slower than `N^-0.5` in accumulated-frame terms — a correct unbiased estimator can *look* like a bias-floor plateau. **Decorrelate the reference:** drive each checkpoint by `reset()` + re-accumulate to `N` *independent* samples (camera static, but reset the reservoir between checkpoints so the temporal chain restarts), or measure the *mean image* convergence not the per-frame. This is precisely the trap that mis-diagnosed the prior Alg-4 attempt.

### 6.5 Gate (a) — UNBIASEDNESS (the non-negotiable corrective)
For each arm, at independent-sample checkpoints `N ∈ {64, 256, 1024, 4096}` (drive via `reset()` then poll `getFrameCount() >= N`, +150 ms React-settle), capture and compute `RMSE_arm(N) = rmse(capture, REF)`. **ALL must hold:**
1. **Converges to the same image, not a bias floor:** `RMSE_RS(4096) ≤ RMSE_BF(4096) + 0.003` (RS reaches essentially BF's quantization floor).
2. **Monotone decrease, no plateau:** log-log slope of `RMSE_RS(N)` over `[256,4096]` is `≤ −0.4` (approaching `N^-0.5`), NOT flat near `−0.1`. Concretely `RMSE_RS(4096) ≤ 0.5·RMSE_RS(256)`.
3. **Anti-regression tripwire:** `RMSE_RS(4096) < 0.0095` (strictly below the *best* cap=1 Alg-4 floor of 0.019 any prior attempt achieved). Near any historical floor (0.019–0.080) ⇒ **fail hard**.
4. **Occlusion-boundary check (where Alg-4 visibly bleeds):** mask RMSE to high-gradient (shadow-boundary) pixels of REF; assert (a.1) holds there too.
5. **Glossy-highlight check (double-count, §3.7):** mask RMSE to the glossy-area-light highlight region; assert (a.1) holds (no systematic brightening from inconsistent BRDF-MIS weights).

### 6.6 Gate (b) — VARIANCE WIN
1. **Equal-sample noise** at low budget `N=8` spp (ReSTIR's sweet spot): `RMSE_RS(8) ≤ 0.7·RMSE_BF(8)` (≥30% reduction on the many-lights scene).
2. **Equal-time noise** (the honest metric): use `getGpuTimePerSample().averageTotal` (single-sample timestamps are coarse on Apple/Dawn — use the average) to pick a fixed wall-clock `T` (= BF's time for ~16 spp); run each arm to `T`; assert `RMSE_RS(T) < RMSE_BF(T)`. If ReSTIR's extra passes make it slower per sample, it must still win on noise-per-second.

### 6.7 Gate (c) — Interactive-only invariant (standing, cheap)
Programmatic (no image): in `production`, `enableReSTIR` reads back `false` even after attempting `true`; the pool is a stub (`isActivated()===false`); a dispatch counter / `getStatistics()` field stays at the BF baseline (passes not dispatched).

### 6.8 Pass condition
Phase 1 ships **iff** (a.1–a.5) AND (b.1–b.2) AND (c). (a) proves *unbiased*; (b) proves *useful*; (c) proves *production-safe*. **Any (a) failure ⇒ still biased (Alg-4 regression) ⇒ DO NOT MERGE.**

---

## 7. Open risks the verifiers flagged + resolutions

Each risk the adversarial verdicts raised is **resolved in the design above**, not papered over. Cross-referenced.

| ID | Risk (verifier) | Severity | Resolution in this spec |
|---|---|---|---|
| **R1** | **Multi-sample S>1 unhandled** (BUDGET VERDICT, highest). Reservoirs are per-pixel; with S>1 the blanket Shade gate strips direct light from sub-samples 1..S-1 (darkening) while only sub-sample 0 gets ReSTIR. | BLOCKER | **Force S=1 whenever `enableReSTIR` is on** in interactive; rebuild kernels via `_resolveSamplesPerPass`/`_ensureSamplesPerPass`. ReSTIR ⊥ multi-sample pool (documented, §4.4, task 1.1). Per-(pixel,subSample) reservoirs rejected (4× VRAM → ~1 GB). |
| **R2** | **`pHatOwn` field overload re-biases** (MIS verdicts #3, #2). One field meaning both "own-domain target (MIS numerator)" and "current-pixel target (for W)" gets overwritten by combine → next frame reads it as the wrong quantity → `Σ mᵢ ≠ 1`. | BIAS (silent) | **Split into two quantities (§2.1):** `pHatOwn` = write-once `p̂_i(y_i)`, NEVER overwritten; the current-pixel target for `W` and the denominator self-term is **recomputed FRESH at finalize**. Unit-tested via the partition-of-unity test (task 0.5). |
| **R3** | **Area/point/spot Jacobian ≠ 1 under direction-only storage** (MIS verdicts #4, #5). Re-using a stored *direction* at a new pixel hits a different light point → wrong area-measure sample. | BIAS | **Store the world light POINT (§2.1), re-derive direction+distance per pixel (§3.6).** J=1 then holds (solid-angle measure, shared direction). Direction-only kept only for a *future* env/directional add-on. The salvage's octahedral encode/decode is dropped from Phase 1. |
| **R4** | **Spatial pairwise `p̂_i(y_c)` uncomputable from budgeted state** (MIS verdicts #5, #4; TSL VERDICT). The canonical-at-neighbor term needs the *neighbor's* material+normal; the G-buffer stores only normal/depth/albedo (no material index). Substituting a stored scalar breaks `Σ mᵢ = 1`. | BIAS | **Defer spatial reuse entirely (§0.3, §11).** Phase 1 is **temporal-only**, where the cross-evaluations are all at the *current* pixel (material recoverable) → exact partition-of-unity. Spatial ships only after a per-pixel **material handle** is added to the G-buffer (then `restirSpatial` binds `gBufferRO`, 6→7 SB, and re-evaluates honestly — never a scalar substitute). |
| **R5** | **Env + emissive-triangle not in `sampleLightWithImportance`** (MIS verdicts #7, #2; TSL VERDICT). Env is a separate deterministic Veach-MIS term; emissive-tri is a separate light-BVH path. A reservoir built only from `sampleLightWithImportance` excludes both; blanket-gating bounce-0 directLight would drop env entirely. | SCOPE/energy-loss | **Phase 1 reservoir covers ONLY the 4 analytic lights.** Env NEE + emissive-tri NEE stay on their own un-gated paths (§0.4, §3.7). The Shade gate is split to suppress ONLY the discrete-analytic term (§4.3). "One shadow ray for the *entire* DI" is explicitly **false** in Phase 1 — only for the analytic-discrete sub-term. |
| **R6** | **Disocclusion gate overclaimed** (TSL VERDICT). `MotionVector`'s validity flag is bounds-only (no depth/normal compare). | Quality (not bias) | **`restirTemporal` implements its own disocclusion gate** (read prev `normalDepth` history, compare depth+normal; §3.3 step 2, task 1.5). 0 extra SB (texture read). A mis-reprojected reservoir is just a worse candidate the unbiased MIS handles correctly — so this is quality, not correctness. |
| **R7** | **NoL floored at 0.001** (MIS verdict #6). `computeDotProducts().NoL = max(dot,0.001)` keeps `p̂ > 0` for back-facing samples → perturbs the balance denominator → small bias. | BIAS (small) | **Compute `p̂` with a dedicated TRUE clamped cosine `max(dot(n,ωᵢ),0)`, NOT `computeDotProducts` (§3.1).** Back-facing ⇒ `p̂=0` ⇒ clean exclusion (§3.6). |
| **R8** | **Firefly clamp defeats the validation gate** (MIS verdict, FATAL). The nonlinear clamp at `ShadeKernel.js:695` clamps low-variance ReSTIR less than BF ⇒ converged images won't match. | FATAL (validation) | **Gate runs with `fireflyThreshold=1e9` on BOTH arms (§6.1).** Clamp treated as out-of-estimator. |
| **R9** | **G-buffer/material not available "between Extend and Shade"** (verdict #3, the integration falsehood). The G-buffer is written *inside* Shade; the raw hit lacks position/material/view. | FATAL (feasibility) | **ReSTIR passes run AFTER bounce-0 Shade (§4.1, §4.2).** Reconstruct `P`/`ωₒ` from ray+hitDist; material from `hitBufferRO` matIdx → `materialBuffer` → `sampleAllMaterialTextures`. |
| **R10** | **Shade is saturated at 10/10** (MIS verdict, FATAL; BUDGET VERDICT). No room for a reservoir binding in Shade. | FATAL (feasibility) | **All reservoir state in 3 dedicated passes (§1), max 9 SB. Shade is untouched** — its bounce-0 directLight add is merely *gated off* (one extra uniform read, no new binding); ReSTIR's contribution is added into `RAY.RADIANCE_ALPHA` by `restirResolve`. |
| **R11** | **`pool.swap()` cadence claim false** (BUDGET VERDICT #4). The SoA buffers don't ping-pong per frame ("No swap", `PathTracer.js:309`). | Accuracy | **Documented as a net-new `frameParity` flip (§2.3), not a mirror.** Explicit per-pass (read,write,parity) slot table closes the ambiguity. |
| **R12** | **Motion vector one frame stale** (BUDGET VERDICT). MotionVector is a later pipeline stage; during frame N's `PathTracer.render()` only frame N-1's motion texture exists. | Quality (not bias) | **Accepted as a quality cost (documented).** A mis-reprojected reservoir is a worse candidate the MIS handles unbiasedly. World-pos reconstruction (`camPos+rayDir·linearDepth`) and prev `normalDepth` history ARE correctly available at `render()` start. If ghosting is unacceptable, the follow-up is to compute motion inline in a ReSTIR pre-pass from the available prev `normalDepth` — out of Phase-1 scope. |
| **R13** | **Cross-pass UCW composition unproven** (MIS verdicts #2, #8). Mixing `W=wSum/(M·p̂)` (Pass 1) and `W=wSum/p̂` (combine). | Correctness (proof gap) | **Derived in §3.4.5** (the `mᵢ` weights absorb the confidence normalization; GRIS Thm 1) + numerically guarded by the partition-of-unity unit test (task 0.5) + the equal-sample convergence gate (§6.5). |

### 7.1 Standing bias-risk watchlist (enforce in code review)
- **Same unshadowed `p̂` in every `mᵢ` numerator AND denominator** — never mix shadowed/unshadowed (breaks `Σ mᵢ=1`). §3.1.
- **`p̂` re-evaluated per pixel at every shift** — never cache across the shift (else J≠1 silently). Comment at every re-eval call site. §3.6.
- **Temporal M-cap stays tight enough** to bound correlation; re-tune empirically — but it does NOT bias for any positive `c_i`. §3.3.
- **The gate measures independent-frame convergence**, not accumulated-frame, to avoid reading correlation as a bias floor. §6.4.

---

## 8. File-touch summary

| File | Change |
|---|---|
| `rayzee/src/TSL/ReSTIRCore.js` (new, from salvage) | Phase-1 `Reservoir` struct (drop `visibility`/`frameAge`/`dirX`/`dirY`; add `samplePos{X,Y,Z}`+`pHatOwn`); port `reservoirUpdate`/`reservoirCapM`/`reservoirSlotIndex`/pack-unpack/light-id codec; **discard** `reservoirCombine*` (Alg-4) + octahedral codec; **add** `reservoirCombineUnbiased` (pairwise GRIS MIS, Eq. 9/10, no 1/K); **fix** `reservoirFinalize` (`W=wSum/p̂`, drop `M`). |
| `rayzee/src/Processor/ReSTIRReservoirPool.js` (new, from salvage) | Port pattern; `activateAtMax` (one-shot at idle, not per-resize); `.ro`/`.rw` node views; `swap`/`clear`/`deactivate`/`isActivated`; `frameParity` uniform. |
| `rayzee/src/TSL/ReSTIRInitialKernel.js` (new) | 9-SB canonical RIS pass (§1.3, §3.2). |
| `rayzee/src/TSL/ReSTIRTemporalKernel.js` (new) | 6-SB temporal GRIS merge + reproject + explicit disocclusion gate (§1.3, §3.3). |
| `rayzee/src/TSL/ReSTIRResolveKernel.js` (new) | 7-SB shadow test + add into `RAY.RADIANCE_ALPHA` (§1.3, §3.8). |
| `rayzee/src/TSL/ShadeKernel.js` (~693-701) | Split `calculateDirectLightingUnified` discrete-analytic vs env; gate ONLY the discrete-analytic add behind `(bounceIndex==0 && enableReSTIR)`; pass `enableReSTIR`+`bounceIndex` into `buildShadeKernel` (§4.3). |
| `rayzee/src/Stages/PathTracer.js` | Register 3 kernels in `_buildWavefrontKernels` (assert interactive-only); dispatch after `shade`, before `resetActiveCounter`, when `bounce===0 && enableReSTIR.value && renderMode.value===0`; `pool.swap()` after `finalWrite`; `pool.activateAtMax`/`setSize` in resize; `pool.clear()` in reset. |
| `rayzee/src/Stages/PathTracerStage.js` | Own the `ReSTIRReservoirPool`; declare `enableReSTIR` uniform; force `samplesPerPixel=1` on flag-on; `pool.clear()` in `reset()`. |
| `rayzee/src/managers/UniformManager.js` | Declare `enableReSTIR` uniform node. |
| `rayzee/src/EngineDefaults.js` | `enableReSTIR:false` in ENGINE_DEFAULTS; `INTERACTIVE_RENDER_CONFIG.enableReSTIR=true`; `PRODUCTION_RENDER_CONFIG.enableReSTIR=false`. |
| `rayzee/src/RenderSettings.js` | SETTING_ROUTES entry + `handleEnableReSTIR` (clamp false in production, warn, `reset:true`). |
| `rayzee/src/PathTracerApp.js` (~938-955) | `configureForMode`: force `enableReSTIR=false` + `pool.deactivate()` when `renderMode===1`; runtime `console.assert`; `pool.activateAtMax` when interactive+on. |
| `tests/unit/core/rngReplay.test.js` (new) | Phase-0 RNG mirror golden-vector + replay-determinism + sub-sample-key contract (task 0.3). |
| `tests/unit/core/restirMIS.test.js` (new) | Partition-of-unity `Σ mᵢ=1` 2-reservoir test (task 0.5). |

---

## 9. Salvage disposition (one-line summary)

| Salvage element | Action |
|---|---|
| `Reservoir` struct (8 fields) | **Reshaped** — drop `visibility`/`frameAge`/`dirX`/`dirY`; add `samplePos{X,Y,Z}`+`pHatOwn`. Same 32 B. |
| `reservoirUpdate` (streaming WRS) | **Port, minor sig** — carry `samplePos`+`pHat` not dir. |
| `reservoirCombine`/`reservoirCombineSpatial` (Alg-4) | **DISCARD. Replace** with `reservoirCombineUnbiased` (pairwise GRIS MIS). |
| `reservoirFinalize` | **Port, formula change** — `W=wSum/p̂`, drop `M`. |
| `reservoirCapM`/`reservoirSlotIndex`/pack-unpack/light-id codec | **Port as-is** (pack field list updated). |
| `encodeOctahedral`/`decodeOctahedral` | **Drop from DI** (point storage). Keep for a future env/GI direction-sample phase. |
| `ReSTIRReservoirPool` (stub→full, ping-pong, 1-binding) | **Port pattern** — `setSize`-realloc → `activateAtMax` one-shot; add `deactivate()`→stub (production VRAM=16 B). |
| M-cap constants (temporal 20, spatial 1) | **Temporal kept** (re-tune empirically). **Spatial deferred** with spatial reuse. |

---

## 10. The unbiasing term, restated one final time (so it is unmissable)

> **DELETE (biased Algorithm 4, salvage):** per-reservoir factor `b.M` + global `1/M_total` normalization.
> **IMPLEMENT (unbiased GRIS):** the generalized-balance MIS weight
> ```
>     mᵢ(yᵢ) = cᵢ · p̂ᵢ(yᵢ) / Σⱼ cⱼ · p̂ⱼ(yᵢ)
> ```
> The denominator — the confidence-weighted sum of EVERY participating reservoir's target at sample `yᵢ` — is the term that guarantees `Σᵢ mᵢ(y) = 1` (partition of unity, Veach 1995) and therefore unbiasedness. Algorithm 4 replaced this denominator with the constant `1/M_total` (a sample count, not a partition of unity) — that substitution IS the bias. `reservoirFinalize` correspondingly drops the `M`: `W = wSum / p̂(chosen)`.

---

## 11. Deferred follow-ups (each separately gated, post-Phase-1)

1. **Spatial reuse** (`restirSpatial`) — requires a per-pixel **material handle** in the G-buffer so `p̂_i(y_c)` can be re-evaluated against neighbor geometry honestly (never a scalar substitute). Binds `gBufferRO` (7 SB). Individually validated against the §6 gate. (Resolves R4 properly.)
2. **Environment in the reservoir** — fold env candidates into the candidate stream with their own `sampleEquirectProbability` solid-angle pdf, or build a unified solid-angle reservoir with consistent per-technique source pdfs. Direction storage (octahedral) is valid for env. (Resolves R5's "env excluded" by inclusion rather than separation.)
3. **Area-light positional shift across pixels** is already in Phase 1 (point storage); a future GI/PT phase needs the full reconnection-shift Jacobian (≠1) — out of scope for DI.
4. **Inline motion in a ReSTIR pre-pass** if the one-frame-stale motion (R12) causes unacceptable ghosting.
5. **Multi-sample + ReSTIR** (per-(pixel,subSample) reservoirs) only if the VRAM (≈1 GB @2048²) becomes affordable.
