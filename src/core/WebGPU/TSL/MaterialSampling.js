import {
	Fn, float, vec3, vec2, int, uint,
	If, max, min, abs, sqrt, cos, sin, normalize, cross, reflect, refract, dot, pow
} from 'three/tsl';

import {
	MultiLobeWeights, DirectionSample, MaterialCache, MaterialClassification
} from './Struct.js';

import {
	PI, TWO_PI, PI_INV, MIN_PDF, EPSILON,
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

export const ImportanceSampleGGX = Fn( ( [ N, roughness, Xi ] ) => {

	const alpha = roughness.mul( roughness );
	const phi = float( TWO_PI ).mul( Xi.x );
	const cosTheta = sqrt( float( 1.0 ).sub( Xi.y ).div( float( 1.0 ).add( alpha.mul( alpha ).sub( 1.0 ).mul( Xi.y ) ) ) );
	const sinTheta = sqrt( max( float( 0.0 ), float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) );

	// Spherical to cartesian conversion
	const H = vec3( cos( phi ).mul( sinTheta ), sin( phi ).mul( sinTheta ), cosTheta );

	// TBN construction
	const up = abs( N.z ).lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
	const tangent = normalize( cross( up, N ) ).toVar( 'ggxTang' );
	const bitangent = cross( N, tangent ).toVar( 'ggxBitang' );

	return normalize( tangent.mul( H.x ).add( bitangent.mul( H.y ) ).add( N.mul( H.z ) ) );

} );

export const ImportanceSampleCosine = Fn( ( [ N, xi ] ) => {

	const T = normalize( cross( N, N.yzx.add( vec3( 0.1, 0.2, 0.3 ) ) ) ).toVar( 'cosT' );
	const B = cross( N, T ).toVar( 'cosB' );

	// Cosine-weighted sampling
	const phi = float( TWO_PI ).mul( xi.x );
	const cosTheta = sqrt( float( 1.0 ).sub( xi.y ) );
	const sinTheta = sqrt( xi.y );

	// Convert from polar to Cartesian coordinates
	const localDir = vec3( sinTheta.mul( cos( phi ) ), sinTheta.mul( sin( phi ) ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T.mul( localDir.x ).add( B.mul( localDir.y ) ).add( N.mul( localDir.z ) ) );

} );

export const cosineWeightedSample = Fn( ( [ N, xi ] ) => {

	// Construct a local coordinate system (TBN)
	const T = normalize( cross( N, N.yzx.add( vec3( 0.1, 0.2, 0.3 ) ) ) ).toVar( 'cwsT' );
	const B = cross( N, T ).toVar( 'cwsB' );

	// Cosine-weighted sampling using concentric disk mapping
	// Convert to polar coordinates
	const phi = float( TWO_PI ).mul( xi.y );
	const cosTheta = sqrt( float( 1.0 ).sub( xi.x ) );
	const sinTheta = sqrt( xi.x );

	// Convert from polar to Cartesian coordinates in tangent space
	const localDir = vec3( sinTheta.mul( cos( phi ) ), sinTheta.mul( sin( phi ) ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T.mul( localDir.x ).add( B.mul( localDir.y ) ).add( N.mul( localDir.z ) ) );

} );

export const cosineWeightedPDF = Fn( ( [ NoL ] ) => {

	return max( NoL, MIN_PDF ).mul( PI_INV );

} );

// -----------------------------------------------------------------------------
// VNDF Sampling (Visible Normal Distribution Function)
// -----------------------------------------------------------------------------

export const sampleGGXVNDF = Fn( ( [ V, roughness, Xi ] ) => {

	const alpha = roughness.mul( roughness );
	// Transform view direction to local space
	const Vh = normalize( vec3( alpha.mul( V.x ), alpha.mul( V.y ), V.z ) ).toVar( 'vndfVh' );

	// Construct orthonormal basis around view direction
	const lensq = Vh.x.mul( Vh.x ).add( Vh.y.mul( Vh.y ) ).toVar( 'vndfLensq' );
	const T1 = lensq.greaterThan( 1e-8 ).select(
		vec3( Vh.y.negate(), Vh.x, 0.0 ).div( sqrt( lensq ) ),
		vec3( 1.0, 0.0, 0.0 )
	).toVar( 'vndfT1' );
	const T2 = cross( Vh, T1 ).toVar( 'vndfT2' );

	// Sample point with polar coordinates (r, phi)
	const r = sqrt( Xi.x );
	const phi = float( TWO_PI ).mul( Xi.y );
	const t1 = r.mul( cos( phi ) ).toVar( 'vndfT1v' );
	const t2Tmp = r.mul( sin( phi ) ).toVar( 'vndfT2v' );
	const s = float( 0.5 ).mul( float( 1.0 ).add( Vh.z ) );
	const t2 = float( 1.0 ).sub( s ).mul( sqrt( float( 1.0 ).sub( t1.mul( t1 ) ) ) ).add( s.mul( t2Tmp ) ).toVar( 'vndfT2f' );

	// Compute normal
	const Nh = T1.mul( t1 ).add( T2.mul( t2 ) ).add(
		Vh.mul( sqrt( max( float( 0.0 ), float( 1.0 ).sub( t1.mul( t1 ) ).sub( t2.mul( t2 ) ) ) ) )
	).toVar( 'vndfNh' );

	// Transform the normal back to the ellipsoid configuration
	const Ne = normalize( vec3( alpha.mul( Nh.x ), alpha.mul( Nh.y ), max( float( 0.0 ), Nh.z ) ) );
	return Ne;

} );

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
	const diffuse = brdfWeights.diffuse.mul( float( 1.0 ).sub( fresnelFactor.mul( 0.3 ) ) ).toVar( 'mlwDiff' );

	// Enhanced specular weight (increased at grazing angles)
	const specular = brdfWeights.specular.mul( float( 1.0 ).add( fresnelFactor.mul( 0.5 ) ) ).toVar( 'mlwSpec' );

	// Clearcoat weight with fresnel enhancement
	const clearcoat = brdfWeights.clearcoat.mul( float( 1.0 ).add( fresnelFactor.mul( 0.8 ) ) ).toVar( 'mlwCc' );

	// Transmission weight (view-dependent)
	const transmission = brdfWeights.transmission.mul( tempIorFactor ).toVar( 'mlwTrans' );

	// Sheen weight (enhanced at grazing angles)
	const sheen = brdfWeights.sheen.mul( float( 1.0 ).add( fresnelFactor ) ).toVar( 'mlwSheen' );

	// Iridescence weight
	const iridescence = brdfWeights.iridescence.mul( float( 1.0 ).add( fresnelFactor.mul( 0.6 ) ) ).toVar( 'mlwIrid' );

	// Calculate total weight for normalization
	const totalWeight = max(
		diffuse.add( specular ).add( clearcoat ).add( transmission ).add( sheen ).add( iridescence ),
		1e-6
	).toVar( 'mlwTotal' );

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
	const diffusePdf = float( 0.0 ).toVar( 'misDiffPdf' );
	const specularPdf = float( 0.0 ).toVar( 'misSpecPdf' );
	const clearcoatPdf = float( 0.0 ).toVar( 'misCcPdf' );
	const transmissionPdf = float( 0.0 ).toVar( 'misTransPdf' );
	const sheenPdf = float( 0.0 ).toVar( 'misSheenPdf' );

	const NoL = dot( N, sampledDirection );

	// Diffuse PDF
	If( NoL.greaterThan( 0.0 ), () => {

		diffusePdf.assign( NoL.div( PI ) );

	} );

	// Specular PDF
	const H = normalize( V.add( sampledDirection ) ).toVar( 'misH' );
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
	const misWeight = float( 1.0 ).toVar( 'misW' );

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

	const sampledDirection = vec3( 0.0 ).toVar( 'mlSampDir' );
	const lobePdf = float( 0.0 ).toVar( 'mlLobePdf' );
	const resultPdf = float( 0.0 ).toVar( 'mlResultPdf' );

	If( rand.lessThan( cumulativeDiffuse ), () => {

		// Diffuse sampling
		sampledDirection.assign( ImportanceSampleCosine( N, xi ) );
		lobePdf.assign( max( dot( N, sampledDirection ), 0.0 ).div( PI ) );
		resultPdf.assign( lobePdf.mul( weights.diffuse ) );

	} ).ElseIf( rand.lessThan( cumulativeSpecular ), () => {

		// Specular sampling
		const H = ImportanceSampleGGX( N, material.roughness, xi ).toVar( 'mlSpecH' );
		sampledDirection.assign( reflect( V.negate(), H ) );

		If( dot( N, sampledDirection ).greaterThan( 0.0 ), () => {

			const NoH = max( dot( N, H ), 0.0 );
			const VoH = max( dot( V, H ), 0.0 );
			lobePdf.assign( calculateGGXPDF( NoH, VoH, material.roughness ) );

		} );

		resultPdf.assign( lobePdf.mul( weights.specular ) );

	} ).ElseIf( rand.lessThan( cumulativeClearcoat ).and( material.clearcoat.greaterThan( 0.0 ) ), () => {

		// Clearcoat sampling
		const H = ImportanceSampleGGX( N, material.clearcoatRoughness, xi ).toVar( 'mlCcH' );
		sampledDirection.assign( reflect( V.negate(), H ) );

		If( dot( N, sampledDirection ).greaterThan( 0.0 ), () => {

			const NoH = max( dot( N, H ), 0.0 );
			const VoH = max( dot( V, H ), 0.0 );
			lobePdf.assign( calculateGGXPDF( NoH, VoH, material.clearcoatRoughness ) );

		} );

		resultPdf.assign( lobePdf.mul( weights.clearcoat ) );

	} ).ElseIf( rand.lessThan( cumulativeTransmission ).and( material.transmission.greaterThan( 0.0 ) ), () => {

		// Transmission sampling - simplified approach
		const H = ImportanceSampleGGX( N, material.roughness, xi ).toVar( 'mlTransH' );
		const refractionDir = refract( V.negate(), H, float( 1.0 ).div( material.ior ) ).toVar( 'mlRefDir' );

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
		sampledDirection.assign( ImportanceSampleCosine( N, xi ) );
		lobePdf.assign( max( dot( N, sampledDirection ), 0.0 ).div( PI ) );
		resultPdf.assign( lobePdf.mul( weights.sheen.add( weights.iridescence ) ) );

	} );

	// Calculate MIS weight considering all possible sampling strategies
	const misWeight = calculateMultiLobeMISWeight( sampledDirection, V, N, material, weights, resultPdf );

	const resultValue = evaluateMaterialResponse( V, sampledDirection, N, material ).toVar( 'mlValue' );
	resultValue.mulAssign( misWeight );

	return DirectionSample( {
		direction: sampledDirection,
		value: resultValue,
		pdf: resultPdf,
	} );

} );
