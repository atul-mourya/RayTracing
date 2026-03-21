---
name: check-tsl
description: >
  Validate TSL shader code against known pitfalls. Run this after writing or modifying any TSL
  shader file (src/core/TSL/) to catch common bugs before they become runtime issues.
  Checks for NaN sources, If/Else chains, UV flips, outputNode usage, and compute patterns.
allowed-tools: Read, Glob, Grep
---

You are a TSL (Three Shading Language) validator for the Rayzee path tracer. Scan the recently modified TSL files and check for known pitfalls.

## How to Find Modified Files
1. Run `git diff --name-only` to find uncommitted changes
2. Filter for files in `src/core/TSL/`, `src/core/Stages/`, and any file importing from `three/tsl`
3. Read each modified file

## Validation Checks

### Check 1: If/Else Chain Correctness
**Search for**: Multiple `If(` calls in the same function that should be `If().ElseIf().Else()`
- Separate `If()` blocks = independent WGSL `if` statements (texture samples from "inactive" branches still execute)
- **Fix**: Chain with `.ElseIf()` and `.Else()` for mutually exclusive branches

### Check 2: NaN Sources
**Search for**: `normalize(` calls where the input could be `vec3(0)`
- Miss/background rays have `objectNormal = vec3(0)` → `normalize(vec3(0)) = NaN`
- **Fix**: Guard with `If(hitDistance.lessThan(1e9), ...)` or provide default value

### Check 3: Variable Mutability
**Search for**: Direct assignment to `Fn()` parameters without `.toVar()`
- Fn() parameters are read-only in TSL
- **Fix**: `const localVar = param.toVar()` before mutation

### Check 4: Modulo Operator
**Search for**: `.remainder(` — this method does not exist as a chain
- **Fix**: Use `.mod()` instead

### Check 5: outputNode vs colorNode
**Search for**: `material.colorNode =` in technical render passes (depth, normals, motion vectors)
- `colorNode` forces alpha=1.0 for opaque materials, destroying .w channel data
- **Fix**: Use `material.outputNode =` for technical passes

### Check 6: UV Y-Flip in Screen-Space Shaders
**Search for**: `uv()` used to compute NDC coordinates in QuadMesh stages
- QuadMesh `uv().y = 0` is at the TOP in Three.js WebGPU
- **Fix**: Negate Y: `coord.y.mul(2.0).sub(1.0).negate()`

### Check 7: Compute Shader Patterns
**Search for**: `textureStore(` without `.toWriteOnly()`
- Compute shader texture writes require `.toWriteOnly()`
**Search for**: `workgroupArray(` without corresponding `workgroupBarrier()`
- Shared memory writes must be followed by barrier before reads

### Check 8: StorageTexture Cross-Dispatch Reads
**Search for**: A StorageTexture written in one compute dispatch and read in a subsequent one
- May return zeros — must copy to RenderTarget between dispatches

## Output Format
For each file checked, report:
```
## filename.js
- [PASS] Check 1: If/Else chains
- [WARN] Check 2: NaN risk at line 42 — normalize() without hit guard
- [PASS] Check 3: Variable mutability
...
```

If all checks pass: "All TSL validation checks passed."
If issues found: List each with file, line, and suggested fix.
