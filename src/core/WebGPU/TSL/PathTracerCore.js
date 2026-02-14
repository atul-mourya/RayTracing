/**
 * PathTracerCore_v2.js - Pure TSL Path Tracing Core
 *
 * True port of pathtracer_core.fs from GLSL to pure TSL/WGSL.
 * NO wgslFn() - uses only Fn(), If(), Loop(), .toVar(), .assign()
 *
 * Matches pathtracer_core.fs logic exactly:
 *  - estimatePathContribution
 *  - handleRussianRoulette
 *  - sampleBackgroundLighting
 *  - regularizePathContribution
 *  - Trace (main loop): traversal → textures → displacement → transparency →
 *    BRDF sample → emissive → direct light → indirect light → G-buffer → RR
 */

import {
	Fn,
	float,
	vec3,
	vec4,
	vec2,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	sqrt,
	abs,
	exp,
	log,
	clamp,
	mix,
	dot,
	normalize,
	length,
	reflect,
	refract,
	If,
	Loop,
	Break,
	Continue,
	texture,
	select,
	smoothstep
} from 'three/tsl';

import { traverseBVH, traverseBVHShadow } from './BVHTraversal.js';
import { RandomValue } from './Random.js';
import {
	maxComponent,
	minComponent,
	luminance,
	buildOrthonormalBasis,
	localToWorld,
	fresnelSchlick,
	distributionGGX,
	geometrySmith,
	importanceSampleCosine,
	importanceSampleGGX
} from './Common.js';
import { sampleEnvironmentDirection } from './Environment.js';
import { calculateDirectLightingUnified } from './LightsSampling.js';
import {
	DirectionSample,
	MaterialClassification,
	pathTracerOutputStruct
} from './Struct.js';

// ================================================================================
// CONSTANTS  (match pathtracer_core.fs / struct.fs)
// ================================================================================

const PI = Math.PI;
const PI_INV = 1.0 / PI;
const TWO_PI = 2.0 * PI;
const MIN_ROUGHNESS = 0.045;
const MAX_ROUGHNESS = 1.0;

// Ray type enumeration (match GLSL)
const RAY_TYPE_CAMERA = 0;
const RAY_TYPE_REFLECTION = 1;
const RAY_TYPE_TRANSMISSION = 2;
const RAY_TYPE_DIFFUSE = 3;
const RAY_TYPE_SHADOW = 4;

// Data layout constants (match GLSL / CLAUDE.md)
const TRI_STRIDE = 8; // 8 vec4s per triangle
const MATERIAL_STRIDE = 11; // 11 vec4s per material

// ================================================================================
// TEXTURE DATA ACCESS
// ================================================================================

const getDataFromTexture = Fn( ( [ tex, texSize, itemIndex, slotIndex, stride ] ) => {

	const baseIndex = itemIndex.mul( stride ).add( slotIndex );
	const x = baseIndex.mod( texSize.x );
	const y = baseIndex.div( texSize.x );
	const uv = vec2( x, y ).add( 0.5 ).div( vec2( texSize ) );
	return texture( tex, uv );

} );

// ================================================================================
// MATERIAL CLASSIFICATION
// ================================================================================

/**
 * Classify material properties — matches GLSL classifyMaterial / getOrCreateMaterialClassification.
 */
export const classifyMaterial = Fn( ( [ color, metalness, roughness, transmission, clearcoat, emissive ] ) => {

	const isMetallic = metalness.greaterThan( 0.7 ).toVar( 'isMetallic' );
	const isRough = roughness.greaterThan( 0.8 ).toVar( 'isRough' );
	const isSmooth = roughness.lessThan( 0.3 ).toVar( 'isSmooth' );
	const isTransmissive = transmission.greaterThan( 0.5 ).toVar( 'isTransmissive' );
	const hasClearcoat = clearcoat.greaterThan( 0.5 ).toVar( 'hasClearcoat' );
	const isEmissive = luminance( emissive ).greaterThan( 0.0 ).toVar( 'isEmissive' );

	const complexityScore = float( 0.0 ).toVar( 'complexityScore' );
	complexityScore.addAssign( metalness.mul( 0.2 ) );
	complexityScore.addAssign( float( 1.0 ).sub( roughness ).mul( 0.15 ) );
	complexityScore.addAssign( transmission.mul( 0.25 ) );
	complexityScore.addAssign( clearcoat.mul( 0.15 ) );

	If( isMetallic.and( isSmooth ), () => {

		complexityScore.addAssign( 0.1 );

	} );
	If( isTransmissive.and( hasClearcoat ), () => {

		complexityScore.addAssign( 0.08 );

	} );
	If( isEmissive, () => {

		complexityScore.addAssign( 0.07 );

	} );

	complexityScore.assign( clamp( complexityScore, 0.0, 1.0 ) );

	return MaterialClassification( { isMetallic, isRough, isSmooth, isTransmissive, hasClearcoat, isEmissive, complexityScore } );

} );

// ================================================================================
// PATH CONTRIBUTION ESTIMATION
// ================================================================================

/**
 * Matches GLSL estimatePathContribution().
 * enableEnvironmentLight / useEnvMapIS passed explicitly (replace uniforms).
 */
export const estimatePathContribution = Fn( ( [
	throughput,
	direction,
	materialClass,
	enableEnvironmentLight,
	useEnvMapIS
] ) => {

	const throughputStrength = maxComponent( throughput ).toVar( 'throughputStrength' );

	const materialImportance = materialClass.get( 'complexityScore' ).toVar( 'materialImportance' );

	If( materialClass.get( 'isMetallic' ).and( materialClass.get( 'isSmooth' ) ), () => {

		materialImportance.addAssign( 0.15 );

	} );
	If( materialClass.get( 'isTransmissive' ).and( materialClass.get( 'hasClearcoat' ) ), () => {

		materialImportance.addAssign( 0.12 );

	} );
	If( materialClass.get( 'isEmissive' ), () => {

		materialImportance.addAssign( 0.1 );

	} );

	materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

	const directionImportance = float( 0.5 ).toVar( 'directionImportance' );

	If( enableEnvironmentLight.and( useEnvMapIS ).and( throughputStrength.greaterThan( 0.01 ) ), () => {

		const cosTheta = clamp( direction.y, 0.0, 1.0 ).toVar( 'cosTheta' );
		directionImportance.assign( mix( float( 0.3 ), float( 0.8 ), cosTheta.mul( cosTheta ) ) );

	} );

	const throughputWeight = smoothstep( float( 0.001 ), float( 0.1 ), throughputStrength );

	return throughputStrength.mul(
		mix( materialImportance.mul( 0.7 ), directionImportance, 0.3 )
	).mul( throughputWeight );

} );

// ================================================================================
// RUSSIAN ROULETTE PATH TERMINATION
// ================================================================================

/**
 * Matches GLSL handleRussianRoulette().
 * Returns continuation probability (0 = terminate).
 */
export const handleRussianRoulette = Fn( ( [
	depth,
	throughput,
	materialClass,
	rayDirection,
	rngState,
	pathImportance,
	enableEnvironmentLight,
	useEnvMapIS
] ) => {

	const result = float( 1.0 ).toVar( 'rrResult' );

	// Always continue for depth < 3
	If( depth.greaterThanEqual( 3 ), () => {

		const throughputStrength = maxComponent( throughput ).toVar( 'throughputStrength' );

		// Energy-conserving early termination for very low throughput
		If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( 4 ) ), () => {

			const lowThroughputProb = max( throughputStrength.mul( 125.0 ), 0.01 ).toVar( 'lowThroughputProb' );
			const rrSample = RandomValue( rngState ).toVar( 'rrSample' );
			result.assign( select( rrSample.lessThan( lowThroughputProb ), lowThroughputProb, float( 0.0 ) ) );

		} ).Else( () => {

			const materialImportance = materialClass.get( 'complexityScore' ).toVar( 'materialImportance' );

			If( materialClass.get( 'isEmissive' ).and( depth.lessThan( 6 ) ), () => {

				materialImportance.addAssign( 0.3 );

			} );
			If( materialClass.get( 'isTransmissive' ).and( depth.lessThan( 5 ) ), () => {

				materialImportance.addAssign( 0.25 );

			} );
			If( materialClass.get( 'isMetallic' ).and( materialClass.get( 'isSmooth' ) ).and( depth.lessThan( 4 ) ), () => {

				materialImportance.addAssign( 0.2 );

			} );

			materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

			// Dynamic minimum bounces
			const minBounces = int( 3 ).toVar( 'minBounces' );
			If( materialImportance.greaterThan( 0.6 ), () => {

				minBounces.assign( 5 );

			} )
				.ElseIf( materialImportance.greaterThan( 0.4 ), () => {

					minBounces.assign( 4 );

				} );

			If( depth.greaterThanEqual( minBounces ), () => {

				// Path contribution (use cached pathImportance if available)
				const pathContribution = estimatePathContribution(
					throughput, rayDirection, materialClass, enableEnvironmentLight, useEnvMapIS
				).toVar( 'pathContribution' );

				const rrProb = float( 0.0 ).toVar( 'rrProb' );
				const adaptiveFactor = materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).toVar( 'adaptiveFactor' );

				If( depth.lessThan( 6 ), () => {

					rrProb.assign( clamp( adaptiveFactor.mul( 1.2 ), 0.15, 0.95 ) );

				} ).ElseIf( depth.lessThan( 10 ), () => {

					const baseProb = clamp( throughputStrength.mul( 0.8 ), 0.08, 0.85 ).toVar( 'baseProb' );
					rrProb.assign( mix( baseProb, pathContribution, 0.6 ) );

				} ).Else( () => {

					rrProb.assign( clamp( throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ), 0.03, 0.6 ) );

				} );

				// Material-specific boost
				If( materialImportance.greaterThan( 0.5 ), () => {

					const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 ).toVar( 'boostFactor' );
					rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

				} );

				// Depth-based decay
				const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) ).toVar( 'depthDecay' );
				const depthFactor = exp( float( depth ).sub( float( minBounces ) ).mul( depthDecay ).negate() );
				rrProb.mulAssign( depthFactor );

				// Minimum probability
				const minProb = select( materialClass.get( 'isEmissive' ), float( 0.04 ), float( 0.02 ) );
				rrProb.assign( max( rrProb, minProb ) );

				const rrSample = RandomValue( rngState );
				result.assign( select( rrSample.lessThan( rrProb ), rrProb, float( 0.0 ) ) );

			} );
			// If depth < minBounces result stays 1.0

		} );

	} );
	// If depth < 3, result stays 1.0

	return result;

} );

// ================================================================================
// BACKGROUND / ENVIRONMENT SAMPLING
// ================================================================================

/**
 * Matches GLSL sampleBackgroundLighting().
 * isPrimaryRay && !showBackground → return vec4(0).
 * Primary rays  → envColor * backgroundIntensity.
 * Secondary rays → envColor * 2.0.
 */
export const sampleBackgroundLighting = Fn( ( [
	direction,
	isPrimaryRay,
	showBackground,
	envTex,
	envIntensity,
	envMatrix,
	backgroundIntensity
] ) => {

	const result = vec4( 0.0 ).toVar( 'bgResult' );

	// Skip if primary ray with no background
	If( isPrimaryRay.and( showBackground.not() ).not(), () => {

		// Apply rotation and convert to equirectangular UV
		const rotatedDir = envMatrix.mul( vec4( direction, 0.0 ) ).xyz.toVar( 'rotatedDir' );
		const u = float( 0.5 ).add( rotatedDir.x.atan( rotatedDir.z ).div( TWO_PI ) );
		const v = float( 0.5 ).sub( rotatedDir.y.asin().div( PI ) );

		const envColor = texture( envTex, vec2( u, v ) ).toVar( 'envColor' );
		const scaledColor = envColor.rgb.mul( envIntensity );

		If( isPrimaryRay, () => {

			result.assign( vec4( scaledColor.mul( backgroundIntensity ), envColor.a ) );

		} ).Else( () => {

			result.assign( vec4( scaledColor.mul( 2.0 ), envColor.a ) );

		} );

	} );

	return result;

} );

// ================================================================================
// FIREFLY SUPPRESSION  (matches GLSL calculateFireflyThreshold / applySoftSuppressionRGB)
// ================================================================================

export const calculateFireflyThreshold = Fn( ( [ baseThreshold, variationMultiplier, pathLength ] ) => {

	const depthFactor = float( 1.0 ).add( float( pathLength ).mul( 0.1 ) );
	const threshold = baseThreshold.mul( variationMultiplier ).div( depthFactor );
	return max( threshold, 0.1 );

} );

export const applySoftSuppressionRGB = Fn( ( [ contribution, threshold, softness ] ) => {

	const maxVal = maxComponent( contribution ).toVar( 'maxVal' );
	const result = contribution.toVar( 'suppressResult' );

	If( maxVal.greaterThan( threshold ), () => {

		const factor = threshold.div( maxVal );
		const smoothFactor = mix( factor, float( 1.0 ), exp( maxVal.sub( threshold ).negate().div( threshold ) ).mul( softness ) );
		result.assign( contribution.mul( smoothFactor ) );

	} );

	return result;

} );

/**
 * Matches GLSL regularizePathContribution().
 */
export const regularizePathContribution = Fn( ( [ contribution, throughput, pathLength, fireflyThresholdVal ] ) => {

	const throughputMax = maxComponent( throughput );
	const throughputMin = minComponent( throughput );
	const throughputVariation = throughputMax.add( 0.001 ).div( throughputMin.add( 0.001 ) );
	const variationMultiplier = float( 1.0 ).div(
		float( 1.0 ).add( log( float( 1.0 ).add( throughputVariation ) ).mul( pathLength ).mul( 0.1 ) )
	);
	const threshold = calculateFireflyThreshold( fireflyThresholdVal, variationMultiplier, int( pathLength ) );

	return applySoftSuppressionRGB( contribution, threshold, 0.5 );

} );

// ================================================================================
// BRDF EVALUATION  (Cook-Torrance)
// ================================================================================

export const evaluateDiffuse = Fn( ( [ color, metalness ] ) => {

	const diffuseColor = color.mul( float( 1.0 ).sub( metalness ) );
	return diffuseColor.mul( PI_INV );

} );

export const evaluateSpecular = Fn( ( [ color, metalness, roughness, NoV, NoL, NoH, VoH ] ) => {

	const F0 = mix( vec3( 0.04 ), color, metalness ).toVar( 'F0' );
	const F = fresnelSchlick( VoH, F0 );
	const D = distributionGGX( NoH, roughness );
	const G = geometrySmith( NoV, NoL, roughness );
	const denom = max( NoV.mul( NoL ).mul( 4.0 ), 0.001 );
	return D.mul( G ).mul( F ).div( denom );

} );

/**
 * Sample combined BRDF — matches GLSL generateSampledDirection (simplified).
 * Chooses diffuse or specular based on metalness.
 */
export const sampleBRDF = Fn( ( [ V, N, color, metalness, roughness, randomSample, rngState ] ) => {

	const specularWeight = mix( float( 0.5 ), float( 1.0 ), metalness ).toVar( 'specWeight' );
	const diffuseWeight = float( 1.0 ).sub( specularWeight ).toVar( 'diffWeight' );

	const xi = RandomValue( rngState ).toVar( 'xi' );

	const T = vec3( 0.0 ).toVar( 'basisT' );
	const B = vec3( 0.0 ).toVar( 'basisB' );
	buildOrthonormalBasis( N, T, B );

	const L = vec3( 0.0 ).toVar( 'L' );
	const pdf = float( 0.0 ).toVar( 'pdf' );
	const brdfValue = vec3( 0.0 ).toVar( 'brdfValue' );

	If( xi.lessThan( diffuseWeight ), () => {

		const localDir = importanceSampleCosine( randomSample );
		L.assign( localToWorld( localDir, T, B, N ) );
		const NoL = max( dot( N, L ), 0.0 ).toVar( 'NoL' );
		pdf.assign( NoL.mul( PI_INV ) );
		brdfValue.assign( evaluateDiffuse( color, metalness ).mul( NoL ) );

	} ).Else( () => {

		const H = importanceSampleGGX( randomSample, roughness );
		const worldH = localToWorld( H, T, B, N ).toVar( 'worldH' );
		L.assign( reflect( V.negate(), worldH ) );

		const NoL = max( dot( N, L ), 0.0 ).toVar( 'NoL' );
		const NoV = max( dot( N, V ), 0.0 ).toVar( 'NoV' );
		const NoH = max( dot( N, worldH ), 0.0 ).toVar( 'NoH' );
		const VoH = max( dot( V, worldH ), 0.0 ).toVar( 'VoH' );

		const D = distributionGGX( NoH, roughness );
		pdf.assign( D.mul( NoH ).div( max( VoH.mul( 4.0 ), 0.001 ) ) );
		brdfValue.assign( evaluateSpecular( color, metalness, roughness, NoV, NoL, NoH, VoH ).mul( NoL ) );

	} );

	return DirectionSample( { direction: L, pdf, value: brdfValue } );

} );

// ================================================================================
// DIRECT LIGHTING (environment importance sampling)
// Matches GLSL calculateDirectLightingUnified (environment portion)
// ================================================================================

export const calculateDirectLighting = Fn( ( [
	hitPoint,
	N,
	V,
	color,
	metalness,
	roughness,
	envTex,
	envIntensity,
	envMatrix,
	envSize,
	marginalCDF,
	conditionalCDF,
	hasImportanceSampling,
	rngState,
	bvhTex, bvhTexSize,
	triTex, triTexSize
] ) => {

	const directLight = vec3( 0.0 ).toVar( 'directLight' );

	const xi1 = RandomValue( rngState );
	const xi2 = RandomValue( rngState );
	const randomSample = vec2( xi1, xi2 ).toVar( 'envRandom' );

	const envSample = sampleEnvironmentDirection(
		envTex, marginalCDF, conditionalCDF, envSize, hasImportanceSampling, randomSample
	);
	const lightDir = envSample.xyz.toVar( 'lightDir' );
	const envPdf = envSample.w.toVar( 'envPdf' );

	const NoL = max( dot( N, lightDir ), 0.0 ).toVar( 'NoL' );

	If( NoL.greaterThan( 0.001 ).and( envPdf.greaterThan( 0.0001 ) ), () => {

		const shadowOrigin = hitPoint.add( N.mul( 0.001 ) );
		const inShadow = traverseBVHShadow(
			shadowOrigin, lightDir, float( 0.001 ), float( 1e10 ),
			bvhTex, bvhTexSize, triTex, triTexSize
		);

		If( inShadow.not(), () => {

			const rotatedLightDir = envMatrix.mul( vec4( lightDir, 0.0 ) ).xyz;
			const u = float( 0.5 ).add( rotatedLightDir.x.atan( rotatedLightDir.z ).div( TWO_PI ) );
			const v = float( 0.5 ).sub( rotatedLightDir.y.asin().div( PI ) );
			const envRadiance = texture( envTex, vec2( u, v ) ).rgb.mul( envIntensity );

			const H = normalize( V.add( lightDir ) );
			const NoV = max( dot( N, V ), 0.0 ).toVar( 'dNoV' );
			const NoH = max( dot( N, H ), 0.0 ).toVar( 'dNoH' );
			const VoH = max( dot( V, H ), 0.0 ).toVar( 'dVoH' );

			const diffuseBRDF = evaluateDiffuse( color, metalness );
			const specularBRDF = evaluateSpecular( color, metalness, roughness, NoV, NoL, NoH, VoH );
			const brdf = diffuseBRDF.add( specularBRDF );

			// Power heuristic MIS
			const brdfPdf = NoL.mul( PI_INV );
			const weight = envPdf.mul( envPdf ).div(
				envPdf.mul( envPdf ).add( brdfPdf.mul( brdfPdf ) ).add( 0.0001 )
			);

			directLight.assign(
				envRadiance.mul( brdf ).mul( NoL ).div( max( envPdf, 0.0001 ) ).mul( weight )
			);

		} );

	} );

	return directLight;

} );

// ================================================================================
// MAIN TRACE FUNCTION
// Exact port of GLSL Trace() from pathtracer_core.fs
// ================================================================================

/**
 * Main path tracing loop.
 *
 * Parameter mapping vs GLSL Trace():
 *  ray           → rayOrigin + rayDirection
 *  rngState      → seed (toVar'd internally)
 *  rayIndex      → removed (folded into seed)
 *  pixelIndex    → removed
 *  objectNormal  → returned in gNormalDepth.xyz
 *  objectColor   → returned in gAlbedo.xyz
 *  objectID      → returned in gAlbedo.w
 *  firstHitPoint → unused (not in output struct)
 *  firstHitDist  → returned in gNormalDepth.w
 */
export const Trace = Fn( ( [
	rayOrigin,
	rayDirection,
	seed,
	maxBounceCount,
	transmissiveBounces,
	bvhTex, bvhTexSize,
	triTex, triTexSize,
	matTex, matTexSize,
	envTex, envIntensity, envMatrix, hasEnv,
	showBackground,
	backgroundIntensity,
	fireflyThreshold,
	envSize, marginalCDF, conditionalCDF, hasImportanceSampling
] ) => {

	// ── Path accumulators ─────────────────────────────────────────────────────
	const radiance = vec3( 0.0 ).toVar( 'radiance' );
	const throughput = vec3( 1.0 ).toVar( 'throughput' );
	const alpha = float( 1.0 ).toVar( 'alpha' );
	const rngState = seed.toVar( 'rngState' );

	// ── G-buffer / edge-detection outputs ────────────────────────────────────
	const objectNormal = vec3( 0.0 ).toVar( 'objectNormal' );
	const objectColor = vec3( 0.0 ).toVar( 'objectColor' );
	const objectID = float( - 1000.0 ).toVar( 'objectID' );

	// ── Motion-vector data ───────────────────────────────────────────────────
	const firstHitPoint = rayOrigin.toVar( 'firstHitPoint' );
	const firstHitDistance = float( 1e10 ).toVar( 'firstHitDistance' );

	// ── Current ray state ─────────────────────────────────────────────────────
	const currentOrigin = rayOrigin.toVar( 'currentOrigin' );
	const currentDirection = rayDirection.toVar( 'currentDirection' );

	// ── Render state (mirrors GLSL RenderState) ───────────────────────────────
	const isPrimaryRay = tslBool( true ).toVar( 'isPrimaryRay' );
	const rayType = int( RAY_TYPE_CAMERA ).toVar( 'rayType' );
	const transmissiveTraversals = transmissiveBounces.toVar( 'transmissiveTraversals' );
	const actualBounceDepth = int( 0 ).toVar( 'actualBounceDepth' );

	// ── PathState flags ───────────────────────────────────────────────────────
	// (no caching in v2 — recomputed each bounce as needed)
	const pathImportance = float( 0.0 ).toVar( 'pathImportance' );

	// ── Effective bounces (separate from transmissive free bounces) ────────────
	const effectiveBounces = int( 0 ).toVar( 'effectiveBounces' );

	// ── Env uniforms (replace GLSL globals) ──────────────────────────────────
	const enableEnvironmentLight = hasEnv;
	const useEnvMapIS = hasImportanceSampling.greaterThan( 0.5 );

	// ── Main bounce loop ──────────────────────────────────────────────────────
	const maxLoopCount = maxBounceCount.add( transmissiveBounces );

	Loop( { start: int( 0 ), end: maxLoopCount, type: 'int', condition: '<=' }, ( { i: bounceIndex } ) => {

		// Update state for this bounce (mirrors GLSL)
		isPrimaryRay.assign( bounceIndex.equal( 0 ) );
		actualBounceDepth.assign( bounceIndex );

		// Check if we've exceeded our effective bounce budget
		If( effectiveBounces.greaterThan( maxBounceCount ), () => {

			Break();

		} );

		// ── 1. BVH TRAVERSAL ─────────────────────────────────────────────────
		const hitResult = traverseBVH(
			currentOrigin, currentDirection,
			float( 0.0001 ), float( 1e10 ),
			bvhTex, bvhTexSize,
			triTex, triTexSize
		).toVar( 'hitResult' );

		const didHit = hitResult.get( 'hit' );
		const hitT = hitResult.get( 't' );
		const hitTriIndex = hitResult.get( 'triangleIndex' );
		const hitU = hitResult.get( 'u' );
		const hitV = hitResult.get( 'v' );
		const hitW = hitResult.get( 'w' );

		// ── MISS — ENVIRONMENT LIGHTING ───────────────────────────────────────
		If( didHit.not(), () => {

			If( hasEnv, () => {

				const envColor = sampleBackgroundLighting(
					currentDirection, isPrimaryRay, showBackground,
					envTex, envIntensity, envMatrix, backgroundIntensity
				);
				const contribution = regularizePathContribution(
					envColor.rgb.mul( throughput ),
					throughput,
					float( bounceIndex ),
					fireflyThreshold
				);
				radiance.addAssign( contribution );
				alpha.mulAssign( envColor.a );

			} );

			Break();

		} );

		// ── 2. RECONSTRUCT HIT DATA FROM TRIANGLE TEXTURE ────────────────────
		const hitPoint = currentOrigin.add( currentDirection.mul( hitT ) ).toVar( 'hitPoint' );

		const nA = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 3 ), int( TRI_STRIDE ) ).xyz;
		const nB = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 4 ), int( TRI_STRIDE ) ).xyz;
		const nC = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 5 ), int( TRI_STRIDE ) ).xyz;

		// Interpolate normal (w = 1 - u - v, matching GLSL barycentric convention)
		const interpNormal = normalize(
			nA.mul( hitW ).add( nB.mul( hitU ) ).add( nC.mul( hitV ) )
		).toVar( 'interpNormal' );

		const uvData1 = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 6 ), int( TRI_STRIDE ) );
		const uvData2 = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 7 ), int( TRI_STRIDE ) );
		const materialIndex = int( uvData2.z ).toVar( 'materialIndex' );

		const uv0 = uvData1.xy;
		const uv1 = uvData1.zw;
		const uv2 = uvData2.xy;
		const interpUV = uv0.mul( hitW ).add( uv1.mul( hitU ) ).add( uv2.mul( hitV ) ).toVar( 'interpUV' );

		// ── 3. SAMPLE ALL MATERIAL TEXTURES ──────────────────────────────────
		// Mirrors GLSL sampleAllMaterialTextures(hitInfo.material, hitInfo.uv, hitInfo.normal)
		// Material layout: 11 vec4s per material (MATERIAL_STRIDE)
		const matData0 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 0 ), int( MATERIAL_STRIDE ) );
		const matData1 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 1 ), int( MATERIAL_STRIDE ) );
		const matData2 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 2 ), int( MATERIAL_STRIDE ) );
		const matData3 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 3 ), int( MATERIAL_STRIDE ) );
		const matData4 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 4 ), int( MATERIAL_STRIDE ) );

		// Apply texture samples to material properties (matches GLSL matSamples)
		const color = matData0.rgb.toVar( 'matColor' ); // albedo (base, no atlas in v2)
		const metalness = matData0.w.toVar( 'metalness' );
		const emissive = matData1.rgb.toVar( 'emissive' );
		const roughness = clamp( matData1.w, MIN_ROUGHNESS, MAX_ROUGHNESS ).toVar( 'roughness' );
		const ior = matData2.x.toVar( 'ior' );
		const transmission = matData2.y.toVar( 'transmission' );
		const thickness = matData2.z.toVar( 'thickness' );
		const clearcoat = matData2.w.toVar( 'clearcoat' );
		const clearcoatRoughness = matData3.x.toVar( 'clearcoatRoughness' );
		const opacity = matData3.y.toVar( 'opacity' );
		const alphaMode = int( matData3.z ).toVar( 'alphaMode' ); // 0=OPAQUE,1=MASK,2=BLEND
		const displacementScale = matData4.x.toVar( 'displacementScale' );

		// Working normal N — starts as interpolated geometry normal
		// (matches GLSL N = matSamples.normal after normal-map sampling)
		const N = interpNormal.toVar( 'N' );

		// Clamp sheenRoughness (matches GLSL)
		const sheenRoughness = clamp( matData3.w, MIN_ROUGHNESS, MAX_ROUGHNESS ).toVar( 'sheenRoughness' );

		// ── 4. DISPLACEMENT MAPPING ───────────────────────────────────────────
		// Matches GLSL: if(material.displacementMapIndex >= 0 && material.displacementScale > 0)
		// In v2 we check displacementScale only (map index not yet tracked in these slots)
		If( displacementScale.greaterThan( 0.01 ), () => {

			// sampleDisplacementMap would go here — requires texture arrays
			// calculateDisplacedNormal would blend the result
			// Kept as stub; full implementation needs displacement texture array param
			// N.assign( normalize( mix( N, displacedNormal, blendFactor ) ) );

		} );

		// ── 5. TRANSPARENCY / TRANSMISSION ───────────────────────────────────
		// Matches GLSL: handleMaterialTransparency(ray, hitPoint, N, material, rngState, state, mediumStack)
		const continueRay = tslBool( false ).toVar( 'continueRay' );
		const isFreeBounce = tslBool( false ).toVar( 'isFreeBounce' );

		// BLEND alpha mode — stochastic transparency
		If( alphaMode.equal( 2 ), () => {

			const finalAlpha = color.a.mul( opacity ).toVar( 'finalAlpha' );
			const alphaRand = RandomValue( rngState );
			If( alphaRand.greaterThan( finalAlpha ), () => {

				// Skip surface (alpha cutout)
				currentOrigin.assign( hitPoint.add( currentDirection.mul( 0.001 ) ) );
				isPrimaryRay.assign( false );
				continueRay.assign( true );
				isFreeBounce.assign( true );

			} );
			alpha.mulAssign( finalAlpha );

		} );

		// MASK alpha mode
		If( alphaMode.equal( 1 ).and( continueRay.not() ), () => {

			If( color.a.lessThan( 0.5 ), () => {

				currentOrigin.assign( hitPoint.add( currentDirection.mul( 0.001 ) ) );
				isPrimaryRay.assign( false );
				continueRay.assign( true );
				isFreeBounce.assign( true );

			} );

		} );

		// Transmission (refractive continuation)
		If( transmission.greaterThan( 0.01 ).and( continueRay.not() ), () => {

			If( transmissiveTraversals.greaterThan( 0 ), () => {

				// Determine entering or exiting
				const cosRN = dot( currentDirection, N ).toVar( 'cosRN' );
				const entering = cosRN.lessThan( 0.0 ).toVar( 'entering' );
				const adjN = select( entering, N, N.negate() ).toVar( 'adjN' );
				const eta = select( entering, float( 1.0 ).div( ior ), ior ).toVar( 'eta' );

				const refractDir = refract( currentDirection, adjN, eta ).toVar( 'refractDir' );
				const isTIR = dot( refractDir, refractDir ).lessThan( 0.001 ).toVar( 'isTIR' );

				If( isTIR.not(), () => {

					// Successful refraction — transmissive free bounce
					currentOrigin.assign( hitPoint.add( currentDirection.mul( 0.001 ) ) );
					currentDirection.assign( normalize( refractDir ) );
					transmissiveTraversals.subAssign( 1 );
					rayType.assign( int( RAY_TYPE_TRANSMISSION ) );
					isPrimaryRay.assign( false );
					// Reset material caches (matches GLSL pathState reset)
					continueRay.assign( true );
					isFreeBounce.assign( true );

				} );

			} );

			// Apply transmission alpha attenuation
			alpha.mulAssign( float( 1.0 ).sub( transmission ) );

		} );

		// If transparency/transmission continues this ray, skip shading for this bounce
		If( continueRay, () => {

			If( isFreeBounce.not(), () => {

				effectiveBounces.addAssign( 1 );

			} );

			Continue();

		} );

		// ── 6. RANDOM SAMPLE + VIEW DIRECTION ────────────────────────────────
		const xi1 = RandomValue( rngState ).toVar( 'xi1' );
		const xi2 = RandomValue( rngState ).toVar( 'xi2' );
		const randomSample = vec2( xi1, xi2 ).toVar( 'randomSample' );
		const V = currentDirection.negate().toVar( 'V' );

		// ── 7. CLASSIFY MATERIAL ─────────────────────────────────────────────
		// Matches GLSL getOrCreateMaterialClassification
		const matClass = classifyMaterial( color, metalness, roughness, transmission, clearcoat, emissive );

		// ── 8. BRDF SAMPLING ─────────────────────────────────────────────────
		// Matches GLSL: if(clearcoat > 0) sampleClearcoat else generateSampledDirection
		const brdfDir = vec3( 0.0 ).toVar( 'brdfDir' );
		const brdfVal = vec3( 0.0 ).toVar( 'brdfVal' );
		const brdfPdf = float( 0.0 ).toVar( 'brdfPdf' );

		If( clearcoat.greaterThan( 0.0 ), () => {

			// Clearcoat path: blend clearcoat GGX with base material
			// Mirrors sampleClearcoat — uses clearcoat GGX for clearcoat layer
			const T = vec3( 0.0 ).toVar( 'ccT' );
			const B = vec3( 0.0 ).toVar( 'ccB' );
			buildOrthonormalBasis( N, T, B );

			const ccRough = max( clearcoatRoughness, float( MIN_ROUGHNESS ) ).toVar( 'ccRough' );
			const baseRough = roughness;

			// Weights
			const specW = float( 1.0 ).sub( baseRough ).mul( float( 0.5 ).add( metalness.mul( 0.5 ) ) ).toVar( 'specW' );
			const ccW = clearcoat.mul( float( 1.0 ).sub( ccRough ) ).toVar( 'ccW' );
			const diffW = float( 1.0 ).sub( specW ).mul( float( 1.0 ).sub( metalness ) ).toVar( 'diffW' );
			const totalW = specW.add( ccW ).add( diffW );
			specW.divAssign( totalW );
			ccW.divAssign( totalW );
			diffW.divAssign( totalW );

			const lobeRand = RandomValue( rngState ).toVar( 'lobeRand' );

			If( lobeRand.lessThan( ccW ), () => {

				// Clearcoat GGX
				const H = localToWorld( importanceSampleGGX( randomSample, ccRough ), T, B, N );
				brdfDir.assign( reflect( V.negate(), H ) );

			} ).ElseIf( lobeRand.lessThan( ccW.add( specW ) ), () => {

				// Base specular GGX
				const H = localToWorld( importanceSampleGGX( randomSample, baseRough ), T, B, N );
				brdfDir.assign( reflect( V.negate(), H ) );

			} ).Else( () => {

				// Diffuse cosine
				brdfDir.assign( localToWorld( importanceSampleCosine( randomSample ), T, B, N ) );

			} );

			const H = normalize( V.add( brdfDir ) ).toVar( 'ccH' );
			const NoLcc = max( dot( N, brdfDir ), 0.0 ).toVar( 'NoLcc' );
			const NoVcc = max( dot( N, V ), 0.001 ).toVar( 'NoVcc' );
			const NoHcc = max( dot( N, H ), 0.001 ).toVar( 'NoHcc' );
			const VoHcc = max( dot( V, H ), 0.001 ).toVar( 'VoHcc' );

			// Combined PDF (MIS)
			const ccPDF = distributionGGX( NoHcc, ccRough ).mul( NoHcc ).div( VoHcc.mul( 4.0 ) ).mul( ccW );
			const specPDF = distributionGGX( NoHcc, baseRough ).mul( NoHcc ).div( VoHcc.mul( 4.0 ) ).mul( specW );
			const diffPDF = NoLcc.mul( PI_INV ).mul( diffW );
			brdfPdf.assign( max( ccPDF.add( specPDF ).add( diffPDF ), 0.001 ) );

			// BRDF value
			const diff = evaluateDiffuse( color, metalness ).mul( NoLcc );
			const spec = evaluateSpecular( color, metalness, baseRough, NoVcc, NoLcc, NoHcc, VoHcc ).mul( NoLcc );
			brdfVal.assign( diff.add( spec ) );

		} ).Else( () => {

			// Standard path: generateSampledDirection equivalent
			const brdfResult = sampleBRDF( V, N, color, metalness, roughness, randomSample, rngState );
			brdfDir.assign( brdfResult.get( 'direction' ) );
			brdfVal.assign( brdfResult.get( 'value' ) );
			brdfPdf.assign( brdfResult.get( 'pdf' ) );

		} );

		// ── 9. EMISSIVE CONTRIBUTION ─────────────────────────────────────────
		// Matches GLSL: if(length(matSamples.emissive) > 0) radiance += emissive * throughput
		If( length( emissive ).greaterThan( 0.0 ), () => {

			radiance.addAssign( emissive.mul( throughput ) );

		} );

		// ── 10. DIRECT LIGHTING ───────────────────────────────────────────────
		// Matches GLSL:
		//   vec3 directLight = calculateDirectLightingUnified(hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats);
		//   radiance += regularizePathContribution(directLight * throughput, throughput, float(bounceIndex));
		const directLight = calculateDirectLightingUnified(
			hitPoint, N, V, color, metalness, roughness, transmission,
			rngState,
			envTex, envIntensity, envMatrix, envSize,
			marginalCDF, conditionalCDF, hasImportanceSampling, enableEnvironmentLight,
			bvhTex, bvhTexSize, triTex, triTexSize
		);
		const regulatedDirect = regularizePathContribution(
			directLight.mul( throughput ),
			throughput,
			float( bounceIndex ),
			fireflyThreshold
		);
		radiance.addAssign( regulatedDirect );

		// ── 11. IMPORTANCE SAMPLING INFO ─────────────────────────────────────
		// Matches GLSL: if(!pathState.weightsComputed || bounceIndex==0)
		//                  pathState.samplingInfo = getImportanceSamplingInfo(...)
		// v2: samplingInfo is implicit in the sampleBRDF/clearcoat weights above

		// ── 12. INDIRECT LIGHTING ─────────────────────────────────────────────
		// Matches GLSL: calculateIndirectLighting → throughput *= indirectResult.throughput * misWeight
		const NoL = max( dot( N, brdfDir ), 0.0 ).toVar( 'NoL' );

		If( NoL.lessThanEqual( 0.0 ).or( brdfPdf.lessThanEqual( 0.0 ) ), () => {

			Break();

		} );

		// Throughput update: BRDF * NoL / pdf * MIS weight
		// In GLSL calculateIndirectLighting also folds globalIlluminationIntensity — we keep it at 1
		const indirectThroughput = brdfVal.div( max( brdfPdf, 0.0001 ) ).toVar( 'indirectThroughput' );
		// Simplified MIS weight = 1.0 (full multi-strategy MIS needs computeSamplingInfo from LightsIndirect)
		throughput.mulAssign( indirectThroughput );

		// ── 13. EARLY RAY TERMINATION ─────────────────────────────────────────
		const maxThroughput = max( max( throughput.r, throughput.g ), throughput.b );
		If( maxThroughput.lessThan( 0.001 ).and( bounceIndex.greaterThan( 2 ) ), () => {

			Break();

		} );

		// ── 14. PREPARE NEXT BOUNCE ───────────────────────────────────────────
		// Matches GLSL: ray.origin = hitPoint + N * 0.001; ray.direction = indirectResult.direction
		currentOrigin.assign( hitPoint.add( N.mul( 0.001 ) ) );
		currentDirection.assign( brdfDir );
		isPrimaryRay.assign( false );

		// Ray type (mirrors GLSL)
		If( metalness.greaterThan( 0.7 ).and( roughness.lessThan( 0.3 ) ), () => {

			rayType.assign( int( RAY_TYPE_REFLECTION ) );

		} ).ElseIf( transmission.greaterThan( 0.5 ), () => {

			rayType.assign( int( RAY_TYPE_TRANSMISSION ) );

		} ).Else( () => {

			rayType.assign( int( RAY_TYPE_DIFFUSE ) );

		} );

		// ── 15. G-BUFFER CAPTURE (first bounce, AFTER lighting — matches GLSL order) ──
		If( bounceIndex.equal( 0 ).and( didHit ), () => {

			objectNormal.assign( N );
			objectColor.assign( color );
			objectID.assign( float( materialIndex ) );
			firstHitPoint.assign( hitPoint );
			firstHitDistance.assign( hitT );

		} );

		// ── 16. RUSSIAN ROULETTE ──────────────────────────────────────────────
		// Matches GLSL: handleRussianRoulette(state.actualBounceDepth, throughput, ...)
		const rrSurvivalProb = handleRussianRoulette(
			actualBounceDepth, throughput, matClass, currentDirection,
			rngState, pathImportance,
			enableEnvironmentLight, useEnvMapIS
		).toVar( 'rrSurvivalProb' );

		If( rrSurvivalProb.lessThanEqual( 0.0 ), () => {

			Break();

		} );

		// Apply throughput compensation (unbiased estimator)
		throughput.divAssign( rrSurvivalProb );

		// ── 17. INCREMENT EFFECTIVE BOUNCES ───────────────────────────────────
		effectiveBounces.addAssign( 1 );

	} );

	// ── Return G-buffer outputs ───────────────────────────────────────────────
	return pathTracerOutputStruct( {
		gColor: vec4( radiance, alpha ),
		gNormalDepth: vec4( objectNormal, firstHitDistance ),
		gAlbedo: vec4( objectColor, objectID )
	} );

} );

// ================================================================================
// SIMPLIFIED SINGLE-BOUNCE TRACE (for debugging / testing)
// ================================================================================

export const traceSingleBounce = Fn( ( [
	rayOrigin,
	rayDirection,
	bvhTex, bvhTexSize,
	triTex, triTexSize,
	matTex, matTexSize,
	envTex, envIntensity, envMatrix, hasEnv
] ) => {

	const hitResult = traverseBVH(
		rayOrigin, rayDirection,
		float( 0.0001 ), float( 1e10 ),
		bvhTex, bvhTexSize, triTex, triTexSize
	).toVar( 'hitResult' );

	const didHit = hitResult.get( 'hit' );
	const hitT = hitResult.get( 't' );
	const hitTriIndex = hitResult.get( 'triangleIndex' );
	const hitU = hitResult.get( 'u' );
	const hitV = hitResult.get( 'v' );
	const hitW = hitResult.get( 'w' );

	const outColor = vec3( 0.0 ).toVar( 'outColor' );
	const outDepth = float( 1e10 ).toVar( 'outDepth' );

	If( didHit, () => {

		const nA = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 3 ), int( TRI_STRIDE ) ).xyz;
		const nB = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 4 ), int( TRI_STRIDE ) ).xyz;
		const nC = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 5 ), int( TRI_STRIDE ) ).xyz;
		const interpNormal = normalize( nA.mul( hitW ).add( nB.mul( hitU ) ).add( nC.mul( hitV ) ) );

		const uvData2 = getDataFromTexture( triTex, triTexSize, hitTriIndex, int( 7 ), int( TRI_STRIDE ) );
		const materialIndex = int( uvData2.z );

		const matData0 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 0 ), int( MATERIAL_STRIDE ) );
		const matData1 = getDataFromTexture( matTex, matTexSize, materialIndex, int( 1 ), int( MATERIAL_STRIDE ) );
		const color = matData0.rgb;
		const emissive = matData1.rgb;

		const lightDir = normalize( vec3( 1.0, 1.0, 1.0 ) );
		const diffuse = max( dot( interpNormal, lightDir ), 0.0 ).mul( 0.6 );
		outColor.assign( color.mul( vec3( 0.1 ).add( diffuse ) ).add( emissive ) );
		outDepth.assign( hitT );

	} ).Else( () => {

		If( hasEnv, () => {

			const rotatedDir = envMatrix.mul( vec4( rayDirection, 0.0 ) ).xyz.toVar( 'rotDir' );
			const u = float( 0.5 ).add( rotatedDir.x.atan( rotatedDir.z ).div( TWO_PI ) );
			const v = float( 0.5 ).sub( rotatedDir.y.asin().div( PI ) );
			outColor.assign( texture( envTex, vec2( u, v ) ).rgb.mul( envIntensity ) );

		} ).Else( () => {

			const t = rayDirection.y.mul( 0.5 ).add( 0.5 );
			outColor.assign( mix( vec3( 1.0 ), vec3( 0.5, 0.7, 1.0 ), t ) );

		} );

	} );

	return vec4( outColor, outDepth );

} );

// ================================================================================
// EXPORTS
// ================================================================================

export {
	RAY_TYPE_CAMERA,
	RAY_TYPE_REFLECTION,
	RAY_TYPE_TRANSMISSION,
	RAY_TYPE_DIFFUSE,
	RAY_TYPE_SHADOW
};
