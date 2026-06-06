# Megakernel Removal — Pure Wavefront Architecture Plan

Goal: remove the monolithic megakernel entirely; leave a clean pure-wavefront engine with
**zero tech debt**, up-to-date UI/docs/tests, no lint errors, and a clear file layout.

Decisions (locked):
- **Debug visualization** → a wavefront debug kernel (`TSL/wavefront/DebugKernel.js`) that **reuses**
  the renderer-agnostic `TraceDebugMode` (`TSL/Debugger.js`) for modes 1–10 (it does its own primary-ray
  trace + per-mode color — no megakernel dependency), computes mode 9 (stratified jitter) inline, and
  routes mode 11 (NaN/Inf) through the normal pipeline + a `FinalWriteKernel` post-branch. All 12 modes
  preserved; UI/uniforms stay. **Reusing `TraceDebugMode` instead of reimplementing it avoids duplicating
  ~80 lines of debug color logic, so `Debugger.js` is KEPT, not deleted.**
- **Class structure** → slim `PathTracerStage` base (shared engine/scene infrastructure) +
  `PathTracer` renderer (wavefront dispatch) extending it. Organization, not polymorphism.
- **File reorg** → full (promote `TSL/wavefront/*` → `TSL/`, rename wavefront-qualified files),
  done LAST so imports stay stable.

Progress: **P1 ✅ P2 ✅ P3 ✅** (committed + live-verified). P4–P6 pending.

Approach deltas vs the original sketch below (all reduce churn/tech-debt):
- P1: shared TSL helpers (`getRequiredSamples`, `computeNDCDepth`) moved into the existing
  `TSL/PathTracerCore.js`, not a new `CameraSampling.js`.
- P2: the texture-node factory stays IN `ShaderBuilder.js` (renamed `_createTextureNodes` →
  public `createSceneTextureNodes`), not a new `SceneTextureNodeManager.js`. `ShaderBuilder.js`
  is the SHARED half and SURVIVES; P5 deletes only its megakernel half (rename to fit in P6 if warranted).
- P3: `DebugKernel` wraps `TraceDebugMode`; `Debugger.js` is kept (shared debug color logic).

## Why this is a separation, not a deletion
`WavefrontPathTracer extends PathTracer`. `PathTracer.js` (~1600 lines) is BOTH the megakernel
renderer AND the shared engine base the wavefront inherits (5 managers, uniforms, camera, lights,
BVH/scene, accumulation, completion, ASVGF coord, lifecycle). Removing the megakernel = peel the
monolithic-dispatch code off the shared base, without breaking the wavefront mid-way.

## Landmines (must be handled, in order)
1. **4 shader setters are SHARED, not megakernel-only.** `setShadowAlbedoMaps`/`setAlphaShadowsUniform`
   (`TSL/LightsDirect.js`) + `setGoboMapsTexture`/`setIESProfilesTexture` (`TSL/LightsCore.js`) configure
   module-level state the wavefront `ShadeKernel` reads (alpha shadows, gobo, IES). They are *called* only
   from megakernel `ShaderBuilder.setupCompute()` (`ShaderBuilder.js:231,271,275,280`). **Relocate the calls;
   do NOT delete.** Deleting → silent wrong shadows/gobo/IES in the wavefront.
2. **`ShaderBuilder._createTextureNodes()` is the SOLE producer** of the texture nodes the wavefront reads
   (`prevColor/NormalDepth/Albedo`, `adaptiveSampling`, scene textures via `getSceneTextureNodes()`), and it
   runs only inside megakernel-only `setupCompute()`. `EnvironmentManager`/`GoboManager`/`IESManager` mutate
   these same node objects at runtime. **Relocate to a shared factory before deleting the megakernel half**,
   else the wavefront gets null texture nodes → permanent black.
3. **`TSL/PathTracer.js` and `TSL/PathTracerCore.js` are MIXED.** Wavefront imports `getRequiredSamples` +
   `computeNDCDepth` (from `TSL/PathTracer.js`) and `regularizePathContribution` + `generateSampledDirection`
   (from `PathTracerCore.js`). **Trim precisely** — move the shared exports out, then delete only the
   megakernel-only parts (`pathTracerMain`, `dithering`, `Trace`, `TraceResult`, `handleRussianRoulette`,
   `sampleBackgroundLighting`, `getOrCreateMaterialClassification`).
4. **`PathTracerApp.js:752 forceCompile()`** compiles the dead megakernel node every load — repoint to a
   wavefront warm-up or remove. Keep the separate raster `compileAsync(meshScene)` at :755.

## Phases (each ends with `npm run lint` clean + `npm test` green + engine/app build)

### P1 — Extract shared TSL
- Move `getRequiredSamples` + `computeNDCDepth` out of `TSL/PathTracer.js` into a shared module
  (e.g. `TSL/CameraSampling.js`); keep `regularizePathContribution`/`generateSampledDirection` in
  `PathTracerCore.js`. Update `GenerateKernel.js:19` + `ShadeKernel.js:56` imports.
- After this, `TSL/PathTracer.js` holds only megakernel code (`pathTracerMain`, `dithering`).

### P2 — Split ShaderBuilder (the safety-critical phase; BOTH renderers still work)
- New `Processor/SceneTextureNodeManager.js`: the salvaged `_createTextureNodes` + `getSceneTextureNodes`
  + `updateSceneTextures` + `updateGoboMaps`/`updateIESProfiles` + `prev*`/`adaptiveSampling` nodes +
  `renderWidth`/`renderHeight`, AND the 4 setter calls (shadow/alpha/gobo/IES) in the same order.
- `PathTracer.setupMaterial()` builds texture nodes via this manager (instead of via `ShaderBuilder.setupCompute`).
- Re-wire `EnvironmentManager` `getSceneTextureNodes()` callback + `GoboManager`/`IESManager` to the manager
  (verify they mutate the SAME node objects the setters received).
- Keep the megakernel `computeNode`/`setupCompute` temporarily. **Checkpoint: megakernel + wavefront both render.**

### P3 — Wavefront debug kernel (reimplement the 12 modes; megakernel still present)
- New `TSL/wavefront/DebugKernel.js`: a single primary-ray debug compute kernel — generate camera ray →
  `traverseBVH` (with triangle/box test counters for modes 7/8) → compute the per-`visMode` debug color
  (port the color logic from `TSL/Debugger.js` `TraceDebugMode`; reuse hit normal/depth/albedo, env
  luminance/PDF) → write the color output. Mode 11 (NaN/Inf) handled as a `FinalWriteKernel` post-branch.
- `WavefrontPathTracer.render()`: when `visMode>0`, dispatch the debug kernel instead of `super.render()`.
- Modes map: 1 normals, 2 depth, 3 albedo (from first-hit MRT data the wavefront already produces);
  4 emissive, 5 indirect-GI, 6 env-reflection (primary-ray approximations); 7 triangle tests, 8 box tests
  (BVH counters); 9 stratified samples; 10 env luminance; 11 NaN/Inf.
- **Checkpoint: every debug mode renders via the wavefront (verify each against the megakernel output).**

### P4 — Collapse the hierarchy
- Rename `Stages/PathTracer.js` → `Stages/PathTracerStage.js`: strip `render()` (megakernel dispatch),
  `setFullScreenDispatch` references, `forceCompile`, any computeNode use. Keep ALL shared infra (managers,
  uniforms, camera, lights, BVH, accumulation, completion, ASVGF coord, lifecycle, the frame-0 primer needs).
- Rename `Stages/WavefrontPathTracer.js` → `Stages/PathTracer.js`; `class PathTracer extends PathTracerStage`;
  `this.name = 'PathTracer'`; drop the no-op `reset()` override.
- Replace the not-ready `super.render()` fallback with an early return (skip frame until kernels built).
- `PathTracerApp.js`: drop the megakernel import + the renderer-selection ternary (`~:1494`); always
  instantiate the sole `PathTracer`. Remove `forceCompile()` call (`:752`). Remove `wavefrontEnabled` from
  `EngineDefaults.js` + `app/src/store.js` (the dead `setWavefrontEnabled`). **Checkpoint: green.**

### P5 — Delete the megakernel
- Delete `TSL/PathTracer.js` (`pathTracerMain`/`dithering`/`nanInfToRed` — the wavefront `FinalWriteKernel`
  has its own `nanInfToRed`), the megakernel-only `PathTracerCore.js` exports (`Trace`, `TraceResult`,
  `handleRussianRoulette`, `sampleBackgroundLighting`, `getOrCreateMaterialClassification` — keep the shared
  helpers `Trace`-adjacent ones the kernels still import), and the megakernel half of `ShaderBuilder.js`
  (`setupCompute`/`_buildComputeNode`/`setFullScreenDispatch`/`computeNode`/`forceCompile`/`renderWidth`/
  `renderHeight`/`setSize`). `ShaderBuilder.js` SURVIVES (shared scene-texture-node factory).
- **KEEP `TSL/Debugger.js`** — `TraceDebugMode` is reused by the wavefront `DebugKernel`.
- Grep for now-unused imports/symbols; remove. **Checkpoint: green, no dead imports.**

### P6 — Reorg + docs + UI + lint (last)
- Promote `TSL/wavefront/*` → `TSL/` (delete the `wavefront/` dir); rename `Processor/WavefrontKernelManager.js`
  → `KernelManager.js`; consider `PackedRayBuffer.js`/`QueueManager.js` as-is. Update all imports.
- Docs rewrite for pure-wavefront: `CLAUDE.md` (PathTracer description, remove two-renderer/megakernel sections,
  fix the stale `setMeshVisibilityBuffer` claim — visibility is patched in the BVH buffer, not via that fn),
  `docs/PIPELINE_ARCHITECTURE.md`, `docs/PATH_TRACER_SHADER_ARCHITECTURE.md` (rewrite around the kernel pipeline),
  `docs/specs/WAVEFRONT_TODO.md` (resolve the "remove monolithic" item), `README.md` + `rayzee/README.md`,
  `docs/TODO.md`. Include the documented wavefront perf characteristics.
- Tests: delete/upgrade any renderer-selection or megakernel-path tests; add a wavefront lifecycle test
  (setupMaterial → kernels built → render) + a debug-kernel smoke test. Update `vitest.config.js` coverage
  excludes (now-renamed files).
- `npm run lint-fix`, `npm test`, `npm run build:engine`, `npm run build:app`. Live-verify via chrome-devtools
  (default scene + each debug mode + an OIDN/upscale render).

## Final layout
```
Stages/PathTracer.js              ← wavefront renderer (sole), extends ↓
Stages/PathTracerStage.js         ← shared engine/scene infrastructure
Processor/ShaderBuilder.js        ← shared scene-texture-node factory (createSceneTextureNodes) + 4 setters
Processor/KernelManager.js        ← was WavefrontKernelManager
Processor/{PackedRayBuffer,QueueManager,StorageTexturePool,...}.js
TSL/{GenerateKernel,ExtendKernel,ShadeKernel,CompactKernel,FinalWriteKernel,Sort*,DebugKernel}.js  ← was TSL/wavefront/
TSL/Debugger.js                   ← TraceDebugMode, reused by DebugKernel (shared)
TSL/PathTracerCore.js             ← Trace/shared helpers incl. getRequiredSamples + computeNDCDepth
TSL/{BVHTraversal,Lights*,Material*,Disney,Environment,Subsurface,...}.js  ← shared, unchanged
[deleted] Stages/WavefrontPathTracer.js, TSL/PathTracer.js, TSL/wavefront/ (dir), megakernel half of ShaderBuilder.js
```

## Invariants
- After every phase: build + tests + lint green; the app renders correctly.
- P2 before P4 (texture-node factory must exist before the megakernel half is deleted).
- P3 before P5 (debug kernel must exist before the megakernel is deleted).
- P6 (reorg) last (imports stable).
- No orphaned UI controls, dead store keys, stale docs, or unused imports at the end.
