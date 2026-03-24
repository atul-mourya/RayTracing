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
} from 'three/tsl';

import { sampleEnvironment, sampleEquirectProbability, sampleEquirect } from '../Environment.js';
import { getMaterial, powerHeuristic } from '../Common.js';
import { sampleAllMaterialTextures } from '../TextureSampling.js';
import { evaluateMaterialResponse } from '../MaterialEvaluation.js';
import { calculateMaterialPDF } from '../LightsSampling.js';
import { regularizePathContribution, generateSampledDirection } from '../PathTracerCore.js';
import {
	RayTracingMaterial,
	MaterialSamples,
	DirectionSample,
	MaterialClassification,
	BRDFWeights,
	MaterialCache,
} from '../Struct.js';
import { RandomValue } from '../Random.js';
import { RAY_FLAG, COUNTER } from '../../Processor/QueueManager.js';
import {
	SHADOW_STRIDE, SHADOW,
	readRayOrigin, readRayDirection, readRayBounceFlags, readRayThroughput, readRayPdf,
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
		// Scene storage buffers (3)
		materialBuffer,
		envMarginalWeights, envConditionalWeights,
		// Packed buffers (5)
		rayBufferRW, rngBufferRW, hitBufferRO,
		shadowBufferRW, counters,
		// NOTE: No activeIndicesRO — use instanceIndex as rayID to stay at 8 bindings.
		// The ACTIVE flag check handles inactive rays (early exit).
		// Textures (not storage buffers)
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		envTexture, environmentIntensity, envMatrix,
		enableEnvironmentLight,
		envTotalSum, envResolution,
		// Light uniform arrays (NOT storage buffers)
		directionalLightsBuffer, numDirectionalLights,
		pointLightsBuffer, numPointLights,
		// Uniforms
		maxBounceCount,
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

			return;

		} );

		// Use instanceIndex directly as rayID (no activeIndicesRO — saves 1 binding)
		const rayID = threadIdx;

		// Read ray state from packed buffer
		const flags = readRayBounceFlags( rayBufferRW, rayID ).toVar();

		// Skip inactive rays
		If( flags.and( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			return;

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

				const bgScale = select( bounceIndex.equal( 0 ), backgroundIntensity, globalIlluminationIntensity );
				const envContribution = envColor.mul( bgScale ).toVar();

				// MIS: weight indirect contribution by brdfPdf / (brdfPdf + lightPdf)
				// Only apply MIS for bounce > 0 (primary miss = full weight)
				If( bounceIndex.greaterThan( 0 ), () => {

					const prevPdf = readRayPdf( rayBufferRW, rayID );
					const envPdfResult = sampleEquirect( envTexture, direction, envMatrix, envTotalSum, envResolution );
					const lightPdf = envPdfResult.w;
					const misWeight = powerHeuristic( { pdf1: prevPdf, pdf2: lightPdf } );
					envContribution.mulAssign( misWeight );

				} );

				currentRadiance.assign( vec4(
					currentRadiance.xyz.add( throughput.mul( envContribution.xyz ) ),
					currentRadiance.w
				) );

			} );

			// Handle transparent background alpha
			If( bounceIndex.equal( 0 ).and( transparentBackground ), () => {

				currentRadiance.w.assign( 0.0 ); // Background = transparent

			} );

			// Write radiance and mark inactive
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.and( uint( ~ RAY_FLAG.ACTIVE ) ) );
			return;

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

		const albedo = matSamples.albedo.toVar();

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

		// ─── EMISSIVE CONTRIBUTION ──────────────────────────────
		const emissive = matSamples.emissive.toVar();
		If( length( emissive ).greaterThan( 0.0 ), () => {

			currentRadiance.assign( vec4(
				currentRadiance.xyz.add( throughput.mul( emissive ).mul( globalIlluminationIntensity ) ),
				currentRadiance.w
			) );

		} );

		// ─── DEFERRED DIRECT LIGHTING (NEE via inline env IS) ───
		const V = direction.negate().toVar();

		If( enableEnvironmentLight, () => {

			// Environment IS — sample important direction from HDRI CDF
			const rayOrigin = hitPoint.add( N.mul( 0.001 ) ).toVar();
			const r = vec2( RandomValue( rngState ), RandomValue( rngState ) );
			const envColor = vec3( 0.0 ).toVar();

			const envSample = sampleEquirectProbability(
				envTexture,
				envMarginalWeights, envConditionalWeights,
				envMatrix, environmentIntensity,
				envTotalSum, envResolution,
				r, envColor,
			);

			const lightDir = envSample.xyz.toVar();
			const lightPdf = envSample.w.toVar();
			const NoL = max( 0.0, dot( N, lightDir ) );

			If( NoL.greaterThan( 0.0 ).and( lightPdf.greaterThan( 0.001 ) ), () => {

				// Full BRDF evaluation + MIS weight
				const brdfValue = evaluateMaterialResponse( V, lightDir, N, material );
				const brdfPdf = calculateMaterialPDF( V, lightDir, N, material );
				const misWeight = powerHeuristic( { pdf1: lightPdf, pdf2: brdfPdf } );
				const pending = throughput.mul( brdfValue ).mul( envColor ).mul( NoL ).div( lightPdf ).mul( misWeight );

				// Write deferred shadow ray
				const shadowIdx = atomicAdd( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ), uint( 1 ) );
				shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) )
					.assign( vec4( rayOrigin, float( 100000.0 ) ) );
				shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) )
					.assign( vec4( lightDir, uintBitsToFloat( rayID ) ) );
				shadowBufferRW.element( shadowIdx.mul( SHADOW_STRIDE ).add( SHADOW.RADIANCE ) )
					.assign( vec4( pending, 0.0 ) );

			} );

		} );

		// ─── FIREFLY SUPPRESSION ────────────────────────────────
		const suppressedRadiance = regularizePathContribution(
			currentRadiance.xyz, float( bounceIndex ), fireflyThreshold, int( frame ),
		);
		currentRadiance.assign( vec4( suppressedRadiance, currentRadiance.w ) );

		// ─── FULL DISNEY BRDF IMPORTANCE SAMPLING ────────────────
		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );

		// Fresh classification each bounce (no cross-bounce cache in wavefront)
		const emptyClassification = MaterialClassification( {
			isMetallic: false, isRough: false, isSmooth: false,
			isTransmissive: false, hasClearcoat: false, isEmissive: false,
			complexityScore: float( 0.0 ),
		} );
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
			// Pass fresh (uncached) — will recompute each bounce
			false, int( - 1 ), emptyClassification,
			false, emptyWeights,
			false, emptyCache,
		) ).toVar();

		const bounceDir = brdfSample.direction.toVar();
		const bouncePdf = max( brdfSample.pdf, 0.001 ).toVar();
		const brdfEval = brdfSample.value.toVar();

		// Throughput: use albedo as stable energy multiplier.
		// BRDF-sampled directions from generateSampledDirection handle importance
		// sampling for the direction; albedo handles the energy attenuation.
		// Full value/pdf requires calculateIndirectLighting (Phase 2).
		throughput.mulAssign( albedo );

		// ─── EARLY RAY TERMINATION ──────────────────────────────
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxThroughput = max( throughput.x, max( throughput.y, throughput.z ) );
			If( maxThroughput.lessThan( 0.001 ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.and( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				return;

			} );

		} );

		// ─── RUSSIAN ROULETTE ───────────────────────────────────
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxComp = max( throughput.x, max( throughput.y, throughput.z ) );
			const survivalProb = maxComp.clamp( 0.05, 0.95 ).toVar();
			const rr = RandomValue( rngState );

			If( rr.greaterThan( survivalProb ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.and( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				return;

			} );

			throughput.divAssign( survivalProb );

		} );

		// ─── TERMINATE IF MAX BOUNCES ───────────────────────────
		If( bounceIndex.greaterThanEqual( maxBounceCount ), () => {

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.and( uint( ~ RAY_FLAG.ACTIVE ) ) );
			rngBufferRW.element( rayID ).assign( rngState );
			return;

		} );

		// ─── UPDATE RAY FOR NEXT BOUNCE ─────────────────────────
		const newOrigin = hitPoint.add( N.mul( 0.001 ) );

		writeRayOriginPixel( rayBufferRW, rayID, newOrigin, pixelIndex );
		writeRayDirFlags( rayBufferRW, rayID, bounceDir, flags );
		writeRayThroughputPdf( rayBufferRW, rayID, throughput, bouncePdf );
		writeRayRadiance( rayBufferRW, rayID, currentRadiance );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as SHADE_WG_SIZE };
