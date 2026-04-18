# Behaviour Specification: Custom Canvas Size / Custom Aspect Ratio

**Status**: Draft
**Feature**: Custom canvas size / custom aspect ratio support
**TODO ref**: `docs/TODO.md` → Camera → custom canvas size / custom aspect ratio

---

## 1. Problem Statement

The renderer currently hardcodes a **512x512 square canvas**. All downstream systems — render targets, camera frustum, tile rendering, denoiser output, image export — implicitly assume `width === height`. Users cannot render at standard production aspect ratios (16:9, 2.39:1, 4:3, 1:1, 9:16 portrait, etc.) or at arbitrary pixel dimensions.

This limits Rayzee to square outputs only, which is insufficient for:
- Social media deliverables (Instagram stories 9:16, YouTube thumbnails 16:9, Twitter banners 3:1)
- Print and wallpaper resolutions (3840x2160, 2560x1440, A4 portrait)
- Cinematic aspect ratios (2.39:1 anamorphic, 1.85:1 flat)
- Pixel-exact output for compositing workflows

---

## 2. Industry Context & Prior Art

### 2.1 How Professional Renderers Handle This

| Application | Canvas/Viewport | Render Resolution | Aspect Lock | Notes |
|---|---|---|---|---|
| **Blender (Cycles/EEVEE)** | Viewport freely resizable, render resolution decoupled | Explicit W×H in pixels | Optional lock toggle | Viewport shows letterbox/pillarbox overlay when aspect differs |
| **Cinema 4D** | Viewport shows safe frame overlay | Explicit W×H + DPI for print | Lock icon on dimension fields | Presets for film/TV/social media formats |
| **Unreal Engine** | Viewport free, PIE window matches | Camera sensor/gate + resolution | Filmback presets (Super 35, IMAX) | Physically-based — sensor size drives aspect |
| **Substance Painter** | Square viewport (like current Rayzee) | Export at any W×H | N/A | Viewport always square, bake/export is decoupled |
| **Three.js examples** | `renderer.setSize(w, h)` matches container | Same as canvas | Manual via code | No built-in UI; developer responsibility |

### 2.2 Key Industry Patterns

1. **Decoupled viewport vs render resolution**: The viewport (what you interact with) and the render output (what you export) are independent. The viewport shows a "safe frame" or letterbox overlay to indicate the render region.

2. **Presets + custom entry**: Every major tool ships aspect ratio presets (16:9, 4:3, 1:1, 9:16, 2.39:1) alongside free-form W×H pixel entry.

3. **Aspect lock toggle**: A chain-link icon between W and H fields. When locked, changing one dimension auto-calculates the other. When unlocked, both are independent.

4. **Resolution vs quality independence**: Render quality (samples, bounces) is orthogonal to resolution. Blender, C4D, and Unreal all let you set 8K resolution at 1 SPP or 256×256 at 10,000 SPP.

5. **Safe frame overlay**: When render aspect differs from viewport aspect, a semi-transparent overlay masks the non-rendered region. The user sees exactly what will be in the final image.

---

## 3. Proposed Behaviour

### 3.1 User-Facing Model

Two independent controls:

| Control | Description | Default |
|---|---|---|
| **Canvas Dimensions** (W × H) | The pixel dimensions of the render output | 512 × 512 |
| **Resolution Scale** | Multiplier on canvas dimensions for internal render resolution | Existing 256–4096 system |

The **aspect ratio** is derived from W/H — it is not a separate input but is displayed as a label (e.g., "16:9") and can be locked.

### 3.2 Dimension Input Modes

#### Mode A: Preset Aspect Ratio + Single Resolution
User picks an aspect ratio preset, then a resolution tier. System calculates W×H.

| Preset | Ratio | At 1024 tier | At 2048 tier | At 4096 tier |
|---|---|---|---|---|
| Square | 1:1 | 1024×1024 | 2048×2048 | 4096×4096 |
| Landscape 16:9 | 16:9 | 1024×576 | 2048×1152 | 3840×2160 |
| Portrait 9:16 | 9:16 | 576×1024 | 1152×2048 | 2160×3840 |
| Cinematic | 2.39:1 | 1024×428 | 2048×857 | 4096×1714 |
| Classic | 4:3 | 1024×768 | 2048×1536 | 4096×3072 |
| Social Story | 9:16 | 1080×1920 | — | — |
| Instagram Square | 1:1 | 1080×1080 | — | — |

The resolution tier maps to the **longest edge**, not the shortest (current system uses shortest — this must change for non-square).

#### Mode B: Custom W × H
User enters exact pixel values. Aspect ratio label updates automatically. Lock toggle available.

#### Mode C: Swap Dimensions
A rotate/swap button that exchanges W and H (landscape ↔ portrait).

### 3.3 Viewport Display Behaviour

The viewport container must adapt to show non-square canvases:

1. **Canvas element** sized to match the W×H aspect ratio at a display-friendly size (fit within viewport panel with padding).
2. **CSS transform scaling** remains for zoom in/out (existing `viewportScale` mechanism).
3. **No letterboxing needed** — the canvas itself is the exact aspect ratio. The viewport background (checkerboard) fills the remaining panel space.
4. The canvas display size is calculated as: fit the W×H rectangle into the available viewport panel, maintaining aspect ratio.

### 3.4 Render Pipeline Behaviour

When canvas dimensions change from `oldW×oldH` to `newW×newH`:

1. **Canvas resize**: The WebGPU canvas and the engine-managed denoiser canvas update to `newW×newH` (display size) or the CSS-scaled equivalent.
2. **Camera frustum**: `camera.aspect = newW / newH`, then `updateProjectionMatrix()`.
3. **Renderer**: `renderer.setSize(newW, newH)` with appropriate pixel ratio.
4. **Pipeline resize**: `pipeline.setSize(renderW, renderH)` propagates to all stages.
5. **All render targets**: Recreated at `renderW × renderH`.
6. **Tile rendering**: `TileManager` receives new dimensions — tile bounds recalculated (already handles non-square correctly).
7. **Denoiser**: OIDN buffers reallocated for new dimensions.
8. **Reset**: Full accumulation reset (`app.reset()`).
9. **Image export**: `canvas.toDataURL()` naturally captures at the new dimensions.

### 3.5 Resolution Scale Mapping (Revised)

Current system maps resolution index to a fixed pixel value applied to the shortest edge. For non-square support, map to the **longest edge**:

```
Longest edge target: { 0: 256, 1: 512, 2: 1024, 3: 2048, 4: 4096 }
pixelRatio = targetForLongestEdge / max(displayW, displayH)
renderW = round(displayW * pixelRatio)
renderH = round(displayH * pixelRatio)
```

This ensures a 16:9 canvas at tier 3 (2048) renders at 2048×1152, not 3641×2048 (which would happen with shortest-edge mapping and be unexpectedly expensive).

---

## 4. Challenges & Nuances

### 4.1 Memory and Performance Scaling

**Challenge**: A 4096×2304 (16:9 at tier 4) render has 9.4M pixels vs 16.7M for 4096×4096. But users may not realize that a 4K ultrawide (5120×2160) exceeds VRAM budgets.

**Mitigation**:
- Display estimated VRAM usage alongside dimension inputs.
- Cap maximum total pixel count (e.g., 4096×4096 = 16.7M pixels max) rather than capping each dimension independently.
- Warn when exceeding device limits (`adapter.limits.maxTextureDimension2D`).

### 4.2 Render Target Alignment

**Challenge**: Some GPU operations require dimensions aligned to specific boundaries (e.g., workgroup sizes in compute shaders, tile sizes).

**Nuance**: ASVGF compute shaders dispatch in 8×8 workgroups. Non-aligned dimensions waste threads at edges but don't break correctness — boundary checks already exist. Tile rendering divides with `Math.ceil`, handling remainders.

**Mitigation**: Round render dimensions to nearest multiple of 8 (or workgroup size) internally. Display the exact user-requested dimensions but render at the aligned size, cropping on output if needed.

### 4.3 Denoiser Buffer Mismatch

**Challenge**: OIDN expects exact buffer dimensions matching the input. If render dimensions are aligned/rounded but denoiser expects the original dimensions, buffer sizes mismatch.

**Mitigation**: Denoiser always receives the actual render target dimensions (post-alignment), not the user-requested dimensions. The final crop (if any) happens after denoising.

### 4.4 Temporal Stability on Resize

**Challenge**: Changing canvas dimensions invalidates all temporal data — ASVGF history buffers, motion vectors, adaptive sampling variance maps. A resize mid-convergence discards accumulated samples.

**Mitigation**:
- Treat dimension change as a full reset (same as current resolution change behaviour).
- Disable dimension changes during active final render (greyed out controls with tooltip).
- Interactive mode: allow free resizing, accept the reset cost.

### 4.5 Tile Rendering with Non-Square Dimensions

**Challenge**: Current tile grid is NxN (square grid). For extreme aspect ratios (3:1), this produces very wide, short tiles that may not be optimal for cache coherence.

**Nuance**: Tile rendering in path tracers typically uses square tiles regardless of image aspect ratio (Blender uses 256×256 tiles by default). The tile grid naturally adapts — a 3840×2160 image with 256×256 tiles has 15×9 = 135 tiles. The existing `TileManager.calculateTileBounds` already handles this correctly with its `Math.ceil` division.

**No change needed** for tile rendering logic itself, only for the tile count calculation and spiral traversal pattern to work with non-square grids.

### 4.6 UI/UX: Canvas in Viewport Panel

**Challenge**: The viewport panel has a fixed layout. A very wide canvas (e.g., 3:1 cinematic) will be tiny vertically when fit to the panel width, wasting vertical space. A very tall canvas (9:16 portrait) has the inverse problem.

**Mitigation**:
- `calculateBestFitScale` already computes `min(scaleX, scaleY)` — it naturally handles non-square. The function signature needs to accept `canvasWidth, canvasHeight` instead of a single `canvasSize`.
- Allow the user to zoom in (scroll wheel / pinch) and pan the canvas within the viewport for detail inspection at extreme aspect ratios.
- Show the actual pixel dimensions as a label overlay on the canvas (e.g., "3840 × 2160").

### 4.7 Screenshot/Export Fidelity

**Challenge**: `canvas.toDataURL()` captures at the CSS display size, not the internal render resolution. A canvas displayed at 512×288 (16:9) but rendering internally at 2048×1152 would export at 512×288.

**Mitigation**: For image export, either:
- Use `canvas.width/height` attributes (not CSS size) set to the full render resolution, then scale display with CSS. This is the correct approach — the canvas element's intrinsic dimensions should match the render resolution.
- Or render to an offscreen canvas at full resolution for export (avoids display canvas DPI complications).

### 4.8 Denoiser Canvas Sync

**Challenge**: The OIDN denoiser writes to a separate 2D canvas. This canvas must match the render output dimensions exactly.

**Mitigation**: The engine internally creates and manages the denoiser canvas, inserting it as a sibling before the main WebGPU canvas. Both canvases resize together — the engine syncs the denoiser canvas dimensions in `onResize()` and `setCanvasSize()`. The denoiser canvas is automatically cleaned up on `dispose()`.

### 4.9 WebGPU Texture Size Limits

**Challenge**: `maxTextureDimension2D` is typically 8192 or 16384 depending on the GPU. With MRT (3 attachments per render target) and ping-pong buffers, a 4096×4096 render allocates ~600MB of VRAM just for path tracer render targets.

**Mitigation**:
- Query `adapter.limits.maxTextureDimension2D` at init.
- Clamp user input to device limits.
- Display available VRAM estimate when dimensions are large.

### 4.10 Aspect Ratio and DOF

**Challenge**: Depth of field bokeh shape is affected by aspect ratio in physical cameras (anamorphic lenses produce oval bokeh). The current DOF system may assume circular aperture.

**Nuance**: This is a separate feature (`Depth of field with support for anamorphic bokeh` in TODO). Custom aspect ratio does not require anamorphic DOF — standard DOF works correctly at any aspect ratio. The sensor aspect ratio affects field of view, not bokeh shape. Anamorphic is a lens property, not a sensor property.

**No coupling needed** between this feature and anamorphic DOF.

---

## 5. State Model

### 5.1 New Store State

```js
// In usePathTracerStore (or a new useCanvasStore)
canvasWidth: 512,           // User-requested canvas width in pixels
canvasHeight: 512,          // User-requested canvas height in pixels
aspectRatioLocked: true,    // Lock toggle
aspectRatioPreset: '1:1',   // Current preset name (or 'custom')
```

### 5.2 Derived Values

```js
aspectRatio = canvasWidth / canvasHeight          // Numeric ratio
renderWidth = round(canvasWidth * pixelRatio)      // Internal render dimensions
renderHeight = round(canvasHeight * pixelRatio)
displayLabel = `${canvasWidth} × ${canvasHeight}`  // UI display string
```

### 5.3 Handlers

```js
handleCanvasWidthChange(newWidth)   // Respects lock: auto-adjusts height if locked
handleCanvasHeightChange(newHeight) // Respects lock: auto-adjusts width if locked
handleAspectPresetChange(preset)    // Sets both W and H from preset + current resolution tier
handleSwapDimensions()              // Swaps W and H
handleAspectLockToggle()            // Toggles lock state
```

All handlers follow the existing `handleChange` pattern: update store, update app via `getApp()`, call `app.reset()`.

---

## 6. Affected Systems

| System | File(s) | Change Required |
|---|---|---|
| Canvas sizing | `Viewport3D.jsx` | Replace hardcoded 512×512 with store-driven W×H |
| Viewport scaling | `viewport.js` | Accept `(canvasWidth, canvasHeight)` instead of `canvasSize` |
| Resolution mapping | `store.js`, `PathTracerApp.js` | Longest-edge-based pixel ratio calculation |
| Camera frustum | `PathTracerApp.js` | Already uses `width/height` — just needs non-square input |
| Render targets | All stages via `pipeline.setSize()` | Already parameterized — no change |
| Tile rendering | `TileManager.js` | Already handles non-square — verify spiral order |
| Denoiser canvas | `PathTracerApp.js` | Engine-managed — auto-synced on resize |
| Image export | `Viewport3D.jsx` | Ensure export captures at render resolution |
| UI controls | `PathTracerTab.jsx` or `FinalRenderPanel.jsx` | New dimension/preset inputs |
| Store | `store.js`, `Constants.js` | New state fields and handlers |

---

## 7. Non-Goals (Out of Scope)

- **Crop/region rendering**: Rendering a sub-region of the full frame (separate feature).
- **Anamorphic DOF**: Oval bokeh from anamorphic lenses (separate TODO item).
- **Multi-camera rendering**: Different resolutions per camera.
- **Render border** (Blender-style): Rendering only a marked rectangle of the full image.
- **DPI/PPI metadata**: Embedding print resolution metadata in exported images.
- **Animation resolution**: Per-frame resolution changes during camera motion video rendering.

---

## 8. Acceptance Criteria

1. User can select from preset aspect ratios (1:1, 16:9, 9:16, 4:3, 2.39:1) and the canvas updates accordingly.
2. User can enter custom W×H values. Both fields accept values from 64 to `maxTextureDimension2D`.
3. Lock toggle: when locked, changing W auto-adjusts H (and vice versa) to maintain aspect ratio.
4. Swap button exchanges W and H instantly.
5. Viewport correctly displays non-square canvases with proper fit-to-panel scaling.
6. Render output (interactive and final) produces correct non-square images with no stretching or distortion.
7. Exported images match the user-specified pixel dimensions exactly.
8. Camera frustum matches the canvas aspect ratio — no FOV distortion.
9. All denoising modes (ASVGF, OIDN, none) work correctly at non-square resolutions.
10. Dimension controls are disabled during active final render.
11. Changing dimensions triggers a full accumulation reset.
12. VRAM warning displayed when total pixel count exceeds a safe threshold.
