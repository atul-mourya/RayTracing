# Two-Level BVH (TLAS/BLAS) for Dynamic Scenes

## Problem Overview

When using a **Compressed Wide BVH (CWBVH)** for an entire scene, performance is excellent for static geometry. However, if a mesh moves, or you insert/delete a mesh, you must perform a full rebuild of the BVH — which is computationally expensive.

## Standard Solution: Two-Level BVH (TLAS/BLAS)

A widely adopted solution in real-time ray tracing frameworks (Embree, OptiX, DXR, MetalRT) is to separate the acceleration structure into two levels:

### 1. Bottom-Level Acceleration Structure (BLAS)

* A BVH per unique mesh (or mesh instance)
* Built once and reused since the geometry is static
* Stores bounding boxes in **local space**

### 2. Top-Level Acceleration Structure (TLAS)

* A BVH over instances of BLASes
* Each node stores:

  * The bounding box of the transformed BLAS
  * The transform from world space → mesh local space
* Much smaller than the full geometry, allowing fast refits or rebuilds

## Workflow

1. **Build once:**

   * Create a BLAS for each mesh
   * Build a TLAS that references those BLASes

2. **If a mesh moves (rigid transform):**

   * Update its transform matrix
   * Refit or rebuild the TLAS only (fast)

3. **If a mesh deforms (non-rigid):**

   * Refit its BLAS (update AABBs only)
   * Rebuild only if topology changes drastically

4. **If a mesh is inserted or deleted:**

   * Only rebuild/refit the TLAS

## Example (Pseudocode)

```js
// Build BLAS (per mesh)
for each mesh:
    mesh.BLAS = buildBVH(mesh.vertices)

// Build TLAS (scene)
for each instance:
    bounds = transformBounds(mesh.BLAS.root.bounds, instance.transform)
TLAS = buildBVH(instanceBounds)

// Ray traversal
traceRay(TLAS, ray):
    for each intersected instance node:
        ray_local = transformRay(ray, instance.inverseTransform)
        hit = traceRay(mesh.BLAS, ray_local)
        ...
```

## Variants and Extensions

| Technique                    | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| **Refitting**                | Update bounding boxes without changing topology — good for deformation.                     |
| **Dynamic BVH (DBVH)**       | Incremental BVH updates for small geometry changes.                                         |
| **LBVH + Rebuild-on-demand** | GPU-friendly rebuild using Morton codes, fast even for full rebuilds.                       |
| **Multi-Level BVH (MBVH)**   | Extends the two-level concept to multiple hierarchy layers.                                 |
| **Scene Graph Integration**  | BVHs built hierarchically matching logical scene graphs (e.g., character → limbs → meshes). |

## Combining with CWBVH

You can combine **CWBVH compression** with the **two-level structure**:

* Use **CWBVH** per mesh (BLAS level)
* Keep the **TLAS** uncompressed (for frequent updates)
* On motion: update instance transforms and refit TLAS bounds

### Benefits

✅ High performance from CWBVH at the BLAS level
✅ Real-time updates for dynamic scenes
✅ Minimal rebuild cost

## Summary

| Situation                   | Best Practice                              |
| --------------------------- | ------------------------------------------ |
| Static geometry             | Monolithic CWBVH                           |
| Movable meshes              | TLAS/BLAS two-level structure              |
| Deforming meshes            | BLAS refit per frame                       |
| Frequent additions/removals | TLAS rebuild only                          |
| Want compression            | Compress only BLAS (CWBVH), leave TLAS raw |
