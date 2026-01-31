import { Fn, float, vec3, vec2, max, min, sqrt, cos, sin, pow, dot, normalize, cross, abs, If, Loop } from 'three/tsl';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';

/**
 * Material Sampling for TSL/WGSL
 * Complete port of material_sampling.fs from GLSL to TSL/WGSL
 *
 * This module contains importance sampling functions for various BRDF lobes:
 * - Basic sampling (GGX, cosine-weighted hemisphere)
 * - VNDF (Visible Normal Distribution Function) sampling
 * - Multi-lobe MIS (Multiple Importance Sampling)
 *
 * These functions generate importance-sampled directions for path tracing.
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const PI = Math.PI;
const TWO_PI = 2.0 * Math.PI;
const PI_INV = 1.0 / Math.PI;
const MIN_PDF = 1e-10;

// Feature flags (match GLSL preprocessor directives)
const ENABLE_MULTI_LOBE_MIS = true;

// ================================================================================
// BASIC SAMPLING FUNCTIONS
// ================================================================================

/**
 * Importance sample the GGX distribution.
 * Samples a microfacet normal according to the GGX distribution.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @param {TSLNode} Xi - Random sample [0, 1]² (vec2)
 * @returns {TSLNode} Sampled half vector (vec3)
 */
export const importanceSampleGGX = Fn( ( [ N, roughness, Xi ] ) => {

	const alpha = roughness.mul( roughness ).toVar();
	const phi = float( TWO_PI ).mul( Xi.x ).toVar();
	const cosTheta = sqrt(
		float( 1.0 ).sub( Xi.y ).div(
			float( 1.0 ).add( alpha.mul( alpha ).sub( 1.0 ).mul( Xi.y ) )
		)
	).toVar();
	const sinTheta = sqrt( max( float( 0.0 ), float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) ).toVar();

	// Spherical to cartesian conversion
	const H = vec3(
		cos( phi ).mul( sinTheta ),
		sin( phi ).mul( sinTheta ),
		cosTheta
	).toVar();

	// TBN construction
	const up = abs( N.z ).lessThan( 0.999 ).select(
		vec3( 0.0, 0.0, 1.0 ),
		vec3( 1.0, 0.0, 0.0 )
	).toVar();

	const tangent = normalize( cross( up, N ) ).toVar();
	const bitangent = cross( N, tangent ).toVar();

	return normalize( tangent.mul( H.x ).add( bitangent.mul( H.y ) ).add( N.mul( H.z ) ) );

} ).setLayout( {
	name: 'importanceSampleGGX',
	type: 'vec3',
	inputs: [
		{ name: 'N', type: 'vec3' },
		{ name: 'roughness', type: 'float' },
		{ name: 'Xi', type: 'vec2' }
	]
} );

/**
 * Importance sample cosine-weighted hemisphere.
 * Classic diffuse sampling for Lambertian materials.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} xi - Random sample [0, 1]² (vec2)
 * @returns {TSLNode} Sampled direction (vec3)
 */
export const importanceSampleCosine = Fn( ( [ N, xi ] ) => {

	const T = normalize( cross( N, N.yzx.add( vec3( 0.1, 0.2, 0.3 ) ) ) ).toVar();
	const B = cross( N, T ).toVar();

	// Cosine-weighted sampling
	const phi = float( TWO_PI ).mul( xi.x ).toVar();
	const cosTheta = sqrt( float( 1.0 ).sub( xi.y ) ).toVar();
	const sinTheta = sqrt( xi.y ).toVar();

	// Convert from polar to Cartesian coordinates
	const localDir = vec3(
		sinTheta.mul( cos( phi ) ),
		sinTheta.mul( sin( phi ) ),
		cosTheta
	).toVar();

	// Transform to world space
	return normalize( T.mul( localDir.x ).add( B.mul( localDir.y ) ).add( N.mul( localDir.z ) ) );

} ).setLayout( {
	name: 'importanceSampleCosine',
	type: 'vec3',
	inputs: [
		{ name: 'N', type: 'vec3' },
		{ name: 'xi', type: 'vec2' }
	]
} );

/**
 * Cosine-weighted hemisphere sampling using concentric disk mapping.
 * Alternative implementation with slightly different parameterization.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} xi - Random sample [0, 1]² (vec2)
 * @returns {TSLNode} Sampled direction (vec3)
 */
export const cosineWeightedSample = Fn( ( [ N, xi ] ) => {

	// Construct local coordinate system (TBN)
	const T = normalize( cross( N, N.yzx.add( vec3( 0.1, 0.2, 0.3 ) ) ) ).toVar();
	const B = cross( N, T ).toVar();

	// Cosine-weighted sampling using concentric disk mapping
	const phi = float( TWO_PI ).mul( xi.y ).toVar();
	const cosTheta = sqrt( float( 1.0 ).sub( xi.x ) ).toVar();
	const sinTheta = sqrt( xi.x ).toVar();

	// Convert from polar to Cartesian in tangent space
	const localDir = vec3(
		sinTheta.mul( cos( phi ) ),
		sinTheta.mul( sin( phi ) ),
		cosTheta
	).toVar();

	// Transform to world space
	return normalize( T.mul( localDir.x ).add( B.mul( localDir.y ) ).add( N.mul( localDir.z ) ) );

} ).setLayout( {
	name: 'cosineWeightedSample',
	type: 'vec3',
	inputs: [
		{ name: 'N', type: 'vec3' },
		{ name: 'xi', type: 'vec2' }
	]
} );

/**
 * PDF for cosine-weighted hemisphere sampling.
 * Returns probability density for the sampled direction.
 *
 * @param {TSLNode} NoL - Normal dot Light direction (float)
 * @returns {TSLNode} PDF value (float)
 */
export const cosineWeightedPDF = Fn( ( [ NoL ] ) => {

	return max( NoL, float( MIN_PDF ) ).mul( PI_INV );

} ).setLayout( {
	name: 'cosineWeightedPDF',
	type: 'float',
	inputs: [
		{ name: 'NoL', type: 'float' }
	]
} );

// ================================================================================
// VNDF SAMPLING (VISIBLE NORMAL DISTRIBUTION FUNCTION)
// ================================================================================

/**
 * Sample GGX VNDF (Visible Normal Distribution Function).
 * More efficient than standard GGX sampling - only samples visible normals.
 * Based on Heitz 2018 "Sampling the GGX Distribution of Visible Normals".
 *
 * @param {TSLNode} V - View direction in local space (vec3)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @param {TSLNode} Xi - Random sample [0, 1]² (vec2)
 * @returns {TSLNode} Sampled half vector in local space (vec3)
 */
export const sampleGGXVNDF = Fn( ( [ V, roughness, Xi ] ) => {

	const alpha = roughness.mul( roughness ).toVar();

	// Transform view direction to hemisphere configuration
	const Vh = normalize( vec3( alpha.mul( V.x ), alpha.mul( V.y ), V.z ) ).toVar();

	// Construct orthonormal basis around view direction
	const lensq = Vh.x.mul( Vh.x ).add( Vh.y.mul( Vh.y ) ).toVar();

	const T1 = lensq.greaterThan( 1e-8 ).select(
		vec3( Vh.y.negate(), Vh.x, 0.0 ).div( sqrt( lensq ) ),
		vec3( 1.0, 0.0, 0.0 )
	).toVar();

	const T2 = cross( Vh, T1 ).toVar();

	// Sample point with polar coordinates (r, phi)
	const r = sqrt( Xi.x ).toVar();
	const phi = float( TWO_PI ).mul( Xi.y ).toVar();
	const t1 = r.mul( cos( phi ) ).toVar();
	const t2_initial = r.mul( sin( phi ) ).toVar();
	const s = float( 0.5 ).mul( float( 1.0 ).add( Vh.z ) ).toVar();

	const t2 = float( 1.0 ).sub( s )
		.mul( sqrt( float( 1.0 ).sub( t1.mul( t1 ) ) ) )
		.add( s.mul( t2_initial ) )
		.toVar();

	// Compute normal
	const Nh = T1.mul( t1 )
		.add( T2.mul( t2 ) )
		.add( Vh.mul( sqrt( max( float( 0.0 ), float( 1.0 ).sub( t1.mul( t1 ) ).sub( t2.mul( t2 ) ) ) ) ) )
		.toVar();

	// Transform back to ellipsoid configuration
	const Ne = normalize(
		vec3(
			alpha.mul( Nh.x ),
			alpha.mul( Nh.y ),
			max( float( 0.0 ), Nh.z )
		)
	);

	return Ne;

} ).setLayout( {
	name: 'sampleGGXVNDF',
	type: 'vec3',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'roughness', type: 'float' },
		{ name: 'Xi', type: 'vec2' }
	]
} );

// ================================================================================
// MULTI-LOBE MIS SAMPLING (Conditional - requires full material system)
// ================================================================================

// Note: Multi-lobe MIS functions require additional struct definitions and are
// implemented when ENABLE_MULTI_LOBE_MIS is true. These functions include:
// - calculateSamplingWeights(): Compute importance weights for each BRDF lobe
// - calculateMultiLobeMISWeight(): Compute MIS weight using power heuristic
// - sampleMaterialWithMultiLobeMIS(): Sample material using multi-lobe MIS
//
// Full implementation requires:
// - MultiLobeWeights struct
// - SamplingResult struct
// - Material classification functions
// - BRDF weight calculation
// - Full material evaluation
//
// These are typically implemented at the application level where all material
// properties and classification functions are available.

/**
 * Calculate sampling weights for multi-lobe MIS.
 * Computes importance weights for each BRDF lobe based on material properties.
 * Only available when ENABLE_MULTI_LOBE_MIS is true.
 *
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} MultiLobeWeights struct with normalized weights
 *
 * Note: This is a placeholder - full implementation requires material classification
 */
export const calculateSamplingWeights = Fn( ( [ V, N, material ] ) => {

	// Simplified implementation - full version requires MaterialClassification and BRDFWeights
	const NoV = max( dot( N, V ), float( 0.0 ) ).toVar();
	const fresnelFactor = pow( float( 1.0 ).sub( NoV ), 5.0 ).toVar();

	// Basic weight calculation (simplified)
	const diffuseWeight = float( 1.0 ).sub( material.metalness ).toVar();
	const specularWeight = float( 1.0 ).sub( material.roughness ).toVar();

	const totalWeight = diffuseWeight.add( specularWeight ).toVar();
	const invTotal = float( 1.0 ).div( max( totalWeight, float( 1e-6 ) ) ).toVar();

	// Return as property object (TSL pattern for struct-like returns)
	return {
		diffuse: diffuseWeight.mul( invTotal ),
		specular: specularWeight.mul( invTotal ),
		clearcoat: material.clearcoat.mul( invTotal ),
		transmission: material.transmission.mul( invTotal ),
		sheen: material.sheen.mul( invTotal ),
		iridescence: material.iridescence.mul( invTotal ),
		totalWeight: totalWeight
	};

} ).setLayout( {
	name: 'calculateSamplingWeights',
	type: 'MultiLobeWeights',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

/**
 * Calculate MIS weight using power heuristic.
 * Computes Multiple Importance Sampling weight considering all sampling strategies.
 * Only available when ENABLE_MULTI_LOBE_MIS is true.
 *
 * @param {TSLNode} sampledDirection - Sampled light direction (vec3)
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} weights - MultiLobeWeights struct
 * @param {TSLNode} selectedPdf - PDF of selected sampling strategy (float)
 * @returns {TSLNode} MIS weight [0, 1] (float)
 *
 * Note: Full implementation requires PDF calculation functions for all lobes
 */
export const calculateMultiLobeMISWeight = Fn( ( [ sampledDirection, V, N, material, weights, selectedPdf ] ) => {

	// Simplified MIS weight calculation
	// Full version would compute PDFs for all lobes and apply power heuristic

	const NoL = dot( N, sampledDirection ).toVar();

	// Basic diffuse PDF
	const diffusePdf = NoL.greaterThan( 0.0 ).select(
		NoL.div( PI ),
		float( 0.0 )
	).toVar();

	// Half vector for specular calculations
	const H = normalize( V.add( sampledDirection ) ).toVar();
	const NoH = max( dot( N, H ), float( 0.0 ) ).toVar();
	const VoH = max( dot( V, H ), float( 0.0 ) ).toVar();

	// Simplified specular PDF (would use calculateGGXPDF in full version)
	const alpha = material.roughness.mul( material.roughness ).toVar();
	const alpha2 = alpha.mul( alpha ).toVar();
	const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 ).toVar();
	const D = alpha2.div( max( float( PI ).mul( denom ).mul( denom ), float( EPSILON ) ) ).toVar();
	const specularPdf = D.mul( NoH ).div( max( float( 4.0 ).mul( VoH ), float( EPSILON ) ) ).toVar();

	// Power heuristic with weighted PDFs
	const weightedDiffusePdf = weights.diffuse.mul( diffusePdf ).toVar();
	const weightedSpecularPdf = weights.specular.mul( specularPdf ).toVar();

	const sumSquaredPdfs = weightedDiffusePdf.mul( weightedDiffusePdf )
		.add( weightedSpecularPdf.mul( weightedSpecularPdf ) )
		.toVar();

	// MIS weight: selectedPdf² / Σ(pdf_i²)
	const misWeight = sumSquaredPdfs.greaterThan( 0.0 ).and( selectedPdf.greaterThan( 0.0 ) ).select(
		selectedPdf.mul( selectedPdf ).div( sumSquaredPdfs ),
		float( 1.0 )
	);

	return misWeight;

} ).setLayout( {
	name: 'calculateMultiLobeMISWeight',
	type: 'float',
	inputs: [
		{ name: 'sampledDirection', type: 'vec3' },
		{ name: 'V', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'weights', type: 'MultiLobeWeights' },
		{ name: 'selectedPdf', type: 'float' }
	]
} );

/**
 * Sample material using multi-lobe MIS.
 * Importance samples the material BRDF considering all lobes with MIS weighting.
 * Only available when ENABLE_MULTI_LOBE_MIS is true.
 *
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} xi - Random sample [0, 1]² (vec2)
 * @param {TSLNode} rngState - RNG state (uint, mutable)
 * @returns {TSLNode} SamplingResult struct with direction, value, pdf
 *
 * Note: This is a simplified version - full implementation requires all BRDF sampling functions
 */
export const sampleMaterialWithMultiLobeMIS = Fn( ( [ V, N, material, xi, rngState ] ) => {

	// Calculate lobe weights
	const weights = calculateSamplingWeights( V, N, material );

	// Simplified sampling - full version would sample all lobes
	const rand = xi.x.toVar();

	const sampledDirection = vec3( 0.0 ).toVar();
	const lobePdf = float( 0.0 ).toVar();

	// Diffuse vs specular selection (simplified)
	If( rand.lessThan( weights.diffuse ), () => {

		// Diffuse sampling
		sampledDirection.assign( importanceSampleCosine( N, xi ) );
		lobePdf.assign( max( dot( N, sampledDirection ), float( 0.0 ) ).div( PI ) );

	} ).Else( () => {

		// Specular sampling
		const H = importanceSampleGGX( N, material.roughness, xi ).toVar();
		// Note: reflect not directly available in TSL, use manual calculation
		const VdotH = dot( V.negate(), H ).toVar();
		sampledDirection.assign( normalize( V.negate().add( H.mul( VdotH.mul( 2.0 ) ) ) ) );

		const NoH = max( dot( N, H ), float( 0.0 ) ).toVar();
		const VoH = max( dot( V, H ), float( 0.0 ) ).toVar();

		const alpha = material.roughness.mul( material.roughness ).toVar();
		const alpha2 = alpha.mul( alpha ).toVar();
		const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 ).toVar();
		const D = alpha2.div( max( float( PI ).mul( denom ).mul( denom ), float( EPSILON ) ) ).toVar();

		lobePdf.assign( D.mul( NoH ).div( max( float( 4.0 ).mul( VoH ), float( EPSILON ) ) ) );

	} );

	const pdf = lobePdf.toVar();

	// Calculate MIS weight
	const misWeight = calculateMultiLobeMISWeight( sampledDirection, V, N, material, weights, pdf ).toVar();

	// Evaluate material response
	const value = evaluateMaterialResponse( V, sampledDirection, N, material ).mul( misWeight ).toVar();

	// Return as property object (TSL pattern for struct-like returns)
	return {
		direction: sampledDirection,
		value: value,
		pdf: pdf
	};

} ).setLayout( {
	name: 'sampleMaterialWithMultiLobeMIS',
	type: 'SamplingResult',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'xi', type: 'vec2' },
		{ name: 'rngState', type: 'uint' }
	]
} );

// ================================================================================
// HELPER UTILITIES
// ================================================================================

/**
 * Construct tangent-bitangent-normal (TBN) basis from normal.
 * Creates an orthonormal coordinate system for local-to-world transforms.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @returns {TSLNode} Object with T (tangent), B (bitangent), N (normal) as vec3
 */
export const constructTBN = Fn( ( [ N ] ) => {

	const up = abs( N.z ).lessThan( 0.999 ).select(
		vec3( 0.0, 0.0, 1.0 ),
		vec3( 1.0, 0.0, 0.0 )
	).toVar();

	const T = normalize( cross( up, N ) ).toVar();
	const B = cross( N, T ).toVar();

	return {
		T: T,
		B: B,
		N: N
	};

} ).setLayout( {
	name: 'constructTBN',
	type: 'TBN',
	inputs: [
		{ name: 'N', type: 'vec3' }
	]
} );
