/**
 * PathTraceKernel.js — Wavefront Path Trace (Monolithic Wrapper)
 *
 * 256×1 workgroup, 1D ray-parallel dispatch.
 * Reads a primary ray from SoA buffers, calls the existing Trace() function
 * (which internally does all bounces including BVH traversal), then writes
 * the final radiance and first-hit data back to buffers.
 *
 * This is a transitional kernel for Phase 1A' — it validates the buffer
 * pipeline with real path tracing data. Phase 1B will decompose this into
 * separate Extend/Shade/Connect kernels.
 */

import {
	Fn, float, vec3, vec4, int, uint,
	If, normalize,
	instanceIndex,
} from 'three/tsl';

import { Trace, TraceResult } from '../PathTracerCore.js';
import { TraceDebugMode } from '../Debugger.js';
import { computeNDCDepth } from '../PathTracer.js';
import { Ray } from '../Struct.js';
import { RAY_FLAG } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;

/**
 * Build the PathTrace compute kernel.
 *
 * @param {Object} params - All uniforms, textures, and buffer nodes
 * @returns {Function} TSL Fn to be compiled via .compute()
 */
export function buildPathTraceKernel( params ) {

	const {
		// Ray buffers (RO for reading, RW for writing results)
		rayOriginRO, rayDirectionRO, rayRngStateRO, rayBounceFlagsRO,
		rayPixelIndexRO,
		// Result buffers (RW)
		rayRadianceRW, rayBounceFlagsRW,
		// First-hit buffers (RW)
		firstHitNormalDepthRW, firstHitAlbedoRW,
		// Scene data
		bvhBuffer, triangleBuffer, materialBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		displacementMaps,
		// Lights
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		// Environment
		envTexture, environmentIntensity, envMatrix,
		envMarginalWeights, envConditionalWeights,
		envTotalSum, envResolution,
		enableEnvironmentLight, useEnvMapIS,
		// Rendering parameters
		maxBounceCount, transmissiveBounces,
		backgroundIntensity, showBackground, transparentBackground,
		fireflyThreshold, globalIlluminationIntensity,
		totalTriangleCount, enableEmissiveTriangleSampling,
		emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
		lightBVHBuffer, lightBVHNodeCount,
		// Per-pixel
		resolution, frame,
		// Camera (for NDC depth computation)
		cameraProjectionMatrix, cameraViewMatrix,
		// Debug
		visMode, debugVisScale,
		// Total ray count for bounds check
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const rayID = instanceIndex;

		// Bounds check
		If( rayID.greaterThanEqual( maxRayCount ), () => {

			return;

		} );

		// Check if ray is active
		const flags = rayBounceFlagsRO.element( rayID );
		If( uint( flags ).and( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			return;

		} );

		// Load ray from SoA buffers
		const originVec4 = rayOriginRO.element( rayID );
		const dirVec4 = rayDirectionRO.element( rayID );
		const rngVec4 = rayRngStateRO.element( rayID );
		const pixelIdx = rayPixelIndexRO.element( rayID );

		const ray = Ray.wrap( {
			origin: originVec4.xyz,
			direction: dirVec4.xyz,
		} );

		const seed = rngVec4.x.toVar();
		const rayIndex = int( 0 );
		const pixelIndex = int( pixelIdx );

		// Compute pixel coordinate from pixelIndex
		const px = float( pixelIndex.mod( int( resolution.x ) ) ).add( 0.5 );
		const py = float( pixelIndex.div( int( resolution.x ) ) ).add( 0.5 );
		const pixelCoord = vec3( px, py, 0.0 ).xy; // vec2

		// Call existing Trace() — does all bounces internally
		const sampleColor = vec4( 0.0 ).toVar();

		If( visMode.greaterThan( int( 0 ) ), () => {

			sampleColor.assign( TraceDebugMode(
				ray.origin, ray.direction,
				bvhBuffer, triangleBuffer, materialBuffer,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				visMode, debugVisScale,
				pixelCoord, resolution,
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
				cameraProjectionMatrix, cameraViewMatrix,
				frame,
			) );

		} ).Else( () => {

			const traceResult = TraceResult.wrap( Trace(
				ray, seed, rayIndex, pixelIndex,
				bvhBuffer, triangleBuffer, materialBuffer,
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
				displacementMaps,
				directionalLightsBuffer, numDirectionalLights,
				areaLightsBuffer, numAreaLights,
				pointLightsBuffer, numPointLights,
				spotLightsBuffer, numSpotLights,
				envTexture, environmentIntensity, envMatrix,
				envMarginalWeights, envConditionalWeights,
				envTotalSum, envResolution,
				enableEnvironmentLight, useEnvMapIS,
				maxBounceCount, transmissiveBounces,
				backgroundIntensity, showBackground, transparentBackground,
				fireflyThreshold, globalIlluminationIntensity,
				totalTriangleCount, enableEmissiveTriangleSampling,
				emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
				lightBVHBuffer, lightBVHNodeCount,
				pixelCoord, resolution, frame,
			) );

			sampleColor.assign( traceResult.radiance );

			// Write first-hit MRT data
			const worldNormal = vec3( 0.0, 0.0, 1.0 ).toVar();
			const linearDepth = float( 1.0 ).toVar();

			If( traceResult.firstHitDistance.lessThan( 1e9 ), () => {

				worldNormal.assign( normalize( traceResult.objectNormal ) );
				linearDepth.assign( computeNDCDepth( {
					worldPos: traceResult.firstHitPoint,
					cameraProjectionMatrix,
					cameraViewMatrix,
				} ) );

			} );

			firstHitNormalDepthRW.element( rayID ).assign(
				vec4( worldNormal.mul( 0.5 ).add( 0.5 ), linearDepth )
			);

			firstHitAlbedoRW.element( rayID ).assign(
				vec4( traceResult.objectColor, traceResult.objectID )
			);

		} );

		// Write radiance result
		rayRadianceRW.element( rayID ).assign( sampleColor );

		// Mark ray as done (clear ACTIVE flag)
		rayBounceFlagsRW.element( rayID ).assign( uint( 0 ) );

	} );

	return computeFn;

}

export { WG_SIZE as PATHTRACE_WG_SIZE };
