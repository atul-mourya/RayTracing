/**
 * ShadeKernel.js — wavefront material eval + bounce generation. 256×1 workgroup, 1D dispatch.
 * 10 storage-buffer bindings: bvh, tri, mat, light, ray, rng, hit, gBuffer, counters, activeIndices
 * (at the device per-stage limit of 10; envCDF is a texture, not a storage buffer).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, exp, log, clamp, dot, length, select,
	instanceIndex,
	sampler,
	atomicAdd, atomicLoad, uintBitsToFloat,
	Return,
} from 'three/tsl';

import { sampleEnvironment, sampleEquirectProbability, sampleEquirect, getGroundProjectedDirection } from './Environment.js';
import { getMaterial, powerHeuristic, classifyMaterial } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from './LightsSampling.js';
import { traceShadowRay, calculateRayOffset } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from './MaterialTransmission.js';
import { sampleChromaticCollision, sampleHenyeyGreenstein, subsurfaceCoefficients, CollisionSample, MediumCoeffs } from './Subsurface.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult } from './LightsCore.js';
import { regularizePathContribution, generateSampledDirection, computeNDCDepth } from './PathTracerCore.js';
import { getImportanceSamplingInfo } from './MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { refineDisplacedIntersection, DisplacementResult } from './Displacement.js';
import { calculateEmissiveTriangleContribution, EmissiveSample } from './EmissiveSampling.js';
import { sampleLightBVHTriangle } from './LightBVHSampling.js';
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
} from './Struct.js';
import { RandomValue, getRandomSample } from './Random.js';
import { RAY_FLAG, COUNTER } from '../Processor/QueueManager.js';
import {
	SHADOW_STRIDE, SHADOW,
	readRayOrigin, readRayDirection, readRayBounceFlags, readRayThroughput, readRayPdf,
	readMediumStack, writeMediumStack, readMediumSigmaA, writeMediumSigmaA,
	readPathBounces, readSssSteps, readSSSMedium, writeSSSMedium,
	readHitDistance, readHitBarycentrics, readHitNormal,
	readHitMaterialIndex, readHitTriangleIndex,
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf, writeRayRadiance,
	writeGBuffer,
	readRayRadiance,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;
const MISS_DIST = 1e19;

export function buildShadeKernel( params ) {

	const {
		bvhBuffer, triangleBuffer, materialBuffer,
		envCDFTexture,
		lightBuffer,
		rayBufferRW, rngBufferRW, hitBufferRO, gBufferRW,
		shadowBufferRW, counters,
		activeIndicesRO,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		displacementMaps,
		envTexture, environmentIntensity, envMatrix,
		enableEnvironmentLight, useEnvMapIS,
		groundProjectionEnabled, groundProjectionRadius, groundProjectionHeight,
		envTotalSum, envCompensationDelta, envResolution,
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		transparentBackground, backgroundIntensity, showBackground,
		globalIlluminationIntensity,
		cameraProjectionMatrix, cameraViewMatrix,
		fireflyThreshold, frame, resolution,
		emissiveTriangleCount, emissiveVec4Offset, emissiveTotalPower,
		emissiveBoost, totalTriangleCount, enableEmissiveTriangleSampling,
		lightBVHNodeCount,
		maxRayCount,
	} = params;

	const useEmissiveNEE = lightBuffer !== undefined;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// bound on ENTERING_COUNT so an over-sized margin dispatch is safe
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : maxRayCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

		} );

		const rayID = activeIndicesRO.element( threadIdx );

		const flags = readRayBounceFlags( rayBufferRW, rayID ).toVar();

		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			Return();

		} );

		const origin = readRayOrigin( rayBufferRW, rayID ).toVar();
		const direction = readRayDirection( rayBufferRW, rayID ).toVar();
		const throughput = readRayThroughput( rayBufferRW, rayID ).toVar();
		const currentRadiance = readRayRadiance( rayBufferRW, rayID ).toVar();
		// pixelIndex + sampleIndex are derived from rayID (= subSample*maxRaysPerSample + pixelIndex; GenerateKernel.js:64), not stored.
		const maxRaysPerSample = uint( resolution.x ).mul( uint( resolution.y ) ).toVar();
		const pixelIndex = rayID.mod( maxRaysPerSample );
		const rngState = rngBufferRW.element( rayID ).toVar();

		const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
		const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
		// hitInfo.uv is the interpolated texture UV (not barycentrics)
		const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
		const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();
		const hitTriIdx = readHitTriangleIndex( hitBufferRO, rayID ).toVar();

		// per-ray camera-bounce depth; free bounces (SSS walk, transmissive traversals) don't advance it
		const bounceIndex = readPathBounces( rayBufferRW, rayID ).toVar();
		const sssSteps = readSssSteps( rayBufferRW, rayID ).toVar();
		const sampleIndex = int( rayID.div( maxRaysPerSample ) ).toVar();

		If( hitDist.greaterThan( MISS_DIST ), () => {

			If( enableEnvironmentLight, () => {

				// Ground projection bends the primary ray's background lookup onto a
				// projected sphere+disk so the lower env hemisphere reads as a ground
				// plane. Primary ray only; secondary bounces see the raw envmap as a light.
				const envDir = direction.toVar();
				If( bounceIndex.equal( 0 ).and( groundProjectionEnabled ), () => {

					envDir.assign( getGroundProjectedDirection(
						origin, direction, groundProjectionRadius, groundProjectionHeight,
					) );

				} );

				const envColor = sampleEnvironment( {
					tex: envTexture,
					samp: sampler( envTexture ),
					direction: envDir,
					environmentMatrix: envMatrix,
					environmentIntensity,
					enableEnvironmentLight,
				} ).toVar();

				// Hide the background for primary rays when showBackground is off; secondary bounces still see the envmap as a light.
				If( bounceIndex.equal( 0 ).and( showBackground.not() ), () => {

					envColor.assign( vec4( 0.0 ) );

				} );

				// MIS weight for implicit env hit — prevents double-counting with NEE
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

			If( bounceIndex.equal( 0 ).and( transparentBackground ), () => {

				currentRadiance.w.assign( 0.0 );

			} );

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			Return();

		} );

		const hitPoint = origin.add( direction.mul( hitDist ) ).toVar();
		const N = normalize( hitNormal ).toVar();

		// medium stack read once here; reused by the transparency block below
		const medStack = readMediumStack( rayBufferRW, rayID );
		const mediumStackDepth = int( medStack.stackDepth ).toVar();
		const mediumStack_ior_1 = medStack.ior1.toVar();
		const mediumStack_ior_2 = medStack.ior2.toVar();
		const mediumStack_ior_3 = medStack.ior3.toVar();
		const transTraversals = int( medStack.transTraversals ).toVar();
		// per-ray locked dispersion wavelength (nm; 0 = achromatic), in medium-stack bits 16-31
		const pathWavelength = float( medStack.wavelength ).toVar();

		// in-medium transport: glass (sigmaS==0) absorbs, subsurface (sigmaS>0) random-walk scatters
		If( mediumStackDepth.greaterThan( 0 ), () => {

			const mSigmaA = readMediumSigmaA( rayBufferRW, rayID ).toVar();
			const sssMed = readSSSMedium( rayBufferRW, rayID );
			const mSigmaS = sssMed.sigmaS.toVar();
			const mG = sssMed.g.toVar();

			If( max( max( mSigmaS.x, mSigmaS.y ), mSigmaS.z ).lessThanEqual( 0.0 ), () => {

				// glass: Beer-Lambert absorption
				throughput.mulAssign( exp( mSigmaA.mul( hitDist ).negate() ) );

			} ).Else( () => {

				// subsurface: chromatic collision-distance sampling
				const mSigmaT = mSigmaA.add( mSigmaS );
				const coll = CollisionSample.wrap( sampleChromaticCollision(
					mSigmaT, mSigmaS, throughput, hitDist, rngState,
				) ).toVar();
				throughput.mulAssign( coll.weight );

				If( coll.didScatter, () => {

					// scatter via Henyey-Greenstein, continue as a free bounce off the sssSteps budget
					const xi2 = vec2( RandomValue( rngState ), RandomValue( rngState ) );
					const scatterPoint = origin.add( direction.mul( coll.t ) );
					const newDir = sampleHenyeyGreenstein( direction, mG, xi2 ).toVar();
					sssSteps.addAssign( 1 );

					// terminate walk: step cap or Russian roulette
					const rrP = clamp( max( max( throughput.x, throughput.y ), throughput.z ), 0.02, 1.0 ).toVar();
					const terminate = sssSteps.greaterThanEqual( maxSubsurfaceSteps )
						.or( RandomValue( rngState ).greaterThan( rrP ) ).toVar();

					If( terminate, () => {

						writeRayRadiance( rayBufferRW, rayID, currentRadiance );
						writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
						rngBufferRW.element( rayID ).assign( rngState );
						Return();

					} );

					throughput.divAssign( rrP );

					// free-bounce continuation: ray stays in the same medium, so medium stack + coeffs persist
					writeRayOriginMeta( rayBufferRW, rayID, scatterPoint, bounceIndex, sssSteps );
					writeRayDirFlags( rayBufferRW, rayID, newDir, flags );
					writeRayThroughputPdf( rayBufferRW, rayID, throughput, float( 1.0 ) );
					writeRayRadiance( rayBufferRW, rayID, currentRadiance );
					rngBufferRW.element( rayID ).assign( rngState );
					Return();

				} );

				// no scatter: reached boundary, fall through to surface handling

			} );

		} );

		const material = RayTracingMaterial.wrap(
			getMaterial( int( hitMatIdx ), materialBuffer )
		).toVar();

		// displacement: analytical ray-height marching refines hitPoint/UV/normal; no-op without a map
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

		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps,
			metalnessMaps, roughnessMaps, emissiveMaps,
			material, samplingUV, N,
		) ).toVar();

		// BRDF functions read material.color/metalness/roughness, so apply samples here
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
		material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );

		const albedo = matSamples.albedo.toVar();
		If(
			material.displacementMapIndex.greaterThanEqual( int( 0 ) )
				.and( material.displacementScale.greaterThan( 0.0 ) ),
			() => {

				N.assign( normalize( displacedNormal.add( matSamples.normal.sub( normalize( hitNormal ) ) ) ) );

			}
		).Else( () => {

			N.assign( matSamples.normal );

		} );

		// first-hit MRT data (bounce 0 only)
		If( bounceIndex.equal( 0 ), () => {

			const linearDepth = computeNDCDepth( {
				worldPos: hitPoint,
				cameraProjectionMatrix,
				cameraViewMatrix,
			} );
			// G-buffer is per-pixel — only sub-sample 0 writes it (FinalWrite reads sub-sample 0). writeGBuffer half-packs (normal/depth/albedo).
			If( sampleIndex.equal( int( 0 ) ), () => {

				writeGBuffer( gBufferRW, pixelIndex, N, linearDepth, albedo.xyz );

			} );

			If( transparentBackground, () => {

				currentRadiance.w.assign( 1.0 );

			} );

		} );

		// transparency / refraction (medium stack + wavelength read at the hit, above)
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

		// persist any wavelength locked on a fresh dispersive transmission; identity write otherwise
		pathWavelength.assign( interaction.pathWavelength );

		If( interaction.continueRay, () => {

			// update medium stack for transmission (not reflection/TIR)
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

						// precompute Beer-Lambert sigmaA once at enter
						writeMediumSigmaA( rayBufferRW, rayID, select(
							material.attenuationDistance.greaterThan( 0.0 ),
							log( max( material.attenuationColor, vec3( 0.001 ) ) ).negate().div( material.attenuationDistance ),
							vec3( 0.0 ),
						) );
						// sigmaS==0 marks glass → in-medium block takes the Beer-Lambert path, not SSS walk
						writeSSSMedium( rayBufferRW, rayID, vec3( 0.0 ), float( 0.0 ) );

					} );

				} ).Else( () => {

					If( mediumStackDepth.greaterThan( 0 ), () => {

						mediumStackDepth.subAssign( 1 );

					} );

				} );

			} );

			// subsurface boundary: push the scattering medium on enter, pop on exit; free bounce
			If( interaction.isSubsurface.and( interaction.didReflect.not() ), () => {

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

						const ssCoeffs = MediumCoeffs.wrap( subsurfaceCoefficients(
							material.subsurfaceColor, material.subsurfaceRadius, material.subsurfaceRadiusScale,
						) ).toVar();
						writeMediumSigmaA( rayBufferRW, rayID, ssCoeffs.sigmaA );
						writeSSSMedium( rayBufferRW, rayID, ssCoeffs.sigmaS, clamp( material.subsurfaceAnisotropy, - 0.99, 0.99 ) );

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

			// reflection stays on same side, transmission pushes through
			const reflectOffsetDir = select( interaction.entering, N, N.negate() );
			const offsetDir = select( interaction.didReflect, reflectOffsetDir, direction );
			const newOrigin = hitPoint.add( offsetDir.mul( 0.001 ) );

			// SSS = free bounce (depth unchanged); transmission advances camera-bounce depth.
			writeRayOriginMeta( rayBufferRW, rayID, newOrigin, select( interaction.isSubsurface, bounceIndex, bounceIndex.add( 1 ) ), sssSteps );
			writeRayDirFlags( rayBufferRW, rayID, interaction.direction, flags );
			writeRayThroughputPdf( rayBufferRW, rayID, throughput, float( 1.0 ) );
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
			rngBufferRW.element( rayID ).assign( rngState );
			Return();

		} );

		const emissive = matSamples.emissive.toVar();
		If( length( emissive ).greaterThan( 0.0 ), () => {

			const emissiveGiScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
			currentRadiance.assign( vec4(
				currentRadiance.xyz.add( throughput.mul( emissive ).mul( emissiveGiScale ) ),
				currentRadiance.w
			) );

		} );

		// BRDF sample (needed by both direct + indirect)
		const V = direction.negate().toVar();

		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive, material.subsurface,
		) ).toVar();

		// STBN keyed on (pixel, bounceIndex, frame); sampleIndex gives each sub-sample a distinct tap
		const _resX = int( resolution.x ).toVar();
		const _pixelCoord = vec2(
			float( int( pixelIndex ).mod( _resX ) ).add( 0.5 ),
			float( int( pixelIndex ).div( _resX ) ).add( 0.5 ),
		);
		const xi = getRandomSample( _pixelCoord, sampleIndex, bounceIndex, rngState, int( - 1 ), resolution, frame ).toVar();
		const emptyWeights = BRDFWeights( {
			specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
			clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
		} );
		// unused (materialCacheCached=false), but must match the 11-field struct shape to construct
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
			envCDFTexture,
			envTotalSum, envCompensationDelta, envResolution,
			enableEnvironmentLight,
		);

		const giScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
		currentRadiance.assign( vec4(
			currentRadiance.xyz.add( throughput.mul( directLight ).mul( giScale ) ),
			currentRadiance.w
		) );

		// emissive triangle NEE: light-BVH fast path when available, flat-CDF fallback otherwise
		if ( useEmissiveNEE ) {

			If(
				enableEmissiveTriangleSampling.equal( int( 1 ) )
					.and( emissiveTriangleCount.greaterThan( int( 0 ) ) ),
				() => {

					// closes over scene buffers for the inner shadow-trace callback
					const traceShadowRayWrapped = Fn( ( [ origin, dir, maxDist ] ) => {

						return traceShadowRay(
							origin, dir, maxDist,
							traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
						);

					} );

					If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

						const emissiveSample = EmissiveSample.wrap( sampleLightBVHTriangle(
							hitPoint, N,
							rngState,
							lightBuffer,
							lightBuffer,
							emissiveVec4Offset,
							triangleBuffer,
						) );

						// skip rough diffuse surfaces on secondary bounces
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

		const suppressedRadiance = regularizePathContribution(
			currentRadiance.xyz, float( bounceIndex ), fireflyThreshold, int( frame ),
		);
		currentRadiance.assign( vec4( suppressedRadiance, currentRadiance.w ) );

		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, mc,
		) ).toVar();

		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfDir, brdfPdf, brdfValue,
			rngState, samplingInfo,
		) ).toVar();

		const bounceDir = indirectResult.direction.toVar();
		// combinedPdf is stored as next bounce's prevBouncePdf for NEE↔implicit-env MIS
		const bouncePdf = max( indirectResult.combinedPdf, 0.001 ).toVar();
		throughput.mulAssign( indirectResult.throughput );

		// early ray termination
		If( bounceIndex.greaterThanEqual( 3 ), () => {

			const maxThroughput = max( throughput.x, max( throughput.y, throughput.z ) );
			If( maxThroughput.lessThan( 0.001 ), () => {

				writeRayRadiance( rayBufferRW, rayID, currentRadiance );
				writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
				rngBufferRW.element( rayID ).assign( rngState );
				Return();

			} );

		} );

		// Russian roulette
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

		If( bounceIndex.greaterThanEqual( maxBounceCount ), () => {

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			rngBufferRW.element( rayID ).assign( rngState );
			Return();

		} );

		const newOrigin = hitPoint.add( N.mul( 0.001 ) );

		writeRayOriginMeta( rayBufferRW, rayID, newOrigin, bounceIndex.add( 1 ), sssSteps );
		writeRayDirFlags( rayBufferRW, rayID, bounceDir, flags );
		writeRayThroughputPdf( rayBufferRW, rayID, throughput, bouncePdf );
		writeRayRadiance( rayBufferRW, rayID, currentRadiance );
		writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as SHADE_WG_SIZE };
