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
	wgslFn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	bool as tslBool,
	max,
	min,
	exp,
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
	sampler,
} from 'three/tsl';

import { struct } from './structProxy.js';

import {
	PI_INV,
	MIN_ROUGHNESS,
	MAX_ROUGHNESS,
	MIN_CLEARCOAT_ROUGHNESS,
	MIN_PDF,
	maxComponent,
	classifyMaterial,
	constructTBN,
	calculateFireflyThreshold,
	applySoftSuppressionRGB,
	getMaterial,
	powerHeuristic,
} from './Common.js';
import {
	DirectionSample,
	MaterialClassification,
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
import { sampleEnvironment, sampleEquirect } from './Environment.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { refineDisplacedIntersection, DisplacementResult } from './Displacement.js';
import { handleMaterialTransparency, MaterialInteractionResult, sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import {
	SheenDistribution,
	calculateVNDFPDF,
	calculateBRDFWeights,
	createMaterialCache,
	getImportanceSamplingInfo,
} from './MaterialProperties.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { dielectricF0 } from './Fresnel.js';
import {
	ImportanceSampleCosine,
	ImportanceSampleGGX,
	sampleGGXVNDF,
} from './MaterialSampling.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from './LightsSampling.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult } from './LightsCore.js';
import { calculateEmissiveTriangleContribution, calculateEmissiveLightPdf, EmissiveSample } from './EmissiveSampling.js';
import { sampleLightBVHTriangle } from './LightBVHSampling.js';
import { traceShadowRay, calculateRayOffset } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';

// =============================================================================
// Constants
// =============================================================================

// Ray type enumeration
const RAY_TYPE_CAMERA = 0;
const RAY_TYPE_REFLECTION = 1;
const RAY_TYPE_TRANSMISSION = 2;
const RAY_TYPE_DIFFUSE = 3;

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

	const result = cachedClassification.toVar();

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

	const resultDirection = vec3( 0.0 ).toVar();
	const resultValue = vec3( 0.0 ).toVar();
	const resultPdf = float( 0.0 ).toVar();

	// Get material classification (cached or computed)
	const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
		material, materialIndex,
		classificationCached, lastMaterialIndex, cachedClassification,
	) ).toVar();

	// Compute BRDF weights
	const weights = cachedBrdfWeights.toVar();

	If( weightsComputed.not(), () => {

		If( materialCacheCached, () => {

			weights.assign( calculateBRDFWeights( material, mc, cachedMaterialCache ) );

		} ).Else( () => {

			// Create minimal temporary cache
			const tempCache = MaterialCache( {
				F0: dielectricF0( material.ior ),
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
			} ).toVar();
			weights.assign( calculateBRDFWeights( material, mc, tempCache ) );

		} );

	} );

	const rand = xi.x.toVar();
	const directionSample = vec2( xi.y, RandomValue( rngState ) ).toVar();
	const H = vec3( 0.0 ).toVar();

	// Cumulative probability approach for sampling selection
	const cumulativeDiffuse = weights.diffuse.toVar();
	const cumulativeSpecular = cumulativeDiffuse.add( weights.specular ).toVar();
	const cumulativeSheen = cumulativeSpecular.add( weights.sheen ).toVar();
	const cumulativeClearcoat = cumulativeSheen.add( weights.clearcoat ).toVar();

	const sampled = tslBool( false ).toVar();

	// Diffuse sampling
	If( rand.lessThan( cumulativeDiffuse ).and( sampled.not() ), () => {

		resultDirection.assign( ImportanceSampleCosine( { N, xi: directionSample } ) );
		const NoL = clamp( dot( N, resultDirection ), 0.0, 1.0 );
		resultPdf.assign( NoL.mul( PI_INV ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	const NoV = clamp( dot( N, V ), 0.001, 1.0 ).toVar();

	// Specular sampling
	If( rand.lessThan( cumulativeSpecular ).and( sampled.not() ), () => {

		const TBN = constructTBN( { N } );
		const localV = TBN.transpose().mul( V ).toVar();

		// VNDF sampling
		const localH = sampleGGXVNDF( { V: localV, roughness: material.roughness, Xi: xi } );
		H.assign( TBN.mul( localH ) );

		const NoH = clamp( dot( N, H ), 0.001, 1.0 );

		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, material.roughness ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	// Sheen sampling
	If( rand.lessThan( cumulativeSheen ).and( sampled.not() ), () => {

		H.assign( ImportanceSampleGGX( { N, roughness: material.sheenRoughness, Xi: xi } ) );
		const NoH = clamp( dot( N, H ), 0.001, 1.0 );
		const VoH = clamp( dot( V, H ), 0.001, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		const NoL = dot( N, resultDirection ).toVar();

		// Reject directions below the surface - fall back to diffuse
		If( NoL.lessThanEqual( 0.0 ), () => {

			resultDirection.assign( ImportanceSampleCosine( { N, xi } ) );
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
		H.assign( ImportanceSampleGGX( { N, roughness: clearcoatRoughness, Xi: xi } ) );
		const NoH = clamp( dot( N, H ), 0.0, 1.0 );
		resultDirection.assign( reflect( V.negate(), H ) );
		resultPdf.assign( calculateVNDFPDF( NoH, NoV, clearcoatRoughness ) );
		resultPdf.assign( max( resultPdf, MIN_PDF ) );
		resultValue.assign( evaluateMaterialResponse( V, resultDirection, N, material ) );
		sampled.assign( tslBool( true ) );

	} );

	// Transmission sampling (fallback)
	If( sampled.not(), () => {

		const entering = dot( V, N ).greaterThan( 0.0 ).toVar();
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

	const throughputStrength = max( maxComponent( { v: throughput } ), 0.0 ).toVar();

	// Use cached material classification
	const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
		material, materialIndex,
		classificationCached, lastMaterialIndex, cachedClassification,
	) ).toVar();

	// Enhanced material importance with interaction bonuses
	const materialImportance = mc.complexityScore.toVar();

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
	const directionImportance = float( 0.5 ).toVar();

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

	const result = float( 1.0 ).toVar();

	// Always continue for first few bounces
	If( depth.greaterThanEqual( int( 3 ) ), () => {

		const throughputStrength = max( maxComponent( { v: throughput } ), 0.0 ).toVar();

		// Energy-conserving early termination for very low throughput paths
		If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( int( 4 ) ) ), () => {

			const lowThroughputProb = max( throughputStrength.mul( 125.0 ), 0.01 );
			const rrSample = RandomValue( rngState );
			result.assign( select( rrSample.lessThan( lowThroughputProb ), lowThroughputProb, float( 0.0 ) ) );

		} ).Else( () => {

			// Get classification
			const mc = MaterialClassification.wrap( getOrCreateMaterialClassification(
				material, materialIndex,
				classificationCached, lastMaterialIndex, cachedClassification,
			) ).toVar();

			const materialImportance = mc.complexityScore.toVar();

			// Boost importance for special materials — depth hierarchy reflects
			// how many bounces each transport type physically needs:
			// Specular metals: deepest (mirror chains carry energy efficiently)
			// Transmissive: deep (caustics, internal reflections)
			// Emissive: shallowest (emission already collected, continuation rarely valuable)
			If( mc.isMetallic.and( mc.isSmooth ).and( depth.lessThan( int( 7 ) ) ), () => {

				materialImportance.addAssign( 0.3 );

			} );
			If( mc.isTransmissive.and( depth.lessThan( int( 6 ) ) ), () => {

				materialImportance.addAssign( 0.25 );

			} );
			If( mc.isEmissive.and( depth.lessThan( int( 4 ) ) ), () => {

				materialImportance.addAssign( 0.15 );

			} );
			materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

			// Dynamic minimum bounces
			const minBounces = int( 3 ).toVar();
			If( materialImportance.greaterThan( 0.6 ), () => {

				minBounces.assign( 5 );

			} ).ElseIf( materialImportance.greaterThan( 0.4 ), () => {

				minBounces.assign( 4 );

			} );

			If( depth.lessThan( minBounces ), () => {

				result.assign( 1.0 );

			} ).Else( () => {

				// Path importance — used across all depth ranges
				const pathContribution = float( 0.0 ).toVar();

				If( classificationCached.and( weightsComputed ), () => {

					pathContribution.assign( pathImportance );

				} ).Else( () => {

					pathContribution.assign( estimatePathContribution(
						throughput, rayDirection, material, materialIndex,
						classificationCached, lastMaterialIndex, cachedClassification,
						enableEnvironmentLight, useEnvMapIS,
					) );

				} );

				// Smooth adaptive continuation probability (no discrete depth brackets)
				// Early behavior: throughput + material driven, generous
				const earlyProb = clamp(
					materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).mul( 1.2 ),
					0.15, 0.95,
				);
				// Deep behavior: aggressive termination, material-aware floor
				const deepProb = clamp(
					throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ),
					0.03, 0.6,
				);

				// Smooth blend from early → deep using depth relative to minBounces
				// At minBounces: t=0 (earlyProb), at minBounces+10: t=1 (deepProb)
				const depthT = clamp( float( depth.sub( minBounces ) ).div( 10.0 ), 0.0, 1.0 );
				const rrProb = mix( earlyProb, deepProb, depthT ).toVar();

				// Mix in path contribution for direction-aware survival
				rrProb.assign( mix( rrProb, max( rrProb, pathContribution ), 0.4 ) );

				// Material-specific boosts
				If( materialImportance.greaterThan( 0.5 ), () => {

					const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 );
					rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

				} );

				// Exponential depth decay
				const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) );
				const depthFactor = exp( float( depth.sub( minBounces ) ).negate().mul( depthDecay ) );
				rrProb.mulAssign( depthFactor );

				// Minimum probability floor
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
	const envColor = vec4( 0.0 ).toVar();

	If( isPrimaryRay.and( showBackground.not() ), () => {

		// Return zero
		envColor.assign( vec4( 0.0 ) );

	} ).Else( () => {

		const sampled = sampleEnvironment( {
			tex: envTexture, samp: sampler( envTexture ), direction, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
		} );

		If( isPrimaryRay, () => {

			envColor.assign( sampled.mul( backgroundIntensity ) );

		} ).Else( () => {

			envColor.assign( sampled );

		} );

	} );

	return envColor;

} );

// =============================================================================
// Firefly Suppression
// =============================================================================

export const regularizePathContribution = /*@__PURE__*/ wgslFn( `
	fn regularizePathContribution( contribution: vec3f, pathLength: f32, fireflyThreshold: f32, frame: i32 ) -> vec3f {
		let threshold = calculateFireflyThreshold( fireflyThreshold, i32( pathLength ), frame );
		return applySoftSuppressionRGB( contribution, threshold, 0.5f );
	}
`, [ calculateFireflyThreshold, applySoftSuppressionRGB ] );

// =============================================================================
// Main Path Tracing Loop
// =============================================================================

export const Trace = Fn( ( [
	ray, rngState, rayIndex, pixelIndex,
	// BVH / Scene
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
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
	backgroundIntensity, showBackground, transparentBackground,
	fireflyThreshold, globalIlluminationIntensity,
	totalTriangleCount, enableEmissiveTriangleSampling,
	emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
	lightBVHBuffer, lightBVHNodeCount,
	// Per-pixel info
	pixelCoord, resolution, frame,
] ) => {

	const radiance = vec3( 0.0 ).toVar();
	const throughput = vec3( 1.0 ).toVar();
	const alpha = float( 1.0 ).toVar();
	const hasHitOpaqueSurface = tslBool( false ).toVar(); // Tracks if ray chain has hit non-transmissive geometry
	const prevBouncePdf = float( 0.0 ).toVar(); // 0 = camera ray (skip MIS for directly visible emissive)

	// Output data
	const objectNormal = vec3( 0.0 ).toVar();
	const objectColor = vec3( 0.0 ).toVar();
	const objectID = float( - 1000.0 ).toVar();
	const firstHitPoint = ray.origin.toVar();
	const firstHitDistance = float( 1e10 ).toVar();

	// Medium stack for transmission (per-slot IOR, slots 1-3 for nested media, depth 0 = air)
	const mediumStackDepth = int( 0 ).toVar();
	const mediumStack_ior_1 = float( 1.0 ).toVar();
	const mediumStack_ior_2 = float( 1.0 ).toVar();
	const mediumStack_ior_3 = float( 1.0 ).toVar();

	// Render state
	const stateTraversals = maxBounceCount.toVar();
	const stateTransmissiveTraversals = transmissiveBounces.toVar();
	const stateRayType = int( RAY_TYPE_CAMERA ).toVar();
	const stateIsPrimaryRay = tslBool( true ).toVar();


	// Path state cache fields (managed individually since TSL can't do inout struct)
	const psWeightsComputed = tslBool( false ).toVar();
	const psClassificationCached = tslBool( false ).toVar();
	const psMaterialCacheCached = tslBool( false ).toVar();
	const psTexturesLoaded = tslBool( false ).toVar();
	const psPathImportance = float( 0.0 ).toVar();
	const psLastMaterialIndex = int( - 1 ).toVar();

	// Cached classification
	const psCachedClassification = MaterialClassification( {
		isMetallic: false, isRough: false, isSmooth: false,
		isTransmissive: false, hasClearcoat: false, isEmissive: false,
		complexityScore: float( 0.0 ),
	} ).toVar();

	// Cached BRDF weights
	const psCachedBrdfWeights = BRDFWeights( {
		specular: float( 0.5 ), diffuse: float( 0.5 ),
		sheen: float( 0.0 ), clearcoat: float( 0.0 ),
		transmission: float( 0.0 ), iridescence: float( 0.0 ),
	} ).toVar();

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
	} ).toVar();

	// Track effective bounces
	const effectiveBounces = int( 0 ).toVar();

	// Mutable ray
	const rayOrigin = ray.origin.toVar();
	const rayDirection = ray.direction.toVar();

	// Main bounce loop
	Loop( { start: int( 0 ), end: maxBounceCount.add( transmissiveBounces ).add( 1 ), type: 'int', condition: '<' }, ( { i: bounceIndex } ) => {

		// Update state
		stateTraversals.assign( maxBounceCount.sub( effectiveBounces ) );
		stateIsPrimaryRay.assign( bounceIndex.equal( int( 0 ) ) );


		// Check bounce budget
		If( effectiveBounces.greaterThan( maxBounceCount ), () => {

			Break();

		} );

		// Non-compounding GI intensity: applied per-bounce to radiance, not throughput
		const giScale = select( bounceIndex.greaterThan( int( 0 ) ), globalIlluminationIntensity, float( 1.0 ) );

		// Traverse BVH
		const currentRay = Ray( { origin: rayOrigin, direction: rayDirection } );
		const hitInfo = HitInfo.wrap( traverseBVH(
			currentRay,
			bvhBuffer,
			triangleBuffer,
			materialBuffer,
		) ).toVar();

		If( hitInfo.didHit.not(), () => {

			// ENVIRONMENT LIGHTING
			const envColor = sampleBackgroundLighting(
				stateIsPrimaryRay, rayDirection,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				showBackground, backgroundIntensity,
			);

			// MIS weight for implicit environment hit — prevents double-counting with NEE.
			// Primary rays and camera rays (prevBouncePdf == 0) get full weight.
			// Secondary rays use power heuristic between the scatter PDF and the
			// environment importance-sampling PDF, mirroring the emissive MIS at line ~978.
			const envMisWeight = float( 1.0 ).toVar();
			If( prevBouncePdf.greaterThan( 0.0 ).and( enableEnvironmentLight ).and( useEnvMapIS ), () => {

				const envEval = sampleEquirect(
					envTexture, rayDirection, envMatrix, envTotalSum, envResolution,
				);
				const envPdf = envEval.w.toVar();
				If( envPdf.greaterThan( 0.0 ), () => {

					envMisWeight.assign( powerHeuristic( { pdf1: prevBouncePdf, pdf2: envPdf } ) );

				} );

			} );

			radiance.addAssign( regularizePathContribution( {
				contribution: envColor.xyz.mul( throughput ).mul( giScale ).mul( envMisWeight ), pathLength: float( bounceIndex ), fireflyThreshold, frame: int( frame ),
			} ) );

			// Transparent background: only transparent if ray escaped WITHOUT hitting opaque geometry first.
			// Secondary bounces from opaque surfaces escaping to env should NOT make the pixel transparent.
			If( transparentBackground.and( hasHitOpaqueSurface.not() ), () => {

				alpha.assign( 0.0 );

			} ).ElseIf( transparentBackground.not(), () => {

				alpha.mulAssign( envColor.a );

			} );

			Break();

		} );

		// Get material from texture
		const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialBuffer ) ).toVar();

		// Tessellation-free displacement — refine intersection with ray-height field marching
		const samplingUV = hitInfo.uv.toVar();
		const displacedNormal = hitInfo.normal.toVar();

		If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ).and( material.displacementScale.greaterThan( 0.0 ) ), () => {

			const dispResult = DisplacementResult.wrap( refineDisplacedIntersection(
				currentRay, hitInfo, triangleBuffer, displacementMaps, material, bounceIndex,
			) ).toVar();
			samplingUV.assign( dispResult.uv );
			displacedNormal.assign( dispResult.normal );
			hitInfo.hitPoint.assign( dispResult.hitPoint );

		} );

		// Sample all textures using displacement-refined UVs
		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
			material, samplingUV, hitInfo.normal,
		) ).toVar();

		// Update material with texture samples
		material.color.assign( matSamples.albedo );
		material.metalness.assign( clamp( matSamples.metalness, 0.0, 1.0 ) );
		material.roughness.assign( clamp( matSamples.roughness, MIN_ROUGHNESS, MAX_ROUGHNESS ) );

		// Blend displaced normal with texture normal map — displacement provides macro shape, normal map adds micro detail
		const N = matSamples.normal.toVar();
		If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ).and( material.displacementScale.greaterThan( 0.0 ) ), () => {

			N.assign( normalize( displacedNormal.add( matSamples.normal.sub( hitInfo.normal ) ) ) );

		} );

		// Compute current and previous medium IOR from stack for transmission
		const currentMediumIOR = float( 1.0 ).toVar();
		const previousMediumIOR = float( 1.0 ).toVar();
		If( mediumStackDepth.equal( int( 1 ) ), () => {

			currentMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( int( 2 ) ), () => {

			currentMediumIOR.assign( mediumStack_ior_2 );
			previousMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( int( 3 ) ), () => {

			currentMediumIOR.assign( mediumStack_ior_3 );
			previousMediumIOR.assign( mediumStack_ior_2 );

		} );

		// Handle transparent materials
		const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
			currentRay, hitInfo.hitPoint, N, material, rngState,
			stateTransmissiveTraversals,
			currentMediumIOR, previousMediumIOR,
		) ).toVar();

		If( interaction.continueRay, () => {

			const isFreeBounce = tslBool( false ).toVar();

			If( interaction.isTransmissive.and( stateTransmissiveTraversals.greaterThan( int( 0 ) ) ), () => {

				stateTransmissiveTraversals.subAssign( 1 );
				stateRayType.assign( int( RAY_TYPE_TRANSMISSION ) );
				isFreeBounce.assign( tslBool( true ) );

				// Update medium stack only if we actually transmitted (not TIR/reflection)
				If( interaction.didReflect.not(), () => {

					If( interaction.entering, () => {

						// Push new medium onto stack
						If( mediumStackDepth.lessThan( int( 3 ) ), () => {

							mediumStackDepth.addAssign( 1 );

							If( mediumStackDepth.equal( int( 1 ) ), () => {

								mediumStack_ior_1.assign( material.ior );

							} ).ElseIf( mediumStackDepth.equal( int( 2 ) ), () => {

								mediumStack_ior_2.assign( material.ior );

							} ).ElseIf( mediumStackDepth.equal( int( 3 ) ), () => {

								mediumStack_ior_3.assign( material.ior );

							} );

						} );

					} ).Else( () => {

						// Pop medium from stack
						If( mediumStackDepth.greaterThan( int( 0 ) ), () => {

							mediumStackDepth.subAssign( 1 );

						} );

					} );

				} );

			} ).ElseIf( interaction.isAlphaSkip, () => {

				isFreeBounce.assign( tslBool( true ) );

			} );

			// Update ray and continue
			throughput.mulAssign( interaction.throughput );

			// Transparent background: defer alpha decision to final hit/miss
			// Normal mode: apply material transparency alpha (blend/mask/transmission)
			If( transparentBackground.not(), () => {

				alpha.mulAssign( interaction.alpha );

			} );

			// For reflection (Fresnel/TIR): offset along the geometric normal to stay on the same side
			// For transmission: offset along the old ray direction to push through the surface
			const reflectOffsetDir = select( interaction.entering, N, N.negate() );
			const offsetDir = select( interaction.didReflect, reflectOffsetDir, rayDirection );
			rayOrigin.assign( hitInfo.hitPoint.add( offsetDir.mul( 0.001 ) ) );
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

		// Apply transparency alpha (skip in transparent background mode — alpha is binary hit/miss)
		If( transparentBackground.not(), () => {

			alpha.mulAssign( interaction.alpha );

		} );

		// Ray hit non-transmissive geometry — lock alpha at 1.0 for subsequent bounces
		hasHitOpaqueSurface.assign( tslBool( true ) );

		const randomSample = getRandomSample( pixelCoord, rayIndex, bounceIndex, rngState, int( - 1 ), resolution, frame ).toVar();

		const V = rayDirection.negate().toVar();
		material.sheenRoughness.assign( clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS ) );

		// Create material cache if needed
		If( psMaterialCacheCached.not(), () => {

			psCachedMaterialCache.assign( createMaterialCache( N, V, material, matSamples, psCachedClassification ) );
			psMaterialCacheCached.assign( tslBool( true ) );

		} );

		// BRDF sampling
		const brdfDir = vec3( 0.0 ).toVar();
		const brdfValue = vec3( 0.0 ).toVar();
		const brdfPdf = float( 0.0 ).toVar();

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

			// Sync psCachedClassification for downstream consumers (importance sampling, Russian roulette).
			// generateSampledDirection computed the correct classification internally via materialIndex
			// guard, but TSL Fn can't write back to the caller's variable — update it here.
			If( psLastMaterialIndex.notEqual( hitInfo.materialIndex ).or( psClassificationCached.not() ), () => {

				psCachedClassification.assign( classifyMaterial(
					material.metalness, material.roughness,
					material.transmission, material.clearcoat,
					material.emissive,
				) );

			} );

			// Update cache state after generateSampledDirection
			psClassificationCached.assign( tslBool( true ) );
			psLastMaterialIndex.assign( hitInfo.materialIndex );
			psWeightsComputed.assign( tslBool( true ) );

		} );

		// 1. EMISSIVE CONTRIBUTION (with MIS when direct emissive sampling is active)
		If( length( matSamples.emissive ).greaterThan( 0.0 ), () => {

			const emissiveMISWeight = float( 1.0 ).toVar();

			// Apply MIS when emissive direct sampling is active and this isn't a camera ray hit
			If( enableEmissiveTriangleSampling.equal( int( 1 ) )
				.and( emissiveTriangleCount.greaterThan( int( 0 ) ) )
				.and( prevBouncePdf.greaterThan( 0.0 ) ), () => {

				const lightPdf = calculateEmissiveLightPdf(
					hitInfo.triangleIndex, hitInfo.dst, rayDirection, rayOrigin,
					triangleBuffer, materialBuffer, emissiveTotalPower,
				);

				emissiveMISWeight.assign(
					powerHeuristic( { pdf1: prevBouncePdf, pdf2: lightPdf } )
				);

			} );

			radiance.addAssign( regularizePathContribution( {
				contribution: matSamples.emissive.mul( throughput ).mul( giScale ).mul( emissiveMISWeight ),
				pathLength: float( bounceIndex ), fireflyThreshold, frame: int( frame ),
			} ) );

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
			bvhBuffer,
			triangleBuffer,
			materialBuffer,
			envTexture, environmentIntensity, envMatrix,
			envMarginalWeights, envConditionalWeights,
			envTotalSum, envResolution,
			enableEnvironmentLight,
		);

		radiance.addAssign( regularizePathContribution( {
			contribution: directLight.mul( throughput ).mul( giScale ), pathLength: float( bounceIndex ), fireflyThreshold, frame: int( frame ),
		} ) );

		// 2b. EMISSIVE TRIANGLE DIRECT LIGHTING
		If( enableEmissiveTriangleSampling.equal( int( 1 ) ).and( emissiveTriangleCount.greaterThan( int( 0 ) ) ), () => {

			// Wrapper binding BVH params (EmissiveSampling expects 4-param callback)
			const traceShadowRayWrapped = Fn( ( [ origin, dir, maxDist, rs ] ) => {

				return traceShadowRay( origin, dir, maxDist, rs, traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer );

			} );

			If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

				// Use Light BVH for spatially-aware importance sampling
				const emissiveSample = EmissiveSample.wrap( sampleLightBVHTriangle(
					hitInfo.hitPoint, N,
					rngState,
					lightBVHBuffer,
					emissiveTriangleBuffer,
					triangleBuffer,
				) );

				// Skip for very rough diffuse surfaces on secondary bounces
				const skip = bounceIndex.greaterThan( int( 1 ) )
					.and( material.roughness.greaterThan( 0.9 ) )
					.and( material.metalness.lessThan( 0.1 ) );

				If( skip.not().and( emissiveSample.valid ).and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

					const NoL = max( float( 0.0 ), dot( N, emissiveSample.direction ) );

					If( NoL.greaterThan( 0.0 ), () => {

						const rayOffset = calculateRayOffset( hitInfo.hitPoint, N, material );
						const rayOrigin = hitInfo.hitPoint.add( rayOffset );
						const shadowDist = emissiveSample.distance.sub( 0.001 );
						const visibility = traceShadowRayWrapped( rayOrigin, emissiveSample.direction, shadowDist, rngState );

						If( visibility.greaterThan( 0.0 ), () => {

							const brdfValue = evaluateMaterialResponse( V, emissiveSample.direction, N, material );
							const brdfPdf = calculateMaterialPDF( V, emissiveSample.direction, N, material );
							const misWeight = select(
								brdfPdf.greaterThan( 0.0 ),
								powerHeuristic( { pdf1: emissiveSample.pdf, pdf2: brdfPdf } ),
								float( 1.0 )
							);

							const emissiveLight = emissiveSample.emission
								.mul( brdfValue ).mul( NoL )
								.div( emissiveSample.pdf )
								.mul( visibility ).mul( emissiveBoost ).mul( misWeight );

							radiance.addAssign( regularizePathContribution( {
								contribution: emissiveLight.mul( throughput ).mul( giScale ), pathLength: float( bounceIndex ), fireflyThreshold, frame: int( frame ),
							} ) );

						} );

					} );

				} );

			} ).Else( () => {

				// Fallback: flat CDF importance sampling
				const emissiveLight = calculateEmissiveTriangleContribution(
					hitInfo.hitPoint, N, V, material,
					totalTriangleCount, bounceIndex, rngState,
					emissiveBoost,
					emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower,
					triangleBuffer,
					traceShadowRayWrapped,
					evaluateMaterialResponse,
					calculateRayOffset,
				);

				radiance.addAssign( regularizePathContribution( {
					contribution: emissiveLight.mul( throughput ).mul( giScale ), pathLength: float( bounceIndex ), fireflyThreshold, frame: int( frame ),
				} ) );

			} );

		} );

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
		) );
		throughput.mulAssign( indirectResult.throughput );

		// Prepare for next bounce
		rayOrigin.assign( hitInfo.hitPoint.add( N.mul( 0.001 ) ) );
		rayDirection.assign( indirectResult.direction );
		prevBouncePdf.assign( indirectResult.combinedPdf );

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
			bounceIndex, throughput, material, hitInfo.materialIndex,
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

		// Reset per-bounce caches so next iteration recomputes for its own material
		psWeightsComputed.assign( tslBool( false ) );
		psMaterialCacheCached.assign( tslBool( false ) );

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
