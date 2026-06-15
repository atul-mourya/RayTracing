# A-SVGF Tier 1 — True Forward-Projected Correlated Temporal Gradient

Roadmap for the "accuracy ceiling" version of the adaptive temporal gradient (Schied et al. 2018),
building on the shipped **Tier 2** (variance-aware demodulated gradient, `feat(asvgf)` / branch
`feat/asvgf-adaptive-gradient`). Tier 1 re-shades a sparse set of pixels with the **previous frame's
RNG sequence** so Monte-Carlo noise cancels and the gradient reflects only real lighting/geometry change.

## Why this engine can do it (and Q2RTX can't trivially)
The RNG is a **stateless replayable hash** of `(pixelCoord, sampleIndex, bounceIndex, frame)` —
`getDecorrelatedSeed` (`TSL/Random.js:502`) + the Halton/Sobol/STBN paths mixing `frame` into the
scramble. The previous frame's exact sequence replays by passing `frame−1`. **No per-pixel seed texture
needed** (Q2RTX must store one). The cost: a re-shade must run with the prior frame index AND the prior
camera matrices for the gradient pixels.

## Storage strategy (decided): A + B — no new binding in the main Shade kernel
Main `Shade` is saturated at **10/10 storage buffers** on Apple Metal-3 (hard cap). Tier 1 avoids touching
it:
- **A — widen, don't add.** Surface IDs ride in a widened per-pixel G-buffer lane (`GBUFFER_STRIDE` 1→2),
  still ONE binding. ✅ DONE (Increment 1).
- **B — separate re-shade stage.** The correlated re-shade is its own mini-wavefront with its OWN ≤10
  budget; it reads the (prev) surface-ID G-buffer as one of its 10 and writes the gradient to a TEXTURE.

Fallbacks if the re-shade stage itself can't fit 10: convert a per-pixel storage buffer → texture (C),
merge two buffers (E, e.g. fold rng into a spare ray lane), or pass-split (F, benchmark the barrier cost —
the engine is barrier/VRAM-bound on Apple). Raising the device limit (G) is NOT viable on Apple.

## Increments

### ✅ 1. Persist primary-hit surface ID in the G-buffer  — DONE + GPU-validated (uncommitted)
- `GBUFFER_STRIDE` 1→2; AoS lane 0 = MRT normal/depth/albedo, lane 1 = surface ID
  (`triIndex`, `meshIndex`, `packUnorm2x16(bary)`, `valid`). `gbLane()` indexes the AoS slot;
  `writeGBuffer/readGBuffer` unchanged at call sites. New `writeGBufferSurfaceID/readGBufferSurfaceID`.
  (`Processor/PackedRayBuffer.js`)
- `GenerateKernel.js` inits `valid=0` per pixel (sub-sample 0); `ShadeKernel.js` writes `valid=1` +
  IDs at the bounce-0 hit (misses `Return()` at ShadeKernel.js:223, so the bounce-0 block is hit-only).
  Surface data comes from the per-ray HIT buffer (`HIT.DIST_TRI_BARY`/`NORMAL_MAT`) via
  `readHitTriangleIndex` / `readHitBarycentrics` / `readHitMeshIndex`.
- Alloc auto-scales: `PathTracer.js:539` uses `requiredCapacity(...) * GBUFFER_STRIDE`.
- Validated: render unchanged, 0 console errors, VRAM 1.06→1.07 GB. Nothing reads lane 1 yet.

### 2. Double-buffer the G-buffer (retain prev-frame surface)
- Ping-pong `_gBufferAttr` (two attributes, swap each frame in `PathTracer.render()`); main Shade writes
  current, the gradient stage reads previous. Each stage binds only the one view it needs (no stage > 10).
- Alternative: copy only lane 1 to a small texture each frame (texture binding, sidesteps the cap entirely).
- Reuse the prev-frame camera matrices already synced for MotionVector (sync from PathTracer uniforms,
  never re-read the camera object — see project memory).

### 3. Gradient-sample selection + forward projection (1/3 res)
- New compute pass (own stage, or fold into the gradient stage). Per 3×3 stratum (GRAD_DWN=3): read prev
  surface-ID + prev demodulated lighting (ASVGF temporal history .xyz); forward-project via
  `motionVector:screenSpace`; **pick the BRIGHTEST reprojected pixel per stratum** (Q2RTX deviation, better
  than random for 1-spp penumbrae); surface-match gate (cluster/normal·>0.9 / relDepth<0.1 — reuse the
  ASVGF temporal geometric gate). Write the chosen gradient-sample pixel + a "this was a gradient sample"
  marker (so it isn't re-used next frame, avoiding multi-frame seed-reuse bias).
- Output: a 1/3-res gradient-sample-position buffer/texture + the cached prev luminance.

### 4. Correlated re-shade mini-wavefront (the hard core — Option B stage)
- For each chosen gradient pixel: reconstruct the prior primary hit from the stored surface ID —
  fetch triangle verts from `triangleBuffer` by `triIndex`, interpolate position/normal by `bary`,
  resolve world transform by `meshIndex`. Build a primary-ray-equivalent shading state.
- Re-derive the prior seed via `getDecorrelatedSeed(pixel, sampleIndex, frame−1)` and run shade (NEE +
  BSDF + the bounce loop) — its OWN ray/rng/hit/queue buffers (≤10 in its own stage). **MUST NOT write
  its advanced rng back to the main `rngBuffer`** or it corrupts the main pass's per-pixel stream.
- TSL pitfalls: copy the seed to a local `.toVar()` before advancing (Fn-param mutation doesn't persist);
  `vec2(RandomValue(s),RandomValue(s))` collapses to `u==v` → per-component `.toVar()`.
- Output: re-shaded current luminance `L_cur` for the gradient samples.

### 5. Gradient image + à-trous reconstruction (1/3 res)
- `g = (|L_cur − L_prev| / max(L_cur, L_prev))²` (Q2RTX get_gradient: max-normalize + square = variance-aware
  floor done right). 2–3 à-trous iterations (joint-bilateral, normal+depth+luma weights) to spread the sparse
  1/9 samples to a dense 1/3-res field; point/bilinear-upsample λ to full res.
- All ping-pong textures follow the over-allocate-to-2048 + copy-to-right-sized-RT rule (three.js #33061).

### 6. Feed λ into the ASVGF temporal `effectiveAlpha`
- Replace the Tier-2 spatial-σ gradient source with the reconstructed λ:
  `effectiveAlpha = mix(baseAlpha, 1.0, λ·gradientStrength)` (already the consumption shape, ASVGF.js).
  Paper Eq.15: `α' = (1−λ)·α + λ`. Optionally take max λ over a 3×3 to hide reconstruction error.
- Keep Tier 2 as the fallback when the re-shade is disabled (UI/preset toggle: "adaptive" = Tier 2,
  "adaptive (correlated)" = Tier 1).

### 7. Pipeline wiring, ordering, preset/UI, validation + benchmark
- **Ordering**: gradient-sample selection + re-shade must run so the re-shade uses the prior frame's state;
  the gradient image + reconstruction feed the temporal pass. Slot relative to the main wavefront in
  `PathTracer.render()` / pipeline.
- **Scope**: interactive tier only (production accumulates-to-convergence + OIDN; anti-lag is irrelevant
  there and Tier 2 already self-limits).
- **Validation**: GPU-validate each increment (render unchanged at minimum). For correctness, use the
  perf+RMSE harness on a **moving-light / animated** scene — the regime where camera-only motion vectors
  fail and the correlated gradient earns its cost. Benchmark the extra dispatches/barriers on Apple
  (the "1/9 the work" cost model is ALU-based and does NOT transfer — measure, don't assume).

## Open questions / risks
- Re-shade depth: full multi-bounce (faithful) vs primary-hit-only (cheap, approximate)? Start primary +
  1 bounce; measure bias vs a brute-force reference.
- Animated objects have **no per-object motion vector** (camera-only) — forward projection mis-lands on
  moving geometry. The surface-match gate rejects bad reprojections (history drops → handled as
  disocclusion), but gradient coverage on fast-moving objects will be sparse.
- The re-shade stage staying ≤10 buffers — verify at build; pack/merge (C/E) if needed.
