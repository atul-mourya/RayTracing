# ReSTIR Path Tracing Roadmap

Roadmap (2026-06) for taking the Rayzee wavefront engine from "no live ReSTIR" to **full
ReSTIR PT** (GRIS, Lin et al. 2022) and the 2024–2026 frontier (Area ReSTIR, ReSTIR PT
Enhanced, ReSTIR-PG). Scope: assess what the current wavefront engine (`main`, post-`0ca431b`)
already provides as substrate, what the prior three ReSTIR attempts are worth, what "full
ReSTIR PT" requires per the latest research, and a phased, individually-shippable plan.

The central finding is **not** a code problem: the three prior ReSTIR DI attempts were
correct-ish but **biased (Bitterli Algorithm 4)** and built for a regime (1-spp real-time)
that fights the production progressive accumulator. The roadmap is structured around resolving
that mismatch *before* writing new ReSTIR code — see §3.

---

## 1. Current state — the three dead attempts

None of the prior ReSTIR work is on `main`. All three predate the pure-wavefront engine
(merged `0ca431b`, 2026-06-07) and were written against the now-deleted megakernel `Trace` Fn.
**None is directly runnable; any revival requires a wavefront port regardless.**

| # | Location | Architecture | State |
|---|---|---|---|
| A | branch `ReSTIR-DI` (`451b2c7`) | **Megakernel**, inline DI in `LightsSampling.js` | Complete & self-contained — the canonical impl, but **biased** |
| B | `stash@{0}` "On main: ReSTIR DI" (`1c3b927`) | Stage-based wavefront port (Initial/Temporal/Spatial) | **INCOMPLETE — will not compile** (references 4 nonexistent files) |
| C | branch `ReSTIR` (`0b976b9`) | Pre-monorepo (`src/core/`), dedicated DI **and GI** stages | Oldest; stale; 3-pass GI prototype is the best DI→GI reference |

Key facts from the audit:
- **Artifact A is biased by design.** `ReSTIR-DI:rayzee/src/TSL/ReSTIRCore.js:229-264` uses the
  "bias-correcting" combination from Bitterli §4 (**Algorithm 4**): `bWeight = b.W · p̂_a(b.sample) · b.M`.
  There is **no per-neighbor MIS weight and no Jacobian** — i.e. the unbiased Algorithm 6 / GRIS
  combination is absent. Comments at `:242-247` explicitly note spatial reuse "bleeds light across
  occlusion boundaries."
- **Why it was shelved** (verbatim, `stash:rayzee/src/PathTracerApp.js` `configureForMode`):
  > "In production mode, temporal correlation across reservoirs introduces bias that defeats SPP
  > accumulation, so hard-disable the stages and the bounce-0 branch."
- **Measured** (memory `project_restir_di_option_a.md`): correlated frames converge ~N⁻⁰·¹ (bias floor)
  instead of N⁻⁰·⁵ (variance); bias floor scales with M-cap (cap=1 → 0.019 RMSE, cap=20 → 0.063,
  +visibility-reuse → 0.080). ReSTIR only wins at N ≲ 8 spp.
- The `ReSTIR-DI` reservoir struct/pool/ping-pong (`ReSTIRCore.js:71-80`, `ReSTIRReservoirPool.js`) is
  **reusable scaffolding**; the algorithm is not.

> Do not confuse the **WRS light *selector*** on `main` (`LightsSampling.js:253-258`) with ReSTIR.
> It picks *which* light to do NEE against per shading call — stateless, per-call, unbiased, no
> temporal/spatial component. Unrelated to spatiotemporal reservoir reuse.

---

## 2. Current state — the substrate (what's already in `main`)

The wavefront engine already provides most of the *plumbing* ReSTIR PT needs:

| ReSTIR PT prerequisite | Status | Anchor |
|---|---|---|
| Multi-pass kernel architecture (ReSTIR is inherently multi-pass) | ✅ | `PathTracer.js` — Generate(`:229`)→Extend(`:302`)→Shade(`:303`)→Compact(`:306`)→FinalWrite(`:325`) |
| **Deterministic, replayable RNG** (req. for random-replay/hybrid shift) | ✅ | `Random.js` — PCG/Halton/Sobol/STBN; `getDecorrelatedSeed()` `:502` reproduces any path's draws from (frame, pixel, sample, bounce) |
| Per-pixel G-buffer (first-hit normal/depth/albedo, packed `uvec4`) | ✅ | `PackedRayBuffer.js:14-32`; `writeGBuffer()` `:152`; decode `:159-170` |
| Motion vectors + prev-frame VP matrix + disocclusion gates | ✅ | `MotionVector.js` — screen-space `:145-243`, camera matrices `:363-418` |
| Previous-frame history (color/normalDepth/albedo) | ✅ | `StorageTexturePool.js` — write-storage→copy(`:145-155`)→read-RT |
| MIS (balance + power heuristics) | ✅ | `Common.js:92-109`; emissive-hit `ShadeKernel.js:546-570`, env `:171-189` |
| Env + light + emissive-triangle sampling w/ PDFs | ✅ | `LightsSampling.js:674`, `Environment.js:72-147` (CDF lat-long, MIS-compensated) |
| Spare per-ray flag bits for ReSTIR metadata | ✅ 14 bits | `QueueManager.js` — bits 18-31 unused (16/17 = HAS_HIT_OPAQUE/AUX_LOCKED) |
| Reservoir struct / GPU pool / ping-pong | 🟡 megakernel + biased | `ReSTIR-DI:ReSTIRCore.js`, `ReSTIRReservoirPool.js` (salvageable) |
| **Path-vertex / reconnection-vertex storage** | ❌ | — |
| **Shift mappings + Jacobians** | ❌ | — |
| **Unbiased GRIS MIS (Algorithm 6 / pairwise)** | ❌ old code is Alg 4 | `ReSTIR-DI:ReSTIRCore.js:229-264` |

**Update (2026-06-10):** Phase 1 (unbiased ReSTIR DI) + Phase 2 (ReSTIR GI) are BUILT, wavefront, unbiased, and
validated (see [[project_restir_realtime]], [[project_restir_gi_phase2]]). The DI reservoir now covers **ALL light
types** — the 4 analytic + **environment (HDRI, type 4)** + **emissive triangles (type 5)** — each unbiased vs
brute-force (analytic +0.39%, env −0.97%, emissive +1.03% worst-case, env+emissive +0.89%); see
[[project_restir_env_emissive_gap]]. A real-time 1-spp DI+GI tier (`setRealtimeMode`) with ASVGF + a UI toggle is also
done (RT-1..RT-5). All on branch `feature/restir-di` (uncommitted).

**Update (2026-06-11) — Phase 3 STARTED; PT-1 DONE.** `docs/specs/restir-pt-phase03.md` stages Phase 3 as
PT-1..PT-4. **PT-1 (multi-bounce path reservoirs via suffix walk, reconnection shift at x1) is IMPLEMENTED +
GPU-VALIDATED**: the reservoir sample is now a FULL PATH (suffix folded into L_o by a ShadeKernel-parity walker
in `ReSTIRPTWalk.js`); reuse kernels/Jacobian/layout unchanged (suffix Jacobian = 1, adversarially verified).
GI now matches **full BF at equal maxBounces**: mb=4 canonical +0.033%, reuse-on −0.61%; env-on −0.002%;
all-emissive worst case −2.2% @mb1 (the documented d=1 frozen-MIS approximation, → PT-2) / +0.81% @mb4.
Also fixed en route: 2 latent Phase-2 emissive-MIS bugs, the stochastic-transparency x0 partition break,
realization-dependent valid-gating in temporal/spatial (M-engagement 35%→79%), the resolve's
pathLength=1 over-clamping, and a DI emissive-toggle gate.

**PT-2 (reconnection-vertex re-evaluation) is ALSO DONE** (same day): 6-vec4 path reservoirs storing the
reconnection data (ω1out full-f32 oct + x1 material handle + split payload A/E/B), the shared domain
evaluator `evalLo = A + E·misW(domain) + f1(V1_domain)·B` at all five touch-points (eval-after-store
canonicalization), `evaluateCombinedLobePdf` (the multi-lobe evaluator — also the PT-4 prerequisite) and
`throughputNoF` threaded out of LightsIndirect. Canonical identities EXACT vs PT-1; protocol reuse
improved to −0.56%; the all-emissive reuse residual (−2.1%) is now DIAGNOSED as the temporal x0-collapse
(history W vs today's target under sub-pixel jitter), not payload weights.

**PT-2b (motion-correct temporal) is ALSO DONE** (same day): the GI primaryHit ping-pongs (2 slots/pixel)
so gi-temporal evaluates the history arm at the TRUE previous-frame jittered x0 with real per-arm
reconnection Jacobians — the temporal x0-collapse carrier is ELIMINATED (emissive worst case
temporal-only −1.57%→−0.71% ≈ canonical; full reuse −2.09%→−1.23%; protocol mb1 reuse −0.56%→−0.17%,
mb4 −0.62%→−0.50%). **Remaining: PT-3 (hybrid shift + replay — the reconnection-vertex storage now
exists; the RNG-replay primitive test is the Phase-0 item still pending), PT-4 (generalized balance MIS
over hybrid shifts — evaluateCombinedLobePdf now exists).**

**Update (2026-06-12/13) — Phase 3 COMPLETE (mechanism): PT-3a..PT-3c-2 LANDED; PT-3d closed by
verification.** PT-3a: stride-21 prefix lane + the GPU determinism probe PASSED (bit-identical pools —
the long-pending Phase-0 RNG-replay primitive is PROVEN); the harness's broken BF-vs-BF determinism was
also fixed (3 mandatory engine settings, puppeteer-core runner). PT-3b: glossy-x0 participation widening
(canonical-only via the nonReusable bit). PT-3c-1: true deeper anchors — walker k-selection,
`ReSTIRGIReplay.js` PSS prefix replay, resolve re-anchored V, RIS denominator p_{k−1}. PT-3c-2:
reuse-side replay (k-branched giPHat in BOTH reuse kernels); its initial −21.755% regression was
root-caused to a `target`-named struct field (WGSL reserved keyword → silently invalid pipelines,
all-zero pool) + a JS-unrolled spatial fold (61s Metal compile → device loss; now a runtime TSL Loop,
27.6s). A THIRD regression surfaced when the post-fix matrix finally ran: the temporal k>1 arm re-evaluated
the history own-domain target by a fresh replay at the QUANTIZED prev-frame domain, which diverges
through the glossy prefix into a constant Jacobian asymmetry → an exponential mb4 reuse blow-up
(+294,482% / +5,447,528%). Fixed by the **same-domain merge** (history own-domain target = stored
pHatOwn, one current-domain replay per arm, J=1 endpoints — sound because the disocclusion gate
asserts the same world surface). **FINAL deterministic matrix (2026-06-13) PASSES every band:**
bfdet bfA 3.714708728117378 bit-exact + BF/GI deterministic, protocol mb1 canonical −0.356% / reuse
−0.804%; protocol4 mb4 −0.507% / −1.098%; glossy4 mb4 −0.509% / −1.127%; emissive mb1 reuse −2.807%
(documented worst case). PT-3d closed (same-domain-merge fix is the temporal-replay substance);
PT-4 closed by audit. 759/759 tests (restirGI 21/21), lint 0 errors. **PHASE 3 COMPLETE.** Deferred
(post-phase, non-blocking): spatial compile-time reduction (prefixPHatCache / k≤2 cap), the 3 flagged
replay/walker divergences, motion-correct x'_{k−1} temporal storage. See `restir-pt-phase03.md` §PT-3c.

**Update (2026-06-13): PT-4 CLOSED as audit + tests.** The Eq. 11 pairwise generalized balance shipped
in the PT-2 combine (`reservoirCombineGIShifted`), and PT-3c-2's reuse-side replay made its MIS
denominators evaluate hybrid-shifted targets (the shared replay-target Fn in both reuse kernels;
Jacobian endpoints at the replays' terminal vertices; target-0 for nonReusable/failed shifts).
Sequential pairwise folds — not the simultaneous K-arm Alg. 6 denominator — is the documented design
choice (variance-only difference, O(K²) eval cost rejected). Partition-of-unity mirrors extended to the
mixed-k / asymmetric-J / target-0 cases, plus the §PT-3c-2 bounded-wS regression pair, in
`tests/unit/core/restirGI.test.js`; see `restir-pt-phase03.md` §PT-4.

VRAM headroom: reservoir pool was ~63–132 MB at 1080p; fixed 2048² textures dominate the ~600 MB–1 GB
baseline (memory `project_vram_tracker`); ≈100 bytes/pixel spare at 2048² for reservoir + path-vertex
state.

---

## 3. The strategic fork — DECIDED 2026-06-07: Option A

**Root cause of the prior failures:** ReSTIR trades variance for bias + inter-frame correlation. That
is a *win* in the 1-spp interactive regime and a *loss* in a progressive accumulator (production mode)
— unless the estimator is **unbiased (GRIS Alg-6)** *and* **decorrelated**.

Two deployment targets:

- **Option A — Interactive-only (recommended start).** ReSTIR PT lives in `INTERACTIVE_RENDER_CONFIG`;
  production stays brute-force progressive PT. This is how shipping engines deploy it, sidesteps the
  accumulator fight, and is where ReSTIR's value (real-time GI preview) is highest.
- **Option B — Unified (the full prize).** Unbiased from day one + duplication-map decorrelation so the
  *same* reservoirs also accelerate production convergence. The genuine end-state, but multiplies risk.

**DECISION (locked 2026-06-07): Option A + unbiased-from-day-one.** ReSTIR lives in
`INTERACTIVE_RENDER_CONFIG` and is asserted OFF in production; the estimator is **unbiased (GRIS pairwise
MIS) from the first commit** — never ship Alg-4 again. Production-mode reconciliation (Option B) is an
explicit, gated, *later* milestone (Phase 5), not a near-term goal.

> **Why this is the right call:** it sidesteps the accumulator/bias fight that shelved all three prior
> attempts, puts ReSTIR where its value is highest (real-time GI preview), and the unbiased-from-day-one
> rule means the interactive work is directly reusable if Option B is ever pursued.
>
> Detailed Phase 0/1 build spec: `docs/specs/restir-di-phase01.md`.

---

## 4. The target — "full ReSTIR PT" per the latest research

Lineage and relevance:

| Paper | Year | Adds | Relevance |
|---|---|---|---|
| ReSTIR DI (Bitterli et al.) | 2020 | Spatiotemporal reservoir reuse, direct lighting | The warm-up (Phase 1), not the goal |
| ReSTIR GI (Ouyang et al.) | 2021 | Reuse of **sample points** (1-bounce indirect) | Stepping stone (Phase 2); `ReSTIR` branch has a 3-pass prototype |
| **GRIS / ReSTIR PT** (Lin, Kettunen, Bitterli et al.) | **2022** | **Full multi-bounce path reuse via shift mappings + unbiased MIS** | **This is "full ReSTIR PT"** (Phase 3) |
| Conditional ReSTIR (Kettunen et al.) | 2023 | Subspace reuse for harder transport | Advanced |
| **Area ReSTIR** (Zhang, Lin et al.) | 2024 | Subpixel + lens reservoirs → DOF & AA | **Strong fit — Rayzee already has DOF** (Phase 4) |
| ReSTIR BDPT | 2025 | Bidirectional + caustics | Frontier |
| ReSTIR-PG (Zeng et al.) | 2025 | Path-guiding feedback from resampled paths | Quality booster (Phase 4) |
| **ReSTIR PT Enhanced** (Lin et al.) | **2026** | **2–3× faster, more robust, production-leaning** | End-state target (Phase 4/5) |

**Core of GRIS (2022) that must be built:**
1. **Path reservoirs** — sample `y` is an entire light path (throughput + reconnection vertex
   {pos, normal, material} + RNG seed for replay), not a light ID.
2. **Shift mappings** — map a neighbor's path into your integration domain:
   - **Reconnection shift** — keep your prefix, reconnect at a "reconnectable" vertex. Cheap; Jacobian =
     ratio of geometry terms (`cosθ/d²`). Fails on specular chains.
   - **Random-replay shift** — replay the neighbor's random numbers from your pixel. Handles
     glossy/specular; expensive (re-traces), correlated. **Depends on the replayable RNG (`Random.js`).**
   - **Hybrid shift** — replay the specular prefix, reconnection-shift the diffuse suffix. ReSTIR PT default.
3. **Jacobian determinants** — change-of-variables term per shift; wrong → energy loss/gain.
4. **Reconnectability criteria** — roughness ≥ threshold + min vertex distance + visibility, so the
   Jacobian can't explode.
5. **Unbiased generalized balance heuristic MIS (Algorithm 6 / pairwise MIS)** — the per-reservoir
   weights that make the combination unbiased. **The single most important change vs the old code.**
6. **Temporal + spatial path-reuse passes.**

**ReSTIR PT Enhanced (2026) deltas:** unified DI+GI in one reservoir set; **reciprocal neighbor
selection** (halves spatial cost); **footprint-based reconnection criteria** (more robust shifts);
**duplication maps** (kill spatiotemporal correlation — directly relevant to the production accumulator).

---

## 5. Phased roadmap

Each phase is independently shippable and de-risks the next. `[ ]` = todo.

### Phase 0 — Foundations & de-risk (no user-visible feature)
- [ ] Lock §3 (A vs B). Wire ReSTIR strictly into the interactive config; assert OFF in production.
- [ ] Port reservoir pool to wavefront. Salvage `ReSTIRReservoirPool.js` + struct from `ReSTIR-DI`;
      rebind as **one** `StorageBuffer` node (8-binding-per-stage limit — memory `project_tsl_compute_patterns`).
      Pre-allocate at max resolution (resize-in-place non-viable — memory `project_wavefront_resize_norebuild`).
- [ ] Prove the replay primitive: unit test that replaying a path from its seed yields bit-identical
      vertices. The whole random-replay/hybrid shift rests on this.
- [ ] Add reconnection-vertex storage to the SoA buffers (pos, normal, packed material, incoming
      radiance). Budget against the ≈100 bytes/pixel headroom (§2).

### Phase 1 — Unbiased ReSTIR DI (redo, don't revive)
- [ ] Re-implement DI as **separate wavefront passes** (Initial RIS → Temporal → Spatial → Shade),
      *not* inline in a megakernel — the architecture `stash@{0}` was reaching for.
- [ ] **Unbiased pairwise MIS (Algorithm 6), not Algorithm 4.** The corrective for every prior attempt.
- [ ] Reuse `MotionVector.js` reprojection + disocclusion gates (temporal); screen-space neighbor gather
      (spatial). Note workgroup atomics are blocked (memory `project_wavefront_progress`) — design gather
      accordingly.
- [ ] **Gate:** A/B vs brute-force in interactive mode — equal-time noise win *and* equal-sample
      convergence to the same image (unbiasedness check). Validates all plumbing on the easy problem.

### Phase 2 — ReSTIR GI (sample-point reuse)
- [ ] Extend reservoir to store a secondary hit + incoming radiance (ReSTIR GI 2021). Reconnection at the
      first bounce → **reconnection shift only** (no hybrid yet).
- [ ] Port the *structure* (not the bias) of `ReSTIR:src/core/Stages/ReSTIRGIStage.js` (3-pass GI prototype).

### Phase 3 — Full ReSTIR PT (GRIS path reuse) — the goal
- [ ] Reservoirs store **full paths**.
- [ ] **Hybrid shift** (random-replay prefix + reconnection suffix) with **correct Jacobians**.
- [ ] **Reconnectability criteria** (roughness/distance/visibility thresholds).
- [ ] **Generalized balance heuristic MIS** over shifted paths.
- [ ] Temporal + spatial path reuse. (The multi-month core.)

### Phase 4 — Frontier enhancements (pick by ROI)
- [ ] **Area ReSTIR (2024)** — highest near-term ROI; Rayzee already ships DOF. Subpixel+lens reservoirs
      fix bokeh/foliage/AA. Builds on Phases 1/3.
- [ ] **ReSTIR PT Enhanced (2026)** — unified DI+GI reservoirs, reciprocal neighbor selection,
      footprint-based reconnection, duplication maps.
- [ ] **ReSTIR-PG (2025)** — feed resampled paths back as next-frame guiding candidates.

### Phase 5 — Production-mode reconciliation (the unified prize — Option B)
- [ ] Bring **duplication maps** (2026) + optionally MCMC decorrelation so the unbiased reservoirs also
      accelerate the production accumulator without the N⁻⁰·¹ bias floor. Only after Phase 3 is solid and
      unbiased.

**Effort:** Phases 0–1 ≈ weeks; Phases 2–3 = the multi-month research-engineering core; Phases 4–5 =
open-ended frontier.

---

## 6. WebGPU/TSL risk register

The papers' "2–3× faster / interactive" numbers are on **NVIDIA RTX desktop GPUs in Falcor/DX12 with
hardware RT + wave intrinsics** — none of which this stack has. The risks below are re-assessed against
the **installed three.js source (r184)** and the **measured device limits** (2026-06, Apple Metal-3 via Dawn).

### 6.1 three.js version posture
- **Pinned at r184** (`0.184.0`), which **is the latest published release** (npm + GitHub). App workspace
  pins `^0.184.0`.
- **r185 is unreleased** (migration-wiki/dev only). Its documented changelog addresses **none** of the
  patched issues below — and it **reimplements premultiplied alpha (#33369)**, which would force
  re-verification of the transparent-bg/OIDN alpha path (memory `project_wavefront_alpha_init`).
- **Do not upgrade for ReSTIR.** Treat r184 + `TSL/patches.js` as the fixed base. Re-evaluate r185 only
  after it ships *and* the alpha change is re-verified.

### 6.2 Measured device limits (2026-06, Apple Metal-3 via Dawn)
Fresh `requestAdapter()` ceiling vs what three.js's device got by default (`WebGPUBackend` defaults
`requiredLimits` to `{}` → conservative WebGPU defaults; `WebGPUBackend.js:71,220`):

| Limit | three granted (default) | Adapter ceiling | Action |
|---|---|---|---|
| `maxStorageBuffersPerShaderStage` | **10** | **10** | **HARD CAP — cannot raise.** Pack + split passes (§6.3) |
| `maxStorageTexturesPerShaderStage` | 4 | **8** | Unlock → 8 via `requiredLimits` (free) |
| `maxSampledTexturesPerShaderStage` | 16 | **48** | Unlock → 48 if needed |
| `maxComputeWorkgroupStorageSize` | 16 KB | **32 KB** | Unlock → 32 KB — shared-mem neighbor tiles |
| `maxComputeInvocationsPerWorkgroup` | 256 | **1024** | Unlock → 1024 — bigger spatial-reuse tiles |
| `maxComputeWorkgroupSizeX` | 256 | **1024** | Unlock → 1024 |
| `maxBufferSize` / `maxStorageBufferBindingSize` | ~4 GB | ~4 GB | Non-issue for reservoir buffers |
| `subgroups` feature | **available** | — | Wave intrinsics on the table for reservoir reductions |

**Free headroom:** pass `requiredLimits: { maxStorageTexturesPerShaderStage: 8, maxComputeWorkgroupStorageSize:
32768, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }` to the `WebGPURenderer`
constructor (clamp each to `adapter.limits` and fall back if a future device reports lower).

### 6.3 Per-risk (re-assessed against installed source)
- **Storage buffers per stage = 10 (hard cap on this HW).** `requiredLimits` **cannot** raise it — it is
  already at the adapter ceiling. (An earlier "request a higher limit" note was wrong for storage buffers
  specifically; the §6.2 measurement caught it.) The wavefront Shade kernel already binds many storage
  buffers; adding reservoir + path-vertex buffers risks exceeding 10. **Mitigations (use both):** (1) the
  wavefront pass-split is the saving grace — each ReSTIR pass (Initial/Temporal/Spatial/Shade) binds only its
  own subset, so the cap is *per-pass*; design pass boundaries with the 10-buffer budget in mind. (2) Pack
  multi-field reservoir/path state into single `vec4`-stride storage nodes, as
  `ReSTIR-DI:ReSTIRReservoirPool.js` already did to stay at 1 binding. **Severity: Medium** — the one genuine
  architectural constraint.
- **`var<private>` register pressure** — three.js bug. `WGSLNodeBuilder.js:247` hardcodes
  `allowGlobalVariables = true` with **no opt-out**; `:2458/:2467` switch emission scope on it. Neutralized by
  `patches.js:48-66` (per-instance accessor → `false` for compute). Also write ReSTIR kernels register-lean
  (run `/check-tsl` for redundant `.toVar()`). **Severity: Low.**
- **Workgroup atomics** — **not blocked at the API level.** r184 TSL exports `atomicAdd/…/Load/Store`
  (`nodes/gpgpu/AtomicFunctionNode.js`), `workgroupArray` (`WorkgroupInfoNode.js:232`),
  `workgroup/storageBarrier` (`BarrierNode.js:75/86`), subgroups (`SubgroupFunctionNode.js`); storage-buffer
  atomics are already in use (`QueueManager` counters). The "blocked" note (memory
  `project_wavefront_progress`) is the narrow atomic-in-workgroup-address-space case, possibly stale.
  **ReSTIR doesn't need it:** per-pixel WRS updates are sequential, spatial reuse is a *gather*, and the queue
  compaction it reuses runs on storage atomics that work. Re-test only if a later phase wants
  workgroup-shared reductions. **Severity: Low.**
- **Timestamp-query pool overflow** — *profiling-only*, never gates correctness. `patches.js:106-141` grows
  the pool to the 4096 WebGPU hard cap + degrades silently. ReSTIR's extra passes are absorbed; can disable
  timestamp tracking under heavy ReSTIR. **Severity: Low.**
- **StorageTexture cross-dispatch reads** (memory `project_storage_texture_read_limitation`) — applies to
  *textures*, not buffers. Reservoirs/path-vertices are storage **buffers** → not affected; MRT/G-buffer
  textures already use copy-to-RT. **Severity: None for ReSTIR data.**
- **TSL pitfalls** (memory `project_tsl_pitfalls`): struct returns need `.wrap()` (provided by
  `patches.js:199-222`); reservoir updates must be **immutable** (field mutation across `Fn` unreliable —
  `ReSTIR-DI:ReSTIRCore.js:23-24`). Coding discipline, already established. **Severity: Low.**
- **Validate every step empirically** (memory `feedback_validate_gpu_perf_claims`,
  `project_perf_benchmark_harness`). CUDA-era ReSTIR wins routinely regress on WebGPU/Apple — the §6.2 check
  already overturned one assumption. Prior M=8/K=3 DI tuning cost a "12× fps regression"
  (`ReSTIR-DI:LightsSampling.js:1110-1114`) — expect to re-tune everything.

**Net:** the only Medium-severity item is the 10-storage-buffer cap (architectural, mitigated by
pass-splitting + packing). Everything else is Low / already-patched / N-A. No risk blocks ReSTIR; r185 is
irrelevant.

---

## 7. Immediate next steps

1. ~~Decide §3 (A vs B).~~ **DONE 2026-06-07 → Option A (interactive-only) + unbiased-from-day-one.** Build spec: `docs/specs/restir-di-phase01.md`.
2. **Quick win (now):** apply the §6.2 `requiredLimits` unlock to the `WebGPURenderer` (8 storage textures,
   32 KB shared mem, 1024 workgroup size) — free headroom, independent of ReSTIR. Audit the wavefront Shade
   kernel's current storage-buffer count against the **10** cap before adding reservoir buffers.
3. **Phase 0**: port the reservoir pool to wavefront (packed `vec4` storage nodes — §6.3) + write the
   RNG-replay determinism test.
4. **Phase 1**: unbiased DI as separate passes — the real "did I understand GRIS MIS" checkpoint.

---

## References

- GRIS / ReSTIR PT (SIGGRAPH 2022): https://research.nvidia.com/labs/rtr/publication/lin2022generalized/ · source: https://github.com/DQLin/ReSTIR_PT
- Area ReSTIR (SIGGRAPH 2024): https://research.nvidia.com/labs/rtr/publication/zhang2024area/ · source (DI part): https://github.com/guiqi134/Area-ReSTIR
- ReSTIR PT Enhanced (2026): https://research.nvidia.com/labs/rtr/publication/lin2026restirptenhanced/
- ReSTIR-PG (SIGGRAPH Asia 2025): https://research.nvidia.com/labs/rtr/publication/zeng2025restirpg/
- ReSTIR BDPT: https://dl.acm.org/doi/10.1145/3744898
- Conditional ReSTIR: https://dl.acm.org/doi/fullHtml/10.1145/3610548.3618245
- Decorrelating ReSTIR via MCMC Mutations: https://arxiv.org/pdf/2211.00166

---

## Related docs / memory

- `docs/specs/wavefront-megakernel-parity-gaps.md` — wavefront porting precedent (all gaps resolved)
- `docs/specs/wavefront-path-tracing.md`, `wavefront-v2-proper-architecture.md` — engine architecture
- Memory: `project_restir_di_option_a.md` (the bias/accumulation benchmark), `project_wavefront_progress.md`,
  `project_tsl_compute_patterns.md`, `project_tsl_pitfalls.md`, `project_vram_tracker.md`
