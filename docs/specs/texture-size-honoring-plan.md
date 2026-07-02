# Honoring Individual Texture Sizes Without Inefficient Packing

Planning doc for `docs/TODO.md → "honor individual texture sizes without inefficient packing"`.
Written 2026-07-01 from a fan-out investigation + adversarial verification + a **live GPU-limit probe**
on this machine (Apple Metal-3, Chrome). Related: `project_texture_sharpness_cap` (the `maxTextureSize`
cap fix), `project_vram_tracker`, `project_tsl_compute_patterns` (the 10 storage-buffer/stage cap).

---

## 1. Problem & root cause

Every material map type (albedo, normal, bump, roughness, metalness, emissive, displacement) is packed
into **one** Three.js `DataArrayTexture` → WGSL `texture_2d_array`. A `texture_2d_array` is a single
`GPUTexture` with exactly **one** `size = {width, height, depthOrArrayLayers}` and **one** `format`;
the API has no per-layer dimension or format. So all layers of a map-type array are *structurally* forced
to identical dimensions. **This is the WebGPU API, not a Rayzee design choice** — verified against the
W3C spec (`GPUTextureDescriptor.size`) and confirmed by adversarial review.

Given that, the engine picks the only safe common size: the power-of-2 of the max width/height across the
group, capped at `maxTextureSize` (default 4096, ceiling 8192). This lives in exactly one function —
`TextureCreator.calculateOptimalDimensions` (`rayzee/src/Processor/TextureCreator.js:1268-1293`), mirrored
in the worker at `rayzee/src/Processor/Workers/TexturesWorker.js:610-639`:

```
maxW/maxH = max over members → Math.pow(2, ceil(log2(x))) → halve while > maxTextureSize
```

Every member is then **upscaled** (not padded) to that common size via
`createImageBitmap({resizeWidth, resizeHeight, resizeQuality:'high'})`
(`TextureCreator.js:799-804, 855-860, 900-905`; worker `266-270`). The buffer is one contiguous
`Uint8Array` of `maxW*maxH*depth*4`, stride `maxW*maxH*4*i` per layer (`TextureCreator.js:891, 912-913`).

There is **no bucketing, no atlasing, no per-texture sizing** anywhere — only the single scene-wide cap.

### Cost (two-fold, both at the shipped default of 4096)

**(a) VRAM waste** — a single large member inflates *all* layers in its group. Worked example, one map-type
group of `1×4096² + 4×256²`, RGBA8:

| Scheme | Bytes | Footprint |
|---|---:|---:|
| Current (all 5 layers → 4096²) | 335,544,320 | **320.00 MiB** |
| Native sizes | 68,157,440 | **65.00 MiB** |
| **Waste** | 267,386,880 | **255.00 MiB (4.92×)** |

Each 256² map costs a full 4096² layer (64 MiB) instead of 0.25 MiB. Multiplies across the 7 types.

**(b) Upscale blur** — small members are bilinearly resampled *up* to the group max, then sampled with
`LinearFilter` (no mips). A 256²→4096² normal map is permanently softened; lost Nyquist detail is
unrecoverable. The NPoT round-**up** (`ceil` on `log2`) compounds it (1500→2048, 4097→8192→halve→4096).

---

## 2. Hard constraints (measured, this machine)

Live `adapter.limits` probe — **Apple Metal-3** — vs the portable WebGPU **default guarantee**:

| Limit | This device | WebGPU default floor |
|---|---:|---:|
| `maxSampledTexturesPerShaderStage` | **48** | 16 |
| `maxSamplersPerShaderStage` | 16 | 16 |
| `maxStorageBuffersPerShaderStage` | **10** | 8 |
| `maxStorageTexturesPerShaderStage` | 8 | 8 |
| `maxTextureDimension2D` | **16384** | 8192 |
| `maxTextureArrayLayers` | **2048** | 256 |

Budget facts that gate every option:

- The Shade kernel already binds **10 storage buffers — AT the per-stage cap** (`ShadeKernel.js`).
  Material maps are *textures*, a separate budget — but **any new per-texture metadata MUST ride the
  existing material storage buffer's free padding lanes; a new storage buffer would break the kernel.**
  Free lanes today: slot12.a (float 51) and slot29 floats 117-119 = **4 free floats**.
- Sampled-texture bindings used by Shade today: ~10-12 (7 material arrays + env + envCDF + gobo + IES).
- Samplers are shared (one covers many textures) — not the bottleneck.

**Bindless is the conceptually ideal answer and is BLOCKED in shipping WebGPU 2026.** `binding_array<texture_2d>`
("sized binding arrays") is a *Draft* proposal (gpuweb, 2024-10-25); non-uniform texture indexing is
explicitly *undecided* (gpuweb #5085). Full bindless (`GPUResourceTable`) is an earlier Draft gated on
optional hardware features missing on many targets. No origin trial, no default-on flag through Chrome 150.
→ The only single-binding containers for heterogeneous sizes are a **uniform-dim 2D array** (resamples) or a
**2D atlas** (sub-rects). Verified against the spec and Chrome release notes.

---

## 3. Option space

| Option | Honors sizes | Texture bindings | Breaks | Effort |
|---|---|---|---|---|
| **(A) Size-bucketed PoT arrays** | rounds **up**, waste ≤4× area | N buckets × types | nothing fragile | ~3-5 d |
| **(B) Single per-type 2D atlas** | **exact**, incl. NPoT | 1 / map type | UV remap + gutters + derivative | ~1-2 wk |
| **(C2) Atlas-of-pages (array of atlases)** | **exact** | 1 / colorSpace | atlas issues + page index | ~1-2 wk |
| **(D) True bindless** | exact | 1 | — | ❌ blocked (WebGPU 2026) |
| **(E) Tune the cap only** | no | 0 | — | trivial (knob exists) |

Notes per option (full detail in the investigation; condensed here):

- **(A)** Group each type's maps into power-of-2 buckets (256²/512²/…/cap); address by `(bucketId, layerInBucket)`.
  Leaves *all* fragile machinery correct: software `fract()` wrapping still lands in `[0,1)`; the array R-axis
  has **no cross-layer bleed** (so no gutters); and crucially `processBump`'s `textureSize(bumpMaps)` derivative
  (`TextureSampling.js:287`) **stays correct with no per-texture dims plumbed**, because each bucket array's
  `textureSize` *is* the native res of maps placed in it at native res. Risk = binding multiplication.
- **(B)** Best VRAM, exact sizes. But the cost list is **more than gutters + derivative** (adversarially confirmed):
  also a *mandatory per-sample UV remap* `origin + fract(uv)*scale` at every sample site, disabling the
  identity-UV fast path (`TextureSampling.js:31`) so UV>1 wraps instead of bleeding, and clamp-to-subrect for
  bilinear at wrap seams on tiled materials (a static gutter is insufficient there).
- **(C2)** A `texture_2d_array` where each **layer is a full atlas page** — exact sizes, **one binding per
  colorSpace**, and it solves single-2D overflow by spilling to layers. Best binding profile of the
  heterogeneous options; reuses the existing one-node-per-type binding shape.
- **(D)** Design *toward* it, don't build *with* it.
- **(E)** Honest baseline; bounds the ceiling but never fixes the skew or NPoT — does **not** solve the TODO.

---

## 4. Recommendation

**Phase 1 = Option A (size-bucketed power-of-2 arrays). Phase 2 = Option C2 (atlas-of-pages) as a
conditional escalation** if a real scene shows heavy intra-bucket fragmentation or needs exact-NPoT packing.

Rationale for a static-camera, offline-quality path tracer:

1. Captures the dominant win — the 4.92× example collapses to ≤4× worst case, typically ~1× (a 256² map
   lands in the 256² bucket, not a 4096² layer).
2. Touches none of the fragile correctness paths (wrap, bilinear, the `textureSize` bump/displacement derivative).
3. Storage-buffer cap (10/10) untouched — metadata rides the material buffer's free lanes.
4. The `(arrayId, layer)` data model generalizes cleanly to C2 later.

The exactness only an atlas gives (arbitrary NPoT, zero round-up) is not worth its broken derivative,
gutter machinery, forced-wrap edge cases, and ~+42-float struct growth for this renderer — hence atlas is
deferred, not the default.

---

## 5. Phase 1 implementation plan (size-bucketed arrays)

1. **Bucket assignment** — `GeometryExtractor.processTexture` (`rayzee/src/Processor/GeometryExtractor.js:483-511`):
   compute `bucketId = ceil(log2(max(w,h)))` clamped to `[256 … maxTextureSize]` + a per-bucket running layer
   index. Replace the per-type `WeakMap<uuid, flatIndex>` with `WeakMap<uuid, {bucketId, layer}>`. Respect
   `MAX_TEXTURES_LIMIT` per bucket array.
2. **Dimension split** — rework `TextureCreator.calculateOptimalDimensions` (`TextureCreator.js:1268`) **and the
   worker twin** (`TexturesWorker.js:610`) to emit *N* `(w,h,depth)` triples (one per occupied bucket) instead of
   one. Members placed at native res within a bucket → the upscale resize becomes a no-op (or only rounds NPoT to
   the bucket edge). Update per-layer stride writes (`TextureCreator.js:912-913, 824, 867`; worker `592`).
3. **Array production** — `SceneProcessor._createMaterialTextures` (`rayzee/src/Processor/SceneProcessor.js:774-795`):
   loop buckets within each type, producing `albedoMaps[bucketId]`, etc.
4. **Binding** — `ShaderBuilder.createSceneTextureNodes` (`rayzee/src/Processor/ShaderBuilder.js:120-126`): bind the
   bucket arrays, 1×1 placeholders for empty buckets (reuse `createArrayPlaceholder` at `108-117`). Mirror for the
   shadow-alpha path (`setShadowAlbedoMaps`, `ShaderBuilder.js:139`).
5. **Material struct** — add `bucketId` per map. Pack into the **4 free padding floats first** (slot12.a float 51;
   slot29 floats 117-119) before growing `SLOTS_PER_MATERIAL`. Write in `MaterialDataManager.js:459-464, 482`;
   decode in `Common.js:374-391` into the `RayTracingMaterial` struct.
6. **Sampling** — in `TextureSampling.js`, wrap each `texture(maps, uv).depth(idx)` (sites
   210/228/236/243/260/289-291/316/380) and `Displacement.js` (131/167/188/200-204) with a `bucketId` switch
   selecting the right array node, then `.depth(bucketLayer)`. UV math is **unchanged**. `processBump`'s
   `textureSize(bumpMaps)` (line 287) now reads the chosen bucket array's size — correct, no extra plumbing.
7. **Validate** — 738-test suite + a GPU A/B on a skewed scene (e.g. the bathroom: one 4K albedo + many small
   maps). Compare `app.vram` before/after and a converged-frame RMSE to confirm no sampling regression. Run the
   `check-tsl` skill after shader edits; check LSP diagnostics.

**Binding-budget guard:** naive *per-type × per-bucket* ≈ 21-28 sampled-texture bindings — fits this device (48)
but **exceeds the portable-16 floor**. Mitigate by feature-detecting `adapter.limits.maxSampledTexturesPerShaderStage`
and consolidating buckets that share `(size, colorSpace)`. Note sRGB (albedo/emissive, `TextureCreator.js:1237,1242`)
cannot co-pack with linear maps — that split is mandatory. Fall back to (E) cap-tuning on a strict-16 device.

---

## 6. Phase 2 (conditional) — C2 atlas-of-pages

Trigger only if Phase 1 leaves material intra-bucket waste or a scene needs exact NPoT. Adds, on top of Phase 1:

- a CPU rectangle packer + page (layer) assignment;
- per-map metadata: rect `(offset.xy, scale.xy)` + per-rect `texelSize.xy` + page index
  (≈ +42 floats/material → `SLOTS_PER_MATERIAL` 30 → ~37, with matching `MaterialDataManager` writers and
  `Common.js` reads);
- the forced `origin + fract(uv)*scale` remap at **every** sample site, with the identity-UV fast path
  (`TextureSampling.js:31`) disabled under atlas;
- ≥1px edge-replicated gutters + half-texel inset; clamp-to-subrect for tiled materials at wrap seams;
- **the derivative fix** — replace `textureSize` with the plumbed per-rect texel size in `processBump:287`
  and `Displacement.js:198`;
- upload via `GPUQueue.copyExternalImageToTexture({texture, origin:[x,y,page]}, [w,h,1])` — Three.js
  `addUpdateRange` is row-range only (open issue #32254), no 2D sub-rect.

`maxTextureDimension2D = 16384` here means one page holds 16 full 4K maps; pages spill to array layers.

---

## 7. Risks & mitigations

| Risk | Applies to | Mitigation |
|---|---|---|
| Bilinear border bleed | Atlas (B/C2) only | ≥1px edge-replicated gutter + half-texel inset. **Bucketing has zero bleed** (discrete R-axis) — the main reason it's Phase 1. |
| Wrap across rect / seam | Atlas (B/C2) | force `origin+fract(uv)*scale`; disable identity fast path; clamp-to-subrect for tiled UVs (static gutter insufficient). Bucketing unaffected. |
| `textureSize` bump derivative wrong | Atlas always; bucketing only if intra-bucket resize | plumb per-rect texel size, use in `processBump:287` / `Displacement.js:198`. **Phase 1 avoids this** by placing maps at native res in-bucket. |
| Sampled-texture cap (16 floor) | Bucketing (A) | feature-detect; consolidate by `(size, colorSpace)`; fall back to (E). C2 sidesteps it (1 array / colorSpace). |
| Page overflow > `maxTextureDimension2D` | Atlas (B) | spill to C2 pages (layers). |
| Storage-buffer cap (10/10) | All | metadata rides the material buffer's free lanes — **never** add a storage buffer. |
| KTX2 / compressed | All | non-issue — all inputs force-transcoded to RGBA8 before packing (`AssetLoader.js:912-915`, `TextureCreator._normalizeTexturesForProcessing:1357-1374`). Stay RGBA8; avoids the `CompressedArrayTexture` TSL-global-state ban (`project_tsl_compressed_texture_limitation`). |
| Worker/main divergence | All | `calculateOptimalDimensions` exists in **both** `TextureCreator.js` and `TexturesWorker.js` — change together (worker path triggers above 2M px). |

---

## 8. Verdict

**Yes — possible and worth doing.** Bindless (ideal) is hard-blocked in shipping WebGPU through 2026 but
unnecessary. Phase-1 size-bucketed arrays eliminate the dominant skew waste (≤4× → typically ~1×) and the
small-map upscale blur, while keeping wrap/filter/derivative correct with metadata in existing free lanes.
Bucketing rounds NPoT *up*; only the deferred C2 atlas honors arbitrary sizes exactly. Best single path =
**Phase 1, Option A, ~3-5 focused days.**

Prior art note: three-gpu-pathtracer also resize-to-max into a 2D array (deliberate uniform upscale) — there is
no drop-in implementation to copy.
