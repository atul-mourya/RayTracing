# Transparent Background — Behavior Specification

## 1. Overview

Transparent background rendering produces RGBA output where background pixels carry `alpha = 0` (fully transparent), allowing the rendered scene to be composited over arbitrary backgrounds in external tools (Photoshop, Figma, web pages, video editors). This is a standard production feature in offline renderers (Blender Cycles, Arnold, V-Ray) and is increasingly expected in real-time/interactive renderers.

---

## 2. Current State

Rayzee already has a basic transparent background pipeline:

| Component | What it does |
|---|---|
| `PathTracer.js` | Tracks `primaryHitAlpha` (1.0 on hit, 0.0 on miss). Selects `outputAlpha` based on `transparentBackground` uniform. Stored in `gColor.w`. |
| `DisplayStage.js` | Reads `.w` from source texture when `transparentBackground` is on; else forces 1.0. |
| `PathTracerApp.js` | Renderer created with `alpha: true`. Setter propagates flag to both stages. |
| `store.js` | Toggle handler forces `showBackground = false` and `scene.background = null` when enabled. |

**Known Bug** (from TODO): Transparent background + transparent/transmissive materials do not work together correctly.

---

## 3. Industry Context & Challenges

### 3.1 What Production Renderers Do

**Blender Cycles / EEVEE:**
- "Film > Transparent" checkbox: miss rays produce `alpha = 0` in all AOVs
- Transparent objects produce fractional alpha via alpha-over compositing
- Glass/transmission: uses "Transparent Glass" mode where the *glass surface itself* is visible (`alpha = 1`) but the *background seen through glass* contributes `alpha = 0` weighted by transmittance
- Outputs premultiplied alpha (industry standard for EXR)
- Compositor's Alpha Over node handles layering

**Arnold / V-Ray / RenderMan:**
- Similar model: camera ray alpha = coverage of geometry over background
- "Holdout" / "Shadow Catcher" materials produce negative alpha to cut holes
- Deep compositing (OpenEXR Deep) stores per-sample depth + alpha for volumetrics
- All use premultiplied alpha natively

### 3.2 Core Challenges

#### Challenge 1: Transmissive Materials (Glass, Water, Thin Film)

This is the **primary unsolved bug** in Rayzee. The fundamental tension:

- A glass object is visible geometry → its primary hit should mark `alpha = 1`
- But the glass is see-through → the background *behind* it should remain transparent
- The environment light gathered *through* glass contributes to the pixel's RGB but the pixel's alpha should reflect how much of the background is "covered"

**Industry solution — Alpha decomposition:**

```
alpha = 1 - transmittance_to_background
```

Where `transmittance_to_background` is the product of all transmission events along the primary ray chain until it either hits opaque geometry (transmittance → 0, alpha → 1) or escapes to the environment (transmittance contributes to making alpha < 1).

For a single pane of clear glass with ~4% Fresnel reflection and ~96% transmission:
- If background is behind it: `alpha ≈ 0.04` (glass is barely visible, background shows through)
- If opaque object is behind it: `alpha = 1.0` (glass + object fully covers background)

For frosted/rough glass: each scattered transmission ray may or may not reach the background. The alpha becomes the statistical fraction of rays that hit geometry vs. environment.

#### Challenge 2: Premultiplied vs. Straight Alpha

Two conventions exist:

| | Premultiplied (Associated) | Straight (Unassociated) |
|---|---|---|
| **Formula** | `stored_RGB = actual_RGB * alpha` | `stored_RGB = actual_RGB` |
| **Compositing** | `result = fg + bg * (1 - fg.a)` | `result = fg * fg.a + bg * (1 - fg.a)` |
| **Used by** | EXR, compositing software, GPUs | PNG, web browsers, Photoshop layers |
| **Edge quality** | Clean edges, no fringing | Can produce dark/light halos at edges |
| **Additive effects** | Natural (emissive glow bleeds correctly) | Requires special handling |

**Why this matters for path tracing:**
- Path tracing naturally produces premultiplied results: a semi-transparent pixel accumulates less light from fewer bounce paths, so RGB is inherently scaled by coverage
- But web canvas (`toDataURL('image/png')`) expects **straight alpha** for PNG export
- WebGPU canvas with `premultipliedAlpha: true` (default) expects premultiplied input — mismatching causes washed-out or darkened transparency edges

#### Challenge 3: Progressive Accumulation

Path tracers accumulate samples over frames. Alpha must accumulate identically:

```
accumulated_alpha[n] = (accumulated_alpha[n-1] * (n-1) + sample_alpha) / n
```

If alpha is binary (0 or 1) per sample — as it currently is — this works trivially. But with fractional alpha from transmissive materials, each sample may produce a different alpha depending on stochastic decisions (reflect vs. transmit at each glass interface). The alpha converges to the correct transmittance ratio over many samples.

#### Challenge 4: Denoising Interaction

Denoisers (ASVGF, OIDN) operate on RGB and assume opaque images:

- **Spatial filtering** can smear alpha across edges, creating semi-transparent halos around objects
- **Temporal reprojection** must also reproject alpha; disoccluded regions need proper alpha reset
- **OIDN**: the neural network is trained on opaque images. Feeding it premultiplied RGBA (where background = black with alpha = 0) works if the denoiser treats it as an opaque image with black background, then the alpha channel is denoised separately or passed through

**Industry approach**: Denoise RGB and alpha independently. Many studios denoise the "beauty" pass as if opaque, then denoise or filter the alpha channel with an edge-preserving filter, and combine in compositing.

#### Challenge 5: Tonemapping

ACES and other tone mapping operators are designed for RGB. Applying tonemapping to premultiplied RGBA is correct (the black background areas get tonemapped to black, which is still black). But:

- If using straight alpha, tonemapping must be applied to RGB *before* the premultiply step
- Alpha itself must **never** be tonemapped — it's a coverage value, not a color

Current Rayzee pipeline applies tonemapping via `toneMapped = true` on the DisplayStage material, which correctly affects only RGB.

#### Challenge 6: Background Contribution Through Transmissive Materials

When `transparentBackground = true` and a ray passes through glass to hit the environment map:

- The environment **should still contribute RGB** (it provides correct lighting/reflections)
- But the environment contribution **should not contribute to alpha** (the pixel is "transparent" at that point for compositing purposes)

This requires tracking the "background contribution" separately from the "scene contribution." Cycles handles this by tagging path segments and decomposing the final radiance.

---

## 4. Specified Behavior

### 4.1 Alpha Generation Rules

| Scenario | Expected Alpha | Rationale |
|---|---|---|
| Primary ray hits opaque geometry | `1.0` | Fully covers background |
| Primary ray misses all geometry (background) | `0.0` | Nothing covers the background |
| Primary ray hits glass → transmitted ray hits opaque geometry | `1.0` | Background fully occluded |
| Primary ray hits glass → transmitted ray misses (environment) | `fresnel_reflectance` | Only the reflected component covers the background |
| Multiple bounces through glass | `1 - cumulative_transmittance_to_env` | Product of all transmission factors |
| Primary ray hits opaque surface behind glass | `1.0` | Glass + surface fully covers background |
| Rough glass / diffuse transmission | Statistical convergence over samples | Each sample ray may or may not reach environment |

### 4.2 Alpha Tracking Algorithm

```
For each primary camera ray:
  throughput = vec3(1.0)        // standard path throughput
  alpha_throughput = 1.0        // scalar tracking background coverage

  For each bounce:
    If ray misses geometry:
      // This path reached the environment
      rgb += throughput * environment_sample
      // Do NOT add to alpha — this portion is "transparent"
      break

    If surface is transmissive:
      // Stochastic decision: reflect or transmit
      If reflecting:
        // Continue tracing; alpha_throughput unchanged
        // (reflected light covers the background)
      If transmitting:
        // Continue tracing through material
        // alpha_throughput remains — decision deferred to next hit

    If surface is opaque:
      // This path is fully covering the background
      rgb += throughput * surface_radiance
      // alpha_throughput contributes to final alpha
      final_alpha += alpha_throughput (for this path)
      break

  // After all bounces:
  // If path terminated by Russian Roulette or max bounces without
  // hitting opaque surface or environment, treat as opaque (alpha = 1)
```

In practice, this simplifies to: **alpha = 1.0 if the primary ray chain eventually hits opaque geometry; alpha = 0.0 if it escapes to the environment.** Over many samples, transmissive surfaces produce the correct fractional alpha automatically.

### 4.3 Output Format

- **Internal pipeline** (render targets, denoiser input): **premultiplied alpha**
  - Rationale: natural output of path tracing, correct for GPU blending, matches EXR convention
- **Canvas display**: premultiplied (matches WebGPU default `premultipliedAlpha: true`)
- **PNG export**: convert to straight alpha before `toDataURL`
  - `straight_RGB = premultiplied_RGB / alpha` (with divide-by-zero guard for `alpha = 0`)
  - Or render to a separate framebuffer with `premultipliedAlpha: false` for export

### 4.4 Denoiser Behavior

| Denoiser | Alpha Handling |
|---|---|
| **None** (raw path tracer output) | Alpha passed through directly from accumulation buffer |
| **ASVGF** | Denoise RGB channels only. Alpha filtered separately with edge-aware bilateral filter using the same geometry-based weights (normal/depth). Temporal reprojection of alpha with disocclusion detection. |
| **OIDN** | Feed RGB as opaque image (background = black in premultiplied). Pass alpha channel through unmodified or apply simple spatial filter. OIDN does not process alpha. |

### 4.5 Post-Processing Chain

```
PathTracer → [premultiplied RGBA, HDR]
  → ASVGF/OIDN → [premultiplied RGBA, HDR, denoised]
    → Bloom → [apply to RGB only, preserve alpha]
      → Tonemapping → [apply to RGB only, preserve alpha]
        → DisplayStage → [premultiplied RGBA, LDR]
          → Canvas (premultiplied) / PNG export (convert to straight)
```

### 4.6 User-Facing Behavior

1. **Toggle**: "Transparent Background" checkbox in UI
2. **When enabled**:
   - Environment map is **hidden** from primary rays (no background visible)
   - Environment lighting still active for indirect illumination and reflections
   - Canvas shows checkerboard pattern behind transparent regions (CSS background on canvas element)
   - PNG/EXR export includes alpha channel
3. **When disabled**:
   - Alpha is always `1.0`
   - Environment map visible as background
   - Standard opaque rendering behavior

### 4.7 Edge Cases

| Case | Behavior |
|---|---|
| **No environment map loaded** | Background alpha = 0 regardless of toggle (no background to show) |
| **Procedural/gradient sky** | Same as environment map — hidden for primary rays when transparent bg is on |
| **Emissive objects** | Always alpha = 1.0 (they are geometry) |
| **Volume/fog** | Alpha = 1.0 where fog is dense enough to be visible; fractional where thin |
| **Shadow catcher** (future) | Special material: alpha = shadow_intensity, RGB = shadow color. Allows "floating object with shadow on transparent background" |
| **Motion blur** (future) | Alpha is motion-blurred just like RGB — temporal samples include alpha |
| **DOF blur** | Out-of-focus background pixels retain alpha = 0; bokeh circles from background remain transparent |

---

## 5. Implementation Priorities

### Phase 1: Fix Transmissive Material Alpha (Critical Bug)

The current `primaryHitAlpha` is set to `1.0` on *any* first hit, including glass. This means glass objects always produce `alpha = 1.0` even when the background is visible through them.

**Fix**: Track alpha through the bounce loop. When a ray transmits through a surface and eventually reaches the environment, that sample contributes `alpha = 0`. When it eventually reaches opaque geometry, it contributes `alpha = 1`. Over many samples, the accumulated alpha reflects the true transmittance.

The simplest correct approach:
- Remove `primaryHitAlpha` from the first-hit test
- Instead, set `sampleAlpha = 1.0` at start of each sample
- If the ray escapes to the environment at any point during bouncing, set `sampleAlpha = 0.0`
- Accumulate `sampleAlpha` across progressive frames like RGB

### Phase 2: Premultiplied Alpha Pipeline

- Ensure internal render targets use premultiplied alpha
- Add straight-alpha conversion for PNG export path
- Verify WebGPU canvas `premultipliedAlpha` setting matches

### Phase 3: Denoiser Alpha Handling

- ASVGF: add alpha channel to temporal and spatial filter passes
- OIDN: pass alpha through unmodified
- Validate no alpha smearing at object edges

### Phase 4: Visual Polish

- CSS checkerboard behind canvas when transparent mode is on
- Alpha-aware bloom (don't bloom into transparent regions, or do so intentionally for glow effects)
- Export format options (PNG with straight alpha, EXR with premultiplied)

---

## 6. References

- [Blender Cycles — Transparent Film](https://docs.blender.org/manual/en/latest/render/cycles/render_settings/film.html#transparent)
- [Premultiplied Alpha — GPU Gems](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-space-ambient-occlusion)
- [Alpha Compositing — Porter-Duff](https://keithp.com/~keithp/porterduff/p253-porter.pdf)
- [OpenEXR Technical Introduction — Alpha](https://openexr.com/en/latest/TechnicalIntroduction.html)
- [OIDN — Alpha Channel Handling](https://www.openimagedenoise.org/documentation.html)
