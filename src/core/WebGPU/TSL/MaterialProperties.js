import { Fn, float, vec3, int, uint, clamp, max, min, sqrt, pow, cos, exp, mix, smoothstep, dot, lessThan, If, Loop, property } from 'three/tsl';
import { square } from './Common.js';

/**
 * Material Properties for TSL/WGSL
 * Complete port of material_properties.fs from GLSL to TSL/WGSL
 *
 * This module contains BRDF distribution functions, geometry terms, and
 * material weight calculations for physically-based rendering:
 * - Microfacet distribution functions (GGX, Sheen)
 * - Geometry terms (Schlick-GGX, Smith)
 * - PDF calculation helpers
 * - Iridescence evaluation
 * - BRDF weight calculation
 * - Material importance and sampling info
 * - Material cache creation
 */

// ================================================================================
// CONSTANTS
// ================================================================================

const EPSILON = 1e-6;
const PI = Math.PI;
const TWO_PI = 2.0 * Math.PI;
const MIN_ROUGHNESS = 0.05;

// XYZ to REC709 color space conversion matrix
const XYZ_TO_REC709 = [
	3.2404542, - 1.5371385, - 0.4985314,
	- 0.9692660, 1.8760108, 0.0415560,
	0.0556434, - 0.2040259, 1.0572252
];

// ================================================================================
// MICROFACET DISTRIBUTION FUNCTIONS
// ================================================================================

/**
 * GGX (Trowbridge-Reitz) microfacet distribution function.
 * Standard distribution used for specular highlights in PBR.
 *
 * @param {TSLNode} NoH - Cosine of angle between normal and half vector (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} Distribution value (float)
 */
export const distributionGGX = Fn( ( [ NoH, roughness ] ) => {

	const alpha = roughness.mul( roughness ).toVar();
	const alpha2 = alpha.mul( alpha ).toVar();
	const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 ).toVar();

	return alpha2.div( max( float( PI ).mul( denom ).mul( denom ), float( EPSILON ) ) );

} ).setLayout( {
	name: 'distributionGGX',
	type: 'float',
	inputs: [
		{ name: 'NoH', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

/**
 * Sheen distribution function for cloth/fabric materials.
 * Uses inverted alpha for sheen lobe characteristics.
 * Conditional compilation - only used when ENABLE_SHEEN is defined.
 *
 * @param {TSLNode} NoH - Cosine of angle between normal and half vector (float)
 * @param {TSLNode} roughness - Sheen roughness [0, 1] (float)
 * @returns {TSLNode} Distribution value (float)
 */
export const sheenDistribution = Fn( ( [ NoH, roughness ] ) => {

	const clampedRoughness = max( roughness, float( MIN_ROUGHNESS ) ).toVar();
	const alpha = clampedRoughness.mul( clampedRoughness ).toVar();
	const invAlpha = float( 1.0 ).div( alpha ).toVar();
	const d = NoH.mul( NoH ).mul( invAlpha.mul( invAlpha ).sub( 1.0 ) ).add( 1.0 ).toVar();

	return min(
		invAlpha.mul( invAlpha ).div( max( float( PI ).mul( d ).mul( d ), float( EPSILON ) ) ),
		float( 100.0 )
	);

} ).setLayout( {
	name: 'sheenDistribution',
	type: 'float',
	inputs: [
		{ name: 'NoH', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

// ================================================================================
// GEOMETRY TERMS
// ================================================================================

/**
 * Schlick-GGX geometry term for one direction.
 * Approximates the microfacet shadowing/masking function.
 *
 * @param {TSLNode} NdotV - Cosine of angle between normal and direction (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} Geometry term (float)
 */
export const geometrySchlickGGX = Fn( ( [ NdotV, roughness ] ) => {

	const r = roughness.add( 1.0 ).toVar();
	const k = r.mul( r ).div( 8.0 ).toVar();

	return NdotV.div( max( NdotV.mul( float( 1.0 ).sub( k ) ).add( k ), float( EPSILON ) ) );

} ).setLayout( {
	name: 'geometrySchlickGGX',
	type: 'float',
	inputs: [
		{ name: 'NdotV', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

/**
 * Smith geometry term combining view and light directions.
 * Accounts for both masking and shadowing.
 *
 * @param {TSLNode} NoV - Normal dot View (float)
 * @param {TSLNode} NoL - Normal dot Light (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} Combined geometry term (float)
 */
export const geometrySmith = Fn( ( [ NoV, NoL, roughness ] ) => {

	const ggx2 = geometrySchlickGGX( NoV, roughness ).toVar();
	const ggx1 = geometrySchlickGGX( NoL, roughness ).toVar();

	return ggx1.mul( ggx2 );

} ).setLayout( {
	name: 'geometrySmith',
	type: 'float',
	inputs: [
		{ name: 'NoV', type: 'float' },
		{ name: 'NoL', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

// ================================================================================
// PDF CALCULATION HELPERS
// ================================================================================

/**
 * Calculate PDF for standard GGX importance sampling.
 * Used when sampling H directly from GGX distribution (ImportanceSampleGGX).
 * Formula: D(H) * NoH / (4 * VoH)
 *
 * @param {TSLNode} NoH - Normal dot Half vector (float)
 * @param {TSLNode} VoH - View dot Half vector (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} PDF value (float)
 */
export const calculateGGXPDF = Fn( ( [ NoH, VoH, roughness ] ) => {

	const D = distributionGGX( NoH, roughness ).toVar();

	return D.mul( NoH ).div( max( float( 4.0 ).mul( VoH ), float( EPSILON ) ) );

} ).setLayout( {
	name: 'calculateGGXPDF',
	type: 'float',
	inputs: [
		{ name: 'NoH', type: 'float' },
		{ name: 'VoH', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

/**
 * Calculate PDF for VNDF (Visible Normal Distribution Function) sampling.
 * Used when sampling H from visible normals (sampleGGXVNDF).
 * Formula: G1(V) * D(H) / (NoV * 4)
 * Note: VoH cancels out in the Jacobian transform from H-space to L-space
 *
 * @param {TSLNode} NoH - Normal dot Half vector (float)
 * @param {TSLNode} NoV - Normal dot View (float)
 * @param {TSLNode} roughness - Surface roughness [0, 1] (float)
 * @returns {TSLNode} PDF value (float)
 */
export const calculateVNDFPDF = Fn( ( [ NoH, NoV, roughness ] ) => {

	const D = distributionGGX( NoH, roughness ).toVar();
	const G1 = geometrySchlickGGX( NoV, roughness ).toVar();

	return D.mul( G1 ).div( max( NoV.mul( 4.0 ), float( EPSILON ) ) );

} ).setLayout( {
	name: 'calculateVNDFPDF',
	type: 'float',
	inputs: [
		{ name: 'NoH', type: 'float' },
		{ name: 'NoV', type: 'float' },
		{ name: 'roughness', type: 'float' }
	]
} );

// ================================================================================
// IRIDESCENCE EVALUATION
// ================================================================================

/**
 * Evaluate sensitivity function for iridescence.
 * Calculates XYZ color response for thin-film interference.
 *
 * @param {TSLNode} OPD - Optical path difference (float)
 * @param {TSLNode} shift - Phase shift (vec3)
 * @returns {TSLNode} XYZ color values (vec3)
 */
export const evalSensitivity = Fn( ( [ OPD, shift ] ) => {

	const phase = float( TWO_PI ).mul( OPD ).mul( 1.0e-9 ).toVar();
	const val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 ).toVar();
	const pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 ).toVar();
	const varVec = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 ).toVar();

	const xyz = val.mul( sqrt( vec3( TWO_PI ).mul( varVec ) ) )
		.mul( cos( pos.mul( phase ).add( shift ) ) )
		.mul( exp( square( phase ).mul( varVec ).negate() ) )
		.toVar();

	// Add additional component for x channel
	const xExtra = float( 9.7470e-14 )
		.mul( sqrt( float( TWO_PI ).mul( 4.5282e+09 ) ) )
		.mul( cos( float( 2.2399e+06 ).mul( phase ).add( shift.x ) ) )
		.mul( exp( float( - 4.5282e+09 ).mul( square( phase ) ) ) )
		.toVar();

	xyz.x.assign( xyz.x.add( xExtra ) );

	// Convert XYZ to REC709 RGB
	const rgb = vec3(
		xyz.x.mul( XYZ_TO_REC709[ 0 ] ).add( xyz.y.mul( XYZ_TO_REC709[ 1 ] ) ).add( xyz.z.mul( XYZ_TO_REC709[ 2 ] ) ),
		xyz.x.mul( XYZ_TO_REC709[ 3 ] ).add( xyz.y.mul( XYZ_TO_REC709[ 4 ] ) ).add( xyz.z.mul( XYZ_TO_REC709[ 5 ] ) ),
		xyz.x.mul( XYZ_TO_REC709[ 6 ] ).add( xyz.y.mul( XYZ_TO_REC709[ 7 ] ) ).add( xyz.z.mul( XYZ_TO_REC709[ 8 ] ) )
	).div( 1.0685e-7 ).toVar();

	return rgb;

} ).setLayout( {
	name: 'evalSensitivity',
	type: 'vec3',
	inputs: [
		{ name: 'OPD', type: 'float' },
		{ name: 'shift', type: 'vec3' }
	]
} );

/**
 * Evaluate iridescence effect based on view angle and film thickness.
 * Calculates thin-film interference for realistic iridescent materials.
 *
 * @param {TSLNode} outsideIOR - IOR of outside medium (typically air = 1.0) (float)
 * @param {TSLNode} eta2 - IOR of thin film layer (float)
 * @param {TSLNode} cosTheta1 - Cosine of incident angle (float)
 * @param {TSLNode} thinFilmThickness - Thickness of film in nanometers (float)
 * @param {TSLNode} baseF0 - Base reflectance of substrate (vec3)
 * @returns {TSLNode} Iridescence reflectance factor (vec3)
 */
export const evalIridescence = Fn( ( [ outsideIOR, eta2, cosTheta1, thinFilmThickness, baseF0 ] ) => {

	// Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
	const iridescenceIor = mix( outsideIOR, eta2, smoothstep( float( 0.0 ), float( 0.03 ), thinFilmThickness ) ).toVar();

	// Evaluate the cosTheta on the base layer (Snell's law)
	const sinTheta2Sq = square( outsideIOR.div( iridescenceIor ) ).mul( float( 1.0 ).sub( square( cosTheta1 ) ) ).toVar();

	// Handle total internal reflection (TIR)
	const cosTheta2Sq = float( 1.0 ).sub( sinTheta2Sq ).toVar();

	// Return total reflection for TIR case
	const result = vec3( 1.0 ).toVar();

	// Compute iridescence if not TIR
	If( cosTheta2Sq.greaterThanEqual( 0.0 ), () => {

		const cosTheta2 = sqrt( cosTheta2Sq ).toVar();

		// First interface
		const sqrtIOReRatio = sqrt( iridescenceIor.div( outsideIOR ) ).toVar();
		const R0 = square( float( 1.0 ).sub( sqrtIOReRatio ).div( float( 1.0 ).add( sqrtIOReRatio ) ) ).toVar();
		const R12 = R0.add( float( 1.0 ).sub( R0 ).mul( pow( float( 1.0 ).sub( cosTheta1 ), float( 5.0 ) ) ) ).toVar();
		const T121 = float( 1.0 ).sub( R12 ).toVar();
		const phi12 = iridescenceIor.lessThan( outsideIOR ).select( float( PI ), float( 0.0 ) ).toVar();
		const phi21 = float( PI ).sub( phi12 ).toVar();

		// Second interface - need fresnel0ToIor helper
		const sqrtF0 = sqrt( clamp( baseF0, vec3( 0.0 ), vec3( 0.9999 ) ) ).toVar();
		const baseIOR = vec3( 1.0 ).add( sqrtF0 ).div( max( vec3( 1.0 ).sub( sqrtF0 ), vec3( EPSILON ) ) ).toVar();

		const sqrtIOReRatio2 = sqrt( vec3( iridescenceIor ).div( baseIOR ) ).toVar();
		const R1 = square( vec3( 1.0 ).sub( sqrtIOReRatio2 ).div( vec3( 1.0 ).add( sqrtIOReRatio2 ) ) ).toVar();
		const R23 = R1.add( vec3( 1.0 ).sub( R1 ).mul( pow( vec3( 1.0 ).sub( cosTheta2 ), vec3( 5.0 ) ) ) ).toVar();

		const phi23 = vec3( 0.0 ).toVar();
		phi23.assign( mix( phi23, vec3( PI ), lessThan( baseIOR, vec3( iridescenceIor ) ) ) );

		const OPD = float( 2.0 ).mul( iridescenceIor ).mul( thinFilmThickness ).mul( cosTheta2 ).toVar();
		const phi = vec3( phi21 ).add( phi23 ).toVar();

		// Compound terms
		const R123 = clamp( R12.mul( R23 ), float( 1e-5 ), float( 0.9999 ) ).toVar();
		const r123 = sqrt( R123 ).toVar();
		const Rs = square( T121 ).mul( R23 ).div( vec3( 1.0 ).sub( R123 ) ).toVar();

		// Reflectance term for m = 0 (DC term amplitude)
		const C0 = R12.add( Rs ).toVar();
		const I = C0.toVar();
		const Cm = Rs.sub( T121 ).toVar();

		// Unrolled loop for m = 1, 2
		Loop( { start: int( 0 ), end: int( 2 ), type: 'int', condition: '<' }, ( { i } ) => {

			const m = i.add( 1 ).toVar();
			Cm.mulAssign( r123 );
			const Sm = evalSensitivity( m.toFloat().mul( OPD ), m.toFloat().mul( phi ) ).mul( 2.0 ).toVar();
			I.addAssign( Cm.mul( Sm ) );

		} );

		result.assign( max( I, vec3( 0.0 ) ) );

	} );

	return result;

} ).setLayout( {
	name: 'evalIridescence',
	type: 'vec3',
	inputs: [
		{ name: 'outsideIOR', type: 'float' },
		{ name: 'eta2', type: 'float' },
		{ name: 'cosTheta1', type: 'float' },
		{ name: 'thinFilmThickness', type: 'float' },
		{ name: 'baseF0', type: 'vec3' }
	]
} );

// ================================================================================
// BRDF WEIGHT CALCULATION
// ================================================================================

/**
 * Calculate BRDF weights for multi-lobe sampling.
 * Enhanced calculation using cached values to eliminate redundant computations.
 *
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} mc - MaterialClassification struct
 * @param {TSLNode} cache - MaterialCache struct
 * @returns {TSLNode} BRDFWeights struct
 */
export const calculateBRDFWeights = Fn( ( [ material, mc, cache ] ) => {

	const weights = property( 'BRDFWeights' ).toVar();

	// Use precomputed values from cache - eliminates redundant calculations
	const invRoughness = cache.invRoughness.toVar();
	const metalFactor = cache.metalFactor.toVar();

	// Optimized specular calculation using classification
	const baseSpecularWeight = float( 0.0 ).toVar();

	If( mc.isMetallic.equal( uint( 1 ) ), () => {

		// Metals: ensure strong specular regardless of roughness
		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), float( 0.7 ) ) );

	} ).ElseIf( mc.isSmooth.equal( uint( 1 ) ), () => {

		// Non-metals but smooth: strong specular
		baseSpecularWeight.assign( invRoughness.mul( metalFactor ).mul( 1.2 ) );

	} ).Else( () => {

		// Regular specular calculation
		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), material.metalness.mul( 0.1 ) ) );

	} );

	weights.specular.assign( baseSpecularWeight.mul( material.specularIntensity ) );
	weights.diffuse.assign( float( 1.0 ).sub( baseSpecularWeight ).mul( float( 1.0 ).sub( material.metalness ) ) );

	// Optimized sheen calculation using cached value
	weights.sheen.assign( material.sheen.mul( cache.maxSheenColor ) );

	// Enhanced clearcoat calculation using classification
	If( mc.hasClearcoat.equal( uint( 1 ) ), () => {

		weights.clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.4 ) );

	} ).Else( () => {

		weights.clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.35 ) );

	} );

	// Enhanced transmission calculation using cached IOR factor
	If( mc.isTransmissive.equal( uint( 1 ) ), () => {

		// High transmission materials get optimized calculation
		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.8 ).toVar();
		weights.transmission.assign(
			material.transmission.mul( transmissionBase )
				.mul( float( 0.6 ).add( material.ior.div( 2.0 ).mul( 0.4 ) ) )
				.mul( float( 1.0 ).add( material.dispersion.mul( 0.6 ) ) )
		);

	} ).Else( () => {

		// Regular transmission calculation using cached iorFactor
		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.7 ).toVar();
		weights.transmission.assign(
			material.transmission.mul( transmissionBase )
				.mul( float( 0.5 ).add( material.ior.div( 2.0 ).mul( 0.5 ) ) )
				.mul( float( 1.0 ).add( material.dispersion.mul( 0.5 ) ) )
		);

	} );

	// Optimized iridescence calculation
	const iridescenceBase = invRoughness.mul( mc.isSmooth.equal( uint( 1 ) ).select( float( 0.6 ), float( 0.5 ) ) ).toVar();
	const thicknessRange = material.iridescenceThicknessRange.y.sub( material.iridescenceThicknessRange.x ).div( 1000.0 ).toVar();
	weights.iridescence.assign(
		material.iridescence.mul( iridescenceBase )
			.mul( float( 0.5 ).add( thicknessRange.mul( 0.5 ) ) )
			.mul( float( 0.5 ).add( material.iridescenceIOR.div( 2.0 ).mul( 0.5 ) ) )
	);

	// Single normalization pass with enhanced precision
	const total = weights.specular.add( weights.diffuse ).add( weights.sheen )
		.add( weights.clearcoat ).add( weights.transmission ).add( weights.iridescence ).toVar();
	const invTotal = float( 1.0 ).div( max( total, float( 0.001 ) ) ).toVar();

	// Vectorized multiplication
	weights.specular.mulAssign( invTotal );
	weights.diffuse.mulAssign( invTotal );
	weights.sheen.mulAssign( invTotal );
	weights.clearcoat.mulAssign( invTotal );
	weights.transmission.mulAssign( invTotal );
	weights.iridescence.mulAssign( invTotal );

	return weights;

} ).setLayout( {
	name: 'calculateBRDFWeights',
	type: 'BRDFWeights',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'mc', type: 'MaterialClassification' },
		{ name: 'cache', type: 'MaterialCache' }
	]
} );

// ================================================================================
// MATERIAL IMPORTANCE AND SAMPLING INFO
// ================================================================================

/**
 * Calculate material importance for path termination decisions.
 * Enhanced calculation with better classification utilization.
 *
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} mc - MaterialClassification struct
 * @returns {TSLNode} Importance value [0, 1] (float)
 */
export const getMaterialImportance = Fn( ( [ material, mc ] ) => {

	const result = float( 0.0 ).toVar();

	// Early out for specialized materials
	If( material.transmission.greaterThan( 0.0 ).or( material.clearcoat.greaterThan( 0.0 ) ), () => {

		result.assign( 0.95 );

	} ).Else( () => {

		// Base importance from enhanced complexity score
		const baseImportance = mc.complexityScore.toVar();

		// Enhanced emissive importance calculation
		const emissiveImportance = float( 0.0 ).toVar();

		If( mc.isEmissive.equal( uint( 1 ) ), () => {

			// Use accurate luminance calculation
			const emissiveLuminance = dot( material.emissive, vec3( 0.2126, 0.7152, 0.0722 ) ).toVar();
			emissiveImportance.assign(
				min( float( 0.6 ), emissiveLuminance.mul( material.emissiveIntensity ).mul( 0.25 ) )
			);

		} );

		// Enhanced material-specific boosts using classification
		const materialBoost = float( 0.0 ).toVar();

		If( mc.isMetallic.equal( uint( 1 ) ).and( mc.isSmooth.equal( uint( 1 ) ) ), () => {

			materialBoost.addAssign( 0.25 ); // Perfect reflector

		} ).ElseIf( mc.isMetallic.equal( uint( 1 ) ), () => {

			materialBoost.addAssign( 0.15 );

		} );

		If( mc.isTransmissive.equal( uint( 1 ) ), () => {

			materialBoost.addAssign( 0.2 );

		} );

		If( mc.hasClearcoat.equal( uint( 1 ) ), () => {

			materialBoost.addAssign( 0.1 );

		} );

		// Combine all factors with better weighting
		const totalImportance = max( baseImportance.add( materialBoost ), emissiveImportance ).toVar();

		// Clamp and return
		result.assign( clamp( totalImportance, float( 0.0 ), float( 1.0 ) ) );

	} );

	return result;

} ).setLayout( {
	name: 'getMaterialImportance',
	type: 'float',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'mc', type: 'MaterialClassification' }
	]
} );

/**
 * Get importance sampling info for a material at specific bounce.
 * Calculates weights for different sampling strategies (diffuse, specular, transmission, etc.).
 *
 * Note: This function references uniforms (environmentIntensity, useEnvMapIS, enableEnvironmentLight)
 * which should be defined in the calling shader context.
 *
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} bounceIndex - Current bounce index (int)
 * @param {TSLNode} mc - MaterialClassification struct
 * @param {TSLNode} environmentIntensity - Environment light intensity (float, uniform)
 * @param {TSLNode} useEnvMapIS - Use environment map importance sampling (bool, uniform)
 * @param {TSLNode} enableEnvironmentLight - Enable environment lighting (bool, uniform)
 * @returns {TSLNode} ImportanceSamplingInfo struct
 */
export const getImportanceSamplingInfo = Fn( ( [ material, bounceIndex, mc, environmentIntensity, useEnvMapIS, enableEnvironmentLight ] ) => {

	const info = property( 'ImportanceSamplingInfo' ).toVar();

	// Base BRDF weights using temporary cache
	const tempCache = property( 'MaterialCache' ).toVar();
	tempCache.invRoughness.assign( float( 1.0 ).sub( material.roughness ) );
	tempCache.metalFactor.assign( float( 0.5 ).add( material.metalness.mul( 0.5 ) ) );
	tempCache.iorFactor.assign( min( float( 2.0 ).div( material.ior ), float( 1.0 ) ) );
	tempCache.maxSheenColor.assign( max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) ) );

	const weights = calculateBRDFWeights( material, mc, tempCache ).toVar();

	// Base importances on BRDF weights
	info.diffuseImportance.assign( weights.diffuse );
	info.specularImportance.assign( weights.specular );
	info.transmissionImportance.assign( weights.transmission );
	info.clearcoatImportance.assign( weights.clearcoat );

	// FIXED: Significantly increased base environment strength for interior scene support
	const baseEnvStrength = environmentIntensity.mul( 0.2 ).toVar();

	// For secondary bounces, boost environment importance further
	const isSecondaryBounce = bounceIndex.greaterThan( 0 ).toVar();
	const indirectEnvBoost = isSecondaryBounce.select( float( 1.5 ), float( 1.0 ) ).toVar();

	// Material-based environment factor
	const envMaterialFactor = float( 1.0 ).toVar();
	envMaterialFactor.mulAssign( mc.isMetallic.equal( uint( 1 ) ).select( float( 2.5 ), float( 1.0 ) ) );
	envMaterialFactor.mulAssign( mc.isRough.equal( uint( 1 ) ).select( float( 2.2 ), float( 1.0 ) ) );
	envMaterialFactor.mulAssign( mc.isTransmissive.equal( uint( 1 ) ).select( float( 0.5 ), float( 1.0 ) ) );
	envMaterialFactor.mulAssign( mc.hasClearcoat.equal( uint( 1 ) ).select( float( 1.6 ), float( 1.0 ) ) );

	// Apply indirect boost for secondary bounces
	info.envmapImportance.assign( baseEnvStrength.mul( envMaterialFactor ).mul( indirectEnvBoost ) );

	// Material-specific adjustments using classification
	If( bounceIndex.greaterThan( 2 ), () => {

		const depthFactor = float( 1.0 ).div( bounceIndex.sub( 1 ).toFloat() ).toVar();

		// Gentle depth adjustments
		info.specularImportance.mulAssign( float( 0.8 ).add( depthFactor.mul( 0.2 ) ) );
		info.clearcoatImportance.mulAssign( float( 0.7 ).add( depthFactor.mul( 0.3 ) ) );
		info.diffuseImportance.mulAssign( float( 1.0 ).add( depthFactor.mul( 0.2 ) ) );

	} );

	// Fast material-specific boosts using pre-computed classification
	If( mc.isMetallic.equal( uint( 1 ) ).and( bounceIndex.lessThan( 3 ) ), () => {

		info.specularImportance.assign( max( info.specularImportance, float( 0.6 ) ) );
		info.envmapImportance.assign( max( info.envmapImportance, float( 0.35 ) ) );
		info.diffuseImportance.mulAssign( 0.4 );

	} );

	// FIXED: For diffuse materials on secondary bounces, boost environment importance
	If( mc.isRough.equal( uint( 1 ) ).and( mc.isMetallic.equal( uint( 0 ) ) ).and( isSecondaryBounce ), () => {

		info.envmapImportance.assign( max( info.envmapImportance, float( 0.4 ) ) );

	} );

	If( mc.isTransmissive.equal( uint( 1 ) ), () => {

		info.transmissionImportance.assign( max( info.transmissionImportance, float( 0.8 ) ) );
		info.diffuseImportance.mulAssign( 0.2 );
		info.specularImportance.mulAssign( 0.6 );
		info.envmapImportance.mulAssign( 0.8 );

	} );

	If( mc.hasClearcoat.equal( uint( 1 ) ), () => {

		info.clearcoatImportance.assign( max( info.clearcoatImportance, float( 0.4 ) ) );
		info.envmapImportance.assign( max( info.envmapImportance, float( 0.25 ) ) );

	} );

	// Normalize to sum to 1.0
	const sum = info.diffuseImportance.add( info.specularImportance )
		.add( info.transmissionImportance ).add( info.clearcoatImportance )
		.add( info.envmapImportance ).toVar();

	If( sum.greaterThan( 0.001 ), () => {

		const invSum = float( 1.0 ).div( sum ).toVar();
		info.diffuseImportance.mulAssign( invSum );
		info.specularImportance.mulAssign( invSum );
		info.transmissionImportance.mulAssign( invSum );
		info.clearcoatImportance.mulAssign( invSum );
		info.envmapImportance.mulAssign( invSum );

	} ).Else( () => {

		// Fallback - prefer environment sampling when IS is available
		If( useEnvMapIS.and( enableEnvironmentLight ), () => {

			info.diffuseImportance.assign( 0.35 );
			info.envmapImportance.assign( 0.65 );

		} ).Else( () => {

			info.diffuseImportance.assign( 0.6 );
			info.envmapImportance.assign( 0.4 );

		} );
		info.specularImportance.assign( 0.0 );
		info.transmissionImportance.assign( 0.0 );
		info.clearcoatImportance.assign( 0.0 );

	} );

	return info;

} ).setLayout( {
	name: 'getImportanceSamplingInfo',
	type: 'ImportanceSamplingInfo',
	inputs: [
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'bounceIndex', type: 'int' },
		{ name: 'mc', type: 'MaterialClassification' },
		{ name: 'environmentIntensity', type: 'float' },
		{ name: 'useEnvMapIS', type: 'bool' },
		{ name: 'enableEnvironmentLight', type: 'bool' }
	]
} );

// ================================================================================
// MATERIAL CACHE CREATION
// ================================================================================

/**
 * Create a material cache with precomputed values for optimization.
 * Uses material classification and texture samples.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @param {TSLNode} samples - MaterialSamples struct
 * @param {TSLNode} mc - MaterialClassification struct
 * @returns {TSLNode} MaterialCache struct
 */
export const createMaterialCache = Fn( ( [ N, V, material, samples, mc ] ) => {

	const cache = property( 'MaterialCache' ).toVar();

	cache.NoV.assign( max( dot( N, V ), float( 0.001 ) ) );

	// Use pre-computed material classification for faster checks
	const isPurelyDiffuse = mc.isRough.equal( uint( 1 ) ).and( mc.isMetallic.equal( uint( 0 ) ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) ).toVar();

	cache.isPurelyDiffuse.assign( isPurelyDiffuse.select( uint( 1 ), uint( 0 ) ) );
	cache.isMetallic.assign( mc.isMetallic );

	const hasSpecialFeatures = mc.isTransmissive.equal( uint( 1 ) )
		.or( mc.hasClearcoat.equal( uint( 1 ) ) )
		.or( material.sheen.greaterThan( 0.0 ) )
		.or( material.iridescence.greaterThan( 0.0 ) ).toVar();

	cache.hasSpecialFeatures.assign( hasSpecialFeatures.select( uint( 1 ), uint( 0 ) ) );

	// Pre-compute frequently used values
	cache.alpha.assign( samples.roughness.mul( samples.roughness ) );
	cache.alpha2.assign( cache.alpha.mul( cache.alpha ) );
	const r = samples.roughness.add( 1.0 ).toVar();
	cache.k.assign( r.mul( r ).div( 8.0 ) );

	// Pre-compute F0 and colors
	const dielectricF0 = vec3( 0.04 ).mul( material.specularColor ).toVar();
	cache.F0.assign( mix( dielectricF0, samples.albedo.rgb, samples.metalness ).mul( material.specularIntensity ) );
	cache.diffuseColor.assign( samples.albedo.rgb.mul( float( 1.0 ).sub( samples.metalness ) ) );
	cache.specularColor.assign( samples.albedo.rgb );

	// OPTIMIZED: Pre-compute BRDF shared values to eliminate redundant calculations
	cache.invRoughness.assign( float( 1.0 ).sub( samples.roughness ) );
	cache.metalFactor.assign( float( 0.5 ).add( samples.metalness.mul( 0.5 ) ) );
	cache.iorFactor.assign( min( float( 2.0 ).div( material.ior ), float( 1.0 ) ) );
	cache.maxSheenColor.assign( max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) ) );

	return cache;

} ).setLayout( {
	name: 'createMaterialCache',
	type: 'MaterialCache',
	inputs: [
		{ name: 'N', type: 'vec3' },
		{ name: 'V', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'samples', type: 'MaterialSamples' },
		{ name: 'mc', type: 'MaterialClassification' }
	]
} );

/**
 * Create a material cache without texture samples (legacy version).
 * Uses material base properties only.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} material - RayTracingMaterial struct
 * @returns {TSLNode} MaterialCache struct
 */
export const createMaterialCacheLegacy = Fn( ( [ N, V, material ] ) => {

	const cache = property( 'MaterialCache' ).toVar();

	cache.NoV.assign( max( dot( N, V ), float( 0.001 ) ) );

	const isPurelyDiffuse = material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) ).toVar();

	cache.isPurelyDiffuse.assign( isPurelyDiffuse.select( uint( 1 ), uint( 0 ) ) );
	cache.isMetallic.assign( material.metalness.greaterThan( 0.7 ).select( uint( 1 ), uint( 0 ) ) );

	const hasSpecialFeatures = material.transmission.greaterThan( 0.0 )
		.or( material.clearcoat.greaterThan( 0.0 ) )
		.or( material.sheen.greaterThan( 0.0 ) )
		.or( material.iridescence.greaterThan( 0.0 ) ).toVar();

	cache.hasSpecialFeatures.assign( hasSpecialFeatures.select( uint( 1 ), uint( 0 ) ) );

	cache.alpha.assign( material.roughness.mul( material.roughness ) );
	cache.alpha2.assign( cache.alpha.mul( cache.alpha ) );
	const r = material.roughness.add( 1.0 ).toVar();
	cache.k.assign( r.mul( r ).div( 8.0 ) );

	const dielectricF0 = vec3( 0.04 ).mul( material.specularColor ).toVar();
	cache.F0.assign( mix( dielectricF0, material.color.rgb, material.metalness ).mul( material.specularIntensity ) );
	cache.diffuseColor.assign( material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ) );
	cache.specularColor.assign( material.color.rgb );

	// OPTIMIZED: Pre-compute BRDF shared values for legacy cache too
	cache.invRoughness.assign( float( 1.0 ).sub( material.roughness ) );
	cache.metalFactor.assign( float( 0.5 ).add( material.metalness.mul( 0.5 ) ) );
	cache.iorFactor.assign( min( float( 2.0 ).div( material.ior ), float( 1.0 ) ) );
	cache.maxSheenColor.assign( max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) ) );

	return cache;

} ).setLayout( {
	name: 'createMaterialCacheLegacy',
	type: 'MaterialCache',
	inputs: [
		{ name: 'N', type: 'vec3' },
		{ name: 'V', type: 'vec3' },
		{ name: 'material', type: 'RayTracingMaterial' }
	]
} );
