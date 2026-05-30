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
 *   materialBuffer(1) + envCDFBuffer(1) [+ lightBuffer(1) for item 13]
 *   + rayBuffer_RW(1) + rngBuffer_RW(1) + hitBuffer_RO(1)
 *   + shadowBuffer_WR(1) + counters(1)
 *
 * NOTE: shadowBuffer and counters are bound but unused in this initial version.
 * They are included to validate the binding budget and will be used when
 * deferred direct lighting is added.
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, exp, log, dot, length, select,
	instanceIndex,
	sampler,
	atomicAdd, atomicLoad, uintBitsToFloat,
	Return,
} from 'three/tsl';

import { sampleEnvironment, sampleEquirectProbability, sampleEquirect } from '../Environment.js';
import { getMaterial, powerHeuristic, classifyMaterial } from '../Common.js';
import { sampleAllMaterialTextures } from '../TextureSampling.js';
import { evaluateMaterialResponse } from '../MaterialEvaluation.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from '../LightsSampling.js';
import { traceShadowRay, calculateRayOffset } from '../LightsDirect.js';
import { traverseBVHShadow } from '../BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from '../MaterialTransmission.js';
import { calculateIndirectLighting } from '../LightsIndirect.js';
import { IndirectLightingResult } from '../LightsCore.js';
import { regularizePathContribution, generateSampledDirection } from '../PathTracerCore.js';
import { getImportanceSamplingInfo } from '../MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from '../Clearcoat.js';
import { refineDisplacedIntersection, DisplacementResult } from '../Displacement.js';
import { calculateEmissiveTriangleContribution, EmissiveSample } from '../EmissiveSampling.js';
import { sampleLightBVHTriangle } from '../LightBVHSampling.js';
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
	readMediumStack, writeMediumStack, readMediumSigmaA, writeMediumSigmaA,
	readHitDistance, readHitBarycentrics, readHitNormal,
	readHitMaterialIndex, readHitTriangleIndex,
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
		// Scene storage buffers (4 after packing env CDF)
		bvhBuffer, triangleBuffer, materialBuffer,
		envCDFBuffer,
		// Optional packed light buffer (emissive tris + light BVH nodes) — 1 binding
		lightBuffer,
		// Packed buffers (5)
		rayBufferRW, rngBufferRW, hitBufferRO,
		shadowBufferRW, counters,
		// Active indices (needed to match ExtendKernel's ray ID mapping)
		activeIndicesRO,
		// Textures (not storage buffers)
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		displacementMaps,
		envTexture, environmentIntensity, envMatrix,
		enableEnvironmentLight, useEnvMapIS,
		envTotalSum, envCompensationDelta, envResolution,
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
		// Emissive triangle NEE (item 13) — opt-in via enableEmissiveTriangleSampling
		emissiveTriangleCount, emissiveVec4Offset, emissiveTotalPower,
		emissiveBoost, totalTriangleCount, enableEmissiveTriangleSampling,
		lightBVHNodeCount,
		// Current bounce (set per-bounce by stage)
		currentBounce,
		// Max count
		maxRayCount,
	} = params;

	const useEmissiveNEE = lightBuffer !== undefined;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// Bound on ENTERING_COUNT (dense active-list length this bounce) so an
		// over-sized margin dispatch is safe; falls back to maxRayCount if absent.
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : maxRayCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

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
		const hitTriIdx = readHitTriangleIndex( hitBufferRO, rayID ).toVar();

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
							envTexture, direction, envMatrix, envTotalSum, envCompensationDelta, envResolution,
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

		// ─── MEDIUM STACK (read once at the hit; reused by the transparency block below) ───
		const medStack = readMediumStack( rayBufferRW, rayID );
		const mediumStackDepth = int( medStack.stackDepth ).toVar();
		const mediumStack_ior_1 = medStack.ior1.toVar();
		const mediumStack_ior_2 = medStack.ior2.toVar();
		const mediumStack_ior_3 = medStack.ior3.toVar();
		const transTraversals = int( medStack.transTraversals ).toVar();
		// Dispersion: per-ray locked wavelength (nm; 0 = achromatic), in medium-stack bits 16-31.
		const pathWavelength = float( medStack.wavelength ).toVar();

		// In-medium Beer-Lambert absorption (KHR_materials_volume): if the segment that reached
		// this hit was inside a medium, attenuate throughput over its length before any shading
		// (mirror PathTracerCore:701-704). Glass has sigmaS==0 so this is the full glass path; the
		// SSS scatter branch (sigmaS>0) is added later. Miss rays already Returned, so the segment
		// is bounded.
		If( mediumStackDepth.greaterThan( 0 ), () => {

			throughput.mulAssign( exp( readMediumSigmaA( rayBufferRW, rayID ).mul( hitDist ).negate() ) );

		} );

		// Load material
		const material = RayTracingMaterial.wrap(
			getMaterial( int( hitMatIdx ), materialBuffer )
		).toVar();

		// ─── DISPLACEMENT MAPPING (item 27) ─────────────────────
		// Tessellation-free via analytical ray-height marching.
		// Mirrors PathTracerCore.js:759 — refines hitPoint/UV/normal when the
		// material has a valid displacement map. Cheap no-op otherwise.
		const samplingUV = hitUV.toVar();
		const displacedNormal = N.toVar();
		If(
			material.displacementMapIndex.greaterThanEqual( int( 0 ) )
				.and( material.displacementScale.greaterThan( 0.0 ) ),
			() => {

				const dispRay = Ray( { origin, direction } );
				const dispHit = HitInfo( {
					didHit: true, dst: hitDist, hitPoint, normal: N, uv: hitUV,
					materialIndex: int( hitMatIdx ), meshIndex: int( 0 ),
					triangleIndex: int( hitTriIdx ),
					boxTests: int( 0 ), triTests: int( 0 ),
				} );
				const dispResult = DisplacementResult.wrap( refineDisplacedIntersection(
					dispRay, dispHit, triangleBuffer, displacementMaps, material, bounceIndex,
				) ).toVar();
				samplingUV.assign( dispResult.uv );
				displacedNormal.assign( dispResult.normal );
				hitPoint.assign( dispResult.hitPoint );

			}
		);

		// Sample textures with displacement-refined UVs
		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps,
			metalnessMaps, roughnessMaps, emissiveMaps,
			material, samplingUV, N,
		) ).toVar();

		// Apply texture samples to material (CRITICAL — BRDF functions use material.color/metalness/roughness)
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
		material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );

		const albedo = matSamples.albedo.toVar();
		// Update N — displacement provides macro shape, normal map adds micro detail (matches PathTracerCore:783)
		If(
			material.displacementMapIndex.greaterThanEqual( int( 0 ) )
				.and( material.displacementScale.greaterThan( 0.0 ) ),
			() => {

				N.assign( normalize( displacedNormal.add( matSamples.normal.sub( normalize( hitNormal ) ) ) ) );

			}
		).Else( () => {

			N.assign( matSamples.normal );

		} );

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
		// (medium stack + dispersion wavelength were read at the hit, above.)

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
			currentRay, N, material, rngState,
			int( transTraversals ),
			currentMediumIOR, previousMediumIOR,
			pathWavelength,
		) ).toVar();

		// Capture the wavelength locked on a fresh dispersive transmission so it survives to the
		// next dispatch (mirrors PathTracerCore:865). Reflective/opaque interactions return it
		// unchanged, so this is an identity write on non-dispersive paths.
		pathWavelength.assign( interaction.pathWavelength );

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

						// KHR_materials_volume: precompute the medium's Beer-Lambert absorption
						// coeff once at enter (mirror PathTracerCore:889-893) and persist it for the
						// in-medium segments. Single-slot store (PackedRayBuffer.MEDIUM_SIGMA_A).
						writeMediumSigmaA( rayBufferRW, rayID, select(
							material.attenuationDistance.greaterThan( 0.0 ),
							log( max( material.attenuationColor, vec3( 0.001 ) ) ).negate().div( material.attenuationDistance ),
							vec3( 0.0 ),
						) );

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
			writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
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
			material.clearcoat, material.emissive, material.subsurface,
		) ).toVar();

		// BRDF sample (for direct lighting MIS + specular strategy input)
		const xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
		const emptyWeights = BRDFWeights( {
			specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
			clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
		} );
		// main slimmed MaterialCache to 11 fields (70ed512). This dummy is unused
		// (materialCacheCached=false → generateSampledDirection builds its own temp cache),
		// but must match the current struct shape to construct.
		const emptyCache = MaterialCache( {
			F0: vec3( 0.04 ), NoV: float( 1.0 ),
			diffuseColor: vec3( 0.0 ), isPurelyDiffuse: false,
			alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
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
				V, N, material, xi, rngState,
				mc,
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
			bounceIndex, rngState,
			directionalLightsBuffer, numDirectionalLights,
			areaLightsBuffer, numAreaLights,
			pointLightsBuffer, numPointLights,
			spotLightsBuffer, numSpotLights,
			bvhBuffer, triangleBuffer, materialBuffer,
			envTexture, environmentIntensity, envMatrix,
			envCDFBuffer,
			envTotalSum, envCompensationDelta, envResolution,
			enableEnvironmentLight,
		);

		const giScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
		currentRadiance.assign( vec4(
			currentRadiance.xyz.add( throughput.mul( directLight ).mul( giScale ) ),
			currentRadiance.w
		) );

		// ─── EMISSIVE TRIANGLE NEE (item 13, unblocked by packed lightBuffer) ────
		// Mirrors PathTracerCore.js:1025-1107. Light BVH fast path when available,
		// flat-CDF fallback otherwise. Both paths go through the shared lightBuffer
		// binding; emissiveVec4Offset locates the emissive section within it.
		if ( useEmissiveNEE ) {

			If(
				enableEmissiveTriangleSampling.equal( int( 1 ) )
					.and( emissiveTriangleCount.greaterThan( int( 0 ) ) ),
				() => {

					// 4-param shadow wrapper — closes over scene storage buffers that
					// calculateEmissiveTriangleContribution's inner callback needs.
					const traceShadowRayWrapped = Fn( ( [ origin, dir, maxDist ] ) => {

						return traceShadowRay(
							origin, dir, maxDist,
							traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
						);

					} );

					If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

						// Light-BVH fast path (spatially-aware importance sampling)
						const emissiveSample = EmissiveSample.wrap( sampleLightBVHTriangle(
							hitPoint, N,
							rngState,
							lightBuffer,
							lightBuffer,
							emissiveVec4Offset,
							triangleBuffer,
						) );

						// Skip for very rough diffuse surfaces on secondary bounces (monolithic match)
						const skip = bounceIndex.greaterThan( int( 1 ) )
							.and( material.roughness.greaterThan( 0.9 ) )
							.and( material.metalness.lessThan( 0.1 ) );

						If( skip.not().and( emissiveSample.valid ).and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

							const NoL = max( float( 0.0 ), dot( N, emissiveSample.direction ) );

							If( NoL.greaterThan( 0.0 ), () => {

								const rayOffset = calculateRayOffset( hitPoint, N, material );
								const rayOrigin = hitPoint.add( rayOffset );
								const shadowDist = emissiveSample.distance.sub( 0.001 );
								const visibility = traceShadowRayWrapped(
									rayOrigin, emissiveSample.direction, shadowDist,
								);

								If( visibility.greaterThan( 0.0 ), () => {

									const brdfVal = evaluateMaterialResponse( V, emissiveSample.direction, N, material );
									const bPdf = calculateMaterialPDF( V, emissiveSample.direction, N, material );
									const misW = select(
										bPdf.greaterThan( 0.0 ),
										powerHeuristic( { pdf1: emissiveSample.pdf, pdf2: bPdf } ),
										float( 1.0 ),
									);

									const emissiveLight = emissiveSample.emission
										.mul( brdfVal ).mul( NoL )
										.div( emissiveSample.pdf )
										.mul( visibility ).mul( emissiveBoost ).mul( misW );

									currentRadiance.assign( vec4(
										currentRadiance.xyz.add(
											regularizePathContribution(
												emissiveLight.mul( throughput ).mul( giScale ),
												float( bounceIndex ), fireflyThreshold, int( frame ),
											),
										),
										currentRadiance.w,
									) );

								} );

							} );

						} );

					} ).Else( () => {

						// Flat-CDF fallback — same packed buffer, emissive triangles start at offset.
						const emissiveLight = calculateEmissiveTriangleContribution(
							hitPoint, N, V, material,
							bounceIndex, rngState,
							emissiveBoost,
							lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
							triangleBuffer,
							traceShadowRayWrapped,
							calculateRayOffset,
						);

						currentRadiance.assign( vec4(
							currentRadiance.xyz.add(
								regularizePathContribution(
									emissiveLight.mul( throughput ).mul( giScale ),
									float( bounceIndex ), fireflyThreshold, int( frame ),
								),
							),
							currentRadiance.w,
						) );

					} );

				},
			);

		}

		// ─── FIREFLY SUPPRESSION ────────────────────────────────
		const suppressedRadiance = regularizePathContribution(
			currentRadiance.xyz, float( bounceIndex ), fireflyThreshold, int( frame ),
		);
		currentRadiance.assign( vec4( suppressedRadiance, currentRadiance.w ) );

		// ─── INDIRECT BOUNCE (full calculateIndirectLighting) ────
		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, mc,
		) ).toVar();

		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfDir, brdfPdf, brdfValue,
			rngState, samplingInfo,
		) ).toVar();

		const bounceDir = indirectResult.direction.toVar();
		// combinedPdf (not pdf) is what main stores as prevBouncePdf for the next bounce's
		// NEE↔implicit-env MIS pairing.
		const bouncePdf = max( indirectResult.combinedPdf, 0.001 ).toVar();
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
		writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as SHADE_WG_SIZE };
