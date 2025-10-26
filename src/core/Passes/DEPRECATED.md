# DEPRECATED: Legacy Pass Architecture

## ⚠️ Notice

**As of October 26, 2025**, the following Pass classes are **deprecated** and replaced by the new Pipeline architecture:

- ❌ `PathTracerPass.js` → ✅ `PathTracerStage.js`
- ❌ `ASVGFPass.js` → ✅ `ASVGFStage.js`
- ❌ `AdaptiveSamplingPass.js` → ✅ `AdaptiveSamplingStage.js`
- ❌ `EdgeAwareFilteringPass.js` → ✅ `EdgeAwareFilteringStage.js`
- ❌ `TileHighlightPass.js` → ✅ `TileHighlightStage.js`

---

## Why Deprecated?

The old Pass-based architecture had several issues:

1. **Tight Coupling** - Direct pass-to-pass references
2. **Execution Order Issues** - AdaptiveSamplingPass ran BEFORE PathTracerPass
3. **Global State** - `window.pathTracerApp` access throughout
4. **Hard to Test** - Couldn't test passes in isolation
5. **Poor Maintainability** - Changes rippled through multiple files

---

## New Pipeline Architecture

**Location:** `src/core/Stages/`

**Benefits:**
- ✅ Zero coupling between stages
- ✅ Event-driven communication
- ✅ Context-based texture sharing
- ✅ Fully testable in isolation
- ✅ Correct execution order guaranteed
- ✅ Clean separation of concerns

---

## Migration Status

### Default Behavior (Now)
- **Pipeline Architecture** - New event-driven system
- Enabled by default as of October 2025
- 5,961 lines of production-ready code

### Fallback Mode (Legacy)
- **Pass Architecture** - Original tightly-coupled system
- Available via `?pipeline=false` URL parameter
- Kept for debugging/comparison only
- **Will be removed in future release**

---

## For Developers

### If you're maintaining this code:

**DO:**
- ✅ Add new features to `src/core/Stages/`
- ✅ Fix bugs in both architectures if needed
- ✅ Test with pipeline architecture first
- ✅ Reference `PASS_PIPELINE_ARCHITECTURE.md` for design

**DON'T:**
- ❌ Add new features to deprecated Pass files
- ❌ Increase coupling in Pass architecture
- ❌ Assume Pass files will exist in future versions

### Timeline

- **October 2025** - Pipeline becomes default
- **Q1 2026** - Deprecation warnings added (done ✅)
- **Q2 2026** - Evaluate removing Pass files entirely
- **Q3 2026+** - Remove Pass files if no issues found

---

## Files Kept For Compatibility

The following Pass files remain available but should NOT be used for new work:

```
src/core/
├── PathTracerPass.js         (deprecated → use PathTracerStage)
└── Passes/
    ├── ASVGFPass.js          (deprecated → use ASVGFStage)
    ├── AdaptiveSamplingPass.js (deprecated → use AdaptiveSamplingStage)
    ├── EdgeAwareFilteringPass.js (deprecated → use EdgeAwareFilteringStage)
    ├── TileHighlightPass.js  (deprecated → use TileHighlightStage)
    ├── OIDNDenoiser.js       (✅ still used by both architectures)
    └── (other denoisers...)  (✅ still active)
```

---

## Questions?

See:
- **Architecture:** [PASS_PIPELINE_ARCHITECTURE.md](../../PASS_PIPELINE_ARCHITECTURE.md)
- **Usage:** [PIPELINE_USAGE.md](../../PIPELINE_USAGE.md)
- **Code:** [src/core/Stages/](../Stages/)
- **Integration:** [src/core/main.js](../main.js)
