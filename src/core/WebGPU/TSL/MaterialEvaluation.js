import { Fn, float, vec3, vec4, max, min, mix, clamp, dot, sqrt, If } from 'three/tsl';
import { fresnelSchlick } from './Fresnel.js';
import { distributionGGX, geometrySmith, sheenDistribution } from './MaterialProperties.js';

/**
 * Material Evaluation for TSL/WGSL
 * Complete port of material_evaluation.fs from GLSL to TSL/WGSL
 *
 * This module contains BRDF evaluation functions that compute the material
 * response to incident and outgoing light directions:
 * - Main material response evaluation
 * - Cached material response evaluation (optimized)
 * - Layered BRDF evaluation (for clearcoat)
 * - Energy conservation helpers
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const PI = Math.PI;
const PI_INV = 1.0 / Math.PI;

// Compile-time feature flags (set to true to enable)
const ENABLE_IRIDESCENCE = true;
const ENABLE_SHEEN = true;

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

/**
 * Compute all dot products needed for BRDF evaluation.
 * Matches computeDotProducts() from material_properties.fs
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} L - Light direction (vec3)
 * @returns {TSLNode} DotProducts struct with NoL, NoV, NoH, VoH, LoH
 */
const computeDotProducts = Fn( ( [ N, V, L ] ) => {

	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), vec3( 0.0, 0.0, 1.0 ) ) );

	const NoL = max( dot( N, L ), float( EPSILON ) ).toVar();
	const NoV = max( dot( N, V ), float( EPSILON ) ).toVar();
	const NoH = max( dot( N, H ), float( EPSILON ) ).toVar();
	const VoH = max( dot( V, H ), float( EPSILON ) ).toVar();
	const LoH = max( dot( L, H ), float( EPSILON ) ).toVar();

	// Return as property object (TSL pattern for struct-like returns)
	return {
		NoL,
		NoV,
		NoH,
		VoH,
		LoH
	};

} );

/**
 * Evaluate iridescence fresnel effect (thin-film interference).
 * Only used when ENABLE_IRIDESCENCE is true.
 *
 * @param {TSLNode} outsideIOR - IOR of outside medium (float)
 * @param {TSLNode} eta2 - IOR of thin film (float)
 * @param {TSLNode} cosTheta1 - Cosine of incident angle (float)
 * @param {TSLNode} thinFilmThickness - Film thickness in nm (float)
 * @param {TSLNode} baseF0 - Base fresnel reflectance (vec3)
 * @returns {TSLNode} Iridescent fresnel color (vec3)
 */
const evalIridescence = Fn( ( [ outsideIOR, eta2, cosTheta1, thinFilmThickness, baseF0 ] ) => {

	// Simplified iridescence - full implementation would need XYZ color space conversion
	// For now, return a color-shifted fresnel based on film thickness and angle
	const phase = thinFilmThickness.mul( cosTheta1 ).mul( 0.01 ).toVar();
	const iridescenceShift = vec3(
		cosTheta1.mul( 0.3 ).add( phase ),
		cosTheta1.mul( 0.5 ).add( phase.mul( 1.5 ) ),
		cosTheta1.mul( 0.7 ).add( phase.mul( 2.0 ) )
	).toVar();

	return baseF0.add( iridescenceShift.mul( 0.1 ) ).clamp( 0.0, 1.0 );

} );

// ================================================================================
// MAIN MATERIAL RESPONSE EVALUATION
// ================================================================================

/**
 * Evaluate complete material response (BRDF) for given view and light directions.
 * Handles diffuse, specular, sheen, clearcoat, and iridescence.
 *
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} L - Light direction (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Material response color (vec3)
 */
export const evaluateMaterialResponse = Fn( ( [ V, L, N, material ] ) => {

	const roughness = material.roughness.toVar();
	const metalness = material.metalness.toVar();
	const transmission = material.transmission.toVar();
	const clearcoat = material.clearcoat.toVar();

	// Early exit for purely diffuse materials
	const isPurelyDiffuse = roughness.greaterThan( 0.98 )
		.and( metalness.lessThan( 0.02 ) )
		.and( transmission.equal( 0.0 ) )
		.and( clearcoat.equal( 0.0 ) );

	If( isPurelyDiffuse, () => {

		const diffuseColor = material.color.rgb.mul( float( 1.0 ).sub( metalness ) ).mul( PI_INV );
		return diffuseColor;

	} );

	// Calculate all dot products once
	const dots = computeDotProducts( N, V, L );

	// Calculate base F0 with specular parameters
	const baseF0 = vec3( 0.04 ).mul( material.specularColor ).toVar();
	const F0 = mix(
		baseF0,
		material.color.rgb,
		metalness
	).mul( material.specularIntensity ).toVar();

	// Modify material color for dispersive materials
	const materialColor = material.color.rgb.toVar();

	If( material.dispersion.greaterThan( 0.0 ).and( transmission.greaterThan( 0.5 ) ), () => {

		const dispersionEffect = clamp( material.dispersion.mul( 0.1 ), 0.0, 0.8 ).toVar();
		const maxComp = max( max( materialColor.r, materialColor.g ), materialColor.b ).toVar();
		const minComp = min( min( materialColor.r, materialColor.g ), materialColor.b ).toVar();

		If( maxComp.greaterThan( minComp ), () => {

			const saturatedColor = materialColor.sub( minComp ).div( maxComp.sub( minComp ) ).toVar();
			materialColor.assign( mix( materialColor, saturatedColor, dispersionEffect.mul( 0.3 ) ) );

		} );

	} );

	// Add iridescence effect if enabled
	If( ENABLE_IRIDESCENCE && material.iridescence.greaterThan( 0.0 ), () => {

		const thickness = mix(
			material.iridescenceThicknessRange.x,
			material.iridescenceThicknessRange.y,
			0.5
		).toVar();

		const iridescenceFresnel = evalIridescence(
			float( 1.0 ),
			material.iridescenceIOR,
			dots.VoH,
			thickness,
			F0
		).toVar();

		F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

	} );

	// Precalculate shared terms
	const D = distributionGGX( dots.NoH, roughness ).toVar();
	const G = geometrySmith( dots.NoV, dots.NoL, roughness ).toVar();
	const F = fresnelSchlick( dots.VoH, F0 ).toVar();

	// Combined specular calculation with NaN protection
	const specular = D.mul( G ).mul( F ).div(
		max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), float( EPSILON ) )
	).toVar();

	const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( metalness ) ).toVar();
	const diffuse = kD.mul( materialColor ).mul( PI_INV ).toVar();

	const baseLayer = diffuse.add( specular ).toVar();

	// Optimize sheen calculation
	If( ENABLE_SHEEN && material.sheen.greaterThan( 0.0 ), () => {

		const sheenDist = sheenDistribution( dots.NoH, material.sheenRoughness ).toVar();
		const sheenTerm = material.sheenColor
			.mul( material.sheen )
			.mul( sheenDist )
			.mul( dots.NoL )
			.toVar();

		// Physically-based sheen attenuation
		const maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b ).toVar();
		const sheenReflectance = material.sheen.mul( maxSheen ).mul( sheenDist ).toVar();
		const sheenAttenuation = max(
			float( 1.0 ).sub( clamp( sheenReflectance, 0.0, 0.9 ) ),
			0.1
		).toVar();

		return baseLayer.mul( sheenAttenuation ).add( sheenTerm );

	} );

	return baseLayer;

} ).setLayout( {
	name: 'evaluateMaterialResponse',
	type: 'vec3',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'L', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );

// ================================================================================
// CACHED MATERIAL RESPONSE EVALUATION (OPTIMIZED)
// ================================================================================

/**
 * Optimized material response evaluation using precomputed cache values.
 * Use when MaterialCache is available for better performance.
 *
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} L - Light direction (vec3)
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} cache - MaterialCache struct with precomputed values
 * @returns {TSLNode} Material response color (vec3)
 */
export const evaluateMaterialResponseCached = Fn( ( [ V, L, N, material, cache ] ) => {

	// Early exit for purely diffuse materials
	If( cache.isPurelyDiffuse.equal( 1 ), () => {

		return cache.diffuseColor;

	} );

	// Compute half vector and dot products
	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( sqrt( lenSq ) ), vec3( 0.0, 0.0, 1.0 ) ) );

	const NoL = max( dot( N, L ), float( EPSILON ) ).toVar();
	const NoH = max( dot( N, H ), float( EPSILON ) ).toVar();
	const VoH = max( dot( V, H ), float( EPSILON ) ).toVar();

	// Check for transmission (view and light on opposite sides)
	const isTransmission = cache.NoV.mul( NoL ).lessThan( 0.0 );

	If( isTransmission.and( material.transmission.greaterThan( 0.0 ) ), () => {

		// Fall back to full evaluation for transmission
		return evaluateMaterialResponse( V, L, N, material );

	} );

	// Use cached F0
	const F0 = cache.F0.toVar();

	// Add iridescence if enabled
	If( ENABLE_IRIDESCENCE && material.iridescence.greaterThan( 0.0 ), () => {

		const thickness = mix(
			material.iridescenceThicknessRange.x,
			material.iridescenceThicknessRange.y,
			0.5
		).toVar();

		const iridescenceFresnel = evalIridescence(
			float( 1.0 ),
			material.iridescenceIOR,
			VoH,
			thickness,
			F0
		).toVar();

		F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

	} );

	// Use precomputed cache values for GGX distribution
	const denom = NoH.mul( NoH ).mul( cache.alpha2.sub( 1.0 ) ).add( 1.0 ).toVar();
	const D = cache.alpha2.div(
		max( float( PI ).mul( denom ).mul( denom ), float( EPSILON ) )
	).toVar();

	// Geometry term using cached k value
	const ggx1 = NoL.div( NoL.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) ).toVar();
	const ggx2 = cache.NoV.div( cache.NoV.mul( float( 1.0 ).sub( cache.k ) ).add( cache.k ) ).toVar();
	const G = ggx1.mul( ggx2 ).toVar();

	// Fresnel term
	const F = fresnelSchlick( VoH, F0 ).toVar();

	// Safer division for specular term
	const specularDenom = max( float( 4.0 ).mul( cache.NoV ).mul( NoL ), float( EPSILON ) ).toVar();
	const specular = D.mul( G ).mul( F ).div( specularDenom ).toVar();

	// Clamp specular to prevent fireflies
	specular.assign( min( specular, vec3( 16.0 ) ) );

	// Energy conservation
	const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( material.metalness ) ).toVar();
	const diffuse = kD.mul( material.color.rgb ).mul( PI_INV ).toVar();

	const baseLayer = diffuse.add( specular ).toVar();

	// Sheen layer
	If( ENABLE_SHEEN && material.sheen.greaterThan( 0.0 ), () => {

		const sheenDist = sheenDistribution( NoH, material.sheenRoughness ).toVar();
		const sheenTerm = material.sheenColor
			.mul( material.sheen )
			.mul( sheenDist )
			.mul( NoL )
			.toVar();

		const maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b ).toVar();
		const sheenReflectance = material.sheen.mul( maxSheen ).mul( sheenDist ).toVar();
		const sheenAttenuation = max(
			float( 1.0 ).sub( clamp( sheenReflectance, 0.0, 0.9 ) ),
			0.1
		).toVar();

		return baseLayer.mul( sheenAttenuation ).add( sheenTerm );

	} );

	return baseLayer;

} ).setLayout( {
	name: 'evaluateMaterialResponseCached',
	type: 'vec3',
	inputs: [
		{ name: 'V', type: 'vec3' },
		{ name: 'L', type: 'vec3' },
		{ name: 'N', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'cache', type: 'MaterialCache' }
	]
} );

// ================================================================================
// LAYERED BRDF EVALUATION (FOR CLEARCOAT)
// ================================================================================

/**
 * Calculate energy conservation attenuation for clearcoat layer.
 * Fresnel term reduces base layer contribution.
 *
 * @param {TSLNode} clearcoat - Clearcoat strength [0, 1] (float)
 * @param {TSLNode} VoH - View dot Half (float)
 * @returns {TSLNode} Attenuation factor (float)
 */
export const calculateLayerAttenuation = Fn( ( [ clearcoat, VoH ] ) => {

	// Fresnel for clearcoat layer (f0 = 0.04 for dielectric)
	const F = fresnelSchlick( VoH, vec3( 0.04 ) ).r.toVar();

	// Attenuate base layer by clearcoat reflection
	return float( 1.0 ).sub( clearcoat.mul( F ) );

} ).setLayout( {
	name: 'calculateLayerAttenuation',
	type: 'float',
	inputs: [
		{ name: 'clearcoat', type: 'float' },
		{ name: 'VoH', type: 'float' }
	]
} );

/**
 * Evaluate layered BRDF with clearcoat layer over base material.
 * Combines base layer (diffuse + specular) with clearcoat layer using energy conservation.
 *
 * @param {TSLNode} dots - DotProducts struct (NoL, NoV, NoH, VoH, LoH)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} Combined BRDF value (vec3)
 */
export const evaluateLayeredBRDF = Fn( ( [ dots, material ] ) => {

	// Base F0 calculation with specular parameters
	const baseF0 = vec3( 0.04 ).toVar();
	const F0 = mix(
		baseF0.mul( material.specularColor ),
		material.color.rgb,
		material.metalness
	).mul( material.specularIntensity ).toVar();

	// Base layer specular
	const D = distributionGGX( dots.NoH, material.roughness ).toVar();
	const G = geometrySmith( dots.NoV, dots.NoL, material.roughness ).toVar();
	const F = fresnelSchlick( dots.VoH, F0 ).toVar();

	const baseBRDF = D.mul( G ).mul( F ).div(
		max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), float( EPSILON ) )
	).toVar();

	// Fresnel masking for diffuse component
	const kD = vec3( 1.0 ).sub( F ).mul( float( 1.0 ).sub( material.metalness ) ).toVar();
	const diffuse = kD.mul( material.color.rgb ).div( PI ).toVar();

	const baseLayer = diffuse.add( baseBRDF ).toVar();

	// Clearcoat layer
	const MIN_CLEARCOAT_ROUGHNESS = 0.05;
	const clearcoatRoughness = max( material.clearcoatRoughness, float( MIN_CLEARCOAT_ROUGHNESS ) ).toVar();

	const clearcoatD = distributionGGX( dots.NoH, clearcoatRoughness ).toVar();
	const clearcoatG = geometrySmith( dots.NoV, dots.NoL, clearcoatRoughness ).toVar();
	const clearcoatF = fresnelSchlick( dots.VoH, vec3( 0.04 ) ).r.toVar();

	const clearcoatBRDF = clearcoatD.mul( clearcoatG ).mul( clearcoatF ).div(
		max( float( 4.0 ).mul( dots.NoV ).mul( dots.NoL ), float( EPSILON ) )
	).toVar();

	// Energy conservation for clearcoat
	const clearcoatAttenuation = float( 1.0 ).sub( material.clearcoat.mul( clearcoatF ) ).toVar();

	// Combine layers
	return baseLayer.mul( clearcoatAttenuation ).add( vec3( clearcoatBRDF ).mul( material.clearcoat ) );

} ).setLayout( {
	name: 'evaluateLayeredBRDF',
	type: 'vec3',
	inputs: [
		{ name: 'dots', type: 'DotProducts' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );
