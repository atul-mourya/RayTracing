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
	DistributionGGX, SheenDistribution, GeometrySmith,
} from './MaterialProperties.js';
import { evalIridescence } from './MaterialProperties.js';

// =============================================================================
// MATERIAL EVALUATION
// =============================================================================

// -----------------------------------------------------------------------------
// Main Material Response Evaluation
// -----------------------------------------------------------------------------

export const evaluateMaterialResponse = Fn( ( [ V, L, N, material ] ) => {

	const result = vec3( 0.0 ).toVar( 'evalResult' );

	// Early exit for purely diffuse materials
	If( material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) ), () => {

		result.assign( material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ).mul( PI_INV ) );

	} ).Else( () => {

		// Calculate all dot products once
		const dots = DotProducts.wrap( computeDotProducts( N, V, L ) );

		// Calculate base F0 with specular parameters
		const F0 = mix( vec3( 0.04 ).mul( material.specularColor ), material.color.rgb, material.metalness )
			.mul( material.specularIntensity ).toVar( 'evalF0' );

		// Modify material color for dispersive materials to enhance color separation
		const materialColor = material.color.rgb.toVar( 'evalMatCol' );
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

			// Calculate thickness based on the range
			const thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
			const iridescenceFresnel = evalIridescence( float( 1.0 ), material.iridescenceIOR, dots.VoH, thickness, F0 );
			F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

		} );

		// Precalculate shared terms
		const D = DistributionGGX( dots.NoH, material.roughness );
		const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
		const F = fresnelSchlick( dots.VoH, F0 ).toVar( 'evalF' );

		// Combined specular calculation with NaN protection
		const specular = D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );
		const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( material.metalness ) );
		const diffuse = kD.mul( materialColor ).mul( PI_INV );

		const baseLayer = diffuse.add( specular ).toVar( 'evalBase' );

		// Optimize sheen calculation
		If( material.sheen.greaterThan( 0.0 ), () => {

			const sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
			const sheenTerm = material.sheenColor.mul( material.sheen ).mul( sheenDist ).mul( dots.NoL );

			// Physically-based sheen attenuation with minimum to prevent black pixels
			const maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
			const sheenReflectance = material.sheen.mul( maxSheen ).mul( sheenDist );
			// Clamp attenuation to preserve at least 10% of base layer
			const sheenAttenuation = max( float( 1.0 ).sub( clamp( sheenReflectance, 0.0, 0.9 ) ), 0.1 );

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

	const result = vec3( 0.0 ).toVar( 'evalCResult' );

	If( cache.isPurelyDiffuse, () => {

		result.assign( cache.diffuseColor );

	} ).Else( () => {

		const H = V.add( L ).toVar( 'evalCH' );
		const lenSq = dot( H, H );
		H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), vec3( 0.0, 0.0, 1.0 ) ) );
		const NoL = max( dot( N, L ), EPSILON );
		const NoH = max( dot( N, H ), EPSILON );
		const VoH = max( dot( V, H ), EPSILON );

		const isTransmission = cache.NoV.mul( NoL ).lessThan( 0.0 );
		If( isTransmission.and( material.transmission.greaterThan( 0.0 ) ), () => {

			result.assign( evaluateMaterialResponse( V, L, N, material ) );

		} ).Else( () => {

			const F0 = cache.F0.toVar( 'evalCF0' );

			// Iridescence
			If( material.iridescence.greaterThan( 0.0 ), () => {

				const thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
				const iridescenceFresnel = evalIridescence( float( 1.0 ), material.iridescenceIOR, VoH, thickness, F0 );
				F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

			} );

			// Use precomputed values
			const denom = NoH.mul( NoH ).mul( cache.alpha2.sub( 1.0 ) ).add( 1.0 );
			const D = cache.alpha2.div( max( float( PI ).mul( denom ).mul( denom ), EPSILON ) );

			const ggx1 = NoL.div( NoL.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) );
			const ggx2 = cache.NoV.div( cache.NoV.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) );
			const G = ggx1.mul( ggx2 );

			const F = fresnelSchlick( VoH, F0 ).toVar( 'evalCF' );

			// Safer division for specular term
			const specularDenom = max( float( 4.0 ).mul( cache.NoV ).mul( NoL ), EPSILON );
			const specular = min( D.mul( G ).mul( F ).div( specularDenom ), vec3( 16.0 ) );

			// Energy conservation: ensure diffuse + specular doesn't exceed 1
			const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( material.metalness ) );
			const diffuse = kD.mul( material.color.rgb ).mul( PI_INV );

			const baseLayer = diffuse.add( specular ).toVar( 'evalCBase' );

			// Sheen
			If( material.sheen.greaterThan( 0.0 ), () => {

				const sheenDist = SheenDistribution( NoH, material.sheenRoughness );
				const sheenTerm = material.sheenColor.mul( material.sheen ).mul( sheenDist ).mul( NoL );
				const maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
				const sheenReflectance = material.sheen.mul( maxSheen ).mul( sheenDist );
				const sheenAttenuation = max( float( 1.0 ).sub( clamp( sheenReflectance, 0.0, 0.9 ) ), 0.1 );

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
	// Attenuate base layer by clearcoat layer's reflection
	return float( 1.0 ).sub( clearcoat.mul( F ) );

} );

// Evaluate both clearcoat and base layer BRDFs
export const evaluateLayeredBRDF = Fn( ( [ dots, material ] ) => {

	// Base F0 calculation with specular parameters
	const baseF0 = vec3( 0.04 );
	const F0 = mix( baseF0.mul( material.specularColor ), material.color.rgb, material.metalness )
		.mul( material.specularIntensity ).toVar( 'layF0' );

	const D = DistributionGGX( dots.NoH, material.roughness );
	const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	const F = fresnelSchlick( dots.VoH, F0 ).toVar( 'layF' );
	const baseBRDF = D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );

	// Fresnel masking for diffuse component
	const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( material.metalness ) );
	const diffuse = kD.mul( material.color.rgb ).div( PI );
	const baseLayer = diffuse.add( baseBRDF );

	// Clearcoat layer
	const clearcoatRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
	const clearcoatD = DistributionGGX( dots.NoH, clearcoatRoughness );
	const clearcoatG = GeometrySmith( dots.NoV, dots.NoL, clearcoatRoughness );
	const clearcoatF = fresnelSchlickFloat( dots.VoH, float( 0.04 ) );
	const clearcoatBRDF = clearcoatD.mul( clearcoatG ).mul( clearcoatF )
		.div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) );

	// Energy conservation for clearcoat
	const clearcoatAttenuation = float( 1.0 ).sub( material.clearcoat.mul( clearcoatF ) );

	return baseLayer.mul( clearcoatAttenuation ).add( vec3( clearcoatBRDF ).mul( material.clearcoat ) );

} );
