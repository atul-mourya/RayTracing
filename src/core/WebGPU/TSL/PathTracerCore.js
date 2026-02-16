/**
 * PathTracerCore.js - Path Tracing Core
 *
 * Exact port of pathtracer_core.fs + helper functions from pathtracer.fs
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Contains:
 *  - getOrCreateMaterialClassification — cached material classification
 *  - generateSampledDirection          — BRDF direction sampling with multi-lobe CDF
 *  - estimatePathContribution          — path importance estimation
 *  - handleRussianRoulette             — adaptive path termination
 *  - sampleBackgroundLighting          — environment background sampling
 *  - regularizePathContribution        — firefly suppression
 *  - Trace                             — main path tracing loop
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	abs,
	sqrt,
	exp,
	log,
	clamp,
	mix,
	dot,
	normalize,
	length,
	reflect,
	If,
	Loop,
	Break,
	Continue,
	select,
	smoothstep,
} from 'three/tsl';

import { struct } from './structProxy.js';

import {
	PI,
	PI_INV,
	EPSILON,
	MIN_ROUGHNESS,
	MAX_ROUGHNESS,
	MIN_CLEARCOAT_ROUGHNESS,
	MIN_PDF,
	maxComponent,
	minComponent,
	classifyMaterial,
	constructTBN,
	calculateFireflyThreshold,
	applySoftSuppressionRGB,
	getMaterial,
} from './Common.js';
import {
	DirectionSample,
	MaterialClassification,
	PathState,
	RenderState,
	MaterialCache,
	BRDFWeights,
	Ray,
	HitInfo,
	MaterialSamples,
	RayTracingMaterial,
	ImportanceSamplingInfo,
} from './Struct.js';
import { RandomValue, getRandomSample } from './Random.js';
import { traverseBVH } from './BVHTraversal.js';
import { sampleEnvironment } from './Environment.js';
import { sampleAllMaterialTextures, sampleDisplacementMap } from './TextureSampling.js';
import { calculateDisplacedNormal } from './Displacement.js';
import { handleMaterialTransparency, MaterialInteractionResult } from './MaterialTransmission.js';
import {
	DistributionGGX,
	SheenDistribution,
	calculateVNDFPDF,
	calculateBRDFWeights,
	createMaterialCache,
	getImportanceSamplingInfo,
} from './MaterialProperties.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import {
	ImportanceSampleCosine,
	ImportanceSampleGGX,
	sampleGGXVNDF,
} from './MaterialSampling.js';
import { sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { calculateDirectLightingUnified } from './LightsSampling.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult } from './LightsCore.js';

// =============================================================================
// Constants
// =============================================================================

// Ray type enumeration
const RAY_TYPE_CAMERA = 0;
const RAY_TYPE_REFLECTION = 1;
const RAY_TYPE_TRANSMISSION = 2;
const RAY_TYPE_DIFFUSE = 3;
const RAY_TYPE_SHADOW = 4;

// Trace result struct
export const TraceResult = struct( {
	radiance: 'vec4',
	objectNormal: 'vec3',
	objectColor: 'vec3',
	objectID: 'float',
	firstHitPoint: 'vec3',
	firstHitDistance: 'float',
} );

// =============================================================================
// Material Classification Caching
// =============================================================================

// OPTIMIZED: Consolidated material classification with material change detection
// Note: In TSL, we cannot use inout on PathState, so we pass individual cache fields
// and return classification. PathState cache management happens in the caller.
export const getOrCreateMaterialClassification = Fn( ( [
	material, materialIndex,
	classificationCached, lastMaterialIndex,
	cachedClassification,
] ) => {

	const result = cachedClassification.toVar( 'gocc_result' );

	If( classificationCached.not().or( lastMaterialIndex.notEqual( materialIndex ) ), () => {

		result.assign( classifyMaterial(
			material.metalness, material.roughness,
			material.transmission, material.clearcoat,
			material.emissive,
		) );

	} );

	return result;

} );

// =============================================================================
// BRDF Direction Sampling
// =============================================================================

export const generateSampledDirection = Fn( ( [
	V, N, material, materialIndex, xi, rngState,
	// PathState cache fields
	classificationCached, lastMaterialIndex, cachedClassification,
	weightsComputed, cachedBrdfWeights,
	materialCacheCached, cachedMaterialCache,
] ) => {

	const resultDirection = vec3( 0.0 ).toVar( 'gsd_dir' );
	const resultValue = vec3( 0.0 ).toVar( 'gsd_val' );
	const resultPdf = float( 0.0 ).toVar( 'gsd_pdf' );

	// Get material classification (cached or computed)
	const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
		material, materialIndex,
		classificationCached, lastMaterialIndex, cachedClassification,
	) ).toVar( 'gsd_mc' );

	// Compute BRDF weights
	const weights = cachedBrdfWeights.toVar( 'gsd_weights' );

	If( weightsComputed.not(), () => {

		If( materialCacheCached, () => {

			weights.assign( calculateBRDFWeights( material, mc, cachedMaterialCache ) );

		} ).Else( () => {

			// Create minimal temporary cache
			const tempCache = MaterialCache( {
				F0: vec3( 0.04 ),
				NoV: float( 1.0 ),
				diffuseColor: vec3( 0.0 ),
				specularColor: vec3( 0.0 ),
				isMetallic: false,
				isPurelyDiffuse: false,
				hasSpecialFeatures: false,
				alpha: float( 0.0 ),
				k: float( 0.0 ),
				alpha2: float( 0.0 ),
				tsAlbedo: vec4( 0.0 ),
				tsEmissive: vec3( 0.0 ),
				tsMetalness: float( 0.0 ),
				tsRoughness: float( 0.0 ),
				tsNormal: vec3( 0.0 ),
				tsHasTextures: false,
				invRoughness: float( 1.0 ).sub( material.roughness ),
				metalFactor: float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ),
				iorFactor: min( float( 2.0 ).div( material.ior ), 1.0 ),
				maxSheenColor: max( material.sheenColor.x, max( material.sheenColor.y, material.sheenColor.z ) ),
			} ).toVar( 'gsd_tempCache' );
			weights.assign( calculateBRDFWeights( material, mc, tempCache ) );

		} );

	} );

	const rand = xi.x.toVar( 'gsd_rand' );
	const directionSample = vec2( xi.y, RandomValue( rngState ) ).toVar( 'gsd_dirSmp' );
	const H = vec3( 0.0 ).toVar( 'gsd_H' );

	// Cumulative probability approach for sampling selection
	const cumulativeDiffuse = weights.diffuse.toVar( 'gsd_cumDiff' );
	const cumulativeSpecular = cumulativeDiffuse.add( weights.specular ).toVar( 'gsd_cumSpec' );
	const cumulativeSheen = cumulativeSpecular.add( weights.sheen ).toVar( 'gsd_cumSheen' );
	const cumulativeClearcoat = cumulativeSheen.add( weights.clearcoat ).toVar( 'gsd_cumCC' );

	const sampled = tslBool( false ).toVar( 'gsd_sampled' );

	// Diffuse sampling
	If( rand.lessThan( cumulativeDiffuse ).and( sampled.not() ), () => {

		resultDirection.assign( ImportanceSampleCosine( N, directionSample ) );
		const NoL = clamp( dot( N, resultDirection ), 0.0, 1.0 );
		resultPdf.assign( NoL.mul( PI_INV ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	const NoV = clamp( dot( N, V ), 0.001, 1.0 ).toVar( 'gsd_NoV' );

	// Specular sampling
	If( rand.lessThan( cumulativeSpecular ).and( sampled.not() ), () => {

		const TBN = constructTBN( N );
		const localV = TBN.transpose().mul( V ).toVar( 'gsd_localV' );

		// VNDF sampling
		const localH = sampleGGXVNDF( localV, material.roughness, xi );
		H.assign( TBN.mul( localH ) );

		const NoH = clamp( dot( N, H ), 0.001, 1.0 );

		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, material.roughness ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	// Sheen sampling
	If( rand.lessThan( cumulativeSheen ).and( sampled.not() ), () => {

		H.assign( ImportanceSampleGGX( N, material.sheenRoughness, xi ) );
		const NoH = clamp( dot( N, H ), 0.001, 1.0 );
		const VoH = clamp( dot( V, H ), 0.001, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		const NoL = dot( N, resultDirection ).toVar( 'gsd_sheenNoL' );

		// Reject directions below the surface - fall back to diffuse
		If( NoL.lessThanEqual( 0.0 ), () => {

			resultDirection.assign( ImportanceSampleCosine( N, xi ) );
			NoL.assign( clamp( dot( N, resultDirection ), 0.0, 1.0 ) );
			resultPdf.assign( NoL.mul( PI_INV ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} ).Else( () => {

			resultPdf.assign( SheenDistribution( NoH, material.sheenRoughness ).mul( NoH ).div( float( 4.0 ).mul( VoH ) ) );
			resultPdf.assign( max( resultPdf, MIN_PDF ) );
			resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

		} );

		sampled.assign( tslBool( true ) );

	} );

	// Clearcoat sampling
	If( rand.lessThan( cumulativeClearcoat ).and( sampled.not() ), () => {

		const clearcoatRoughness = clamp( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS );
		H.assign( ImportanceSampleGGX( N, clearcoatRoughness, xi ) );
		const NoH = clamp( dot( N, H ), 0.0, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, clearcoatRoughness ) );
		resultPdf.assign( max( resultPdf, MIN_PDF ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	// Transmission sampling (fallback)
	If( sampled.not(), () => {

		const entering = dot( V, N ).lessThan( 0.0 ).toVar( 'gsd_entering' );
		const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission(
			V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState,
		) );
		resultDirection.assign( mtResult.direction );
		resultPdf.assign( max( mtResult.pdf, MIN_PDF ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );

	} );

	// Ensure PDF is valid
	resultPdf.assign( max( resultPdf, MIN_PDF ) );

	return DirectionSample( {
		direction: resultDirection,
		value: resultValue,
		pdf: resultPdf,
	} );

} );

// =============================================================================
// Path Contribution Estimation
// =============================================================================

export const estimatePathContribution = Fn( ( [
	throughput, direction, material, materialIndex,
	classificationCached, lastMaterialIndex, cachedClassification,
	enableEnvironmentLight, useEnvMapIS,
] ) => {

	const throughputStrength = maxComponent( throughput ).toVar( 'epc_ts' );

	// Use cached material classification
	const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
		material, materialIndex,
		classificationCached, lastMaterialIndex, cachedClassification,
	) ).toVar( 'epc_mc' );

	// Enhanced material importance with interaction bonuses
	const materialImportance = mc.complexityScore.toVar( 'epc_matImp' );

	// Interaction complexity bonuses
	If( mc.isMetallic.and( mc.isSmooth ), () => {

		materialImportance.addAssign( 0.15 );

	} );
	If( mc.isTransmissive.and( mc.hasClearcoat ), () => {

		materialImportance.addAssign( 0.12 );

	} );
	If( mc.isEmissive, () => {

		materialImportance.addAssign( 0.1 );

	} );
	materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

	// Direction importance calculation
	const directionImportance = float( 0.5 ).toVar( 'epc_dirImp' );

	If( enableEnvironmentLight.and( useEnvMapIS ).and( throughputStrength.greaterThan( 0.01 ) ), () => {

		const cosTheta = clamp( direction.y, 0.0, 1.0 );
		directionImportance.assign( mix( float( 0.3 ), float( 0.8 ), cosTheta.mul( cosTheta ) ) );

	} );

	// Enhanced weighting
	const throughputWeight = smoothstep( float( 0.001 ), float( 0.1 ), throughputStrength );
	return throughputStrength.mul(
		mix( materialImportance.mul( 0.7 ), directionImportance, 0.3 ),
	).mul( throughputWeight );

} );

// =============================================================================
// Russian Roulette Path Termination
// =============================================================================

export const handleRussianRoulette = Fn( ( [
	depth, throughput, material, materialIndex, rayDirection, rngState,
	classificationCached, lastMaterialIndex, cachedClassification,
	weightsComputed, pathImportance,
	enableEnvironmentLight, useEnvMapIS,
] ) => {

	const result = float( 1.0 ).toVar( 'rr_result' );

	// Always continue for first few bounces
	If( depth.greaterThanEqual( int( 3 ) ), () => {

		const throughputStrength = maxComponent( throughput ).toVar( 'rr_ts' );

		// Energy-conserving early termination for very low throughput paths
		const earlyTerminated = tslBool( false ).toVar( 'rr_early' );
		If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( int( 4 ) ) ), () => {

			const lowThroughputProb = max( throughputStrength.mul( 125.0 ), 0.01 );
			const rrSample = RandomValue( rngState );
			result.assign( select( rrSample.lessThan( lowThroughputProb ), lowThroughputProb, float( 0.0 ) ) );
			earlyTerminated.assign( tslBool( true ) );

		} );

		If( earlyTerminated.not(), () => {

			// Get classification
			const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
				material, materialIndex,
				classificationCached, lastMaterialIndex, cachedClassification,
			) ).toVar( 'rr_mc' );

			const materialImportance = mc.complexityScore.toVar( 'rr_matImp' );

			// Boost importance for special materials
			If( mc.isEmissive.and( depth.lessThan( int( 6 ) ) ), () => {

				materialImportance.addAssign( 0.3 );

			} );
			If( mc.isTransmissive.and( depth.lessThan( int( 5 ) ) ), () => {

				materialImportance.addAssign( 0.25 );

			} );
			If( mc.isMetallic.and( mc.isSmooth ).and( depth.lessThan( int( 4 ) ) ), () => {

				materialImportance.addAssign( 0.2 );

			} );
			materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

			// Dynamic minimum bounces
			const minBounces = int( 3 ).toVar( 'rr_minB' );
			If( materialImportance.greaterThan( 0.6 ), () => {

				minBounces.assign( 5 );

			} ).ElseIf( materialImportance.greaterThan( 0.4 ), () => {

				minBounces.assign( 4 );

			} );

			If( depth.lessThan( minBounces ), () => {

				result.assign( 1.0 );

			} ).Else( () => {

				// Path importance
				const pathContribution = float( 0.0 ).toVar( 'rr_pathC' );

				If( classificationCached.and( weightsComputed ), () => {

					pathContribution.assign( pathImportance );

				} ).Else( () => {

					pathContribution.assign( estimatePathContribution(
						throughput, rayDirection, material, materialIndex,
						classificationCached, lastMaterialIndex, cachedClassification,
						enableEnvironmentLight, useEnvMapIS,
					) );

				} );

				// Adaptive continuation probability
				const rrProb = float( 0.0 ).toVar( 'rr_prob' );
				const adaptiveFactor = materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).toVar( 'rr_adapt' );

				If( depth.lessThan( int( 6 ) ), () => {

					rrProb.assign( clamp( adaptiveFactor.mul( 1.2 ), 0.15, 0.95 ) );

				} ).ElseIf( depth.lessThan( int( 10 ) ), () => {

					const baseProb = clamp( throughputStrength.mul( 0.8 ), 0.08, 0.85 );
					rrProb.assign( mix( baseProb, pathContribution, 0.6 ) );

				} ).Else( () => {

					rrProb.assign( clamp( throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ), 0.03, 0.6 ) );

				} );

				// Material-specific boosts
				If( materialImportance.greaterThan( 0.5 ), () => {

					const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 );
					rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

				} );

				// Smoother depth-based decay
				const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) );
				const depthFactor = exp( float( depth.sub( minBounces ) ).negate().mul( depthDecay ) );
				rrProb.mulAssign( depthFactor );

				// Minimum probability
				const minProb = select( mc.isEmissive, float( 0.04 ), float( 0.02 ) );
				rrProb.assign( max( rrProb, minProb ) );

				const rrSample = RandomValue( rngState );
				result.assign( select( rrSample.lessThan( rrProb ), rrProb, float( 0.0 ) ) );

			} );

		} );

	} );

	return result;

} );

// =============================================================================
// Background & Environment Sampling
// =============================================================================

export const sampleBackgroundLighting = Fn( ( [
	isPrimaryRay, direction,
	envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
	showBackground, backgroundIntensity,
] ) => {

	// Only hide background for primary camera rays when showBackground is false
	const envColor = vec4( 0.0 ).toVar( 'sbl_envColor' );

	If( isPrimaryRay.and( showBackground.not() ), () => {

		// Return zero
		envColor.assign( vec4( 0.0 ) );

	} ).Else( () => {

		const sampled = sampleEnvironment(
			envTexture, direction, envMatrix, environmentIntensity, enableEnvironmentLight,
		);

		If( isPrimaryRay, () => {

			envColor.assign( sampled.mul( backgroundIntensity ) );

		} ).Else( () => {

			envColor.assign( sampled.mul( 2.0 ) );

		} );

	} );

	return envColor;

} );

// =============================================================================
// Firefly Suppression
// =============================================================================

export const regularizePathContribution = Fn( ( [
	contribution, throughput, pathLength, fireflyThreshold,
] ) => {

	const throughputMax = maxComponent( throughput );
	const throughputMin = minComponent( throughput );

	const throughputVariation = throughputMax.add( 0.001 ).div( throughputMin.add( 0.001 ) );

	const variationMultiplier = float( 1.0 ).div(
		float( 1.0 ).add( log( float( 1.0 ).add( throughputVariation ) ).mul( pathLength ).mul( 0.1 ) ),
	);

	const threshold = calculateFireflyThreshold( fireflyThreshold, variationMultiplier, int( pathLength ) );

	return applySoftSuppressionRGB( contribution, threshold, 0.5 );

} );

// =============================================================================
// Main Path Tracing Loop
// =============================================================================

export const Trace = Fn( ( [
	ray, rngState, rayIndex, pixelIndex,
	// BVH / Scene
	bvhTexture, bvhTexSize,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
	// Texture arrays for material sampling
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
	backgroundIntensity, showBackground,
	fireflyThreshold, globalIlluminationIntensity,
	totalTriangleCount, enableEmissiveTriangleSampling,
	// Per-pixel info
	pixelCoord, resolution, frame,
] ) => {

	const radiance = vec3( 0.0 ).toVar( 'tr_radiance' );
	const throughput = vec3( 1.0 ).toVar( 'tr_throughput' );
	const alpha = float( 1.0 ).toVar( 'tr_alpha' );

	// Output data
	const objectNormal = vec3( 0.0 ).toVar( 'tr_objNormal' );
	const objectColor = vec3( 0.0 ).toVar( 'tr_objColor' );
	const objectID = float( - 1000.0 ).toVar( 'tr_objID' );
	const firstHitPoint = ray.origin.toVar( 'tr_firstHitPt' );
	const firstHitDistance = float( 1e10 ).toVar( 'tr_firstHitDst' );

	// Medium stack for transmission
	const mediumStackDepth = int( 0 ).toVar( 'tr_msDepth' );
	const mediumStackPrevIOR = float( 1.0 ).toVar( 'tr_msPrevIOR' );

	// Render state
	const stateTraversals = maxBounceCount.toVar( 'tr_stTrav' );
	const stateTransmissiveTraversals = transmissiveBounces.toVar( 'tr_stTransTrav' );
	const stateRayType = int( RAY_TYPE_CAMERA ).toVar( 'tr_stRayType' );
	const stateIsPrimaryRay = tslBool( true ).toVar( 'tr_stPrimary' );
	const stateActualBounceDepth = int( 0 ).toVar( 'tr_stActDep' );

	// Path state cache fields (managed individually since TSL can't do inout struct)
	const psWeightsComputed = tslBool( false ).toVar( 'tr_psWC' );
	const psClassificationCached = tslBool( false ).toVar( 'tr_psCC' );
	const psMaterialCacheCached = tslBool( false ).toVar( 'tr_psMCC' );
	const psTexturesLoaded = tslBool( false ).toVar( 'tr_psTL' );
	const psPathImportance = float( 0.0 ).toVar( 'tr_psPI' );
	const psLastMaterialIndex = int( - 1 ).toVar( 'tr_psLMI' );

	// Cached classification
	const psCachedClassification = MaterialClassification( {
		isMetallic: false, isRough: false, isSmooth: false,
		isTransmissive: false, hasClearcoat: false, isEmissive: false,
		complexityScore: float( 0.0 ),
	} ).toVar( 'tr_psCachedMC' );

	// Cached BRDF weights
	const psCachedBrdfWeights = BRDFWeights( {
		specular: float( 0.5 ), diffuse: float( 0.5 ),
		sheen: float( 0.0 ), clearcoat: float( 0.0 ),
		transmission: float( 0.0 ), iridescence: float( 0.0 ),
	} ).toVar( 'tr_psCachedBW' );

	// Cached material cache
	const psCachedMaterialCache = MaterialCache( {
		F0: vec3( 0.04 ), NoV: float( 1.0 ),
		diffuseColor: vec3( 0.0 ), specularColor: vec3( 0.0 ),
		isMetallic: false, isPurelyDiffuse: false, hasSpecialFeatures: false,
		alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
		tsAlbedo: vec4( 0.0 ), tsEmissive: vec3( 0.0 ),
		tsMetalness: float( 0.0 ), tsRoughness: float( 0.0 ),
		tsNormal: vec3( 0.0 ), tsHasTextures: false,
		invRoughness: float( 1.0 ), metalFactor: float( 0.5 ),
		iorFactor: float( 1.0 ), maxSheenColor: float( 0.0 ),
	} ).toVar( 'tr_psCachedMC2' );

	// Cached sampling info
	const psCachedSamplingInfo = vec4( 0.0 ).toVar( 'tr_psCSI_placeholder' );

	// Track effective bounces
	const effectiveBounces = int( 0 ).toVar( 'tr_effBounces' );

	// Mutable ray
	const rayOrigin = ray.origin.toVar( 'tr_rayOri' );
	const rayDirection = ray.direction.toVar( 'tr_rayDir' );

	// Main bounce loop
	Loop( { start: int( 0 ), end: maxBounceCount.add( transmissiveBounces ).add( 1 ), type: 'int', condition: '<' }, ( { i: bounceIndex } ) => {

		// Update state
		stateTraversals.assign( maxBounceCount.sub( effectiveBounces ) );
		stateIsPrimaryRay.assign( bounceIndex.equal( int( 0 ) ) );
		stateActualBounceDepth.assign( bounceIndex );

		// Check bounce budget
		If( effectiveBounces.greaterThan( maxBounceCount ), () => {

			Break();

		} );

		// Traverse BVH
		const currentRay = Ray( { origin: rayOrigin, direction: rayDirection } );
		const hitInfo = HitInfo.wrap( traverseBVH(
			currentRay,
			bvhTexture, bvhTexSize,
			triangleTexture, triangleTexSize,
			materialTexture, materialTexSize,
		) ).toVar( 'tr_hitInfo' );

		If( hitInfo.didHit.not(), () => {

			// ENVIRONMENT LIGHTING
			const envColor = sampleBackgroundLighting(
				stateIsPrimaryRay, rayDirection,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				showBackground, backgroundIntensity,
			);
			radiance.addAssign( regularizePathContribution(
				envColor.xyz.mul( throughput ), throughput, float( bounceIndex ), fireflyThreshold,
			) );
			alpha.mulAssign( envColor.a );
			Break();

		} );

		// Get material from texture
		const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialTexture, materialTexSize ) ).toVar( 'tr_material' );

		// Sample all textures in one batch
		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
			material, hitInfo.uv, hitInfo.normal,
		) ).toVar( 'tr_matSamples' );

		// Update material with texture samples
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness );
		material.roughness.assign( clamp( matSamples.roughness, MIN_ROUGHNESS, MAX_ROUGHNESS ) );
		const N = matSamples.normal.toVar( 'tr_N' );

		// Displacement mapping
		If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ).and( material.displacementScale.greaterThan( 0.0 ) ), () => {

			const heightSample = sampleDisplacementMap(
				displacementMaps, material.displacementMapIndex, hitInfo.uv, material.displacementTransform,
			);
			const displacementHeight = heightSample.sub( 0.5 ).mul( material.displacementScale );
			const displacement = N.mul( displacementHeight );
			hitInfo.hitPoint.addAssign( displacement );

			If( material.displacementScale.greaterThan( 0.01 ), () => {

				const displacedNormal = calculateDisplacedNormal( displacementMaps, hitInfo.hitPoint, N, hitInfo.uv, material );
				const blendFactor = clamp( material.displacementScale.mul( 0.5 ), 0.1, 0.8 )
					.mul( float( 1.0 ).sub( material.roughness.mul( 0.5 ) ) ).toVar( 'tr_blendF' );
				N.assign( normalize( mix( N, displacedNormal, blendFactor ) ) );

			} );

		} );

		// Handle transparent materials
		const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
			currentRay, hitInfo.hitPoint, N, material, rngState,
			stateTransmissiveTraversals,
			mediumStackDepth, mediumStackPrevIOR,
		) ).toVar( 'tr_interaction' );

		If( interaction.continueRay, () => {

			const isFreeBounce = tslBool( false ).toVar( 'tr_freeBounce' );

			If( interaction.isTransmissive.and( stateTransmissiveTraversals.greaterThan( int( 0 ) ) ), () => {

				stateTransmissiveTraversals.subAssign( 1 );
				stateRayType.assign( int( RAY_TYPE_TRANSMISSION ) );
				isFreeBounce.assign( tslBool( true ) );

			} ).ElseIf( interaction.isAlphaSkip, () => {

				isFreeBounce.assign( tslBool( true ) );

			} );

			// Update ray and continue
			throughput.mulAssign( interaction.throughput );
			alpha.mulAssign( interaction.alpha );
			rayOrigin.assign( hitInfo.hitPoint.add( rayDirection.mul( 0.001 ) ) );
			rayDirection.assign( interaction.direction );

			stateIsPrimaryRay.assign( tslBool( false ) );

			// Reset material-dependent caches
			psWeightsComputed.assign( tslBool( false ) );
			psMaterialCacheCached.assign( tslBool( false ) );

			If( isFreeBounce.not(), () => {

				effectiveBounces.addAssign( 1 );

			} );

			Continue();

		} );

		// Apply transparency alpha
		alpha.mulAssign( interaction.alpha );

		const randomSample = vec2( RandomValue( rngState ), RandomValue( rngState ) ).toVar( 'tr_randSample' );

		const V = rayDirection.negate().toVar( 'tr_V' );
		material.sheenRoughness.assign( clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS ) );

		// Create material cache if needed
		If( psMaterialCacheCached.not(), () => {

			psCachedMaterialCache.assign( createMaterialCache( N, V, material, matSamples, psCachedClassification ) );
			psMaterialCacheCached.assign( tslBool( true ) );

		} );

		// BRDF sampling
		const brdfDir = vec3( 0.0 ).toVar( 'tr_brdfDir' );
		const brdfValue = vec3( 0.0 ).toVar( 'tr_brdfVal' );
		const brdfPdf = float( 0.0 ).toVar( 'tr_brdfPdf' );

		// Handle clearcoat
		If( material.clearcoat.greaterThan( 0.0 ), () => {

			const ccResult = ClearcoatResult.wrap( sampleClearcoat(
				currentRay, hitInfo, material, randomSample, rngState,
			) );
			brdfDir.assign( ccResult.L );
			brdfValue.assign( ccResult.brdf );
			brdfPdf.assign( ccResult.pdf );

		} ).Else( () => {

			const brdfSample = DirectionSample.wrap( generateSampledDirection(
				V, N, material, hitInfo.materialIndex, randomSample, rngState,
				psClassificationCached, psLastMaterialIndex, psCachedClassification,
				psWeightsComputed, psCachedBrdfWeights,
				psMaterialCacheCached, psCachedMaterialCache,
			) );
			brdfDir.assign( brdfSample.direction );
			brdfValue.assign( brdfSample.value );
			brdfPdf.assign( brdfSample.pdf );

			// Update cache state after generateSampledDirection
			psClassificationCached.assign( tslBool( true ) );
			psLastMaterialIndex.assign( hitInfo.materialIndex );
			psWeightsComputed.assign( tslBool( true ) );

		} );

		// 1. EMISSIVE CONTRIBUTION
		If( length( matSamples.emissive ).greaterThan( 0.0 ), () => {

			radiance.addAssign( matSamples.emissive.mul( throughput ) );

		} );

		// 2. DIRECT LIGHTING
		const directLight = calculateDirectLightingUnified(
			hitInfo.hitPoint, N, material,
			V,
			brdfDir, brdfPdf, brdfValue,
			rayIndex, bounceIndex, rngState,
			directionalLightsBuffer, numDirectionalLights,
			areaLightsBuffer, numAreaLights,
			pointLightsBuffer, numPointLights,
			spotLightsBuffer, numSpotLights,
			bvhTexture, bvhTexSize,
			triangleTexture, triangleTexSize,
			materialTexture, materialTexSize,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight,
		);

		radiance.addAssign( regularizePathContribution(
			directLight.mul( throughput ), throughput, float( bounceIndex ), fireflyThreshold,
		) );

		// Get importance sampling info with caching
		If( psWeightsComputed.not().or( bounceIndex.equal( int( 0 ) ) ), () => {

			// Update classification first
			psCachedClassification.assign( MaterialClassification.wrap( getOrCreateMaterialClassification(
				material, hitInfo.materialIndex,
				psClassificationCached, psLastMaterialIndex, psCachedClassification,
			) ) );
			psClassificationCached.assign( tslBool( true ) );
			psLastMaterialIndex.assign( hitInfo.materialIndex );

		} );

		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, psCachedClassification,
			environmentIntensity, useEnvMapIS, enableEnvironmentLight,
		) );

		// 3. INDIRECT LIGHTING
		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfDir, brdfPdf, brdfValue,
			rayIndex, bounceIndex,
			rngState,
			samplingInfo,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight, useEnvMapIS,
			globalIlluminationIntensity,
		) );
		throughput.mulAssign( indirectResult.throughput.mul( indirectResult.misWeight ) );

		// Early ray termination
		const maxThroughput = max( max( throughput.x, throughput.y ), throughput.z );
		If( maxThroughput.lessThan( 0.001 ).and( bounceIndex.greaterThan( int( 2 ) ) ), () => {

			Break();

		} );

		// Prepare for next bounce
		rayOrigin.assign( hitInfo.hitPoint.add( N.mul( 0.001 ) ) );
		rayDirection.assign( indirectResult.direction );

		stateIsPrimaryRay.assign( tslBool( false ) );

		// Determine ray type
		If( material.metalness.greaterThan( 0.7 ).and( material.roughness.lessThan( 0.3 ) ), () => {

			stateRayType.assign( int( RAY_TYPE_REFLECTION ) );

		} ).ElseIf( material.transmission.greaterThan( 0.5 ), () => {

			stateRayType.assign( int( RAY_TYPE_TRANSMISSION ) );

		} ).Else( () => {

			stateRayType.assign( int( RAY_TYPE_DIFFUSE ) );

		} );

		// Store first hit data for G-buffer
		If( bounceIndex.equal( int( 0 ) ).and( hitInfo.didHit ), () => {

			objectNormal.assign( N );
			objectColor.assign( material.color.xyz );
			objectID.assign( float( hitInfo.materialIndex ) );
			firstHitPoint.assign( hitInfo.hitPoint );
			firstHitDistance.assign( hitInfo.dst );

		} );

		// 4. RUSSIAN ROULETTE
		const rrSurvivalProb = handleRussianRoulette(
			stateActualBounceDepth, throughput, material, hitInfo.materialIndex,
			rayDirection, rngState,
			psClassificationCached, psLastMaterialIndex, psCachedClassification,
			psWeightsComputed, psPathImportance,
			enableEnvironmentLight, useEnvMapIS,
		);
		If( rrSurvivalProb.lessThanEqual( 0.0 ), () => {

			Break();

		} );
		// Apply throughput compensation
		throughput.divAssign( rrSurvivalProb );

		// Increment effective bounces
		effectiveBounces.addAssign( 1 );

	} );

	return TraceResult( {
		radiance: vec4( radiance, alpha ),
		objectNormal,
		objectColor,
		objectID,
		firstHitPoint,
		firstHitDistance,
	} );

} );
