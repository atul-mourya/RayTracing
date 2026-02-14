/**
 * LightsSampling.js - Pure TSL Direct Lighting
 *
 * Exact port of lights_sampling.fs → calculateDirectLightingUnified
 * Pure TSL: Fn(), If(), .toVar(), .assign() — NO wgslFn()
 *
 * v2 mapping vs GLSL:
 *  traceShadowRay              → traverseBVHShadow
 *  sampleEquirectProbability   → sampleEnvironmentDirection (returns vec4(dir, pdf))
 *  evaluateMaterialResponse    → evaluateDiffuseBRDF + evaluateSpecularBRDF
 *  calculateVNDFPDF            → D(H) * NoH / (4 * VoH) inline
 *  powerHeuristic              → pure TSL math
 *
 * v2 context (no discrete lights):
 *  totalLights = 0 → sampleLights = false, sampleBRDF = false
 *  sampleEnv = true when enableEnvironmentLight
 *  MIS strategy simplified: envWeight = 1.0, totalSamplingWeight = 1.0
 */

import {
	Fn,
	float,
	vec3,
	vec4,
	vec2,
	max,
	dot,
	normalize,
	mix,
	If,
	texture,
	bool as tslBool,
} from 'three/tsl';

import { traverseBVHShadow } from './BVHTraversal_v2.js';
import { RandomValue } from './Random_v2.js';
import { fresnelSchlick, distributionGGX, geometrySmith } from './Common_v2.js';
import { sampleEnvironmentDirection } from './Environment_v2.js';

const PI = Math.PI;
const TWO_PI = 2.0 * PI;
const PI_INV = 1.0 / PI;

// ================================================================================
// POWER HEURISTIC
// Matches GLSL: powerHeuristic(a, b) = a² / (a² + b²)
// ================================================================================

export const powerHeuristic = Fn( ( [ a, b ] ) => {

	const a2 = a.mul( a ).toVar( 'ph_a2' );
	const b2 = b.mul( b ).toVar( 'ph_b2' );
	return a2.div( max( a2.add( b2 ), 1e-10 ) );

} );

// ================================================================================
// DIRECTION VALIDITY CHECK
// Matches GLSL: isDirectionValid — direction must be in the same hemisphere as normal
// ================================================================================

export const isDirectionValid = Fn( ( [ dir, normal ] ) => {

	return dot( dir, normal ).greaterThan( 0.0 );

} );

// ================================================================================
// MATERIAL PDF CALCULATION FOR MIS
// Exact port of GLSL calculateMaterialPDF(viewDir, lightDir, normal, material)
// Accepts explicit metalness/roughness/transmission instead of material struct
// ================================================================================

export const calculateMaterialPDF = Fn( ( [ viewDir, lightDir, normal, metalness, roughness, transmission ] ) => {

	// result variable at top — TSL pattern (no return inside If callbacks)
	const pdf = float( 0.0 ).toVar( 'mpdf_pdf' );

	const NoL = max( 0.0, dot( normal, lightDir ) ).toVar( 'mpdf_NoL' );
	const H = normalize( viewDir.add( lightDir ) ).toVar( 'mpdf_H' );
	const NoH = max( 0.0, dot( normal, H ) ).toVar( 'mpdf_NoH' );
	const VoH = max( 0.0, dot( viewDir, H ) ).toVar( 'mpdf_VoH' );

	// Lobe weights — matches GLSL exactly
	const diffuseWeight = float( 1.0 ).sub( metalness ).mul(
		float( 1.0 ).sub( transmission )
	).toVar( 'mpdf_diffW' );

	const specularWeight = float( 1.0 ).sub(
		diffuseWeight.mul( float( 1.0 ).sub( metalness ) )
	).toVar( 'mpdf_specW' );

	const totalWeight = diffuseWeight.add( specularWeight ).toVar( 'mpdf_totalW' );

	// Only compute if totalWeight > 0 — replaces GLSL early return, no return inside If
	If( totalWeight.greaterThan( 0.0 ), () => {

		// Guard division
		const invTotalWeight = float( 1.0 ).div( max( totalWeight, 1e-10 ) ).toVar( 'mpdf_invW' );
		diffuseWeight.mulAssign( invTotalWeight );
		specularWeight.mulAssign( invTotalWeight );

		// Diffuse PDF: cosine-weighted hemisphere = NoL / PI
		If( diffuseWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {

			pdf.addAssign( diffuseWeight.mul( NoL ).mul( PI_INV ) );

		} );

		// Specular PDF: GGX VNDF approx = D(H) * NoH / (4 * VoH)
		// Matches GLSL calculateVNDFPDF(NoH, NoV, roughness)
		If( specularWeight.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {

			const r = max( roughness, 0.02 ).toVar( 'mpdf_r' );
			const D = distributionGGX( NoH, r );
			const vndfPdf = D.mul( NoH ).div( max( VoH.mul( 4.0 ), 0.001 ) );
			pdf.addAssign( specularWeight.mul( vndfPdf ) );

		} );

	} );

	return max( pdf, 1e-8 );

} );

// ================================================================================
// LOCAL BRDF EVALUATION
// Matches GLSL evaluateDiffuse / evaluateSpecular / evaluateMaterialResponse
// ================================================================================

const evaluateDiffuseBRDF = Fn( ( [ color, metalness ] ) => {

	return color.mul( float( 1.0 ).sub( metalness ) ).mul( PI_INV );

} );

const evaluateSpecularBRDF = Fn( ( [ color, metalness, roughness, NoV, NoL, NoH, VoH ] ) => {

	const F0 = mix( vec3( 0.04 ), color, metalness ).toVar( 'ls_F0' );
	const F = fresnelSchlick( VoH, F0 );
	const D = distributionGGX( NoH, roughness );
	const G = geometrySmith( NoV, NoL, roughness );
	const denom = max( NoV.mul( NoL ).mul( 4.0 ), 0.001 );
	return D.mul( G ).mul( F ).div( denom );

} );

// ================================================================================
// UNIFIED DIRECT LIGHTING
// Exact port of GLSL calculateDirectLightingUnified (lights_sampling.fs)
//
// Parameters:
//   hitPoint, N, V              — surface hit point, shading normal, view direction
//   color, metalness, roughness, transmission  — material properties
//   brdfSampleDir, brdfSamplePdf, brdfSampleValue  — BRDF sample (DirectionSample)
//   bounceIndex                 — current bounce index
//   rngState                    — RNG state (mutable uint)
//   envTex, envIntensity, envMatrix, envSize   — environment map
//   marginalCDF, conditionalCDF, hasImportanceSampling  — env importance sampling
//   enableEnvironmentLight      — bool, whether env light is active
//   bvhTex, bvhTexSize, triTex, triTexSize     — BVH / triangle data for shadow rays
//
// v2 context (no discrete lights):
//   totalLights = 0 → sampleLights = false, sampleBRDF = false
//   GLSL fallback path: when no lights and enableEnvironmentLight → sampleEnv = true
//   MIS: envWeight = 1.0, brdfWeight = 1.0 (power heuristic between env pdf and BRDF pdf)
// ================================================================================

export const calculateDirectLightingUnified = Fn( ( [
	hitPoint, N, V,
	color, metalness, roughness, transmission,
	rngState,
	envTex, envIntensity, envMatrix, envSize,
	marginalCDF, conditionalCDF, hasImportanceSampling, enableEnvironmentLight,
	bvhTex, bvhTexSize, triTex, triTexSize
] ) => {

	const totalContribution = vec3( 0.0 ).toVar( 'dlTotalContrib' );

	// Early exit: no lights at all
	// Matches GLSL: if (totalLights == 0 && !enableEnvironmentLight) return vec3(0)
	If( enableEnvironmentLight, () => {




		// Ray origin offset — matches GLSL: rayOrigin = hitInfo.hitPoint + hitInfo.normal * 0.001
		const rayOrigin = hitPoint.add( N.mul( 0.001 ) ).toVar( 'dlRayOrigin' );

		// ── ENVIRONMENT SAMPLING ─────────────────────────────────────────────────────
		// Matches GLSL sampleEnv path in calculateDirectLightingUnified.
		// In v2: totalLights = 0, hasDiscreteLights = false.
		// GLSL fallback: when no discrete lights → sampleEnv = true (if env enabled).
		// totalSamplingWeight = envWeight = 1.0 → envContrib * 1.0 / 1.0 = envContrib

		const dlXi1 = RandomValue( rngState ).toVar( 'dlXi1' );
		const dlXi2 = RandomValue( rngState ).toVar( 'dlXi2' );
		const envRandom = vec2( dlXi1, dlXi2 ).toVar( 'dlEnvRandom' );

		// sampleEquirectProbability(envRandom, envColor, envDirection)
		// → sampleEnvironmentDirection returns vec4(direction, pdf)
		const envSampleResult = sampleEnvironmentDirection(
			envTex, marginalCDF, conditionalCDF, envSize, hasImportanceSampling, envRandom
		).toVar( 'dlEnvSample' );

		const envDir = envSampleResult.xyz.toVar( 'dlEnvDir' );
		const envPdf = envSampleResult.w.toVar( 'dlEnvPdf' );

		If( envPdf.greaterThan( 0.0 ), () => {

			const NoL = max( 0.0, dot( N, envDir ) ).toVar( 'dlNoL' );

			If( NoL.greaterThan( 0.0 ).and( isDirectionValid( envDir, N ) ), () => {

				// traceShadowRay → traverseBVHShadow
				const inShadow = traverseBVHShadow(
					rayOrigin, envDir, float( 0.001 ), float( 1e10 ),
					bvhTex, bvhTexSize, triTex, triTexSize
				);

				// const inShadow = tslBool( true ).toVar( 'dlInShadow' ); // --- NO SHADOWS IN TSL PATH TRACER ---

				If( inShadow.not(), () => {

					// Sample env color — matches GLSL envColor from sampleEquirectProbability
					const rotatedDir = envMatrix.mul( vec4( envDir, 0.0 ) ).xyz.toVar( 'dlRotDir' );
					const dlU = float( 0.5 ).add( rotatedDir.x.atan( rotatedDir.z ).div( TWO_PI ) ).toVar( 'dlU' );
					const dlV = float( 0.5 ).sub( rotatedDir.y.asin().div( PI ) ).toVar( 'dlV' );
					const envColor = texture( envTex, vec2( dlU, dlV ) ).rgb.mul( envIntensity ).toVar( 'dlEnvColor' );

					// evaluateMaterialResponse(viewDir, envDir, N, material)
					// → evaluateDiffuse + evaluateSpecular
					const dlH = normalize( V.add( envDir ) ).toVar( 'dlH' );
					const dlNoV = max( dot( N, V ), 0.0 ).toVar( 'dlNoV' );
					const dlNoH = max( dot( N, dlH ), 0.0 ).toVar( 'dlNoH' );
					const dlVoH = max( dot( V, dlH ), 0.0 ).toVar( 'dlVoH' );
					const brdfValue = evaluateDiffuseBRDF( color, metalness )
						.add( evaluateSpecularBRDF( color, metalness, roughness, dlNoV, NoL, dlNoH, dlVoH ) )
						.toVar( 'dlBrdfValue' );

					// calculateMaterialPDF for MIS — matches GLSL brdfPdf = calculateMaterialPDF(...)
					const dlBrdfPdf = calculateMaterialPDF(
						V, envDir, N, metalness, roughness, transmission
					).toVar( 'dlBrdfPdf' );

					// Power heuristic MIS weight (envPdf vs brdfPdf) — matches GLSL
					// envPdfWeighted = envPdf * envWeight (1.0), brdfPdfWeighted = brdfPdf * brdfWeight (1.0)
					const misWeight = dlBrdfPdf.greaterThan( 0.0 ).select(
						powerHeuristic( envPdf, dlBrdfPdf ),
						1.0
					).toVar( 'dlMisWeight' );

					// Guard division — matches GLSL
					// totalSamplingWeight / envWeight = 1.0 (no discrete lights)
					const envContrib = envColor.mul( brdfValue ).mul( NoL ).mul( misWeight ).div(
						max( envPdf, 1e-10 )
					);
					totalContribution.addAssign( envContrib );

				} );

			} );

		} );

	} );


	// NOTE: Emissive triangle direct lighting is handled separately in PathTracerCore_v2
	// to bypass firefly suppression — matches GLSL pathtracer_core.fs comment

	return totalContribution;

} );
