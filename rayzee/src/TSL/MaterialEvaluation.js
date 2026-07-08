import {
	Fn, float, vec3,
	If, max, min, clamp, mix
} from 'three/tsl';

import { DotProducts, DFGResult } from './Struct.js';
import {
	PI, PI_INV, EPSILON, MIN_CLEARCOAT_ROUGHNESS,
	computeDotProductsAniso,
} from './Common.js';
import { fresnelSchlick, fresnelSchlickFloat, dielectricF0 } from './Fresnel.js';
import {
	DistributionGGX, SheenDistribution, GeometrySmith, evaluateDFG,
	computeAnisoAlphas, DistributionGGXAniso, VisibilityGGXAniso,
} from './MaterialProperties.js';
import { evalIridescence } from './MaterialProperties.js';

// =============================================================================
// MATERIAL EVALUATION
// =============================================================================

// -----------------------------------------------------------------------------
// Main Material Response Evaluation
// -----------------------------------------------------------------------------

// Body of evaluateMaterialResponse taking precomputed dot products. Callers
// that also need calculateMaterialPDF for the same (V, L, N) should share dots
// to save one computeDotProducts call.
export const evaluateMaterialResponseFromDots = Fn( ( [ material, dots ] ) => {

	const result = vec3( 0.0 ).toVar();

	// Early exit for purely diffuse materials (skip if iridescent)
	If( material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) )
		.and( material.iridescence.equal( 0.0 ) ), () => {

		result.assign( material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ).mul( PI_INV ) );

	} ).Else( () => {

		// Calculate base F0 with specular parameters, clamped to physically valid range
		const F0 = clamp(
			mix( dielectricF0( material.ior ).mul( material.specularColor ), material.color.rgb, material.metalness )
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
		const F = fresnelSchlick( dots.VoH, F0 );

		// Single-scatter specular BRDF (anisotropic when material.anisotropy > 0; the aniso
		// visibility term already carries the 1/(4·NoV·NoL) denominator)
		const specularSS = vec3( 0.0 ).toVar();
		If( material.anisotropy.greaterThan( 0.0 ), () => {

			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			const Da = DistributionGGXAniso( a.x, a.y, dots.NoH, dots.ToH, dots.BoH );
			const Va = VisibilityGGXAniso( a.x, a.y, dots.ToV, dots.BoV, dots.ToL, dots.BoL, dots.NoV, dots.NoL );
			specularSS.assign( F.mul( Da.mul( Va ) ) );

		} ).Else( () => {

			const D = DistributionGGX( dots.NoH, material.roughness );
			const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
			specularSS.assign( D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) ) );

		} );

		// Shared DFG evaluation — compensation factor and total directional albedo
		// come from the same polynomial.
		const dfg = DFGResult.wrap( evaluateDFG( F0, dots.NoV, material.roughness ) );
		const specular = specularSS.mul( dfg.compensation );

		// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
		const kD = vec3( 1.0 ).sub( dfg.E_total ).mul( float( 1.0 ).sub( material.metalness ) );
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

// Wrapper that computes dot products internally. Use this when you don't already
// have dots; otherwise prefer evaluateMaterialResponseFromDots to share the work.
export const evaluateMaterialResponse = Fn( ( [ V, L, N, material ] ) => {

	const dots = DotProducts.wrap( computeDotProductsAniso( N, V, L, material ) );
	return evaluateMaterialResponseFromDots( material, dots );

} );

// -----------------------------------------------------------------------------
// Layered BRDF Evaluation (for clearcoat)
// -----------------------------------------------------------------------------

// Evaluate both clearcoat and base layer BRDFs
export const evaluateLayeredBRDF = Fn( ( [ dots, material ] ) => {

	// Base F0 calculation with specular parameters, clamped to physically valid range
	const baseF0 = dielectricF0( material.ior );
	const F0 = clamp(
		mix( baseF0.mul( material.specularColor ), material.color.rgb, material.metalness )
			.mul( material.specularIntensity ),
		vec3( 0.0 ), vec3( 1.0 )
	).toVar();

	const F = fresnelSchlick( dots.VoH, F0 );

	// Base specular (anisotropic when anisotropy > 0; aniso V term carries 1/(4·NoV·NoL))
	const baseBRDFSS = vec3( 0.0 ).toVar();
	If( material.anisotropy.greaterThan( 0.0 ), () => {

		const a = computeAnisoAlphas( material.roughness, material.anisotropy );
		const Da = DistributionGGXAniso( a.x, a.y, dots.NoH, dots.ToH, dots.BoH );
		const Va = VisibilityGGXAniso( a.x, a.y, dots.ToV, dots.BoV, dots.ToL, dots.BoL, dots.NoV, dots.NoL );
		baseBRDFSS.assign( F.mul( Da.mul( Va ) ) );

	} ).Else( () => {

		const D = DistributionGGX( dots.NoH, material.roughness );
		const G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
		baseBRDFSS.assign( D.mul( G ).mul( F ).div( max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), EPSILON ) ) );

	} );

	// Shared DFG evaluation — compensation factor and total directional albedo
	// come from the same polynomial.
	const dfg = DFGResult.wrap( evaluateDFG( F0, dots.NoV, material.roughness ) );
	const baseBRDF = baseBRDFSS.mul( dfg.compensation );

	// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
	const kD = vec3( 1.0 ).sub( dfg.E_total ).mul( float( 1.0 ).sub( material.metalness ) );
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
