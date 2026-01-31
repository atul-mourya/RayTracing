/**
 * TSL/WGSL Module Index
 * Central export point for all ported GLSL shader modules
 * 
 * Complete path tracing system ported from GLSL to TSL/WGSL
 */

// ================================================================================
// CORE STRUCTURES AND UTILITIES
// ================================================================================

export * from './Struct.js';
export * from './Common.js';
export * from './Random.js';

// ================================================================================
// GEOMETRY AND INTERSECTION
// ================================================================================

export * from './RayIntersection.js';
export * from './RayAABB.js';
export * from './RayTriangle.js';
export * from './BVHTraversal.js';
export * from './Displacement.js';

// ================================================================================
// ENVIRONMENT AND CAMERA
// ================================================================================

export * from './Environment.js';
export * from './CameraRay.js';

// ================================================================================
// MATERIAL SYSTEM
// ================================================================================

// BRDF Components
export * from './Fresnel.js';
export * from './BSDF.js';
export * from './DisneyBSDF.js';

// Material Properties and Evaluation
export * from './MaterialProperties.js';
export * from './MaterialEvaluation.js';
export * from './MaterialSampling.js';
export * from './MaterialTransmission.js';
export * from './Clearcoat.js';

// Texture Sampling
export * from './TextureSampling.js';

// ================================================================================
// LIGHTING SYSTEM
// ================================================================================

export * from './LightsCore.js';
export * from './LightsDirect.js';
export * from './LightsIndirect.js';
export * from './LightsSampling.js';

// ================================================================================
// PATH TRACING CORE
// ================================================================================

export * from './PathTracerCore.js';
export * from './PathTracer.js';

/**
 * Module completion status:
 * 
 * ✅ COMPLETED:
 * - Struct.js (struct.fs)
 * - Common.js (common.fs)
 * - Random.js (random.fs)
 * - Environment.js (environment.fs)
 * - TextureSampling.js (texture_sampling.fs)
 * - RayIntersection.js (rayintersection.fs)
 * - BVHTraversal.js (bvhtraverse.fs)
 * - Displacement.js (displacement.fs)
 * - Fresnel.js (fresnel.fs)
 * - MaterialProperties.js (material_properties.fs)
 * - MaterialEvaluation.js (material_evaluation.fs)
 * - MaterialSampling.js (material_sampling.fs)
 * - MaterialTransmission.js (material_transmission.fs)
 * - Clearcoat.js (clearcoat.fs)
 * - LightsCore.js (lights_core.fs)
 * - LightsDirect.js (lights_direct.fs)
 * - LightsSampling.js (lights_sampling.fs)
 * - LightsIndirect.js (lights_indirect.fs)
 * - PathTracerCore.js (pathtracer_core.fs) - Main trace loop
 * - PathTracer.js (pathtracer.fs) - Main shader entry point
 * 
 * ⏭️ SKIPPED (not needed for core functionality):
 * - debugger.fs - Debug visualization modes
 * - emissive_sampling.fs - Emissive triangle sampling (commented out)
 * - preetham_sky.glsl - Procedural sky model
 * 
 * 📋 NEXT STEPS:
 * 1. Integrate TSL modules into PathTracingStage.js
 * 2. Create unified shader composition system
 * 3. Test WebGPU rendering pipeline
 * 4. Optimize performance and memory usage
 */
