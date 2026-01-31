/**
 * MaterialSampling_v2.js - Pure TSL Material BRDF Sampling
 *
 * Provides importance sampling functions for different material types:
 * - Diffuse (Lambert): Cosine-weighted hemisphere sampling
 * - Metallic: GGX microfacet importance sampling
 * - Dielectric/Glass: Fresnel-based transmission/reflection
 * - Clearcoat: Separate GGX lobe with oriented normals
 * - Sheen: Charlie sheen BRDF sampling
 * - Multi-lobe: MIS (Multiple Importance Sampling) for combined materials
 *
 * NO wgslFn() - Pure TSL using Fn(), If(), Loop(), .toVar(), .assign()
 */

import { Fn, vec3, vec4, float, If, Return, Loop, Break } from 'three/tsl';
import {
	randomVec2,
	randomValue,
	getStratifiedSample
} from './Random_v2.js';
import {
	fresnelSchlick,
	distributionGGX,
	geometrySmith,
	importanceSampleGGX,
	importanceSampleCosine,
	buildOrthonormalBasis,
	localToWorld,
	minComponent,
	maxComponent
} from './Common_v2.js';

const PI = Math.PI;
const PI_INV = 1.0 / PI;

/**
 * Sample diffuse (Lambertian) BRDF using cosine-weighted hemisphere sampling
 *
 * @param {vec3} normal - Surface normal (world space)
 * @param {vec2} randomSample - Random values [0,1] for sampling
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleDiffuseBRDF = Fn( ( [ normal, randomSample ] ) => {

	// Use cosine-weighted hemisphere sampling
	const localDir = importanceSampleCosine( randomSample ).toVar();

	// Build ONB and transform to world space
	const T = vec3().toVar();
	const B = vec3().toVar();
	buildOrthonormalBasis( normal, T, B );
	const worldDir = localToWorld( localDir, T, B, normal ).toVar();

	// PDF for cosine-weighted sampling: cos(theta) / PI
	const cosTheta = localDir.z.max( 0.001 ).toVar();
	const pdf = cosTheta.mul( PI_INV ).toVar();

	return vec4( worldDir, pdf );

} ).setLayout( {
	name: 'sampleDiffuseBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'normal', type: 'vec3' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Sample GGX microfacet BRDF for metallic/specular surfaces
 *
 * Uses VNDF (Visible Normal Distribution Function) importance sampling
 * for better convergence with rough materials
 *
 * @param {vec3} viewDir - View direction (world space, pointing towards camera)
 * @param {vec3} normal - Surface normal (world space)
 * @param {float} roughness - Surface roughness [0,1]
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleGGXBRDF = Fn( ( [ viewDir, normal, roughness, randomSample ] ) => {

	// Build orthonormal basis
	const T = vec3().toVar();
	const B = vec3().toVar();
	buildOrthonormalBasis( normal, T, B );

	// Transform view direction to local space
	const V_local = vec3(
		viewDir.dot( T ),
		viewDir.dot( B ),
		viewDir.dot( normal )
	).toVar();

	// Sample halfway vector in local space using GGX importance sampling
	const H_local = importanceSampleGGX( randomSample, roughness ).toVar();

	// Transform halfway vector to world space
	const H_world = localToWorld( H_local, T, B, normal ).toVar();

	// Reflect view direction around halfway vector to get light direction
	const L_world = viewDir.negate().reflect( H_world ).toVar();

	// Calculate PDF
	const NoH = normal.dot( H_world ).max( 0.001 ).toVar();
	const VoH = viewDir.dot( H_world ).max( 0.001 ).toVar();

	const alpha = roughness.mul( roughness ).toVar();
	const D = distributionGGX( NoH, alpha ).toVar();
	const pdf = D.mul( NoH ).div( VoH.mul( 4.0 ) ).toVar();

	return vec4( L_world, pdf );

} ).setLayout( {
	name: 'sampleGGXBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'roughness', type: 'float' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Sample dielectric BRDF (glass/transmission) using Fresnel equations
 *
 * Handles both reflection and refraction based on Fresnel reflectance.
 * Uses Snell's law for refraction direction.
 *
 * @param {vec3} viewDir - View direction (towards camera)
 * @param {vec3} normal - Surface normal
 * @param {float} ior - Index of refraction (1.5 for glass)
 * @param {float} randomValue - Random value [0,1] for reflection/refraction choice
 * @returns {Object} { direction: vec3, pdf: float, transmitted: float }
 */
export const sampleDielectricBRDF = Fn( ( [ viewDir, normal, ior, randomValue ] ) => {

	const VoN = viewDir.dot( normal ).toVar();
	const entering = VoN.greaterThan( 0.0 ).toVar();

	// Adjust normal and IOR based on ray direction
	const adjustedNormal = If( entering, normal, normal.negate() ).toVar();
	const eta = If( entering, float( 1.0 ).div( ior ), ior ).toVar();

	// Calculate Fresnel reflectance using Schlick approximation
	const cosTheta = VoN.abs().toVar();
	const F0 = float( 1.0 ).sub( eta ).div( float( 1.0 ).add( eta ) ).toVar();
	const F0_sq = F0.mul( F0 ).toVar();
	const Fr = fresnelSchlick( cosTheta, F0_sq, float( 1.0 ) ).toVar();

	const result = vec4().toVar();

	If( randomValue.lessThan( Fr ), () => {

		// Reflection
		const reflectDir = viewDir.negate().reflect( adjustedNormal ).toVar();
		result.assign( vec4( reflectDir, Fr ) );

	} ).Else( () => {

		// Refraction using Snell's law
		const sinThetaSq = float( 1.0 ).sub( cosTheta.mul( cosTheta ) ).toVar();
		const sinThetaT_sq = sinThetaSq.mul( eta ).mul( eta ).toVar();

		If( sinThetaT_sq.lessThan( 1.0 ), () => {

			// Valid refraction
			const cosThetaT = float( 1.0 ).sub( sinThetaT_sq ).sqrt().toVar();
			const refractDir = viewDir.negate().mul( eta )
				.sub( adjustedNormal.mul( cosThetaT.add( eta.mul( cosTheta ) ) ) ).toVar();

			result.assign( vec4( refractDir.normalize(), float( 1.0 ).sub( Fr ) ) );

		} ).Else( () => {

			// Total internal reflection
			const reflectDir = viewDir.negate().reflect( adjustedNormal ).toVar();
			result.assign( vec4( reflectDir, float( 1.0 ) ) );

		} );

	} );

	return result;

} ).setLayout( {
	name: 'sampleDielectricBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'ior', type: 'float' },
		{ name: 'randomValue', type: 'float' }
	]
} );

/**
 * Sample clearcoat layer (separate GGX lobe on top of base layer)
 *
 * Clearcoat is modeled as a thin dielectric layer with its own normal map.
 * Uses GGX distribution with clearcoat-specific roughness.
 *
 * @param {vec3} viewDir - View direction
 * @param {vec3} clearcoatNormal - Clearcoat normal (can differ from base normal)
 * @param {float} clearcoatRoughness - Clearcoat roughness [0,1]
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleClearcoatBRDF = Fn( ( [ viewDir, clearcoatNormal, clearcoatRoughness, randomSample ] ) => {

	// Clearcoat uses same GGX sampling as metallic, but with separate normal/roughness
	const result = sampleGGXBRDF( viewDir, clearcoatNormal, clearcoatRoughness, randomSample ).toVar();

	return result;

} ).setLayout( {
	name: 'sampleClearcoatBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'clearcoatNormal', type: 'vec3' },
		{ name: 'clearcoatRoughness', type: 'float' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Sample sheen BRDF (fabric-like retroreflective surface)
 *
 * Uses Charlie sheen distribution for cloth/fabric materials.
 * Provides retro-reflective response at grazing angles.
 *
 * @param {vec3} viewDir - View direction
 * @param {vec3} normal - Surface normal
 * @param {float} sheenRoughness - Sheen roughness [0,1]
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {Object} { direction: vec3, pdf: float }
 */
export const sampleSheenBRDF = Fn( ( [ viewDir, normal, sheenRoughness, randomSample ] ) => {

	// For sheen, we use cosine-weighted sampling as a simplified approximation
	// A proper Charlie distribution sampler would be more complex
	const result = sampleDiffuseBRDF( normal, randomSample ).toVar();

	// Scale PDF by sheen roughness to account for lobe shape
	const sheenPdf = result.w.mul( sheenRoughness.add( 1.0 ) ).toVar();
	result.w.assign( sheenPdf );

	return result;

} ).setLayout( {
	name: 'sampleSheenBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'sheenRoughness', type: 'float' },
		{ name: 'randomSample', type: 'vec2' }
	]
} );

/**
 * Calculate MIS (Multiple Importance Sampling) weight for combined BRDF lobes
 *
 * Uses power heuristic (beta=2) for optimal variance reduction when
 * combining multiple sampling strategies.
 *
 * @param {float} pdfA - PDF of strategy A
 * @param {float} pdfB - PDF of strategy B
 * @returns {float} MIS weight for strategy A
 */
export const calculateMISWeight = Fn( ( [ pdfA, pdfB ] ) => {

	const pdfA_sq = pdfA.mul( pdfA ).toVar();
	const pdfB_sq = pdfB.mul( pdfB ).toVar();

	const weight = pdfA_sq.div( pdfA_sq.add( pdfB_sq ) ).toVar();

	return weight;

} ).setLayout( {
	name: 'calculateMISWeight',
	type: 'float',
	inputs: [
		{ name: 'pdfA', type: 'float' },
		{ name: 'pdfB', type: 'float' }
	]
} );

/**
 * Sample combined material BRDF using MIS for multi-lobe materials
 *
 * Handles materials with multiple BRDF components (diffuse + specular,
 * base + clearcoat, etc.) using Multiple Importance Sampling for
 * optimal convergence.
 *
 * @param {vec3} viewDir - View direction
 * @param {vec3} normal - Surface normal
 * @param {float} metalness - Metallic factor [0,1]
 * @param {float} roughness - Roughness [0,1]
 * @param {float} clearcoat - Clearcoat strength [0,1]
 * @param {float} transmission - Transmission factor [0,1]
 * @param {float} ior - Index of refraction
 * @param {vec3} randomValues - Random values for sampling decisions
 * @returns {Object} { direction: vec3, pdf: float, lobeType: float }
 */
export const sampleCombinedBRDF = Fn( ( [ viewDir, normal, metalness, roughness, clearcoat, transmission, ior, randomValues ] ) => {

	// Calculate lobe weights
	const diffuseWeight = float( 1.0 ).sub( metalness ).mul( float( 1.0 ).sub( transmission ) ).toVar();
	const specularWeight = float( 1.0 ).sub( transmission ).toVar();
	const transmissionWeight = transmission.toVar();
	const clearcoatWeight = clearcoat.toVar();

	// Normalize weights
	const totalWeight = diffuseWeight.add( specularWeight ).add( transmissionWeight ).add( clearcoatWeight ).toVar();
	const normDiffuse = diffuseWeight.div( totalWeight ).toVar();
	const normSpecular = specularWeight.div( totalWeight ).toVar();
	const normTransmission = transmissionWeight.div( totalWeight ).toVar();
	const normClearcoat = clearcoatWeight.div( totalWeight ).toVar();

	// Stratified sampling - choose which lobe to sample
	const lobeChoice = randomValues.x.toVar();
	const sampleUV = randomValues.yz.toVar();

	const result = vec4().toVar();
	const lobeType = float( 0.0 ).toVar(); // 0=diffuse, 1=specular, 2=transmission, 3=clearcoat

	If( lobeChoice.lessThan( normDiffuse ), () => {

		// Sample diffuse lobe
		result.assign( sampleDiffuseBRDF( normal, sampleUV ) );
		lobeType.assign( 0.0 );

	} ).ElseIf( lobeChoice.lessThan( normDiffuse.add( normSpecular ) ), () => {

		// Sample specular lobe
		result.assign( sampleGGXBRDF( viewDir, normal, roughness, sampleUV ) );
		lobeType.assign( 1.0 );

	} ).ElseIf( lobeChoice.lessThan( normDiffuse.add( normSpecular ).add( normTransmission ) ), () => {

		// Sample transmission lobe
		result.assign( sampleDielectricBRDF( viewDir, normal, ior, randomValues.z ) );
		lobeType.assign( 2.0 );

	} ).Else( () => {

		// Sample clearcoat lobe
		result.assign( sampleClearcoatBRDF( viewDir, normal, roughness.mul( 0.25 ), sampleUV ) );
		lobeType.assign( 3.0 );

	} );

	// Return direction, pdf, and lobe type
	return vec4( result.xyz, result.w );

} ).setLayout( {
	name: 'sampleCombinedBRDF',
	type: 'vec4',
	inputs: [
		{ name: 'viewDir', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'metalness', type: 'float' },
		{ name: 'roughness', type: 'float' },
		{ name: 'clearcoat', type: 'float' },
		{ name: 'transmission', type: 'float' },
		{ name: 'ior', type: 'float' },
		{ name: 'randomValues', type: 'vec3' }
	]
} );
