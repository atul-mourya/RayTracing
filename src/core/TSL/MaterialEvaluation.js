import {
	Fn, float, vec3, int,
	If, max, min, dot, sqrt, clamp, mix, normalize, pow
} from 'three/tsl';

import { DotProducts, MaterialCache } from './Struct.js';
import {
	PI, PI_INV, EPSILON, MIN_CLEARCOAT_ROUGHNESS,
	computeDotProducts,
} from './Common.js';
import { fresnelSchlick, fresnelSchlickFloat } from './Fresnel.js';
import {
	DistributionGGX, SheenDistribution, GeometrySmith, multiscatterCompensation, specularDirectionalAlbedo,
} from './MaterialProperties.js';
import { evalIridescence } from './MaterialProperties.js';

// =============================================================================
// MATERIAL EVALUATION
// =============================================================================

// -----------------------------------------------------------------------------
// Main Material Response Evaluation
// -----------------------------------------------------------------------------

export const evaluateMaterialResponse = Fn( ( [ V, L, N, material ] ) => {

	const result = vec3( 0.0 ).toVar();

	// Early exit for purely diffuse materials (skip if iridescent)
	If( material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) )
		.and( material.iridescence.equal( 0.0 ) ), () => {

		result.assign( material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ).mul( PI_INV ) );

	} ).Else( () => {

		// Calculate all dot products once
		const dots = DotProducts.wrap( computeDotProducts( N, V, L ) );

		// Calculate base F0 with specular parameters, clamped to physically valid range
		const F0 = clamp(
			mix( vec3( 0.04 ).mul( material.specularColor ), material.color.rgb, material.metalness )
				.mul( material.specularIntensity ),
			vec3( 0.0 ), vec3( 1.0 )
		).toVar();

		// Modify material color for dispersive materials to enhance color separation
		const materialColor = material.color.rgb.toVar();
		If( material.dispersion.greaterThan( 0.0 ).and( material.transmission.greaterThan( 0.5 ) ), () => {

			// For highly dispersive transmissive materials, boost color saturation
			const dispersionEffect = clamp( material.dispersion.mul( 0.1 ), 0.0, 0.8 );
			const maxComp = max( max( materialColor.r, materialColor.g ), materialColor.b );
			const minComp = min( min( materialColor.r, materialColor.g ), materialColor.b );
			If( maxComp.greaterThan( minComp ), () => {

				const saturatedColor = materialColor.sub( minComp ).div( maxComp.sub( minComp ) );
				materialColor.assign( mix( materialColor, saturatedColor, dispersionEffect.mul( 0.3 ) ) );

			} );

		} );

		// Add iridescence effect if enabled
		If( material.iridescence.greaterThan( 0.0 ), () => {

			// Per glTF KHR_materials_iridescence spec: use max thickness when no texture
			const thickness = material.iridescenceThicknessRange.y;
			const iridescenceFresnel = evalIridescence( float( 1.0 ), material.iridescenceIOR, dots.VoH, thickness, F0 );
			F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

		} );

		// Precalculate shared terms
		const D = DistributionGGX( dots.NoH, material.roughness );
		const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
		const F = fresnelSchlick( dots.VoH, F0 ).toVar();

		// Single-scatter specular BRDF
		const specularSS = D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );

		// Kulla-Conty multiscatter energy compensation for rough surfaces
		const specular = specularSS.mul( multiscatterCompensation( F0, dots.NoV, material.roughness ) );

		// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
		const E_total = specularDirectionalAlbedo( F0, dots.NoV, material.roughness );
		const kD = vec3( 1.0 ).sub( E_total ).mul( float( 1.0 ).sub( material.metalness ) );
		const diffuse = kD.mul( materialColor ).mul( PI_INV );

		const baseLayer = diffuse.add( specular ).toVar();

		// Optimize sheen calculation
		If( material.sheen.greaterThan( 0.0 ), () => {

			const sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
			const sheenTerm = material.sheenColor.mul( material.sheen ).mul( sheenDist ).mul( dots.NoL );

			// Hemisphere-averaged sheen reflectance for energy-conserving base layer attenuation
			// Uses roughness-dependent average rather than per-sample distribution to avoid directional bias
			const avgSheenFactor = float( 1.0 ).sub( material.sheenRoughness ).mul( 0.5 ).add( 0.25 );
			const sheenReflectance = clamp( material.sheenColor.mul( material.sheen ).mul( avgSheenFactor ), vec3( 0.0 ), vec3( 1.0 ) );
			const sheenAttenuation = vec3( 1.0 ).sub( sheenReflectance );

			result.assign( baseLayer.mul( sheenAttenuation ).add( sheenTerm ) );

		} ).Else( () => {

			result.assign( baseLayer );

		} );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// Cached Material Response Evaluation (Optimized)
// -----------------------------------------------------------------------------

export const evaluateMaterialResponseCached = Fn( ( [ V, L, N, material, cache ] ) => {

	const result = vec3( 0.0 ).toVar();

	If( cache.isPurelyDiffuse, () => {

		result.assign( cache.diffuseColor );

	} ).Else( () => {

		const H = V.add( L ).toVar();
		const lenSq = dot( H, H );
		H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), vec3( 0.0, 0.0, 1.0 ) ) );
		const NoL = max( dot( N, L ), EPSILON );
		const NoH = max( dot( N, H ), EPSILON );
		const VoH = max( dot( V, H ), EPSILON );

		const isTransmission = cache.NoV.mul( NoL ).lessThan( 0.0 );
		If( isTransmission.and( material.transmission.greaterThan( 0.0 ) ), () => {

			result.assign( evaluateMaterialResponse( V, L, N, material ) );

		} ).Else( () => {

			const F0 = cache.F0.toVar();

			// Iridescence
			If( material.iridescence.greaterThan( 0.0 ), () => {

				// Per glTF KHR_materials_iridescence spec: use max thickness when no texture
				const thickness = material.iridescenceThicknessRange.y;
				const iridescenceFresnel = evalIridescence( float( 1.0 ), material.iridescenceIOR, VoH, thickness, F0 );
				F0.assign( clamp( mix( F0, iridescenceFresnel, material.iridescence ), vec3( 0.0 ), vec3( 1.0 ) ) );

			} );

			// Use precomputed values
			const denom = NoH.mul( NoH ).mul( cache.alpha2.sub( 1.0 ) ).add( 1.0 );
			const D = cache.alpha2.div( max( float( PI ).mul( denom ).mul( denom ), EPSILON ) );

			const ggx1 = NoL.div( NoL.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) );
			const ggx2 = cache.NoV.div( cache.NoV.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) );
			const G = ggx1.mul( ggx2 );

			const F = fresnelSchlick( VoH, F0 ).toVar();

			// Single-scatter specular BRDF
			const specularDenom = max( float( 4.0 ).mul( cache.NoV ).mul( NoL ), EPSILON );
			const specularSS = D.mul( G ).mul( F ).div( specularDenom );

			// Kulla-Conty multiscatter energy compensation for rough surfaces
			const specular = specularSS.mul( multiscatterCompensation( F0, cache.NoV, material.roughness ) );
			// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
			const E_total = specularDirectionalAlbedo( F0, cache.NoV, material.roughness );
			const kD = vec3( 1.0 ).sub( E_total ).mul( float( 1.0 ).sub( material.metalness ) );
			const diffuse = kD.mul( material.color.rgb ).mul( PI_INV );

			const baseLayer = diffuse.add( specular ).toVar();

			// Sheen
			If( material.sheen.greaterThan( 0.0 ), () => {

				const sheenDist = SheenDistribution( NoH, material.sheenRoughness );
				const sheenTerm = material.sheenColor.mul( material.sheen ).mul( sheenDist ).mul( NoL );
				// Hemisphere-averaged sheen reflectance for energy-conserving base layer attenuation
				const avgSheenFactor = float( 1.0 ).sub( material.sheenRoughness ).mul( 0.5 ).add( 0.25 );
				const sheenReflectance = clamp( material.sheenColor.mul( material.sheen ).mul( avgSheenFactor ), vec3( 0.0 ), vec3( 1.0 ) );
				const sheenAttenuation = vec3( 1.0 ).sub( sheenReflectance );

				result.assign( baseLayer.mul( sheenAttenuation ).add( sheenTerm ) );

			} ).Else( () => {

				result.assign( baseLayer );

			} );

		} );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// Layered BRDF Evaluation (for clearcoat)
// -----------------------------------------------------------------------------

// Helper function to calculate energy conservation for layered materials
export const calculateLayerAttenuation = Fn( ( [ clearcoat, VoH ] ) => {

	// Fresnel term for clearcoat layer (using f0 = 0.04 for dielectric)
	const F = fresnelSchlickFloat( VoH, float( 0.04 ) );
	// Two-interface clearcoat attenuation: (1-F)² blended by clearcoat strength
	// = 1 - clearcoat * F * (2 - F)
	return float( 1.0 ).sub( clearcoat.mul( F ).mul( float( 2.0 ).sub( F ) ) );

} );

// Evaluate both clearcoat and base layer BRDFs
export const evaluateLayeredBRDF = Fn( ( [ dots, material ] ) => {

	// Base F0 calculation with specular parameters, clamped to physically valid range
	const baseF0 = vec3( 0.04 );
	const F0 = clamp(
		mix( baseF0.mul( material.specularColor ), material.color.rgb, material.metalness )
			.mul( material.specularIntensity ),
		vec3( 0.0 ), vec3( 1.0 )
	).toVar();

	const D = DistributionGGX( dots.NoH, material.roughness );
	const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	const F = fresnelSchlick( dots.VoH, F0 ).toVar();
	const baseBRDFSS = D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );

	// Kulla-Conty multiscatter energy compensation for rough surfaces
	const baseBRDF = baseBRDFSS.mul( multiscatterCompensation( F0, dots.NoV, material.roughness ) );

	// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
	const E_total = specularDirectionalAlbedo( F0, dots.NoV, material.roughness );
	const kD = vec3( 1.0 ).sub( E_total ).mul( float( 1.0 ).sub( material.metalness ) );
	const diffuse = kD.mul( material.color.rgb ).div( PI );
	const baseLayer = diffuse.add( baseBRDF );

	// Clearcoat layer
	const clearcoatRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
	const clearcoatD = DistributionGGX( dots.NoH, clearcoatRoughness );
	const clearcoatG = GeometrySmith( dots.NoV, dots.NoL, clearcoatRoughness );
	const clearcoatF = fresnelSchlickFloat( dots.VoH, float( 0.04 ) );
	const clearcoatBRDF = clearcoatD.mul( clearcoatG ).mul( clearcoatF )
		.div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );

	// Energy conservation for clearcoat: two-interface model (1-F)² per clearcoat strength
	const clearcoatAttenuation = float( 1.0 ).sub( material.clearcoat.mul( clearcoatF ).mul( float( 2.0 ).sub( clearcoatF ) ) );

	return baseLayer.mul( clearcoatAttenuation ).add( vec3( clearcoatBRDF ).mul( material.clearcoat ) );

} );
