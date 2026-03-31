---
name: debug-pipeline
description: >
  Debug the rendering pipeline. Diagnoses why the render output looks wrong by tracing data flow
  through pipeline stages, checking context textures, event wiring, and Display fallback chain.
  Use when the rendered image is black, flickering, shows ghosting, or has visual artifacts.
allowed-tools: Read, Glob, Grep, Bash(npm run lint*), Bash(npm run build*)
---

You are debugging the Rayzee rendering pipeline. Follow this systematic diagnostic process.

## Step 1: Identify the Symptom
Ask the user (if not already clear) which symptom they see:
- **Black screen** → likely a disabled stage publishing dark output, or context texture missing
- **Flickering** → temporal data not persisting, ping-pong swap issue, or reset loop
- **Ghosting/smearing** → ASVGF temporal accumulation bug, motion vector error, or camera matrix mismatch
- **Wrong colors** → Display stage picking wrong texture from fallback chain
- **NaN artifacts (white/black pixels)** → normalize(vec3(0)) on miss rays, or uninitialized data
- **Y-flipped image** → QuadMesh UV Y-flip not handled in screen-space shader

## Step 2: Check the Display Fallback Chain
The Display stage picks the first available texture from this priority list:
1. `bloom:output`
2. `edgeFiltering:output`
3. `asvgf:output`
4. `pathtracer:color`

**If a higher-priority stage is enabled but outputting black/wrong data, it overrides the correct output.**

Read `rayzee/src/Stages/` to find the Display stage and check which textures are being published to context.

## Step 3: Trace Texture Flow
For each stage in the pipeline:
1. What does it read from `context.getTexture()`?
2. What does it publish via `context.setTexture()`?
3. Is the stage enabled? (PipelineStage defaults to `enabled: true`)
4. On denoiser switch, are stale textures cleaned from context?

## Step 4: Check Event Wiring
Verify events are properly connected:
- `pathtracer:frameComplete` → triggers downstream stages
- `asvgf:reset` → clears temporal history
- `tile:changed` → updates tile highlight

## Step 5: Camera Matrix Consistency
If the issue involves depth, normals, or motion vectors:
- Stages MUST sync camera matrices from PathTracer uniforms
- Reading from the camera object directly causes timing mismatches
- Pattern: `this.cameraWorldMatrix.value.copy(pt.cameraWorldMatrix.value)`

## Step 6: TSL Shader Checks
If the issue is in shader output:
- Check for `normalize(vec3(0))` NaN on background pixels
- Check `outputNode` vs `colorNode` (colorNode destroys .w channel for opaque materials)
- Check If/Else chains (separate `If()` blocks contaminate output)

## Step 7: Report Findings
Provide a clear diagnosis with:
- Root cause identified
- Which file(s) and line(s) are affected
- Suggested fix with code
