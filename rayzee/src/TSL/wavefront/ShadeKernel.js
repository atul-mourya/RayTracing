/**
 * ShadeKernel.js — Wavefront Material Evaluation + Bounce Generation
 *
 * 256×1 workgroup, 1D dispatch over active ray count.
 *
 * Phase 1B initial version: Handles miss/environment, material loading,
 * texture sampling, BRDF bounce generation, first-hit MRT, Russian roulette.
 * Direct lighting (NEE) deferred to Phase 1B+ once pipeline is validated.
 *
 * Storage buffer bindings: 8 (at limit)
 *   materialBuffer(1) + envMarginalWeights(1) + envConditionalWeights(1)
 *   + rayBuffer_RW(1) + rngBuffer_RW(1) + hitBuffer_RO(1)
 *   + shadowBuffer_WR(1) + counters(1)
 *
 * NOTE: shadowBuffer and counters are bound but unused in this initial version.
 * They are included to validate the binding budget and will be used when
 * deferred direct lighting is added.
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, dot, length, select,
	instanceIndex,
	sampler,
	atomicAdd, uintBitsToFloat,
	Return,
} from 'three/tsl';

import { sampleEnvironment, sampleEquirectProbability, sampleEquirect } from '../Environment.js';
import { getMaterial, powerHeuristic, classifyMaterial } from '../Common.js';
import { sampleAllMaterialTextures } from '../TextureSampling.js';
import { evaluateMaterialResponse } from '../MaterialEvaluation.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from '../LightsSampling.js';
import { traverseBVHShadow } from '../BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from '../MaterialTransmission.js';
import { calculateIndirectLighting } from '../LightsIndirect.js';
import { IndirectLightingResult } from '../LightsCore.js';
import { regularizePathContribution, generateSampledDirection } from '../PathTracerCore.js';
import { getImportanceSamplingInfo } from '../MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from '../Clearcoat.js';
import {
	Ray,
	HitInfo,
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
	SHADOW_STRIDE, SHADOW,
	readRayOrigin, readRayDirection, readRayBounceFlags, readRayThroughput, readRayPdf,
	readMediumStack, writeMediumStack,
	readHitDistance, readHitBarycentrics, readHitNormal,
	readHitMaterialIndex,
	writeRayOriginPixel, writeRayDirFlags, writeRayThroughputPdf, writeRayRadiance,
	writeRayNormalDepth, writeRayAlbedoID,
	readRayRadiance, readRayPixelIndex,
} from '../../Processor/PackedRayBuffer.js';
import { computeNDCDepth } from '../PathTracer.js';

const WG_SIZE = 256;
const MISS_DIST = 1e19;

/**
 * Build the Shade compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildShadeKernel( params ) {

	const {
		// Scene storage buffers (5 — requires maxStorageBuffersPerShaderStage >= 10)
		bvhBuffer, triangleBuffer, materialBuffer,
		envMarginalWeights, envConditionalWeights,
		// Packed buffers (5)
		rayBufferRW, rngBufferRW, hitBufferRO,
		shadowBufferRW, counters,
		// Active indices (needed to match ExtendKernel's ray ID mapping)
		activeIndicesRO,
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
		transparentBackground, backgroundIntensity,
		globalIlluminationIntensity,
		cameraProjectionMatrix, cameraViewMatrix,
		fireflyThreshold, frame,
		// Current bounce (set per-bounce by stage)
		currentBounce,
		// Max count
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		If( threadIdx.greaterThanEqual( maxRayCount ), () => {

			Return();

		} );

		// Use activeIndicesRO to match ExtendKernel's ray ID mapping
		const rayID = activeIndicesRO.element( threadIdx );

		// Read ray state from packed buffer
		const flags = readRayBounceFlags( rayBufferRW, rayID ).toVar();

		// Skip inactive rays
		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			Return();

		} );

		const origin = readRayOrigin( rayBufferRW, rayID ).toVar();
		const direction = readRayDirection( rayBufferRW, rayID ).toVar();
		const throughput = readRayThroughput( rayBufferRW, rayID ).toVar();
		const currentRadiance = readRayRadiance( rayBufferRW, rayID ).toVar();
		const pixelIndex = readRayPixelIndex( rayBufferRW, rayID );
		const rngState = rngBufferRW.element( rayID ).toVar();

		// Read hit data
		const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
		const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
		// hitInfo.uv from traverseBVH is the interpolated texture UV (not barycentrics)
		const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
		const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

		const bounceIndex = currentBounce;

		// ─── MISS HANDLING ──────────────────────────────────────
		If( hitDist.greaterThan( MISS_DIST ), () => {

			// Sample environment
			If( enableEnvironmentLight, () => {

				const envColor = sampleEnvironment( {
					tex: envTexture,
					samp: sampler( envTexture ),
					direction,
					environmentMatrix: envMatrix,
					environmentIntensity,
					enableEnvironmentLight,
				} );

				// MIS weight for implicit env hit — prevents double-counting with NEE.
				// Primary rays (bounce 0) get backgroundIntensity as a display-only scale.
				// Secondary rays use power heuristic between the scatter PDF stored in the
				// ray buffer and the env importance-sampling PDF, matching PathTracerCore.
				const envMisWeight = float( 1.0 ).toVar();
				If( bounceIndex.greaterThan( 0 ).and( useEnvMapIS ), () => {

					const prevBouncePdf = readRayPdf( rayBufferRW, rayID );
					If( prevBouncePdf.greaterThan( 0.0 ), () => {

						const envEval = sampleEquirect(
							envTexture, direction, envMatrix, envTotalSum, envResolution,
						);
						const envPdf = envEval.w;
						If( envPdf.greaterThan( 0.0 ), () => {

							envMisWeight.assign( powerHeuristic( { pdf1: prevBouncePdf, pdf2: envPdf } ) );

						} );

					} );

				} );

				const envGiScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
				const envScale = select( bounceIndex.equal( 0 ), backgroundIntensity, envMisWeight.mul( envGiScale ) );

				currentRadiance.assign( vec4(
					currentRadiance.xyz.add( throughput.mul( envColor.xyz ).mul( envScale ) ),
					currentRadiance.w
				) );

			} );

			// Handle transparent background alpha
			If( bounceIndex.equal( 0 ).and( transparentBackground ), () => {

				currentRadiance.w.assign( 0.0 ); // Background = transparent

			} );

			// Write radiance and mark inactive
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			Return();

		} );

		// ─── HIT PROCESSING ─────────────────────────────────────

		const hitPoint = origin.add( direction.mul( hitDist ) ).toVar();
		const N = normalize( hitNormal ).toVar();

		// Load material
		const material = RayTracingMaterial.wrap(
			getMaterial( int( hitMatIdx ), materialBuffer )
		).toVar();

		// Sample textures (hitUV already loaded above)
		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps,
			metalnessMaps, roughnessMaps, emissiveMaps,
			material, hitUV, N,
		) ).toVar();

		// Apply texture samples to material (CRITICAL — BRDF functions use material.color/metalness/roughness)
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
		material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );

		const albedo = matSamples.albedo.toVar();
		// Update N with texture-perturbed normal for all subsequent BRDF evaluations
		N.assign( matSamples.normal );

		// ─── FIRST-HIT MRT DATA (bounce 0 only) ────────────────
		If( bounceIndex.equal( 0 ), () => {

			const encodedNormal = N.mul( 0.5 ).add( 0.5 );
			const linearDepth = computeNDCDepth( {
				worldPos: hitPoint,
				cameraProjectionMatrix,
				cameraViewMatrix,
			} );
			writeRayNormalDepth( rayBufferRW, rayID, vec4( encodedNormal, linearDepth ) );
			writeRayAlbedoID( rayBufferRW, rayID, vec4( albedo, float( hitMatIdx ) ) );

			If( transparentBackground, () => {

				currentRadiance.w.assign( 1.0 );

			} );

		} );

		// ─── TRANSPARENCY / REFRACTION ──────────────────────────
		const medStack = readMediumStack( rayBufferRW, rayID );
		const mediumStackDepth = int( medStack.stackDepth ).toVar();
		const mediumStack_ior_1 = medStack.ior1.toVar();
		const mediumStack_ior_2 = medStack.ior2.toVar();
		const mediumStack_ior_3 = medStack.ior3.toVar();
		const transTraversals = int( medStack.transTraversals ).toVar();

		// Compute current/previous medium IOR from stack
		const currentMediumIOR = float( 1.0 ).toVar();
		const previousMediumIOR = float( 1.0 ).toVar();
		If( mediumStackDepth.equal( 1 ), () => {

			currentMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( 2 ), () => {

			currentMediumIOR.assign( mediumStack_ior_2 );
			previousMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( 3 ), () => {

			currentMediumIOR.assign( mediumStack_ior_3 );
			previousMediumIOR.assign( mediumStack_ior_2 );

		} );

		const currentRay = Ray( { origin, direction } );
		const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
			currentRay, hitPoint, N, material, rngState,
			int( transTraversals ),
			currentMediumIOR, previousMediumIOR,
		) ).toVar();

		If( interaction.continueRay, () => {

			// Update medium stack for transmission (not reflection/TIR)
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

			// Decrement transmissive traversals budget
			If( interaction.isTransmissive.and( transTraversals.greaterThan( 0 ) ), () => {

				transTraversals.subAssign( 1 );

			} );

			throughput.mulAssign( interaction.throughput );

			// Offset ray: reflection stays on same side, transmission pushes through
			const reflectOffsetDir = select( interaction.entering, N, N.negate() );
			const offsetDir = select( interaction.didReflect, reflectOffsetDir, direction );
			const newOrigin = hitPoint.add( offsetDir.mul( 0.001 ) );

			writeRayOriginPixel( rayBufferRW, rayID, newOrigin, pixelIndex );
			writeRayDirFlags( rayBufferRW, rayID, interaction.direction, flags );
			writeRayThroughputPdf( rayBufferRW, rayID, throughput, float( 1.0 ) );
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3 );
			rngBufferRW.element( rayID ).assign( rngState );
			Return(); // Skip BRDF/NEE for transparent interaction

		} );

		// ─── EMISSIVE CONTRIBUTION ──────────────────────────────
		const emissive = matSamples.emissive.toVar();
		If( length( emissive ).greaterThan( 0.0 ), () => {

			const emissiveGiScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
			currentRadiance.assign( vec4(
				currentRadiance.xyz.add( throughput.mul( emissive ).mul( emissiveGiScale ) ),
				currentRadiance.w
			) );

		} );

		// ─── BRDF SAMPLE (needed by both direct + indirect) ─────
		const V = direction.negate().toVar();

		// Compute real material classification
		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive,
		) ).toVar();

		// BRDF sample (for direct lighting MIS + specular strategy input)
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

		const brdfDir = vec3( 0.0 ).toVar();
		const brdfValue = vec3( 0.0 ).toVar();
		const brdfPdf = float( 0.0 ).toVar();

		If( material.clearcoat.greaterThan( 0.0 ), () => {

			const ccRay = Ray( { origin, direction } );
			const ccHit = HitInfo( {
				didHit: true, dst: hitDist, hitPoint, normal: N, uv: hitUV,
				materialIndex: int( hitMatIdx ), meshIndex: int( 0 ),
				triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
			} );
			const ccResult = ClearcoatResult.wrap( sampleClearcoat(
				ccRay, ccHit, material, xi, rngState,
			) );
			brdfDir.assign( ccResult.L );
			brdfValue.assign( ccResult.brdf );
			brdfPdf.assign( ccResult.pdf );

		} ).Else( () => {

			const bs = DirectionSample.wrap( generateSampledDirection(
				V, N, material, int( hitMatIdx ), xi, rngState,
				false, int( - 1 ), mc,
				false, emptyWeights,
				false, emptyCache,
			) );
			brdfDir.assign( bs.direction );
			brdfValue.assign( bs.value );
			brdfPdf.assign( bs.pdf );

		} );

		// ─── DIRECT LIGHTING ────────────────────────────────────
		const directLight = calculateDirectLightingUnified(
			hitPoint, N, material, V,
			brdfDir, brdfPdf, brdfValue,
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

		// ─── INDIRECT BOUNCE (full calculateIndirectLighting) ────
		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, mc,
			environmentIntensity, useEnvMapIS, enableEnvironmentLight,
		) ).toVar();

		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfDir, brdfPdf, brdfValue,
			int( 0 ), bounceIndex, rngState, samplingInfo,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight, useEnvMapIS,
		) ).toVar();

		const bounceDir = indirectResult.direction.toVar();
		const bouncePdf = max( indirectResult.pdf, 0.001 ).toVar();
		throughput.mulAssign( indirectResult.throughput );

		// ─── EARLY RAY TERMINATION ──────────────────────────────
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxThroughput = max( throughput.x, max( throughput.y, throughput.z ) );
			If( maxThroughput.lessThan( 0.001 ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				Return();

			} );

		} );

		// ─── RUSSIAN ROULETTE ───────────────────────────────────
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxComp = max( throughput.x, max( throughput.y, throughput.z ) );
			const survivalProb = maxComp.clamp( 0.05, 0.95 ).toVar();
			const rr = RandomValue( rngState );

			If( rr.greaterThan( survivalProb ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				Return();

			} );

			throughput.divAssign( survivalProb );

		} );

		// ─── TERMINATE IF MAX BOUNCES ───────────────────────────
		If( bounceIndex.greaterThanEqual( maxBounceCount ), () => {

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			rngBufferRW.element( rayID ).assign( rngState );
			Return();

		} );

		// ─── UPDATE RAY FOR NEXT BOUNCE ─────────────────────────
		const newOrigin = hitPoint.add( N.mul( 0.001 ) );

		writeRayOriginPixel( rayBufferRW, rayID, newOrigin, pixelIndex );
		writeRayDirFlags( rayBufferRW, rayID, bounceDir, flags );
		writeRayThroughputPdf( rayBufferRW, rayID, throughput, bouncePdf );
		writeRayRadiance( rayBufferRW, rayID, currentRadiance );
		writeMediumStack( rayBufferRW, rayID, mediumStackDepth, transTraversals, mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3 );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as SHADE_WG_SIZE };
