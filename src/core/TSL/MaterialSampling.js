import {
	Fn, wgslFn, float, vec3, vec2, int, uint,
	If, max, min, abs, normalize, reflect, refract, dot, pow
} from 'three/tsl';

import {
	MultiLobeWeights, DirectionSample, MaterialCache, MaterialClassification
} from './Struct.js';

import {
	PI, PI_INV, MIN_PDF, EPSILON,
	classifyMaterial, square,
} from './Common.js';

import { calculateBRDFWeights, calculateGGXPDF } from './MaterialProperties.js';
import { RandomValue } from './Random.js';

// =============================================================================
// MATERIAL SAMPLING
// =============================================================================
// This file contains importance sampling functions for various BRDF lobes
// including GGX, cosine-weighted hemisphere, VNDF, and multi-lobe MIS.

// -----------------------------------------------------------------------------
// Basic Sampling Functions
// -----------------------------------------------------------------------------

export const ImportanceSampleGGX = /*@__PURE__*/ wgslFn( `
	fn ImportanceSampleGGX( N: vec3f, roughness: f32, Xi: vec2f ) -> vec3f {
		let alpha = roughness * roughness;
		let phi = 6.28318530717958647692f * Xi.x;
		let cosTheta = sqrt( ( 1.0f - Xi.y ) / ( 1.0f + ( alpha * alpha - 1.0f ) * Xi.y ) );
		let sinTheta = sqrt( max( 0.0f, 1.0f - cosTheta * cosTheta ) );
		let H = vec3f( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );
		// TBN construction
		let up = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( 0.0f, 0.0f, 1.0f ), abs( N.z ) < 0.999f );
		let tangent = normalize( cross( up, N ) );
		let bitangent = cross( N, tangent );
		return normalize( tangent * H.x + bitangent * H.y + N * H.z );
	}
` );

export const ImportanceSampleCosine = /*@__PURE__*/ wgslFn( `
	fn ImportanceSampleCosine( N: vec3f, xi: vec2f ) -> vec3f {
		let T = normalize( cross( N, N.yzx + vec3f( 0.1f, 0.2f, 0.3f ) ) );
		let B = cross( N, T );
		let phi = 6.28318530717958647692f * xi.x;
		let cosTheta = sqrt( 1.0f - xi.y );
		let sinTheta = sqrt( xi.y );
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
	}
` );

export const cosineWeightedSample = /*@__PURE__*/ wgslFn( `
	fn cosineWeightedSample( N: vec3f, xi: vec2f ) -> vec3f {
		let T = normalize( cross( N, N.yzx + vec3f( 0.1f, 0.2f, 0.3f ) ) );
		let B = cross( N, T );
		let phi = 6.28318530717958647692f * xi.y;
		let cosTheta = sqrt( 1.0f - xi.x );
		let sinTheta = sqrt( xi.x );
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
	}
` );

export const cosineWeightedPDF = Fn( ( [ NoL ] ) => {

	return max( NoL, MIN_PDF ).mul( PI_INV );

} );

// -----------------------------------------------------------------------------
// VNDF Sampling (Visible Normal Distribution Function)
// -----------------------------------------------------------------------------

export const sampleGGXVNDF = /*@__PURE__*/ wgslFn( `
	fn sampleGGXVNDF( V: vec3f, roughness: f32, Xi: vec2f ) -> vec3f {
		let alpha = roughness * roughness;
		// Transform view direction to local space
		let Vh = normalize( vec3f( alpha * V.x, alpha * V.y, V.z ) );
		// Construct orthonormal basis around view direction
		let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
		let T1 = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( -Vh.y, Vh.x, 0.0f ) / sqrt( lensq ), lensq > 1e-8f );
		let T2 = cross( Vh, T1 );
		// Sample point with polar coordinates (r, phi)
		let r = sqrt( Xi.x );
		let phi = 6.28318530717958647692f * Xi.y;
		let t1 = r * cos( phi );
		let t2tmp = r * sin( phi );
		let s = 0.5f * ( 1.0f + Vh.z );
		let t2 = ( 1.0f - s ) * sqrt( 1.0f - t1 * t1 ) + s * t2tmp;
		// Compute normal
		let Nh = T1 * t1 + T2 * t2 + Vh * sqrt( max( 0.0f, 1.0f - t1 * t1 - t2 * t2 ) );
		// Transform the normal back to the ellipsoid configuration
		return normalize( vec3f( alpha * Nh.x, alpha * Nh.y, max( 0.0f, Nh.z ) ) );
	}
` );

// -----------------------------------------------------------------------------
// Multi-Lobe MIS Sampling
// -----------------------------------------------------------------------------

// Enhanced sampling weights calculation for multi-lobe MIS
export const calculateSamplingWeights = Fn( ( [ V, N, material ] ) => {

	// Get material classification for optimized calculations
	const mc = MaterialClassification.wrap( classifyMaterial( material ) );

	// Create temporary cache values
	const tempInvRoughness = float( 1.0 ).sub( material.roughness );
	const tempMetalFactor = float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) );
	const tempIorFactor = min( float( 2.0 ).div( material.ior ), 1.0 );
	const tempMaxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );

	// Create temporary cache for calculations
	const tempCache = MaterialCache( {
		NoV: float( 0.5 ),
		isPurelyDiffuse: false,
		isMetallic: mc.isMetallic,
		hasSpecialFeatures: false,
		alpha: material.roughness.mul( material.roughness ),
		alpha2: material.roughness.mul( material.roughness ).mul( material.roughness ).mul( material.roughness ),
		k: material.roughness.add( 1.0 ).mul( material.roughness.add( 1.0 ) ).div( 8.0 ),
		F0: vec3( 0.04 ),
		diffuseColor: material.color.rgb,
		specularColor: material.color.rgb,
		tsAlbedo: material.color, // placeholder
		tsEmissive: vec3( 0.0 ),
		tsMetalness: float( 0.0 ),
		tsRoughness: material.roughness,
		tsNormal: vec3( 0.0, 1.0, 0.0 ),
		tsHasTextures: false,
		invRoughness: tempInvRoughness,
		metalFactor: tempMetalFactor,
		iorFactor: tempIorFactor,
		maxSheenColor: tempMaxSheenColor,
	} );

	// Calculate base BRDF weights
	const brdfWeights = BRDFWeights.wrap( calculateBRDFWeights( material, mc, tempCache ) );

	// Calculate view-dependent factors
	const NoV = max( dot( N, V ), 0.0 );
	const fresnelFactor = pow( float( 1.0 ).sub( NoV ), 5.0 );

	// Enhanced diffuse weight (reduced at grazing angles)
	const diffuse = brdfWeights.diffuse.mul( float( 1.0 ).sub( fresnelFactor.mul( 0.3 ) ) ).toVar();

	// Enhanced specular weight (increased at grazing angles)
	const specular = brdfWeights.specular.mul( float( 1.0 ).add( fresnelFactor.mul( 0.5 ) ) ).toVar();

	// Clearcoat weight with fresnel enhancement
	const clearcoat = brdfWeights.clearcoat.mul( float( 1.0 ).add( fresnelFactor.mul( 0.8 ) ) ).toVar();

	// Transmission weight (view-dependent)
	const transmission = brdfWeights.transmission.mul( tempIorFactor ).toVar();

	// Sheen weight (enhanced at grazing angles)
	const sheen = brdfWeights.sheen.mul( float( 1.0 ).add( fresnelFactor ) ).toVar();

	// Iridescence weight
	const iridescence = brdfWeights.iridescence.mul( float( 1.0 ).add( fresnelFactor.mul( 0.6 ) ) ).toVar();

	// Calculate total weight for normalization
	const totalWeight = max(
		diffuse.add( specular ).add( clearcoat ).add( transmission ).add( sheen ).add( iridescence ),
		1e-6
	).toVar();

	// Normalize weights
	const invTotal = float( 1.0 ).div( totalWeight );

	return MultiLobeWeights( {
		diffuse: diffuse.mul( invTotal ),
		specular: specular.mul( invTotal ),
		clearcoat: clearcoat.mul( invTotal ),
		transmission: transmission.mul( invTotal ),
		sheen: sheen.mul( invTotal ),
		iridescence: iridescence.mul( invTotal ),
		totalWeight,
	} );

} );

// Calculate MIS weight considering all possible sampling strategies
export const calculateMultiLobeMISWeight = Fn( ( [
	sampledDirection, V, N, material, weights, selectedPdf
] ) => {

	// Calculate PDFs for all possible sampling strategies
	const diffusePdf = float( 0.0 ).toVar();
	const specularPdf = float( 0.0 ).toVar();
	const clearcoatPdf = float( 0.0 ).toVar();
	const transmissionPdf = float( 0.0 ).toVar();
	const sheenPdf = float( 0.0 ).toVar();

	const NoL = dot( N, sampledDirection );

	// Diffuse PDF
	If( NoL.greaterThan( 0.0 ), () => {

		diffusePdf.assign( NoL.div( PI ) );

	} );

	// Specular PDF
	const H = normalize( V.add( sampledDirection ) ).toVar();
	const NoH = max( dot( N, H ), 0.0 );
	const VoH = max( dot( V, H ), 0.0 );
	const NoV = max( dot( N, V ), 0.0 );

	If( NoH.greaterThan( 0.0 ).and( VoH.greaterThan( 0.0 ) ).and( NoV.greaterThan( 0.0 ) ), () => {

		specularPdf.assign( calculateGGXPDF( NoH, VoH, material.roughness ) );

		// Clearcoat PDF (using clearcoat roughness)
		If( material.clearcoat.greaterThan( 0.0 ), () => {

			clearcoatPdf.assign( calculateGGXPDF( NoH, VoH, material.clearcoatRoughness ) );

		} );

	} );

	// Transmission PDF (simplified)
	If( material.transmission.greaterThan( 0.0 ).and( NoL.lessThan( 0.0 ) ), () => {

		// For transmission, we're sampling the opposite hemisphere
		transmissionPdf.assign( abs( NoL ).div( PI ) );

	} );

	// Sheen PDF (approximated as diffuse)
	If( material.sheen.greaterThan( 0.0 ).and( NoL.greaterThan( 0.0 ) ), () => {

		sheenPdf.assign( NoL.div( PI ) );

	} );

	// Calculate weighted PDFs for each lobe
	const weightedDiffusePdf = weights.diffuse.mul( diffusePdf );
	const weightedSpecularPdf = weights.specular.mul( specularPdf );
	const weightedClearcoatPdf = weights.clearcoat.mul( clearcoatPdf );
	const weightedTransmissionPdf = weights.transmission.mul( transmissionPdf );
	const weightedSheenPdf = weights.sheen.mul( sheenPdf );
	const weightedIridescencePdf = weights.iridescence.mul( diffusePdf );

	// Power heuristic (β=2): sum of squared weighted PDFs
	const sumSquaredPdfs = weightedDiffusePdf.mul( weightedDiffusePdf )
		.add( weightedSpecularPdf.mul( weightedSpecularPdf ) )
		.add( weightedClearcoatPdf.mul( weightedClearcoatPdf ) )
		.add( weightedTransmissionPdf.mul( weightedTransmissionPdf ) )
		.add( weightedSheenPdf.mul( weightedSheenPdf ) )
		.add( weightedIridescencePdf.mul( weightedIridescencePdf ) );

	// MIS weight: selectedPdf² / Σ(pdf_i²)
	const misWeight = float( 1.0 ).toVar();

	If( sumSquaredPdfs.greaterThan( 0.0 ).and( selectedPdf.greaterThan( 0.0 ) ), () => {

		const selectedPdfSquared = selectedPdf.mul( selectedPdf );
		misWeight.assign( selectedPdfSquared.div( sumSquaredPdfs ) );

	} );

	return misWeight;

} );

// Multi-lobe MIS for complex materials
// Note: evaluateMaterialResponse is imported from MaterialEvaluation.js at usage site
export const sampleMaterialWithMultiLobeMIS = Fn( ( [
	V, N, material, xi, rngState, evaluateMaterialResponse
] ) => {

	// Calculate individual lobe weights
	const weights = calculateSamplingWeights( V, N, material );

	// Multi-importance sampling across different lobes
	const rand = RandomValue( rngState );
	const cumulativeDiffuse = weights.diffuse;
	const cumulativeSpecular = cumulativeDiffuse.add( weights.specular );
	const cumulativeClearcoat = cumulativeSpecular.add( weights.clearcoat );
	const cumulativeTransmission = cumulativeClearcoat.add( weights.transmission );

	const sampledDirection = vec3( 0.0 ).toVar();
	const lobePdf = float( 0.0 ).toVar();
	const resultPdf = float( 0.0 ).toVar();

	If( rand.lessThan( cumulativeDiffuse ), () => {

		// Diffuse sampling
		sampledDirection.assign( ImportanceSampleCosine( { N, xi } ) );
		lobePdf.assign( max( dot( N, sampledDirection ), 0.0 ).div( PI ) );
		resultPdf.assign( lobePdf.mul( weights.diffuse ) );

	} ).ElseIf( rand.lessThan( cumulativeSpecular ), () => {

		// Specular sampling
		const H = ImportanceSampleGGX( { N, roughness: material.roughness, Xi: xi } ).toVar();
		sampledDirection.assign( reflect( V.negate(), H ) );

		If( dot( N, sampledDirection ).greaterThan( 0.0 ), () => {

			const NoH = max( dot( N, H ), 0.0 );
			const VoH = max( dot( V, H ), 0.0 );
			lobePdf.assign( calculateGGXPDF( NoH, VoH, material.roughness ) );

		} );

		resultPdf.assign( lobePdf.mul( weights.specular ) );

	} ).ElseIf( rand.lessThan( cumulativeClearcoat ).and( material.clearcoat.greaterThan( 0.0 ) ), () => {

		// Clearcoat sampling
		const H = ImportanceSampleGGX( { N, roughness: material.clearcoatRoughness, Xi: xi } ).toVar();
		sampledDirection.assign( reflect( V.negate(), H ) );

		If( dot( N, sampledDirection ).greaterThan( 0.0 ), () => {

			const NoH = max( dot( N, H ), 0.0 );
			const VoH = max( dot( V, H ), 0.0 );
			lobePdf.assign( calculateGGXPDF( NoH, VoH, material.clearcoatRoughness ) );

		} );

		resultPdf.assign( lobePdf.mul( weights.clearcoat ) );

	} ).ElseIf( rand.lessThan( cumulativeTransmission ).and( material.transmission.greaterThan( 0.0 ) ), () => {

		// Transmission sampling - simplified approach
		const H = ImportanceSampleGGX( { N, roughness: material.roughness, Xi: xi } ).toVar();
		const refractionDir = refract( V.negate(), H, float( 1.0 ).div( material.ior ) ).toVar();

		If( dot( refractionDir, refractionDir ).greaterThan( 0.001 ), () => {

			sampledDirection.assign( normalize( refractionDir ) );
			const NoH = max( dot( N, H ), 0.0 );
			const VoH = max( dot( V, H ), 0.0 );
			lobePdf.assign( calculateGGXPDF( NoH, VoH, material.roughness ) );

		} ).Else( () => {

			// Total internal reflection - fallback to specular
			sampledDirection.assign( reflect( V.negate(), H ) );
			lobePdf.assign( 0.1 );

		} );

		resultPdf.assign( lobePdf.mul( weights.transmission ) );

	} ).Else( () => {

		// Fallback to diffuse sampling for sheen/iridescence
		sampledDirection.assign( ImportanceSampleCosine( { N, xi } ) );
		lobePdf.assign( max( dot( N, sampledDirection ), 0.0 ).div( PI ) );
		resultPdf.assign( lobePdf.mul( weights.sheen.add( weights.iridescence ) ) );

	} );

	// Calculate MIS weight considering all possible sampling strategies
	const misWeight = calculateMultiLobeMISWeight( sampledDirection, V, N, material, weights, resultPdf );

	const resultValue = evaluateMaterialResponse( V, sampledDirection, N, material ).toVar();
	resultValue.mulAssign( misWeight );

	return DirectionSample( {
		direction: sampledDirection,
		value: resultValue,
		pdf: resultPdf,
	} );

} );
