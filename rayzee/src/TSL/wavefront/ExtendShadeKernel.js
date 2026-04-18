/**
 * ExtendShadeKernel.js — Fused BVH Traversal + Material Evaluation
 *
 * 256×1 workgroup, 1D ray-parallel dispatch.
 *
 * Fuses Extend (BVH traversal) and Shade (material eval + bounce) into
 * a single kernel. Hit data stays in registers between phases — no hit
 * buffer round-trip needed.
 *
 * Direct lighting uses deferred shadow rays (no inline BVH in shading phase).
 * This keeps the shading portion small for better occupancy.
 *
 * Storage buffer bindings: 8
 *   bvhBuffer(1) + triangleBuffer(1) + materialBuffer(1)
 *   + envMarginalWeights(1) + envConditionalWeights(1)
 *   + rayBuffer_RW(1) + rngBuffer_RW(1) + counters(1)
 *
 * Shadow rays go to shadowBuffer via the Shade kernel's counters binding.
 * Wait — that's 8 without shadowBuffer. We need shadowBuffer too = 9.
 * With maxStorageBuffersPerShaderStage: 10, we have room.
 *
 * Revised bindings: 9
 *   bvh(1) + tri(1) + mat(1) + envMarg(1) + envCond(1)
 *   + rayBuf(1) + rngBuf(1) + shadowBuf(1) + counters(1)
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, dot, length, select,
	instanceIndex,
	sampler,
	atomicAdd, uintBitsToFloat,
} from 'three/tsl';

import { traverseBVH } from '../BVHTraversal.js';
import { sampleEnvironment, sampleEquirectProbability, sampleEquirect } from '../Environment.js';
import { sampleBackgroundLighting } from '../PathTracerCore.js';
import { getMaterial, classifyMaterial, powerHeuristic } from '../Common.js';
import { sampleAllMaterialTextures } from '../TextureSampling.js';
import { evaluateMaterialResponse } from '../MaterialEvaluation.js';
import { handleMaterialTransparency, MaterialInteractionResult } from '../MaterialTransmission.js';
import { calculateIndirectLighting } from '../LightsIndirect.js';
import { IndirectLightingResult } from '../LightsCore.js';
import { regularizePathContribution, generateSampledDirection } from '../PathTracerCore.js';
import { getImportanceSamplingInfo } from '../MaterialProperties.js';
import {
	calculateDirectLightingUnified,
} from '../LightsSampling.js';
import {
	Ray, HitInfo,
	RayTracingMaterial,
	MaterialSamples,
	DirectionSample,
	ImportanceSamplingInfo,
	MaterialClassification,
	BRDFWeights,
	MaterialCache,
} from '../Struct.js';
import { RandomValue } from '../Random.js';
import { RAY_FLAG, COUNTER } from '../../Processor/QueueManager.js';
import {
	RAY_STRIDE, RAY, SHADOW_STRIDE, SHADOW,
	readRayOrigin, readRayDirection, readRayBounceFlags, readRayThroughput, readRayPdf,
	readMediumStack, writeMediumStack,
	writeRayOriginPixel, writeRayDirFlags, writeRayThroughputPdf, writeRayRadiance,
	writeRayNormalDepth, writeRayAlbedoID,
	readRayRadiance, readRayPixelIndex,
} from '../../Processor/PackedRayBuffer.js';
import { computeNDCDepth } from '../PathTracer.js';

const WG_SIZE = 256;
const MISS_DIST = 1e19;

export function buildExtendShadeKernel( params ) {

	const {
		// Scene storage buffers (5)
		bvhBuffer, triangleBuffer, materialBuffer,
		envMarginalWeights, envConditionalWeights,
		// Packed buffers (4)
		rayBufferRW, rngBufferRW,
		shadowBufferRW, counters,
		// Textures (not storage buffers)
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		envTexture, environmentIntensity, envMatrix,
		enableEnvironmentLight, useEnvMapIS,
		envTotalSum, envResolution,
		// Light uniform arrays (NOT storage buffers)
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		// Uniforms
		maxBounceCount, transmissiveBounces,
		transparentBackground, backgroundIntensity, showBackground,
		globalIlluminationIntensity,
		cameraProjectionMatrix, cameraViewMatrix,
		fireflyThreshold, frame,
		currentBounce,
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;
		If( threadIdx.greaterThanEqual( maxRayCount ), () => {

			return;

		} );

		const rayID = threadIdx;
		const flags = readRayBounceFlags( rayBufferRW, rayID ).toVar();
		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			return;

		} );

		const origin = readRayOrigin( rayBufferRW, rayID ).toVar();
		const direction = readRayDirection( rayBufferRW, rayID ).toVar();
		const throughput = readRayThroughput( rayBufferRW, rayID ).toVar();
		const currentRadiance = readRayRadiance( rayBufferRW, rayID ).toVar();
		const pixelIndex = readRayPixelIndex( rayBufferRW, rayID );
		const rngState = rngBufferRW.element( rayID ).toVar();
		const bounceIndex = currentBounce;

		// ═══════════════════════════════════════════════════════════
		// PHASE 1: BVH TRAVERSAL (fused Extend — no hit buffer needed)
		// ═══════════════════════════════════════════════════════════
		const ray = Ray( { origin, direction } );
		const hitInfo = HitInfo.wrap( traverseBVH(
			ray, bvhBuffer, triangleBuffer, materialBuffer,
		) ).toVar();

		// ═══════════════════════════════════════════════════════════
		// PHASE 2: SHADING (material eval + bounce — hit data in registers)
		// ═══════════════════════════════════════════════════════════

		// ─── MISS (matches monolithic Trace() lines 711-733) ────
		If( hitInfo.didHit.not(), () => {

			const isPrimaryRay = bounceIndex.equal( 0 );
			const giScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );

			const envColor = sampleBackgroundLighting(
				isPrimaryRay, direction,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				showBackground, backgroundIntensity,
			);

			// Apply firefly suppression + throughput + GI scale (matches monolithic)
			const missContrib = regularizePathContribution(
				envColor.xyz.mul( throughput ).mul( giScale ),
				float( bounceIndex ), fireflyThreshold, int( frame ),
			);
			currentRadiance.assign( vec4(
				currentRadiance.xyz.add( missContrib ),
				currentRadiance.w
			) );

			If( isPrimaryRay.and( transparentBackground ), () => {

				currentRadiance.w.assign( 0.0 );

			} );

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			return;

		} );

		// ─── HIT: MATERIAL + TEXTURES ───────────────────────────
		const hitPoint = origin.add( direction.mul( hitInfo.dst ) ).toVar();
		const N = normalize( hitInfo.normal ).toVar();
		const hitMatIdx = hitInfo.materialIndex;
		const hitUV = hitInfo.uv;

		const material = RayTracingMaterial.wrap(
			getMaterial( int( hitMatIdx ), materialBuffer )
		).toVar();

		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps,
			metalnessMaps, roughnessMaps, emissiveMaps,
			material, hitUV, N,
		) ).toVar();

		// Apply textures to material (CRITICAL for correct BRDF)
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
		material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
		const albedo = matSamples.albedo.toVar();
		N.assign( matSamples.normal );

		// (debug removed)

		// ─── FIRST-HIT MRT ──────────────────────────────────────
		If( bounceIndex.equal( 0 ), () => {

			writeRayNormalDepth( rayBufferRW, rayID, vec4( N.mul( 0.5 ).add( 0.5 ), computeNDCDepth( {
				worldPos: hitPoint, cameraProjectionMatrix, cameraViewMatrix,
			} ) ) );
			writeRayAlbedoID( rayBufferRW, rayID, vec4( albedo, float( hitMatIdx ) ) );
			If( transparentBackground, () => {

				currentRadiance.w.assign( 1.0 );

			} );

		} );

		// ─── TRANSPARENCY ───────────────────────────────────────
		const medStack = readMediumStack( rayBufferRW, rayID );
		const mediumStackDepth = int( medStack.stackDepth ).toVar();
		const mediumStack_ior_1 = medStack.ior1.toVar();
		const mediumStack_ior_2 = medStack.ior2.toVar();
		const mediumStack_ior_3 = medStack.ior3.toVar();
		const transTraversals = int( medStack.transTraversals ).toVar();

		const currentMediumIOR = float( 1.0 ).toVar();
		const previousMediumIOR = float( 1.0 ).toVar();
		If( mediumStackDepth.equal( 1 ), () => {

			currentMediumIOR.assign( mediumStack_ior_1 );

		} )
			.ElseIf( mediumStackDepth.equal( 2 ), () => {

				currentMediumIOR.assign( mediumStack_ior_2 );
				previousMediumIOR.assign( mediumStack_ior_1 );

			} )
			.ElseIf( mediumStackDepth.equal( 3 ), () => {

				currentMediumIOR.assign( mediumStack_ior_3 );
				previousMediumIOR.assign( mediumStack_ior_2 );

			} );

		const currentRay = Ray( { origin, direction } );
		const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
			currentRay, hitPoint, N, material, rngState,
			int( transTraversals ), currentMediumIOR, previousMediumIOR,
		) ).toVar();

		If( interaction.continueRay, () => {

			If( interaction.isTransmissive.and( interaction.didReflect.not() ), () => {

				If( interaction.entering, () => {

					If( mediumStackDepth.lessThan( 3 ), () => {

						mediumStackDepth.addAssign( 1 );
						If( mediumStackDepth.equal( 1 ), () => {

							mediumStack_ior_1.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 2 ), () => {

							mediumStack_ior_2.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 3 ), () => {

							mediumStack_ior_3.assign( material.ior );

						} );

					} );

				} ).Else( () => {

					If( mediumStackDepth.greaterThan( 0 ), () => {

						mediumStackDepth.subAssign( 1 );

					} );

				} );

			} );

			If( interaction.isTransmissive.and( transTraversals.greaterThan( 0 ) ), () => {

				transTraversals.subAssign( 1 );

			} );
			throughput.mulAssign( interaction.throughput );

			const reflectOffsetDir = select( interaction.entering, N, N.negate() );
			const offsetDir = select( interaction.didReflect, reflectOffsetDir, direction );
			const newOrigin = hitPoint.add( offsetDir.mul( 0.001 ) );

			writeRayOriginPixel( rayBufferRW, rayID, newOrigin, pixelIndex );
			writeRayDirFlags( rayBufferRW, rayID, interaction.direction, flags );
			writeRayThroughputPdf( rayBufferRW, rayID, throughput, float( 1.0 ) );
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3 );
			rngBufferRW.element( rayID ).assign( rngState );
			return;

		} );

		// ─── EMISSIVE ───────────────────────────────────────────
		const emissive = matSamples.emissive.toVar();
		If( length( emissive ).greaterThan( 0.0 ), () => {

			const emissiveGiScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
			currentRadiance.assign( vec4(
				currentRadiance.xyz.add( throughput.mul( emissive ).mul( emissiveGiScale ) ),
				currentRadiance.w
			) );

		} );

		// ─── BRDF SAMPLE (needed by both direct + indirect) ────
		const V = direction.negate().toVar();
		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive,
		) ).toVar();

		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
		const emptyWeights = BRDFWeights( {
			specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
			clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
		} );
		const emptyCache = MaterialCache( {
			F0: vec3( 0.04 ), NoV: float( 1.0 ),
			diffuseColor: vec3( 0.0 ), specularColor: vec3( 0.0 ),
			isMetallic: false, isPurelyDiffuse: false, hasSpecialFeatures: false,
			alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
			tsAlbedo: vec4( 0.0 ), tsEmissive: vec3( 0.0 ),
			tsMetalness: float( 0.0 ), tsRoughness: float( 0.0 ),
			tsNormal: vec3( 0.0, 0.0, 1.0 ), tsHasTextures: false,
			invRoughness: float( 0.5 ), metalFactor: float( 0.5 ),
			iorFactor: float( 0.67 ), maxSheenColor: float( 0.0 ),
		} );

		const brdfSample = DirectionSample.wrap( generateSampledDirection(
			V, N, material, int( hitMatIdx ), xi, rngState,
			false, int( - 1 ), mc, false, emptyWeights, false, emptyCache,
		) ).toVar();

		// ─── DIRECT LIGHTING (full MIS with inline shadow) ──────
		const directLight = calculateDirectLightingUnified(
			hitPoint, N, material, V,
			brdfSample.direction, brdfSample.pdf, brdfSample.value,
			int( 0 ), bounceIndex, rngState,
			directionalLightsBuffer, numDirectionalLights,
			areaLightsBuffer, numAreaLights,
			pointLightsBuffer, numPointLights,
			spotLightsBuffer, numSpotLights,
			bvhBuffer, triangleBuffer, materialBuffer,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight,
		);

		const giScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
		currentRadiance.assign( vec4(
			currentRadiance.xyz.add( throughput.mul( directLight ).mul( giScale ) ),
			currentRadiance.w
		) );

		// ─── FIREFLY SUPPRESSION ────────────────────────────────
		const suppressedRadiance = regularizePathContribution(
			currentRadiance.xyz, float( bounceIndex ), fireflyThreshold, int( frame ),
		);
		currentRadiance.assign( vec4( suppressedRadiance, currentRadiance.w ) );

		// ─── INDIRECT BOUNCE ────────────────────────────────────
		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, mc,
			environmentIntensity, useEnvMapIS, enableEnvironmentLight,
		) ).toVar();

		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfSample.direction, brdfSample.pdf, brdfSample.value,
			int( 0 ), bounceIndex, rngState, samplingInfo,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight, useEnvMapIS,
		) ).toVar();

		const bounceDir = indirectResult.direction.toVar();
		const bouncePdf = max( indirectResult.pdf, 0.001 ).toVar();
		throughput.mulAssign( indirectResult.throughput );

		// (debug removed)

		// ─── EARLY TERMINATION + RUSSIAN ROULETTE ───────────────
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxThroughput = max( throughput.x, max( throughput.y, throughput.z ) );
			If( maxThroughput.lessThan( 0.001 ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				return;

			} );

		} );

		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxComp = max( throughput.x, max( throughput.y, throughput.z ) );
			const survivalProb = maxComp.clamp( 0.05, 0.95 ).toVar();
			const rr = RandomValue( rngState );

			If( rr.greaterThan( survivalProb ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				return;

			} );

			throughput.divAssign( survivalProb );

		} );

		If( bounceIndex.greaterThanEqual( maxBounceCount ), () => {

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			rngBufferRW.element( rayID ).assign( rngState );
			return;

		} );

		// ─── UPDATE RAY ─────────────────────────────────────────
		const newOrigin = hitPoint.add( N.mul( 0.001 ) );

		writeRayOriginPixel( rayBufferRW, rayID, newOrigin, pixelIndex );
		writeRayDirFlags( rayBufferRW, rayID, bounceDir, flags );
		writeRayThroughputPdf( rayBufferRW, rayID, throughput, bouncePdf );
		writeRayRadiance( rayBufferRW, rayID, currentRadiance );
		writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3 );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as EXTENDSHADE_WG_SIZE };
