import { Fn, float, vec2, vec3, vec4, mat3, int, If } from 'three/tsl';

/**
 * Common utility functions for path tracing.
 * Comprehensive port of common.fs from GLSL to TSL.
 * 
 * Includes:
 * - Color space conversions (sRGB, linear, XYZ)
 * - Mathematical utilities (square, min/max component)
 * - Multiple Importance Sampling (MIS) helpers
 * - Firefly suppression and clamping
 * - Material classification
 * - TBN matrix construction
 * - Dot product computations
 * 
 * Note: Material-related functions reference RayTracingMaterial struct.
 * See Struct.js for struct definitions (rayTracingMaterialStruct, dotProductsStruct).
 */

// -----------------------------------------------------------------------------
// Constants (export as JavaScript constants for use in TSL)
// -----------------------------------------------------------------------------

export const PI = Math.PI;
export const PI_INV = 1.0 / Math.PI;
export const TWO_PI = 2.0 * Math.PI;
export const EPSILON = 1e-6;
export const MIN_ROUGHNESS = 0.05;
export const MIN_CLEARCOAT_ROUGHNESS = 0.089;
export const MAX_ROUGHNESS = 1.0;
export const MIN_PDF = 0.001;

// REC709 luminance coefficients for color to luminance conversion
export const REC709_LUMINANCE_COEFFICIENTS = [ 0.2126, 0.7152, 0.0722 ];

// Material data layout
export const MATERIAL_SLOTS = 27;

// XYZ to sRGB color space conversion matrix
export const XYZ_TO_REC709_MATRIX = [
	3.2404542, -0.9692660, 0.0556434,
	-1.5371385, 1.8760108, -0.2040259,
	-0.4985314, 0.0415560, 1.0572252
];

// -----------------------------------------------------------------------------
// Color Space Conversions
// -----------------------------------------------------------------------------

/**
 * Convert sRGB color to linear RGB.
 * Matches sRGBToLinear from GLSL.
 *
 * @param {TSLNode} srgbColor - sRGB color (vec3)
 * @returns {TSLNode} Linear RGB color (vec3)
 */
export const sRGBToLinear = Fn( ( [ srgbColor ] ) => {

	return srgbColor.pow( vec3( 2.2 ) );

} );

/**
 * Apply gamma correction (linear to sRGB).
 * Matches gammaCorrection from GLSL.
 *
 * @param {TSLNode} color - Linear RGB color (vec3)
 * @returns {TSLNode} Gamma-corrected color (vec3)
 */
export const gammaCorrection = Fn( ( [ color ] ) => {

	return color.pow( vec3( 1.0 / 2.2 ) );

} );

/**
 * Convert XYZ color to sRGB.
 * Uses the XYZ_TO_REC709 matrix.
 *
 * @param {TSLNode} xyzColor - XYZ color (vec3)
 * @returns {TSLNode} sRGB color (vec3)
 */
export const xyzToSRGB = Fn( ( [ xyzColor ] ) => {

	// Create matrix from constants
	const m = mat3(
		vec3( 3.2404542, -1.5371385, -0.4985314 ),
		vec3( -0.9692660, 1.8760108, 0.0415560 ),
		vec3( 0.0556434, -0.2040259, 1.0572252 )
	);

	return m.mul( xyzColor );

} );

// -----------------------------------------------------------------------------
// Mathematical Utilities
// -----------------------------------------------------------------------------

/**
 * Square a float value.
 * Matches square(float) from GLSL.
 *
 * @param {TSLNode} x - Input value (float)
 * @returns {TSLNode} Squared value (float)
 */
export const square = Fn( ( [ x ] ) => {

	return x.mul( x );

} );

/**
 * Square a vec3 component-wise.
 * Matches square(vec3) from GLSL.
 *
 * @param {TSLNode} x - Input vector (vec3)
 * @returns {TSLNode} Squared vector (vec3)
 */
export const squareVec3 = Fn( ( [ x ] ) => {

	return x.mul( x );

} );

/**
 * Get maximum component of a vector.
 * Matches maxComponent from GLSL.
 *
 * @param {TSLNode} v - Input vector (vec3)
 * @returns {TSLNode} Maximum component (float)
 */
export const maxComponent = Fn( ( [ v ] ) => {

	return v.r.max( v.g ).max( v.b );

} );

/**
 * Get minimum component of a vector.
 * Matches minComponent from GLSL.
 *
 * @param {TSLNode} v - Input vector (vec3)
 * @returns {TSLNode} Minimum component (float)
 */
export const minComponent = Fn( ( [ v ] ) => {

	return v.r.min( v.g ).min( v.b );

} );

/**
 * Get luminance of a color using REC709 coefficients.
 * Built-in luminance() available in some TSL versions, this is explicit version.
 *
 * @param {TSLNode} color - RGB color (vec3)
 * @returns {TSLNode} Luminance (float)
 */
export const luminance = Fn( ( [ color ] ) => {

	const coeffs = vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] );
	return color.dot( coeffs );

} );

// -----------------------------------------------------------------------------
// Multiple Importance Sampling (MIS)
// -----------------------------------------------------------------------------

/**
 * Optimized power heuristic for multiple importance sampling.
 * Matches powerHeuristic from GLSL with fast paths for extreme ratios.
 *
 * @param {TSLNode} pdf1 - PDF of first sampling strategy
 * @param {TSLNode} pdf2 - PDF of second sampling strategy
 * @returns {TSLNode} MIS weight for first strategy
 */
export const powerHeuristic = Fn( ( [ pdf1, pdf2 ] ) => {

	// Fast path for clearly dominant PDF
	const ratio = pdf1.div( pdf2.max( float( MIN_PDF ) ) );

	let result = float( 0.0 ).toVar( 'result' );

	// Extreme cases - early exit
	If( ratio.greaterThan( float( 10.0 ) ), () => {

		result.assign( float( 1.0 ) );

	} ).ElseIf( ratio.lessThan( float( 0.1 ) ), () => {

		result.assign( float( 0.0 ) );

	} ).ElseIf( ratio.greaterThan( float( 5.0 ) ), () => {

		result.assign( float( 0.95 ) );

	} ).ElseIf( ratio.lessThan( float( 0.2 ) ), () => {

		result.assign( float( 0.05 ) );

	} ).Else( () => {

		// Standard power heuristic calculation for intermediate cases
		const p1 = pdf1.mul( pdf1 );
		const p2 = pdf2.mul( pdf2 );
		result.assign( p1.div( p1.add( p2 ).max( float( MIN_PDF ) ) ) );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// Dithering and Firefly Suppression
// -----------------------------------------------------------------------------

/**
 * Apply Bayer matrix dithering to reduce banding.
 * Matches applyDithering from GLSL.
 * Note: Requires resolution uniform to be available.
 *
 * @param {TSLNode} color - Input color (vec3)
 * @param {TSLNode} uv - UV coordinates (vec2)
 * @param {TSLNode} ditheringAmount - Dithering strength (float)
 * @param {TSLNode} resolution - Screen resolution (vec2)
 * @returns {TSLNode} Dithered color (vec3)
 */
export const applyDithering = Fn( ( [ color, uv, ditheringAmount, resolution ] ) => {

	// Bayer 4x4 matrix values
	// This is a simplified version - full implementation would use array lookup
	const pixelCoord = uv.mul( resolution ).floor().toInt();
	const x = pixelCoord.x.mod( int( 4 ) );
	const y = pixelCoord.y.mod( int( 4 ) );

	// Simple dithering pattern (approximation)
	// Full Bayer matrix would require conditional lookups
	const dither = float( x ).add( float( y ).mul( float( 4 ) ) ).div( float( 16.0 ) );

	return color.add( dither.sub( float( 0.5 ) ).mul( ditheringAmount ).div( float( 255.0 ) ) );

} );

/**
 * Reduce fireflies by clamping luminance.
 * Matches reduceFireflies from GLSL.
 *
 * @param {TSLNode} color - Input color (vec3)
 * @param {TSLNode} maxValue - Maximum luminance (float)
 * @returns {TSLNode} Clamped color (vec3)
 */
export const reduceFireflies = Fn( ( [ color, maxValue ] ) => {

	const coeffs = vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] );
	const lum = color.dot( coeffs );

	let result = color.toVar( 'result' );

	If( lum.greaterThan( maxValue ), () => {

		result.assign( color.mul( maxValue.div( lum ) ) );

	} );

	return result;

} );

/**
 * Apply soft suppression to prevent harsh clipping.
 * Matches applySoftSuppression from GLSL.
 *
 * @param {TSLNode} value - Input value (float)
 * @param {TSLNode} threshold - Threshold value (float)
 * @param {TSLNode} dampingFactor - Damping factor (float)
 * @returns {TSLNode} Suppressed value (float)
 */
export const applySoftSuppression = Fn( ( [ value, threshold, dampingFactor ] ) => {

	let result = value.toVar( 'result' );

	If( value.greaterThan( threshold ), () => {

		const excess = value.sub( threshold );
		const suppressionFactor = threshold.div( threshold.add( excess.mul( dampingFactor ) ) );
		result.assign( value.mul( suppressionFactor ) );

	} );

	return result;

} );

/**
 * Apply soft suppression to RGB color while preserving hue.
 * Matches applySoftSuppressionRGB from GLSL.
 *
 * @param {TSLNode} color - Input color (vec3)
 * @param {TSLNode} threshold - Luminance threshold (float)
 * @param {TSLNode} dampingFactor - Damping factor (float)
 * @returns {TSLNode} Suppressed color (vec3)
 */
export const applySoftSuppressionRGB = Fn( ( [ color, threshold, dampingFactor ] ) => {

	const coeffs = vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] );
	const lum = color.dot( coeffs );

	let result = color.toVar( 'result' );

	If( lum.greaterThan( threshold ), () => {

		const suppressedLum = applySoftSuppression( lum, threshold, dampingFactor );
		If( lum.greaterThan( float( EPSILON ) ), () => {

			result.assign( color.mul( suppressedLum.div( lum ) ) );

		} );

	} );

	return result;

} );

/**
 * Calculate firefly threshold based on bounce depth.
 * Matches calculateFireflyThreshold from GLSL.
 *
 * @param {TSLNode} baseThreshold - Base threshold value (float)
 * @param {TSLNode} contextMultiplier - Context-specific multiplier (float)
 * @param {TSLNode} bounceIndex - Current bounce index (int)
 * @returns {TSLNode} Adjusted threshold (float)
 */
export const calculateFireflyThreshold = Fn( ( [ baseThreshold, contextMultiplier, bounceIndex ] ) => {

	const depthFactor = float( 1.0 ).div( float( bounceIndex ).add( float( 1 ) ).pow( float( 0.5 ) ) );
	return baseThreshold.mul( contextMultiplier ).mul( depthFactor );

} );

// -----------------------------------------------------------------------------
// Geometry Utilities
// -----------------------------------------------------------------------------

/**
 * Construct TBN (Tangent-Bitangent-Normal) matrix from normal.
 * Matches constructTBN from GLSL.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @returns {TSLNode} TBN matrix (mat3)
 */
export const constructTBN = Fn( ( [ N ] ) => {

	// Create tangent and bitangent vectors
	const majorAxis = N.x.abs().lessThan( float( 0.999 ) ).select( vec3( 1, 0, 0 ), vec3( 0, 1, 0 ) );
	const T = N.cross( majorAxis ).normalize();
	const B = N.cross( T ).normalize();

	return mat3( T, B, N );

} );

/**
 * Compute all dot products for BRDF evaluation.
 * Matches computeDotProducts from GLSL.
 * Returns object with NoL, NoV, NoH, VoH, LoH.
 *
 * @param {TSLNode} N - Surface normal (vec3)
 * @param {TSLNode} V - View direction (vec3)
 * @param {TSLNode} L - Light direction (vec3)
 * @returns {Object} Dot products { NoL, NoV, NoH, VoH, LoH }
 */
export const computeDotProducts = Fn( ( [ N, V, L ] ) => {

	const H = V.add( L );
	const lenSq = H.dot( H );

	const normalizedH = lenSq.greaterThan( float( EPSILON ) ).select(
		H.div( lenSq.sqrt() ),
		vec3( 0.0, 0.0, 1.0 )
	);

	const NoL = N.dot( L ).max( float( 0.001 ) );
	const NoV = N.dot( V ).max( float( 0.001 ) );
	const NoH = N.dot( normalizedH ).max( float( 0.001 ) );
	const VoH = V.dot( normalizedH ).max( float( 0.001 ) );
	const LoH = L.dot( normalizedH ).max( float( 0.001 ) );

	return { NoL, NoV, NoH, VoH, LoH };

} );

// -----------------------------------------------------------------------------
// Material Classification and Firefly Tolerance (Requires Material Struct)
// -----------------------------------------------------------------------------
// Note: These functions require the RayTracingMaterial struct to be defined
// They are included as reference but may need struct definitions from Material.js

/**
 * Get material-specific firefly tolerance multiplier.
 * Matches getMaterialFireflyTolerance from GLSL.
 * Note: Requires material struct with metalness, roughness, transmission, dispersion fields.
 *
 * @param {TSLNode} material - Material struct
 * @returns {TSLNode} Tolerance multiplier (float)
 */
export const getMaterialFireflyTolerance = Fn( ( [ material ] ) => {

	let tolerance = float( 1.0 ).toVar( 'tolerance' );

	// Metals can handle brighter values legitimately
	tolerance.mulAssign( material.metalness.greaterThanEqual( float( 0.7 ) ).select( float( 1.5 ), float( 1.0 ) ) );

	// Rough surfaces need less aggressive clamping
	tolerance.mulAssign( material.roughness.mul( float( 0.4 ) ).add( float( 0.8 ) ) );

	// Transmissive materials
	tolerance.mulAssign( material.transmission.mul( float( - 0.1 ) ).add( float( 1.0 ) ) );

	// Dispersive materials need more aggressive clamping
	const dispersionFactor = material.dispersion.mul( float( 0.1 ) ).clamp( float( 0.0 ), float( 1.0 ) );
	tolerance.mulAssign( dispersionFactor.mul( float( - 0.3 ) ).add( float( 1.0 ) ) );

	return tolerance;

} );

/**
 * Calculate view-dependent firefly tolerance for specular materials.
 * Matches getViewDependentTolerance from GLSL.
 *
 * @param {TSLNode} material - Material struct
 * @param {TSLNode} sampleDir - Sample direction (vec3)
 * @param {TSLNode} viewDir - View direction (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @returns {TSLNode} Tolerance multiplier (float)
 */
export const getViewDependentTolerance = Fn( ( [ material, sampleDir, viewDir, normal ] ) => {

	let tolerance = float( 1.0 ).toVar( 'tolerance' );

	// For very smooth materials, allow brighter values in specular direction
	If( material.roughness.lessThan( float( 0.2 ) ), () => {

		const reflectDir = viewDir.negate().reflect( normal );
		const specularAlignment = sampleDir.dot( reflectDir ).max( float( 0.0 ) );
		const viewDependentScale = specularAlignment.pow( float( 4.0 ) ).mul( float( 1.5 ) ).add( float( 1.0 ) );
		tolerance.mulAssign( viewDependentScale );

	} );

	return tolerance;

} );

/**
 * Summary of exported functions:
 * 
 * Color Space:
 * - sRGBToLinear(srgbColor) - sRGB to linear RGB
 * - gammaCorrection(color) - Linear RGB to sRGB
 * - xyzToSRGB(xyzColor) - XYZ to sRGB conversion
 * 
 * Math Utilities:
 * - square(x) - Square a float
 * - squareVec3(x) - Square vec3 component-wise
 * - maxComponent(v) - Get max component of vec3
 * - minComponent(v) - Get min component of vec3
 * - luminance(color) - Calculate luminance
 * 
 * MIS:
 * - powerHeuristic(pdf1, pdf2) - Power heuristic for MIS
 * 
 * Firefly Suppression:
 * - applyDithering(color, uv, amount, resolution) - Bayer dithering
 * - reduceFireflies(color, maxValue) - Luminance clamping
 * - applySoftSuppression(value, threshold, damping) - Soft value suppression
 * - applySoftSuppressionRGB(color, threshold, damping) - Soft color suppression
 * - calculateFireflyThreshold(base, multiplier, bounceIndex) - Depth-aware threshold
 * - getMaterialFireflyTolerance(material) - Material-specific tolerance
 * - getViewDependentTolerance(material, sampleDir, viewDir, normal) - View-dependent tolerance
 * 
 * Geometry:
 * - constructTBN(N) - Build TBN matrix from normal
 * - computeDotProducts(N, V, L) - Compute all BRDF dot products
 */
