import { Fn, float, vec2, vec3, vec4, texture, uniform, If, select, int, Loop } from 'three/tsl';
import { randomFloat } from './Random.js';

/**
 * Environment map sampling module for TSL.
 * Supports both uniform and importance-sampled environment lighting.
 *
 * Features:
 * - Uniform sphere sampling
 * - CDF-based importance sampling for HDR environments
 * - Binary search CDF lookup for accurate sampling
 * - MIS (Multiple Importance Sampling) weight computation
 */

const PI = Math.PI;
const TWO_PI = 2.0 * PI;

/**
 * Converts a 3D direction to equirectangular UV coordinates.
 *
 * @param {TSLNode} direction - Normalized direction vector (vec3)
 * @returns {TSLNode} UV coordinates (vec2) in [0, 1] range
 */
export const directionToEquirectUV = Fn( ( [ direction ] ) => {

	// Spherical coordinates
	// phi = atan(z, x), theta = acos(y)
	const phi = direction.z.atan( direction.x );
	const theta = direction.y.acos();

	// Map to [0, 1] UV range
	// U = (phi + PI) / (2 * PI)
	// V = theta / PI
	const u = phi.add( float( PI ) ).div( float( TWO_PI ) );
	const v = theta.div( float( PI ) );

	return vec2( u, v );

} );

/**
 * Converts equirectangular UV coordinates to a 3D direction.
 *
 * @param {TSLNode} uv - UV coordinates (vec2) in [0, 1] range
 * @returns {TSLNode} Normalized direction vector (vec3)
 */
export const equirectUVToDirection = Fn( ( [ uv ] ) => {

	// Convert UV back to spherical coordinates
	const phi = uv.x.mul( float( TWO_PI ) ).sub( float( PI ) );
	const theta = uv.y.mul( float( PI ) );

	// Convert to Cartesian
	const sinTheta = theta.sin();
	const cosTheta = theta.cos();
	const sinPhi = phi.sin();
	const cosPhi = phi.cos();

	return vec3(
		sinTheta.mul( cosPhi ),
		cosTheta,
		sinTheta.mul( sinPhi )
	);

} );

/**
 * Calculates the PDF for a direction on an equirectangular map.
 * Accounts for the solid angle distortion at the poles.
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @returns {TSLNode} PDF value (float)
 */
export const equirectPDF = Fn( ( [ direction ] ) => {

	// theta = acos(y), sin(theta) = sqrt(1 - y^2)
	const sinTheta = float( 1.0 ).sub( direction.y.mul( direction.y ) ).sqrt().max( 0.001 );

	// Uniform PDF over sphere: 1 / (4 * PI)
	// Jacobian for equirectangular: 1 / (2 * PI * PI * sin(theta))
	return float( 1.0 ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) );

} );

/**
 * Binary search in a 1D CDF texture.
 * Finds the UV coordinate corresponding to a random value.
 *
 * @param {TSLNode} cdfTex - CDF texture (1D, stored as 2D with height=1)
 * @param {TSLNode} targetValue - Random value in [0, 1]
 * @param {TSLNode} row - Row coordinate for 2D CDF (0 for marginal)
 * @returns {TSLNode} UV coordinate in [0, 1]
 */
export const binarySearchCDF = Fn( ( [ cdfTex, targetValue, row ] ) => {

	// Binary search using 8 iterations (sufficient for up to 256-wide textures)
	const low = float( 0.0 ).toVar( 'low' );
	const high = float( 1.0 ).toVar( 'high' );

	Loop( int( 8 ), () => {

		const mid = low.add( high ).mul( 0.5 );
		const cdfValue = cdfTex.sample( vec2( mid, row ) ).x;

		If( cdfValue.lessThan( targetValue ), () => {

			low.assign( mid );

		} ).Else( () => {

			high.assign( mid );

		} );

	} );

	return low.add( high ).mul( 0.5 );

} );

/**
 * Computes the power heuristic weight for MIS (Multiple Importance Sampling).
 * Uses the balance heuristic with power=2 for good variance reduction.
 *
 * @param {TSLNode} pdf1 - PDF of first sampling strategy
 * @param {TSLNode} pdf2 - PDF of second sampling strategy
 * @returns {TSLNode} MIS weight for first strategy
 */
export const misWeight = Fn( ( [ pdf1, pdf2 ] ) => {

	const p1Sq = pdf1.mul( pdf1 );
	const p2Sq = pdf2.mul( pdf2 );

	return p1Sq.div( p1Sq.add( p2Sq ).max( 0.0001 ) );

} );

/**
 * Creates an environment sampler for basic (uniform) sampling.
 *
 * @param {DataTexture} envMap - Environment map texture
 * @param {number} intensity - Environment intensity multiplier
 * @returns {Object} Environment sampler functions
 */
export const createEnvironmentSampler = ( envMap, intensity = 1.0 ) => {

	const envTex = texture( envMap );
	const envIntensity = uniform( intensity );

	/**
	 * Samples the environment map at a given direction.
	 *
	 * @param {TSLNode} direction - World space direction (vec3)
	 * @returns {TSLNode} Environment radiance (vec3)
	 */
	const sample = Fn( ( [ direction ] ) => {

		const uv = directionToEquirectUV( direction );
		const color = envTex.sample( uv ).xyz;
		return color.mul( envIntensity );

	} );

	/**
	 * Uniform random direction sampling.
	 * Samples a random direction on the upper hemisphere.
	 *
	 * @param {TSLNode} N - Surface normal (vec3)
	 * @param {TSLNode} rngState - Mutable RNG state
	 * @returns {Object} { direction, color, pdf }
	 */
	const sampleUniform = Fn( ( [ N, rngState ] ) => {

		const u1 = randomFloat( rngState );
		const u2 = randomFloat( rngState );

		// Uniform sphere sampling
		const z = float( 1.0 ).sub( u1.mul( 2.0 ) );
		const r = float( 1.0 ).sub( z.mul( z ) ).sqrt();
		const phi = u2.mul( float( TWO_PI ) );

		const direction = vec3(
			r.mul( phi.cos() ),
			z,
			r.mul( phi.sin() )
		);

		// Ensure direction is in the upper hemisphere (same side as normal)
		const NdotD = N.dot( direction );
		const flipped = direction.mul( NdotD.sign() );

		const color = sample( flipped );
		const pdf = float( 1.0 / ( 4.0 * PI ) );

		return { direction: flipped, color, pdf };

	} );

	return {
		sample,
		sampleUniform,
		intensity: envIntensity
	};

};

/**
 * Creates an environment sampler with importance sampling using CDF textures.
 * More efficient for HDR environments with bright light sources.
 *
 * @param {DataTexture} envMap - Environment map texture
 * @param {DataTexture} marginalCDF - Marginal CDF texture (1D, inverted for direct lookup)
 * @param {DataTexture} conditionalCDF - Conditional CDF texture (2D, inverted for direct lookup)
 * @param {number} totalLuminance - Sum of all luminance values
 * @param {number} intensity - Environment intensity multiplier
 * @returns {Object} Environment sampler functions
 */
export const createImportanceSampledEnvironment = ( envMap, marginalCDF, conditionalCDF, totalLuminance, intensity = 1.0 ) => {

	const envTex = texture( envMap );
	const marginalTex = texture( marginalCDF );
	const conditionalTex = texture( conditionalCDF );
	const envIntensity = uniform( intensity );
	const totalSum = uniform( totalLuminance );

	/**
	 * Samples the environment map at a given direction.
	 */
	const sample = Fn( ( [ direction ] ) => {

		const uv = directionToEquirectUV( direction );
		const color = envTex.sample( uv ).xyz;
		return color.mul( envIntensity );

	} );

	/**
	 * Importance samples the environment using precomputed CDF textures.
	 * Uses binary search for accurate CDF inversion.
	 *
	 * @param {TSLNode} rngState - Mutable RNG state
	 * @returns {Object} { direction, color, pdf }
	 */
	const sampleImportance = Fn( ( [ rngState ] ) => {

		const r1 = randomFloat( rngState );
		const r2 = randomFloat( rngState );

		// Sample V coordinate from marginal CDF using binary search
		const v = binarySearchCDF( marginalTex, r1, float( 0.5 ) );

		// Sample U coordinate from conditional CDF at row V using binary search
		const u = binarySearchCDF( conditionalTex, r2, v );

		const uv = vec2( u, v );
		const direction = equirectUVToDirection( uv );
		const color = envTex.sample( uv ).xyz.mul( envIntensity );

		// Compute PDF
		// PDF = luminance(pixel) / totalSum * (width * height) / (2 * PI * PI * sin(theta))
		const luminance = color.x.mul( 0.2126 ).add( color.y.mul( 0.7152 ) ).add( color.z.mul( 0.0722 ) );
		const sinTheta = float( 1.0 ).sub( direction.y.mul( direction.y ) ).sqrt().max( 0.001 );
		const pdf = luminance.div( totalSum.max( 0.001 ) ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) ).max( 0.0001 );

		return { direction, color, pdf };

	} );

	/**
	 * Importance samples with MIS weight computation.
	 * Returns both the sample and MIS weight for combining with BSDF sampling.
	 *
	 * @param {TSLNode} rngState - Mutable RNG state
	 * @param {TSLNode} bsdfPdf - PDF from BSDF sampling (for MIS)
	 * @returns {Object} { direction, color, pdf, misWeight }
	 */
	const sampleWithMIS = Fn( ( [ rngState, bsdfPdf ] ) => {

		const result = sampleImportance( rngState );
		const weight = misWeight( result.pdf, bsdfPdf );

		return {
			direction: result.direction,
			color: result.color,
			pdf: result.pdf,
			misWeight: weight
		};

	} );

	/**
	 * Computes the PDF for a specific direction using the importance sampling distribution.
	 *
	 * @param {TSLNode} direction - Direction to compute PDF for
	 * @returns {TSLNode} PDF value (float)
	 */
	const pdfForDirection = Fn( ( [ direction ] ) => {

		const uv = directionToEquirectUV( direction );
		const color = envTex.sample( uv ).xyz.mul( envIntensity );
		const luminance = color.x.mul( 0.2126 ).add( color.y.mul( 0.7152 ) ).add( color.z.mul( 0.0722 ) );
		const sinTheta = float( 1.0 ).sub( direction.y.mul( direction.y ) ).sqrt().max( 0.001 );

		return luminance.div( totalSum.max( 0.001 ) ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) ).max( 0.0001 );

	} );

	return {
		sample,
		sampleImportance,
		sampleWithMIS,
		pdfForDirection,
		intensity: envIntensity,
		totalSum
	};

};

/**
 * Creates a simple solid color environment (for testing or simple scenes).
 *
 * @param {number[]} color - RGB color array [r, g, b]
 * @param {number} intensity - Intensity multiplier
 * @returns {Object} Environment sampler functions
 */
export const createSolidColorEnvironment = ( color = [ 0.5, 0.7, 1.0 ], intensity = 1.0 ) => {

	const envColor = uniform( vec3( ...color ) );
	const envIntensity = uniform( intensity );

	const sample = Fn( ( [ direction ] ) => {

		// Simple sky gradient based on Y direction
		const t = direction.y.mul( 0.5 ).add( 0.5 );
		const skyBlue = vec3( 0.5, 0.7, 1.0 );
		const horizonWhite = vec3( 1.0, 1.0, 1.0 );

		return skyBlue.mix( horizonWhite, t ).mul( envIntensity );

	} );

	const sampleUniform = Fn( ( [ N, rngState ] ) => {

		const u1 = randomFloat( rngState );
		const u2 = randomFloat( rngState );

		const z = float( 1.0 ).sub( u1.mul( 2.0 ) );
		const r = float( 1.0 ).sub( z.mul( z ) ).sqrt();
		const phi = u2.mul( float( TWO_PI ) );

		const direction = vec3( r.mul( phi.cos() ), z, r.mul( phi.sin() ) );
		const NdotD = N.dot( direction );
		const flipped = direction.mul( NdotD.sign() );

		const color = sample( flipped );
		const pdf = float( 1.0 / ( 4.0 * PI ) );

		return { direction: flipped, color, pdf };

	} );

	return {
		sample,
		sampleUniform,
		color: envColor,
		intensity: envIntensity
	};

};

