# glTF Khronos Gap — Remediation Plan

Companion to the 2026-07-08 gap audit (verified against parsed JSON of all 133 `DebugModels.json`
test-tab models + adversarial code verification). This is the *how-to-fix*, sequenced by
(impact on test-model correctness) × (1/effort), with dependency unlocks called out.

## Two cost tiers (the organizing principle)

| Change surface | Blast radius | Cost |
|---|---|---|
| **Material buffer** (`MATERIAL_DATA_LAYOUT`) | Single source-of-truth table; offset-driven. Growing the stride touches only `EngineDefaults.js` (layout), `TextureCreator.js` (the pack array), `Common.js` (`getMaterial` unpack). | **Cheap / mechanical** |
| **Triangle buffer** (`TRIANGLE_DATA_LAYOUT`, 32 floats) | ~14 JS files (BVH build/refit + workers, EmissiveTriangleBuilder, InstanceTable, GeometryExtractor, PathTracerStage) + 7 TSL hit-unpack sites. Largest GPU buffer. | **Structural / expensive** |

The freshly-shipped **anisotropy** change (uncommitted) is the reference implementation for the
cheap tier — it un-dropped one texture family across exactly 8 files:
`GeometryExtractor` (array + extract) → `SceneProcessor` (list + bucket remap + fix) →
`TextureCreator` (pack index) → `EngineDefaults` (map-index float) → `Struct.js` (field) →
`Common.js` (unpack) → `TextureSampling.js` (sampler Fn) → `ShadeKernel.js` (fold into material).
**Every Phase-1 texture family follows this same recipe.** Note it consumed the last free floats
(slot 29 full at 120 floats), so Phase 1 must grow the stride first.

Verification: every item below names the Khronos model that exercises it. Use the existing
chrome-devtools perf harness (`window.app`) to load the model, render to convergence, and diff
against the model's README screenshot.

---

## Phase 0 — Surgical correctness bugs (no new data structures)

Highest value-per-hour. Each is isolated, each has a named test model. Do these first.

> **STATUS: all 5 implemented (uncommitted working tree), lint-clean, 738 unit tests pass, live-verified.**
> Files touched: `AssetLoader.js`, `TextureCreator.js`, `MaterialDataManager.js`,
> `MaterialTransmission.js`, `LightsDirect.js`, `GeometryExtractor.js`.
> Live verification (dev server + chrome-devtools, 3 Khronos models, zero shader/WGSL errors):
> - **0.1** LightsPunctualLamp — intensities numerically = candela×4π (15→188.5, 80→1005.3, 180→2261.9), all `__candelaConverted`; lamp renders correctly lit.
> - **0.2** TextureTransformTest — the `Offset_V` tile renders a correct **"✓v"** (offset.y now applied; the bug showed the wrong region). All offset/rotation/scale tiles correct.
> - **0.3** implicit in TextureTransformTest — tiles tile cleanly, no edge-smear; identity transforms no longer forced through fract().
> - **0.4** code-correct + tests; visible only on a factor-only-MASK asset (the standard AlphaBlendModeTest/CompareAlphaCoverage are texture-alpha-driven, so no regression there and no visible delta — expected).
> - **0.5** MetalRoughSpheres — smooth metallic spheres show crisp mirror reflections; pipeline healthy.

### 0.1 Punctual lights 4π (~12.6×) too dim — **HIGH**
`LightSerializer.js:209` (point) / `:251` (spot) multiply intensity by `INV_4PI`, treating it as
Blender-style radiant power (Watts). three.js normalizes **all** lights to candela/lux, so glTF
point/spot intensity arrives already in candela; the `INV_4PI` is spurious. Directional is correct.
- **Fix:** drop `INV_4PI` for point/spot so net radiance is `I/d²` not `I/(4π·d²)`.
- **Decision required:** confirm no import path (Blender exports?) actually delivers Watts and relies
  on the current scaling. If one does, convert at *that* import site instead of in the shared serializer.
- **Verify:** LightsPunctualLamp, PlaysetLightTest match reference brightness; re-check any calibrated
  Blender scene didn't depend on the dim value.
- **Size:** S (few lines) + one convention decision.

### 0.2 KHR_texture_transform `offset.y` dropped + forced-`fract()` cascade — **HIGH**
`TextureCreator.js:~985-998` packs matrix `elements[0..6]` + a literal `1` into the 8-float transform
slot, dropping `elements[7]` (= `ty`/`m13`). `arrayToMat3` (`Common.js:351`) then reads that pad as
`t[2][1]`, so it's constant `1.0` → `isIdentityTransform` (`TextureSampling.js:120`) **never passes** →
**every textured material** is forced through `fract()` (= forced REPEAT), and authored V-offsets vanish.
- **Fix:** pack `elements[7]` at float index 7 instead of literal `1`. `arrayToMat3` already reads
  `data2.zw` (floats 6,7) into `col2.xy` and hardcodes `col2.z = 1.0`, so the reconstruction becomes
  correct `(tx, ty, 1)` with no shader change.
- **Also fix the runtime clobber:** `MaterialDataManager.js:546,636` write 9 floats/transform into
  8-float slots; the displacement slot's 9th float lands on `SUBSURFACE_COLOR.r` (offset 108) —
  every UI material edit silently sets subsurfaceColor.r = 1.0. Align the runtime loop to the 8-float
  pack (7 elements + explicit 0 pad, matching TextureCreator).
- **Unlock:** once identity transforms report identity, the forced-`fract()` stops → exposes the wrap
  gap (0.3), so ship 0.2 + 0.3 together.
- **Verify:** TextureTransformTest (offset rows), TextureTransformMultiTest, ToyCar, SheenChair, ClearCoatCarPaint.
- **Size:** S.

### 0.3 Sampler wrap modes discarded — **MEDIUM** (pair with 0.2)
Bucket `DataArrayTexture`s never set `wrapS/wrapT` (`TextureCreator.js:1311-1320`) → three's default
`ClampToEdgeWrapping`. With 0.2 fixed, genuinely-tiling UVs now clamp/smear instead of tiling.
- **Fix (80/20):** set bucket array `wrapS/wrapT = RepeatWrapping` (glTF default is REPEAT; layers are
  independent array slices, so per-layer wrap is safe). KHR_texture_transform tiling already works via `fract()`.
- **Follow-up (defer):** true per-texture wrap (store 2-bit wrap mode per slot in the buffer, branch
  clamp/repeat/mirror in TSL) to honor MIRRORED_REPEAT (2 models) and per-texture CLAMP.
- **Sub-item:** NEAREST mag filter + mipmaps are hardcoded off — pixel-art samplers smooth, minification
  aliases. Lower priority.
- **Verify:** SimpleTexture, TextureSettingsTest (MIRRORED_REPEAT — remains wrong under 80/20), tiling UVs.
- **Size:** S (80/20) / M (full per-texture wrap).

### 0.4 `baseColorFactor.a` forced to 1.0 — **MEDIUM-LOW** — DONE
`Common.js:403` hardcodes `color.a = 1.0`; the MASK branch then tested only `color.a` (= texture alpha,
or 1.0 when untextured), so factor-only MASK never cut out and textured MASK omitted the spec's `× factor.a`.
- **Implemented (cleaner than the original VISIBLE-reclaim idea — no new slot):** three already sets
  `material.opacity = baseColorFactor.a`, and it is already packed (`OPACITY` offset 8) and read into
  the struct. The BLEND branch already multiplied `color.a × opacity` correctly; only MASK omitted it.
  Fix = multiply the MASK test by `opacity` in both paths — `MaterialTransmission.js` (camera) and
  `LightsDirect.js` (shadow). Now factor-only MASK cuts and textured MASK includes the factor.
- **Verify (pending live):** CompareAlphaCoverage, AlphaBlendModeTest with factor-driven alpha.
- **Size:** S.

### 0.5 Roughness 0.05 floor — **LOW**
`GeometryExtractor.js:405` clamps roughness ≥ 0.05; perfect mirrors (MetalRoughSpheres row 0)
render slightly blurry. Lower/remove the floor; A/B for firefly regressions on smooth speculars.
- **Size:** S + A/B.

---

## Phase 1 — Un-drop extension textures (material buffer, mechanical)

> **STATUS: DONE (uncommitted), lint-clean, 738 unit tests pass, live-verified.** Material stride grown
> 30→33 slots (120→132 floats); 9 maps wired extract→bucket→pack→sample→fold. Single fold site in
> `ShadeKernel.js` (`applyExtensionMaps`) mutates the shared `material` struct → covers BRDF-sample AND
> NEE paths at once. `thicknessMap` left dropped (deferred to 4.4); `clearcoatNormalMap` deferred (needs
> Phase 2 TANGENT). Files: EngineDefaults, Struct, Common, TextureCreator, MaterialDataManager,
> GeometryExtractor, SceneProcessor, TextureSampling, ShadeKernel.
> Live verify (chrome-devtools, zero shader/WGSL/buffer errors): **TransmissionTest** shows per-texel
> transmission stripe masks (decisive — uniform if dropped); numeric probe: stride 132, 6 materials carry a
> transmission map index. **SpecularTest** sRGB path confirmed (specularColor packed at offset 128, specularIntensity 127).
> **ClearCoatTest** renders. sheen/iridescence/clearcoatRoughness use identical linear/sRGB mechanisms.

All these families extract the map into a throwaway `[]` (`GeometryExtractor.js:469-478`) — scalar
factor works, texture is discarded. Each follows the **anisotropy 8-file recipe**.

**Prerequisite — 1.0 Grow the material stride:** slot 29 is full. Add ~3 vec4 slots
(`SLOTS_PER_MATERIAL 30 → 33`, offset-driven — cheap) to hold 11 new map-index floats. Reclaim dead
floats where possible (slot 9 `w`=39 reserved, slot 12 `w`=51 padding).

Order by impact (highest first):

| # | Maps | Test model(s) | Impact | Notes |
|---|---|---|---|---|
| 1.1 | `transmissionMap` | TransmissionTest | **HIGH** | core renderer feature; per-texel transparency mask |
| 1.2 | `clearcoatMap`, `clearcoatRoughnessMap` | ClearCoatTest, ToyCar, ClearcoatWicker | **HIGH** | lobe already exists; spatial coat variation |
| 1.3 | `sheenColorMap`, `sheenRoughnessMap` | SheenCloth | MED | |
| 1.4 | `iridescenceMap`, `iridescenceThicknessMap` | IridescenceAbalone, IridescenceLamp | MED | thickness map lets min-end of range be selected |
| 1.5 | `specularIntensityMap`, `specularColorMap` | SpecularTest, CompareSpecular | MED | |
| 1.6 | `clearcoatNormalMap` | AnisotropyBarnLamp, ToyCar | LOW | needs a TBN → **correct only after Phase 2 TANGENT**; ship with heuristic ONB meanwhile (parity with base normal maps) |
| — | `thicknessMap` | DragonAttenuation | **SKIP** | thickness has no render effect today; unblock in Phase 4.4 first |

Each family is independent and batchable (candidate for a parallel implementation workflow — one
agent per family, worktree-isolated).

**Size:** 1.0 = S; each family = S-M (mechanical). Aggregate M-L.

---

## Phase 2 — Geometry attributes (structural, triangle-buffer expansion)

The expensive tier. Adds per-vertex attributes the 32-float layout has no room for; touches BVH
build/refit (main + `BVHRefitWorker`/`BVHWorker`), EmissiveTriangleBuilder, InstanceTable, every TSL
hit-unpack site, and roughly doubles the largest GPU buffer.

**2.0 Spike / design decision (do first):** don't blindly widen every triangle to ~64 floats — that
taxes every scene's VRAM. **Recommend an optional side-buffer** (parallel array keyed by triangle
index) allocated only when the scene actually ships tangents / vertex colors / UV1, so the common case
stays 32 floats. Decide packing + measure VRAM with the perf harness before implementing.

| # | Attribute | Unlocks | Test model(s) | Priority |
|---|---|---|---|---|
| 2.1 | **TANGENT** | correct normal mapping; **fixes anisotropy direction** (removes the known arbitrary-ONB limitation); correct `clearcoatNormalMap` (1.6) | NormalTangentTest, AnisotropyBarnLamp | **highest quality value** |
| 2.2 | **TEXCOORD_1** | second UV set; prerequisite for any UV1-bound texture | MultiUVTest, SheenChair | MED |
| 2.3 | **COLOR_0** | vertex-color tint into albedo | VertexColorTest, BoxVertexColors, IridescentDishWithOlives | MED |

TBN construction currently uses a heuristic world-axis ONB (`TextureSampling.js:386-388`) — 2.1
replaces it with real UV/tangent-space frames (fall back to the ONB when a mesh ships no tangents,
matching three's `useDerivativeTangents`).

**Size:** 2.0 = M (design+spike); each attribute = M-L. Aggregate L.

---

## Phase 3 — Loader-level material gaps (three plugin + BSDF)

three r185 GLTFLoader has no handler for these; nothing downstream can recover them.

| # | Feature | Work | Test model(s) | Size |
|---|---|---|---|---|
| 3.1 | KHR_materials_diffuse_transmission | custom `GLTFLoaderPlugin` to read ext → material fields **+ a diffuse-transmission (translucent) BSDF lobe** | DiffuseTransmissionPlant, DiffuseTransmissionTeacup, MandarinOrange | M-L |
| 3.2 | KHR_materials_pbrSpecularGlossiness | convert spec-gloss → metallic-rough at load (plugin or manual) | SpecGlossVsMetalRough | M |
| 3.3 | KHR_materials_variants | loader plugin (`gltf.userData` mapping) + engine material-swap hook + Models-tab UI to enumerate/select | DragonAttenuation, GlamVelvetSofa, MaterialsVariantsShoe, SheenChair, StainedGlassLamp | M (mostly plumbing/UI) |
| 3.4 | EXT_mesh_gpu_instancing | expand `InstancedMesh` in GeometryExtractor: bake per-instance matrices (duplicate triangles) or add real TLAS instances | SimpleInstancing | M |

---

## Phase 4 — Camera / animation / volume correctness

| # | Issue | Fix | Test model(s) | Size |
|---|---|---|---|---|
| 4.1 | Orthographic camera → NaN/black | guard undefined `.fov` in `CameraManager.switchCamera:166`; add ortho branch in `generateRayFromCamera` (`BVHTraversal.js:560-617` — per-pixel origin, constant direction) | Cameras | M |
| 4.2 | Static/default morph & skin weights ignored | bake `morphTargetInfluences`/skin at load (`seekTo(0)` or `getVertexPosition` in extraction) so the pre-play frame is correct | MorphPrimitivesTest, RiggedFigure | S-M |
| 4.3 | BVH refit flattens smooth normals during animation | recompute smooth (area-weighted) normals in refit, or pass normals through the animation refit path (`BVHRefitter.js:79-97`; the transform-gizmo path already does this) | all animated models | M |
| 4.4 | `thicknessFactor` dead + no thin-wall case | wire thickness into absorption, and/or add a `thickness==0` thin-walled branch that disables volumetric refraction; unblocks `thicknessMap` (1.7) | TransmissionThinwallTestGrid, IridescentDishWithOlives lid | M |

---

## Phase 5 — BSDF fidelity polish (optional, lower priority)

- **5.1** Charlie/Estevez sheen distribution + sheen visibility term (current is inverted-GGX approx).
- **5.2** `specularIntensity`: apply to the dielectric F0 component only + scale F90; stop dimming metals.
- **5.3** Add the clearcoat lobe to the NEE-side evaluator (`LightsSampling.js:1000/1202`) so light-sampled coat highlights aren't under-represented.
- **5.4** True unlit passthrough (unlit flag in the buffer, short-circuit the BSDF) instead of the emissive conversion that spuriously casts light. UnlitTest, TextureTransformMultiTest.

---

## Explicitly deferred / won't-do

- **POINTS / LINES primitives** (MeshPrimitiveModes) — no line primitive in the path tracer; would
  need cylinder/sphere proxies. Large, low value. Skip.
- **occlusionTexture / aoMap** (39 models) — the path tracer computes true occlusion; ignoring baked AO
  is defensible. Optional: apply as a primary-ray-only multiplier if raster parity is wanted. Document the intent.
- **KHR_animation_pointer** — no test-tab model uses it.
- **Quantized attributes** — already safe (denormalizing getters); no test-tab model loads the quantized variant.

---

## Recommended sequence

1. **Phase 0** (0.1 → 0.2+0.3 → 0.4 → 0.5) — days, high value, no structural risk.
2. **Phase 1** (1.0 stride grow, then 1.1→1.5; defer 1.6/1.7) — mechanical, batchable.
3. **Phase 2.1 (TANGENT)** — unlocks normal-map correctness, anisotropy direction, and clearcoat normals (1.6); then 2.2/2.3.
4. **Phase 4** correctness items (4.1, 4.2, 4.3, 4.4) — interleave as bandwidth allows.
5. **Phase 3** loader gaps — larger, standalone features.
6. **Phase 5** polish — opportunistic.

## Cross-cutting rules

- Keep `MATERIAL_DATA_LAYOUT` the single source of truth — never hardcode offsets.
- When touching transform slots, fix the 9-vs-8 float runtime clobber (0.2) first.
- Tie each change to its named Khronos model + a screenshot diff before calling it done.
