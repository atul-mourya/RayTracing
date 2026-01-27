import { Fn, float, vec2, vec3, vec4, texture, uniform, If, select } from 'three/tsl';
import { randomFloat } from './Random.js';

/**
 * Environment map sampling module for TSL.
 * Supports both uniform and importance-sampled environment lighting.
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
	// phi = atan2(z, x), theta = acos(y)
	const phi = direction.z.atan2( direction.x );
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
 * @param {DataTexture} marginalCDF - Marginal CDF texture (1D)
 * @param {DataTexture} conditionalCDF - Conditional CDF texture (2D)
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
	 *
	 * @param {TSLNode} rngState - Mutable RNG state
	 * @returns {Object} { direction, color, pdf }
	 */
	const sampleImportance = Fn( ( [ rngState ] ) => {

		const r1 = randomFloat( rngState );
		const r2 = randomFloat( rngState );

		// Sample V coordinate from marginal CDF
		const v = marginalTex.sample( vec2( r1, 0.5 ) ).x;

		// Sample U coordinate from conditional CDF at V
		const u = conditionalTex.sample( vec2( r2, v ) ).x;

		const uv = vec2( u, v );
		const direction = equirectUVToDirection( uv );
		const color = envTex.sample( uv ).xyz.mul( envIntensity );

		// Compute PDF
		// PDF = luminance(pixel) * resolution / totalSum * equirect_jacobian
		const luminance = color.x.mul( 0.2126 ).add( color.y.mul( 0.7152 ) ).add( color.z.mul( 0.0722 ) );
		const sinTheta = float( 1.0 ).sub( direction.y.mul( direction.y ) ).sqrt().max( 0.001 );
		const pdf = luminance.div( totalSum ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) ).max( 0.0001 );

		return { direction, color, pdf };

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

		return luminance.div( totalSum ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) ).max( 0.0001 );

	} );

	return {
		sample,
		sampleImportance,
		pdfForDirection,
		intensity: envIntensity
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

