import { Fn, float, vec3, vec4, int, If, dot, max, min, sqrt, cos, exp, mix, clamp, smoothstep, lessThan, select } from 'three/tsl';

import {
	BRDFWeights,
	MaterialClassification,
	MaterialCache,
	ImportanceSamplingInfo,
	MaterialSamples,
} from './Struct.js';

import {
	PI, TWO_PI, EPSILON, MIN_ROUGHNESS, REC709_LUMINANCE_COEFFICIENTS,
	XYZ_TO_REC709, square, squareVec3, maxComponent,
} from './Common.js';

import {
	fresnelSchlickFloat, fresnel0ToIor, iorToFresnel0Vec3, iorToFresnel0,
} from './Fresnel.js';

// -----------------------------------------------------------------------------
// Microfacet Distribution Functions
// -----------------------------------------------------------------------------

export const DistributionGGX = Fn( ( [ NoH, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );
	const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 );
	return alpha2.div( max( float( PI ).mul( denom ).mul( denom ), EPSILON ) );

} );

export const SheenDistribution = Fn( ( [ NoH, roughness ] ) => {

	const clampedRoughness = max( roughness, MIN_ROUGHNESS );
	const alpha = clampedRoughness.mul( clampedRoughness );
	const invAlpha = float( 1.0 ).div( alpha );
	const d = NoH.mul( NoH ).mul( invAlpha.mul( invAlpha ).sub( 1.0 ) ).add( 1.0 );
	return min( invAlpha.mul( invAlpha ).div( max( float( PI ).mul( d ).mul( d ), EPSILON ) ), 100.0 );

} );

// -----------------------------------------------------------------------------
// Geometry Terms
// -----------------------------------------------------------------------------

export const GeometrySchlickGGX = Fn( ( [ NdotV, roughness ] ) => {

	const r = roughness.add( 1.0 );
	const k = r.mul( r ).div( 8.0 );
	return NdotV.div( max( NdotV.mul( float( 1.0 ).sub( k ) ).add( k ), EPSILON ) );

} );

export const GeometrySmith = Fn( ( [ NoV, NoL, roughness ] ) => {

	const ggx2 = GeometrySchlickGGX( NoV, roughness );
	const ggx1 = GeometrySchlickGGX( NoL, roughness );
	return ggx1.mul( ggx2 );

} );

// -----------------------------------------------------------------------------
// PDF Calculation Helpers
// -----------------------------------------------------------------------------

// Calculate PDF for standard GGX importance sampling
// Formula: D(H) * NoH / (4 * VoH)
export const calculateGGXPDF = Fn( ( [ NoH, VoH, roughness ] ) => {

	const D = DistributionGGX( NoH, roughness );
	return D.mul( NoH ).div( max( float( 4.0 ).mul( VoH ), EPSILON ) );

} );

// Calculate PDF for VNDF sampling
// Formula: G1(V) * D(H) / (NoV * 4)
export const calculateVNDFPDF = Fn( ( [ NoH, NoV, roughness ] ) => {

	const D = DistributionGGX( NoH, roughness );
	const G1 = GeometrySchlickGGX( NoV, roughness );
	return D.mul( G1 ).div( max( NoV.mul( 4.0 ), EPSILON ) );

} );

// -----------------------------------------------------------------------------
// Iridescence Evaluation
// -----------------------------------------------------------------------------

export const evalSensitivity = Fn( ( [ OPD, shift ] ) => {

	const phase = float( TWO_PI ).mul( OPD ).mul( 1.0e-9 );
	const val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	const pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	const vr = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

	const xyz = val.mul( sqrt( float( TWO_PI ).mul( vr ) ) )
		.mul( cos( pos.mul( phase ).add( shift ) ) )
		.mul( exp( square( phase ).negate().mul( vr ) ) )
		.toVar( 'xyz' );

	xyz.x.addAssign(
		float( 9.7470e-14 ).mul( sqrt( float( TWO_PI ).mul( 4.5282e+09 ) ) )
			.mul( cos( float( 2.2399e+06 ).mul( phase ).add( shift.x ) ) )
			.mul( exp( float( - 4.5282e+09 ).mul( square( phase ) ) ) )
	);

	return XYZ_TO_REC709.mul( xyz.div( 1.0685e-7 ) );

} );

export const evalIridescence = Fn( ( [ outsideIOR, eta2, cosTheta1, thinFilmThickness, baseF0 ] ) => {

	// Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
	const iridescenceIor = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) ).toVar( 'iridIor' );

	// Evaluate the cosTheta on the base layer (Snell law)
	const sinTheta2Sq = square( outsideIOR.div( iridescenceIor ) ).mul( float( 1.0 ).sub( square( cosTheta1 ) ) ).toVar( 'sinTheta2Sq' );

	// Handle TIR
	const cosTheta2Sq = float( 1.0 ).sub( sinTheta2Sq ).toVar( 'cosTheta2Sq' );
	const result = vec3( 0.0 ).toVar( 'iridResult' );

	If( cosTheta2Sq.lessThan( 0.0 ), () => {

		result.assign( vec3( 1.0 ) );

	} ).Else( () => {

		const cosTheta2 = sqrt( cosTheta2Sq ).toVar( 'cosTheta2' );

		// First interface
		const R0 = iorToFresnel0( iridescenceIor, outsideIOR ).toVar( 'R0' );
		const R12 = fresnelSchlickFloat( cosTheta1, R0 ).toVar( 'R12' );
		const T121 = float( 1.0 ).sub( R12 ).toVar( 'T121' );
		const phi12 = iridescenceIor.lessThan( outsideIOR ).select( float( PI ), float( 0.0 ) ).toVar( 'phi12' );
		const phi21 = float( PI ).sub( phi12 ).toVar( 'phi21' );

		// Second interface
		const baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ).toVar( 'baseIOR' );
		const R1 = iorToFresnel0Vec3( baseIOR, iridescenceIor ).toVar( 'R1' );
		const R23 = vec3(
			fresnelSchlickFloat( cosTheta2, R1.x ),
			fresnelSchlickFloat( cosTheta2, R1.y ),
			fresnelSchlickFloat( cosTheta2, R1.z )
		).toVar( 'R23' );
		const phi23 = mix( vec3( 0.0 ), vec3( PI ), lessThan( baseIOR, vec3( iridescenceIor ) ) ).toVar( 'phi23' );

		const OPD = float( 2.0 ).mul( iridescenceIor ).mul( thinFilmThickness ).mul( cosTheta2 ).toVar( 'OPD' );
		const phi = vec3( phi21 ).add( phi23 ).toVar( 'phi' );

		// Compound terms
		const R123 = clamp( vec3( R12 ).mul( R23 ), 1e-5, 0.9999 ).toVar( 'R123' );
		const r123 = sqrt( R123 ).toVar( 'r123' );
		const Rs = vec3( T121.mul( T121 ) ).mul( R23 ).div( vec3( 1.0 ).sub( R123 ) ).toVar( 'Rs' );

		// Reflectance term for m = 0 (DC term amplitude)
		const C0 = vec3( R12 ).add( Rs ).toVar( 'C0' );
		const I = C0.toVar( 'I' );
		const Cm = Rs.sub( vec3( T121 ) ).toVar( 'Cm' );

		// Unrolled loop for m = 1, 2
		Cm.mulAssign( r123 );
		I.addAssign( Cm.mul( float( 2.0 ).mul( evalSensitivity( float( 1.0 ).mul( OPD ), float( 1.0 ).mul( phi ) ) ) ) );

		Cm.mulAssign( r123 );
		I.addAssign( Cm.mul( float( 2.0 ).mul( evalSensitivity( float( 2.0 ).mul( OPD ), float( 2.0 ).mul( phi ) ) ) ) );

		result.assign( max( I, vec3( 0.0 ) ) );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// BRDF Weight Calculation
// -----------------------------------------------------------------------------

export const calculateBRDFWeights = Fn( ( [ material, mc, cache ] ) => {

	// Use precomputed values from cache
	const invRoughness = cache.invRoughness;
	const metalFactor = cache.metalFactor;

	// Optimized specular calculation using classification
	const baseSpecularWeight = float( 0.0 ).toVar( 'baseSpecW' );

	If( mc.isMetallic, () => {

		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), 0.7 ) );

	} ).ElseIf( mc.isSmooth, () => {

		baseSpecularWeight.assign( invRoughness.mul( metalFactor ).mul( 1.2 ) );

	} ).Else( () => {

		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), material.metalness.mul( 0.1 ) ) );

	} );

	const specular = baseSpecularWeight.mul( material.specularIntensity ).toVar( 'wSpec' );
	const diffuse = float( 1.0 ).sub( baseSpecularWeight ).mul( float( 1.0 ).sub( material.metalness ) ).toVar( 'wDiff' );
	const sheen = material.sheen.mul( cache.maxSheenColor ).toVar( 'wSheen' );

	const clearcoat = float( 0.0 ).toVar( 'wClearcoat' );
	If( mc.hasClearcoat, () => {

		clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.4 ) );

	} ).Else( () => {

		clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.35 ) );

	} );

	const transmission = float( 0.0 ).toVar( 'wTrans' );
	If( mc.isTransmissive, () => {

		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.8 );
		transmission.assign( material.transmission.mul( transmissionBase )
			.mul( float( 0.6 ).add( float( 0.4 ).mul( material.ior.div( 2.0 ) ) ) )
			.mul( float( 1.0 ).add( material.dispersion.mul( 0.6 ) ) ) );

	} ).Else( () => {

		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.7 );
		transmission.assign( material.transmission.mul( transmissionBase )
			.mul( float( 0.5 ).add( float( 0.5 ).mul( material.ior.div( 2.0 ) ) ) )
			.mul( float( 1.0 ).add( material.dispersion.mul( 0.5 ) ) ) );

	} );

	// Iridescence calculation
	const iridescenceBase = invRoughness.mul( mc.isSmooth.select( float( 0.6 ), float( 0.5 ) ) );
	const iridescence = material.iridescence.mul( iridescenceBase )
		.mul( float( 0.5 ).add( float( 0.5 ).mul(
			material.iridescenceThicknessRange.y.sub( material.iridescenceThicknessRange.x ).div( 1000.0 )
		) ) )
		.mul( float( 0.5 ).add( float( 0.5 ).mul( material.iridescenceIOR.div( 2.0 ) ) ) )
		.toVar( 'wIrid' );

	// Single normalization pass
	const total = specular.add( diffuse ).add( sheen ).add( clearcoat ).add( transmission ).add( iridescence );
	const invTotal = float( 1.0 ).div( max( total, 0.001 ) );

	return BRDFWeights( {
		specular: specular.mul( invTotal ),
		diffuse: diffuse.mul( invTotal ),
		sheen: sheen.mul( invTotal ),
		clearcoat: clearcoat.mul( invTotal ),
		transmission: transmission.mul( invTotal ),
		iridescence: iridescence.mul( invTotal ),
	} );

} );

// -----------------------------------------------------------------------------
// Material Importance and Sampling Info
// -----------------------------------------------------------------------------

export const getMaterialImportance = Fn( ( [ material, mc ] ) => {

	const result = float( 0.0 ).toVar( 'matImp' );

	// Early out for specialized materials
	If( material.transmission.greaterThan( 0.0 ).or( material.clearcoat.greaterThan( 0.0 ) ), () => {

		result.assign( 0.95 );

	} ).Else( () => {

		// Base importance from complexity score
		const baseImportance = mc.complexityScore.toVar( 'baseImp' );

		// Enhanced emissive importance
		const emissiveImportance = float( 0.0 ).toVar( 'emImp' );
		If( mc.isEmissive, () => {

			const emissiveLuminance = dot( material.emissive, REC709_LUMINANCE_COEFFICIENTS );
			emissiveImportance.assign( min( float( 0.6 ), emissiveLuminance.mul( material.emissiveIntensity ).mul( 0.25 ) ) );

		} );

		// Material-specific boosts
		const materialBoost = float( 0.0 ).toVar( 'matBoost' );
		If( mc.isMetallic.and( mc.isSmooth ), () => {

			materialBoost.addAssign( 0.25 );

		} ).ElseIf( mc.isMetallic, () => {

			materialBoost.addAssign( 0.15 );

		} );

		If( mc.isTransmissive, () => {

			materialBoost.addAssign( 0.2 );

		} );
		If( mc.hasClearcoat, () => {

			materialBoost.addAssign( 0.1 );

		} );

		const totalImportance = max( baseImportance.add( materialBoost ), emissiveImportance );
		result.assign( clamp( totalImportance, 0.0, 1.0 ) );

	} );

	return result;

} );

export const getImportanceSamplingInfo = Fn( ( [
	material, bounceIndex, mc,
	environmentIntensity, useEnvMapIS, enableEnvironmentLight
] ) => {

	// Base BRDF weights using temporary cache
	const tempInvRoughness = float( 1.0 ).sub( material.roughness );
	const tempMetalFactor = float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) );
	const tempIorFactor = min( float( 2.0 ).div( material.ior ), 1.0 );
	const tempMaxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );

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
		tsAlbedo: material.color,
		tsEmissive: material.emissive,
		tsMetalness: material.metalness,
		tsRoughness: material.roughness,
		tsNormal: vec3( 0.0, 1.0, 0.0 ),
		tsHasTextures: false,
		invRoughness: tempInvRoughness,
		metalFactor: tempMetalFactor,
		iorFactor: tempIorFactor,
		maxSheenColor: tempMaxSheenColor,
	} );

	const weights = BRDFWeights.wrap( calculateBRDFWeights( material, mc, tempCache ) );

	const diffuseImportance = weights.diffuse.toVar( 'isDiff' );
	const specularImportance = weights.specular.toVar( 'isSpec' );
	const transmissionImportance = weights.transmission.toVar( 'isTrans' );
	const clearcoatImportance = weights.clearcoat.toVar( 'isCc' );

	// Environment importance
	const baseEnvStrength = environmentIntensity.mul( 0.2 ).toVar( 'baseEnvStr' );
	const isSecondaryBounce = bounceIndex.greaterThan( int( 0 ) );
	const indirectEnvBoost = isSecondaryBounce.select( float( 1.5 ), float( 1.0 ) ).toVar( 'indEnvBoost' );

	const envMaterialFactor = float( 1.0 ).toVar( 'envMatFac' );
	envMaterialFactor.mulAssign( mix( float( 1.0 ), float( 2.5 ), float( mc.isMetallic ) ) );
	envMaterialFactor.mulAssign( mix( float( 1.0 ), float( 2.2 ), float( mc.isRough ) ) );
	envMaterialFactor.mulAssign( mix( float( 1.0 ), float( 0.5 ), float( mc.isTransmissive ) ) );
	envMaterialFactor.mulAssign( mix( float( 1.0 ), float( 1.6 ), float( mc.hasClearcoat ) ) );

	const envmapImportance = baseEnvStrength.mul( envMaterialFactor ).mul( indirectEnvBoost ).toVar( 'isEnv' );

	// Depth adjustments
	If( bounceIndex.greaterThan( int( 2 ) ), () => {

		const depthFactor = float( 1.0 ).div( float( bounceIndex ).sub( 1.0 ) );
		specularImportance.mulAssign( float( 0.8 ).add( depthFactor.mul( 0.2 ) ) );
		clearcoatImportance.mulAssign( float( 0.7 ).add( depthFactor.mul( 0.3 ) ) );
		diffuseImportance.mulAssign( float( 1.0 ).add( depthFactor.mul( 0.2 ) ) );

	} );

	// Material-specific boosts
	If( mc.isMetallic.and( bounceIndex.lessThan( int( 3 ) ) ), () => {

		specularImportance.assign( max( specularImportance, 0.6 ) );
		envmapImportance.assign( max( envmapImportance, 0.35 ) );
		diffuseImportance.mulAssign( 0.4 );

	} );

	If( mc.isRough.and( mc.isMetallic.not() ).and( isSecondaryBounce ), () => {

		envmapImportance.assign( max( envmapImportance, 0.4 ) );

	} );

	If( mc.isTransmissive, () => {

		transmissionImportance.assign( max( transmissionImportance, 0.8 ) );
		diffuseImportance.mulAssign( 0.2 );
		specularImportance.mulAssign( 0.6 );
		envmapImportance.mulAssign( 0.8 );

	} );

	If( mc.hasClearcoat, () => {

		clearcoatImportance.assign( max( clearcoatImportance, 0.4 ) );
		envmapImportance.assign( max( envmapImportance, 0.25 ) );

	} );

	// Normalize to sum to 1.0
	const sum = diffuseImportance.add( specularImportance ).add( transmissionImportance )
		.add( clearcoatImportance ).add( envmapImportance ).toVar( 'isSum' );

	If( sum.greaterThan( 0.001 ), () => {

		const invSum = float( 1.0 ).div( sum );
		diffuseImportance.mulAssign( invSum );
		specularImportance.mulAssign( invSum );
		transmissionImportance.mulAssign( invSum );
		clearcoatImportance.mulAssign( invSum );
		envmapImportance.mulAssign( invSum );

	} ).Else( () => {

		If( useEnvMapIS.and( enableEnvironmentLight ), () => {

			diffuseImportance.assign( 0.35 );
			envmapImportance.assign( 0.65 );

		} ).Else( () => {

			diffuseImportance.assign( 0.6 );
			envmapImportance.assign( 0.4 );

		} );

		specularImportance.assign( 0.0 );
		transmissionImportance.assign( 0.0 );
		clearcoatImportance.assign( 0.0 );

	} );

	return ImportanceSamplingInfo( {
		diffuseImportance,
		specularImportance,
		transmissionImportance,
		clearcoatImportance,
		envmapImportance,
	} );

} );

// -----------------------------------------------------------------------------
// Material Cache Creation
// -----------------------------------------------------------------------------

export const createMaterialCache = Fn( ( [ N, V, material, samples, mc ] ) => {

	const NoV = max( dot( N, V ), 0.001 ).toVar( 'cacheNoV' );

	const isPurelyDiffuse = mc.isRough.and( mc.isMetallic.not() )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) )
		.toVar( 'cachePD' );

	const isMetallic = mc.isMetallic.toVar( 'cacheMet' );

	const hasSpecialFeatures = mc.isTransmissive.or( mc.hasClearcoat )
		.or( material.sheen.greaterThan( 0.0 ) )
		.or( material.iridescence.greaterThan( 0.0 ) )
		.toVar( 'cacheSF' );

	const alpha = samples.roughness.mul( samples.roughness ).toVar( 'cacheAlpha' );
	const alpha2 = alpha.mul( alpha ).toVar( 'cacheAlpha2' );
	const r = samples.roughness.add( 1.0 );
	const k = r.mul( r ).div( 8.0 ).toVar( 'cacheK' );

	const dielectricF0 = vec3( 0.04 ).mul( material.specularColor );
	const F0 = mix( dielectricF0, samples.albedo.rgb, samples.metalness ).mul( material.specularIntensity ).toVar( 'cacheF0' );
	const diffuseColor = samples.albedo.rgb.mul( float( 1.0 ).sub( samples.metalness ) ).toVar( 'cacheDiffCol' );
	const specularColor = samples.albedo.rgb.toVar( 'cacheSpecCol' );

	const invRoughness = float( 1.0 ).sub( samples.roughness ).toVar( 'cacheInvR' );
	const metalFactor = float( 0.5 ).add( float( 0.5 ).mul( samples.metalness ) ).toVar( 'cacheMetF' );
	const iorFactor = min( float( 2.0 ).div( material.ior ), 1.0 ).toVar( 'cacheIorF' );
	const maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) ).toVar( 'cacheMaxSheen' );

	return MaterialCache( {
		NoV,
		isPurelyDiffuse,
		isMetallic,
		hasSpecialFeatures,
		alpha,
		alpha2,
		k,
		F0,
		diffuseColor,
		specularColor,
		tsAlbedo: samples.albedo,
		tsEmissive: samples.emissive,
		tsMetalness: samples.metalness,
		tsRoughness: samples.roughness,
		tsNormal: samples.normal,
		tsHasTextures: samples.hasTextures,
		invRoughness,
		metalFactor,
		iorFactor,
		maxSheenColor,
	} );

} );

export const createMaterialCacheLegacy = Fn( ( [ N, V, material ] ) => {

	const NoV = max( dot( N, V ), 0.001 ).toVar( 'legNoV' );

	const isPurelyDiffuse = material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) )
		.toVar( 'legPD' );

	const isMetallic = material.metalness.greaterThan( 0.7 ).toVar( 'legMet' );

	const hasSpecialFeatures = material.transmission.greaterThan( 0.0 )
		.or( material.clearcoat.greaterThan( 0.0 ) )
		.or( material.sheen.greaterThan( 0.0 ) )
		.or( material.iridescence.greaterThan( 0.0 ) )
		.toVar( 'legSF' );

	const alpha = material.roughness.mul( material.roughness ).toVar( 'legAlpha' );
	const alpha2 = alpha.mul( alpha ).toVar( 'legAlpha2' );
	const r = material.roughness.add( 1.0 );
	const k = r.mul( r ).div( 8.0 ).toVar( 'legK' );

	const dielectricF0 = vec3( 0.04 ).mul( material.specularColor );
	const F0 = mix( dielectricF0, material.color.rgb, material.metalness ).mul( material.specularIntensity ).toVar( 'legF0' );
	const diffuseColor = material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ).toVar( 'legDiffCol' );
	const specularColor = material.color.rgb.toVar( 'legSpecCol' );

	const dummySamples = MaterialSamples( {
		albedo: material.color,
		emissive: material.emissive.mul( material.emissiveIntensity ),
		metalness: material.metalness,
		roughness: material.roughness,
		normal: N,
		hasTextures: false,
	} );

	const invRoughness = float( 1.0 ).sub( material.roughness ).toVar( 'legInvR' );
	const metalFactor = float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ).toVar( 'legMetF' );
	const iorFactor = min( float( 2.0 ).div( material.ior ), 1.0 ).toVar( 'legIorF' );
	const maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) ).toVar( 'legMaxSheen' );

	return MaterialCache( {
		NoV,
		isPurelyDiffuse,
		isMetallic,
		hasSpecialFeatures,
		alpha,
		alpha2,
		k,
		F0,
		diffuseColor,
		specularColor,
		tsAlbedo: dummySamples.albedo,
		tsEmissive: dummySamples.emissive,
		tsMetalness: dummySamples.metalness,
		tsRoughness: dummySamples.roughness,
		tsNormal: dummySamples.normal,
		tsHasTextures: dummySamples.hasTextures,
		invRoughness,
		metalFactor,
		iorFactor,
		maxSheenColor,
	} );

} );
