/**
 * WebGPU Path Tracer Module
 *
 * Phase 1, 2 & 3 Implementation:
 * - Phase 1: WebGPU foundation with Three.js WebGPURenderer
 * - Phase 2: TSL (Three.js Shading Language) based ray tracing with BVH hit test visualization
 * - Phase 3: Full path tracing with multi-bounce, materials, BSDF sampling, environment lighting
 *
 * Usage:
 *
 * // Phase 1: Basic WebGPU test
 * import { initWebGPUTest } from './core/WebGPU';
 * const app = await initWebGPUTest(canvas);
 *
 * // Phase 2: Hit test visualization with existing app
 * import { WebGPUHitTestApp, VIS_MODE } from './core/WebGPU';
 * const hitTestApp = new WebGPUHitTestApp(canvas, existingPathTracerApp);
 * await hitTestApp.init();
 * hitTestApp.loadSceneData();
 * hitTestApp.animate();
 * hitTestApp.setVisMode(VIS_MODE.NORMALS);
 *
 * // Phase 3: Full path tracing
 * import { initPathTracing } from './core/WebGPU';
 * const pathTracer = await initPathTracing(canvas, existingPathTracerApp);
 * pathTracer.setMaxBounces(5);
 */

// Phase 1: Base WebGPU Application
export { WebGPUPathTracerApp } from './WebGPUPathTracerApp.js';

// Phase 1: TSL Test Scene (Development Tool)
export { createTestMaterial, createTestQuad } from './dev/TSLTestScene.js';

// Phase 2: Hit Test Application (Development Tool)
export { WebGPUHitTestApp, VIS_MODE } from './dev/WebGPUHitTestApp.js';

// Phase 2: Data Transfer Utilities
export { DataTransfer } from './DataTransfer.js';

// Phase 2: Hit Test Stage
export { HitTestStage } from './Stages/HitTestStage.js';

// Phase 3: Path Tracing Stage
export { PathTracingStage } from './Stages/PathTracingStage.js';

// Phase 4: Pipeline-Integrated Path Tracing Stage (drop-in replacement for WebGL)
export { WebGPUPathTracerStage } from './Stages/WebGPUPathTracerStage.js';

// Phase 6: Tile Manager for progressive rendering
export { WebGPUTileManager } from './WebGPUTileManager.js';

// Phase 7: ASVGF Denoising Stage
export { WebGPUASVGFStage } from './Stages/WebGPUASVGFStage.js';

// Phase 8: Backend Manager (exported from parent directory)
export { BackendManager, BackendType, BackendStatus, getBackendManager } from '../BackendManager.js';

// TSL Modules - Ray Tracing Core (Phase 2)
export { createRay, createHitInfo, createMutableHitInfo, TRIANGLE_OFFSETS } from './TSL/Structs.js';
export { rayAABBIntersect, rayAABBIntersectFull } from './TSL/RayAABB.js';
export { rayTriangleIntersect, triangleGeometricNormal, barycentricInterpolate } from './TSL/RayTriangle.js';
export { createBVHTraverser, createOcclusionTest } from './TSL/BVHTraversal.js';
export { createRayGenerator, createRayGeneratorManual, createDOFRayGenerator, createDOFRayGeneratorManual } from './TSL/CameraRay.js';

// TSL Modules - Struct Definitions
export * from './TSL/Struct.js';

// TSL Modules - Common Utilities
export * from './TSL/Common.js';

// TSL Modules - Path Tracing (Phase 3)
export { initRNG, randomFloat, randomVec2, randomVec3, pcgHash, randomCosineHemisphere, randomSphere, randomDisk } from './TSL/Random.js';
export { createMaterialReader, computeF0, classifyMaterial } from './TSL/Material.js';
export { fresnelSchlick, distributionGGX, geometrySmith, sampleCosineHemisphere, sampleGGX, evaluateSpecularBRDF, evaluateDiffuseBRDF, sampleBSDF, reflect, refract, buildTBN, tangentToWorld } from './TSL/BSDF.js';
export { equirectDirectionToUv, equirectUvToDirection, equirectDirectionPdf, sampleEquirectColor, sampleEquirect, sampleEquirectProbability, sampleEnvironment, createEnvironmentSampler } from './TSL/Environment.js';

// TSL Modules - Disney BSDF (Full material system)
export {
	fresnelDielectric,
	distributionGTR1,
	distributionSheen,
	fresnelIridescence,
	beerLambertAttenuation,
	sampleClearcoat,
	sampleTransmission,
	sampleDisneyBSDF,
	evaluateDisneyBSDF
} from './TSL/DisneyBSDF.js';

// TSL Modules - Displacement Mapping
export {
	getDisplacedHeight,
	getDisplacedPosition,
	applyDisplacement,
	calculateDisplacedNormal,
	createRayTriangleDisplaced
} from './TSL/Displacement.js';

// TSL Modules - Fresnel Functions
export {
	fresnel,
	fresnelSchlickFloat,
	fresnelSchlickVec3,
	fresnel0ToIor,
	iorToFresnel0Vec3,
	iorToFresnel0Float,
	iorToFresnel0,
	fresnelSchlick as fresnelSchlickFromFresnel
} from './TSL/Fresnel.js';

// TSL Modules - Material Properties
export {
	sheenDistribution,
	calculateGGXPDF,
	calculateVNDFPDF,
	evalSensitivity,
	evalIridescence,
	calculateBRDFWeights,
	getMaterialImportance,
	getImportanceSamplingInfo,
	createMaterialCache,
	createMaterialCacheLegacy
} from './TSL/MaterialProperties.js';

// TSL Modules - Material Evaluation
export {
	evaluateMaterialResponse,
	evaluateMaterialResponseCached,
	calculateLayerAttenuation,
	evaluateLayeredBRDF
} from './TSL/MaterialEvaluation.js';

// TSL Modules - Material Sampling
export {
	importanceSampleGGX,
	importanceSampleCosine,
	cosineWeightedSample,
	cosineWeightedPDF,
	sampleGGXVNDF,
	calculateSamplingWeights,
	calculateMultiLobeMISWeight,
	sampleMaterialWithMultiLobeMIS,
	constructTBN
} from './TSL/MaterialSampling.js';

// TSL Modules - Clearcoat (Conditional BRDF Layer)
export {
	sampleClearcoat as sampleClearcoatLayered
} from './TSL/Clearcoat.js';

// ----------------------------------------------------------------
// Convenience function for Phase 1 testing
// ----------------------------------------------------------------

import { WebGPUPathTracerApp } from './WebGPUPathTracerApp.js';
import { createTestQuad } from './dev/TSLTestScene.js';

/**
 * Initializes a WebGPU test application with an animated quad.
 * Use this to verify WebGPU and TSL are working correctly.
 *
 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
 * @returns {Promise<WebGPUPathTracerApp>} Initialized app instance
 *
 * @example
 * const canvas = document.getElementById('canvas');
 * const app = await initWebGPUTest(canvas);
 * // App is now running with animated test shader
 */
export async function initWebGPUTest( canvas ) {

	const app = new WebGPUPathTracerApp( canvas );
	await app.init();

	// Add test quad with animated shader
	const quad = createTestQuad();
	app.scene.add( quad );

	// Start animation
	app.animate();

	console.log( 'WebGPU Test initialized - you should see an animated color gradient' );

	return app;

}

// ----------------------------------------------------------------
// Convenience function for Phase 2 hit test visualization
// ----------------------------------------------------------------

import { WebGPUHitTestApp } from './dev/WebGPUHitTestApp.js';
import { DataTransfer } from './DataTransfer.js';

/**
 * Initializes the WebGPU hit test visualization with existing app data.
 *
 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
 * @param {PathTracerApp} existingApp - Existing path tracer app with scene data
 * @returns {Promise<WebGPUHitTestApp>} Initialized hit test app
 *
 * @example
 * const canvas = document.getElementById('webgpu-canvas');
 * const hitTestApp = await initHitTestVisualization(canvas, window.pathTracerApp);
 * // Switch visualization modes
 * hitTestApp.setVisMode(VIS_MODE.DISTANCE);
 */
export async function initHitTestVisualization( canvas, existingApp ) {

	const app = new WebGPUHitTestApp( canvas, existingApp );
	await app.init();

	const success = app.loadSceneData();

	if ( ! success ) {

		console.error( 'Failed to load scene data for hit test visualization' );
		// Show debug info about data availability
		DataTransfer.checkDataAvailability( existingApp );
		return app;

	}

	app.animate();

	console.log( 'WebGPU Hit Test Visualization initialized' );
	console.log( '  - Mode 0: Normals (RGB = XYZ)' );
	console.log( '  - Mode 1: Distance gradient' );
	console.log( '  - Mode 2: Material ID colors' );
	console.log( 'Use app.setVisMode(mode) to switch' );

	return app;

}

// ----------------------------------------------------------------
// Convenience function for Phase 3 path tracing
// ----------------------------------------------------------------

/**
 * Initializes the WebGPU path tracer with existing app data.
 *
 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
 * @param {PathTracerApp} existingApp - Existing path tracer app with scene data
 * @returns {Promise<WebGPUPathTracerApp>} Initialized path tracer app
 *
 * @example
 * const canvas = document.getElementById('webgpu-canvas');
 * const pathTracer = await initPathTracing(canvas, window.pathTracerApp);
 * pathTracer.setMaxBounces(5);
 * pathTracer.setEnvironmentIntensity(1.5);
 */
export async function initPathTracing( canvas, existingApp ) {

	const { WebGPUPathTracerApp } = await import( './WebGPUPathTracerApp.js' );
	const app = new WebGPUPathTracerApp( canvas, existingApp );
	await app.init();

	const success = app.loadSceneData();

	if ( ! success ) {

		console.error( 'Failed to load scene data for path tracing' );
		DataTransfer.checkDataAvailability( existingApp );
		return app;

	}

	app.animate();

	console.log( 'WebGPU Path Tracer initialized' );
	console.log( '  - Max bounces:', app.maxBounces );
	console.log( '  - Frame count: app.getFrameCount()' );
	console.log( 'Use app.setMaxBounces(n) to change bounce count' );

	return app;

}

/**
 * Checks if WebGPU is supported in the current browser.
 *
 * @returns {boolean} True if WebGPU is supported
 */
export function isWebGPUSupported() {

	return 'gpu' in navigator;

}

/**
 * Gets WebGPU adapter info if available.
 *
 * @returns {Promise<Object|null>} Adapter info or null
 */
export async function getWebGPUInfo() {

	if ( ! isWebGPUSupported() ) {

		return null;

	}

	try {

		const adapter = await navigator.gpu.requestAdapter();

		if ( ! adapter ) {

			return { supported: true, adapterAvailable: false };

		}

		const info = await adapter.requestAdapterInfo();

		return {
			supported: true,
			adapterAvailable: true,
			vendor: info.vendor,
			architecture: info.architecture,
			device: info.device,
			description: info.description
		};

	} catch ( error ) {

		return { supported: true, error: error.message };

	}

}

// ----------------------------------------------------------------
// Global exposure for browser console testing
// ----------------------------------------------------------------

/**
 * Expose WebGPU utilities on window for console testing.
 * This allows testing without ES module imports.
 *
 * Usage in browser console:
 *   // Check WebGPU support
 *   WebGPU.isSupported()
 *
 *   // Start path tracer (needs a canvas element)
 *   const canvas = document.createElement('canvas');
 *   canvas.width = 800; canvas.height = 600;
 *   document.body.appendChild(canvas);
 *   const pt = await WebGPU.startPathTracer(canvas, window.pathTracerApp);
 *
 *   // Or start hit test visualization
 *   const ht = await WebGPU.startHitTest(canvas, window.pathTracerApp);
 */
// if ( typeof window !== 'undefined' ) {

// 	window.WebGPU = {

// 		// Check support
// 		isSupported: isWebGPUSupported,
// 		getInfo: getWebGPUInfo,

// 		// Start path tracer
// 		startPathTracer: async ( canvas, existingApp ) => {

// 			const { WebGPUPathTracerApp } = await import( './WebGPUPathTracerApp.js' );
// 			const app = new WebGPUPathTracerApp( canvas, existingApp );
// 			await app.init();
// 			app.loadSceneData();
// 			app.animate();
// 			console.log( 'WebGPU Path Tracer started' );
// 			console.log( '  app.setMaxBounces(n) - Set bounce count' );
// 			console.log( '  app.setEnvironmentIntensity(n) - Set env brightness' );
// 			console.log( '  app.reset() - Reset accumulation' );
// 			console.log( '  app.getFrameCount() - Get current frame' );
// 			return app;

// 		},

// 		// Start hit test visualization
// 		startHitTest: async ( canvas, existingApp ) => {

// 			const { WebGPUHitTestApp, VIS_MODE } = await import( './dev/WebGPUHitTestApp.js' );
// 			const app = new WebGPUHitTestApp( canvas, existingApp );
// 			await app.init();
// 			app.loadSceneData();
// 			app.animate();
// 			console.log( 'WebGPU Hit Test started' );
// 			console.log( '  app.setVisMode(0) - Normals' );
// 			console.log( '  app.setVisMode(1) - Distance' );
// 			console.log( '  app.setVisMode(2) - Material ID' );
// 			console.log( '  app.setVisMode(3) - BVH Heatmap' );
// 			return app;

// 		},

// 		// Visualization modes for hit test
// 		VIS_MODE: {
// 			NORMALS: 0,
// 			DISTANCE: 1,
// 			MATERIAL_ID: 2,
// 			BVH_HEATMAP: 3
// 		}

// 	};

// 	console.log( 'WebGPU utilities available: window.WebGPU' );
// 	console.log( '  WebGPU.isSupported() - Check if WebGPU is available' );
// 	console.log( '  WebGPU.startPathTracer(canvas, app) - Start path tracing' );
// 	console.log( '  WebGPU.startHitTest(canvas, app) - Start hit test viz' );

// }
