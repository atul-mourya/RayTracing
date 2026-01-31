import { Fn, float, vec2, vec3, vec4, mat4, If } from 'three/tsl';

/**
 * Environment map sampling module for TSL.
 * Comprehensive port of environment.fs from GLSL to TSL/WGSL.
 * 
 * Supports:
 * - Equirectangular HDR environment maps
 * - Uniform sphere sampling
 * - Importance sampling via CDF textures
 * - Multiple Importance Sampling (MIS) with BRDF
 * - Environment matrix rotation
 * 
 * Exact implementation matching environment.fs
 */

const PI = Math.PI;
const TWO_PI = 2.0 * Math.PI;

// Luminance coefficients for importance sampling
const REC709_LUMINANCE_COEFFICIENTS = [ 0.2126, 0.7152, 0.0722 ];

// -----------------------------------------------------------------------------
// Equirectangular Coordinate Conversion
// -----------------------------------------------------------------------------

/**
 * Convert direction to UV coordinates for equirectangular map.
 * Exact implementation matching environment.fs
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @returns {TSLNode} UV coordinates (vec2)
 */
export const equirectDirectionToUv = Fn( ( [ direction, environmentMatrix ] ) => {

	// Apply environment matrix rotation
	const rotated = environmentMatrix.mul( vec4( direction, 0.0 ) );
	const d = rotated.xyz.normalize();

	// Convert to spherical coordinates
	const uvX = d.z.atan2( d.x );
	const uvY = d.y.acos();

	const uv = vec2( uvX, uvY ).div( vec2( TWO_PI, PI ) ).toVar( 'uv' );

	// Adjust to [0, 1] range and flip Y
	uv.x.assign( uv.x.add( float( 0.5 ) ) );
	uv.y.assign( float( 1.0 ).sub( uv.y ) );

	return uv;

} );

/**
 * Convert UV coordinates to direction.
 * Exact implementation matching environment.fs
 *
 * @param {TSLNode} uv - UV coordinates (vec2)
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @returns {TSLNode} Direction vector (vec3)
 */
export const equirectUvToDirection = Fn( ( [ uv, environmentMatrix ] ) => {

	// Undo UV adjustments
	const adjustedUV = vec2(
		uv.x.sub( float( 0.5 ) ),
		float( 1.0 ).sub( uv.y )
	).toVar();

	// Convert from spherical coordinates
	const theta = adjustedUV.x.mul( float( TWO_PI ) );
	const phi = adjustedUV.y.mul( float( PI ) );

	const sinPhi = phi.sin();

	const localDir = vec3(
		sinPhi.mul( theta.cos() ),
		phi.cos(),
		sinPhi.mul( theta.sin() )
	);

	// Apply inverse environment matrix rotation (transpose for orthogonal matrix)
	const transposed = mat4(
		vec4( environmentMatrix[ 0 ].x, environmentMatrix[ 1 ].x, environmentMatrix[ 2 ].x, environmentMatrix[ 3 ].x ),
		vec4( environmentMatrix[ 0 ].y, environmentMatrix[ 1 ].y, environmentMatrix[ 2 ].y, environmentMatrix[ 3 ].y ),
		vec4( environmentMatrix[ 0 ].z, environmentMatrix[ 1 ].z, environmentMatrix[ 2 ].z, environmentMatrix[ 3 ].z ),
		vec4( environmentMatrix[ 0 ].w, environmentMatrix[ 1 ].w, environmentMatrix[ 2 ].w, environmentMatrix[ 3 ].w )
	);

	return transposed.mul( vec4( localDir, 0.0 ) ).xyz.normalize();

} );

/**
 * Sample environment map color in a given direction.
 * Matches sampleEquirectColor from GLSL.
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @param {TSLNode} environmentTexture - Environment texture
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @returns {TSLNode} Environment color (vec3)
 */
export const sampleEquirectColor = Fn( ( [ direction, environmentTexture, environmentMatrix ] ) => {

	const uv = equirectDirectionToUv( direction, environmentMatrix );
	return environmentTexture.sample( uv ).rgb;

} );

/**
 * Calculate PDF for uniform sphere sampling with Jacobian.
 * Matches equirectDirectionPdf from GLSL.
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @returns {TSLNode} PDF value (float)
 */
export const equirectDirectionPdf = Fn( ( [ direction, environmentMatrix ] ) => {

	const uv = equirectDirectionToUv( direction, environmentMatrix );
	const theta = uv.y.mul( float( PI ) );
	const sinTheta = theta.sin();

	// Avoid division by zero at poles
	const pdf = sinTheta.equal( float( 0.0 ) ).select(
		float( 0.0 ),
		float( 1.0 ).div( float( TWO_PI ).mul( float( PI ) ).mul( sinTheta ) )
	);

	return pdf;

} );

// -----------------------------------------------------------------------------
// Environment Sampling with Importance Sampling
// -----------------------------------------------------------------------------

/**
 * Evaluate PDF for a given direction (for MIS).
 * Exact implementation matching sampleEquirect from GLSL.
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @param {TSLNode} environmentTexture - Environment texture
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @param {TSLNode} envTotalSum - Total luminance sum
 * @param {TSLNode} envResolution - Environment resolution (ivec2 as vec2)
 * @returns {Object} { color, pdf }
 */
export const sampleEquirect = Fn( ( [ direction, environmentTexture, environmentMatrix, envTotalSum, envResolution ] ) => {

	const color = vec3( 0.0 ).toVar();
	const pdf = float( 0.0 ).toVar();

	If( envTotalSum.equal( float( 0.0 ) ), () => {

		// Exclude black environments from MIS
		color.assign( vec3( 0.0 ) );
		pdf.assign( float( 0.0 ) );

	} ).Else( () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix );
		const sampledColor = environmentTexture.sample( uv ).rgb;
		color.assign( sampledColor );

		// Calculate luminance
		const coeffs = vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] );
		const lum = sampledColor.dot( coeffs );

		const luminancePdf = lum.div( envTotalSum );
		const jacobian = equirectDirectionPdf( direction, environmentMatrix );

		pdf.assign( envResolution.x.mul( envResolution.y ).mul( luminancePdf ).mul( jacobian ) );

	} );

	return { color, pdf };

} );

/**
 * Sample environment map using importance sampling.
 * Returns PDF, outputs color and direction.
 * Exact implementation matching sampleEquirectProbability from GLSL.
 *
 * @param {TSLNode} r - Random values (vec2)
 * @param {TSLNode} environmentTexture - Environment texture
 * @param {TSLNode} envMarginalWeights - Marginal CDF texture
 * @param {TSLNode} envConditionalWeights - Conditional CDF texture
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @param {TSLNode} environmentIntensity - Environment intensity multiplier (float)
 * @param {TSLNode} envTotalSum - Total luminance sum
 * @param {TSLNode} envResolution - Environment resolution (vec2)
 * @returns {Object} { direction, color, pdf }
 */
export const sampleEquirectProbability = Fn( ( [ r, environmentTexture, envMarginalWeights, envConditionalWeights, environmentMatrix, environmentIntensity, envTotalSum, envResolution ] ) => {

	// Sample marginal CDF for V coordinate
	const v = envMarginalWeights.sample( vec2( r.x, 0.0 ) ).x;

	// Sample conditional CDF for U coordinate
	const u = envConditionalWeights.sample( vec2( r.y, v ) ).x;

	const uv = vec2( u, v );

	// Convert UV to direction
	const derivedDirection = equirectUvToDirection( uv, environmentMatrix );
	const color = environmentTexture.sample( uv ).rgb.mul( environmentIntensity );

	// Calculate PDF
	const coeffs = vec3( REC709_LUMINANCE_COEFFICIENTS[ 0 ], REC709_LUMINANCE_COEFFICIENTS[ 1 ], REC709_LUMINANCE_COEFFICIENTS[ 2 ] );
	const colorWithoutIntensity = environmentTexture.sample( uv ).rgb;
	const lum = colorWithoutIntensity.dot( coeffs );
	const luminancePdf = lum.div( envTotalSum );

	const jacobian = equirectDirectionPdf( derivedDirection, environmentMatrix );
	const pdf = envResolution.x.mul( envResolution.y ).mul( luminancePdf ).mul( jacobian );

	return { direction: derivedDirection, color, pdf };

} );

/**
 * Simple environment lookup (no importance sampling).
 * Matches sampleEnvironment from GLSL.
 *
 * @param {TSLNode} direction - Direction vector (vec3)
 * @param {TSLNode} enableEnvironmentLight - Enable flag (bool as float)
 * @param {TSLNode} environmentTexture - Environment texture
 * @param {TSLNode} environmentMatrix - Environment rotation matrix (mat4)
 * @param {TSLNode} environmentIntensity - Environment intensity multiplier (float)
 * @returns {TSLNode} Environment color (vec4)
 */
export const sampleEnvironment = Fn( ( [ direction, enableEnvironmentLight, environmentTexture, environmentMatrix, environmentIntensity ] ) => {

	const result = vec4( 0.0 ).toVar();

	If( enableEnvironmentLight.greaterThan( float( 0.5 ) ), () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix );
		const texSample = environmentTexture.sample( uv );
		result.assign( texSample.mul( environmentIntensity ) );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// Factory Function for Creating Environment Sampler
// -----------------------------------------------------------------------------

/**
 * Creates a complete environment sampler with all functions.
 * 
 * @param {Object} options - Configuration options
 * @param {Texture} options.environmentTexture - Environment map texture
 * @param {Texture} options.envMarginalWeights - Marginal CDF texture (optional, for IS)
 * @param {Texture} options.envConditionalWeights - Conditional CDF texture (optional, for IS)
 * @param {mat4} options.environmentMatrix - Environment rotation matrix
 * @param {number} options.environmentIntensity - Environment intensity
 * @param {number} options.envTotalSum - Total luminance sum (for IS)
 * @param {vec2} options.envResolution - Environment resolution
 * @param {boolean} options.useEnvMapIS - Enable importance sampling
 * @returns {Object} Environment sampler functions
 */
export const createEnvironmentSampler = ( options ) => {

	const {
		environmentTexture,
		envMarginalWeights,
		envConditionalWeights,
		environmentMatrix,
		environmentIntensity = 1.0,
		envTotalSum = 0.0,
		envResolution = [ 1024, 512 ],
		useEnvMapIS = false
	} = options;

	return {
		// Basic sampling
		sampleColor: ( direction ) => sampleEquirectColor( direction, environmentTexture, environmentMatrix ),

		// Simple environment lookup
		sample: ( direction, enabled ) => sampleEnvironment( 
			direction, 
			enabled ? float( 1.0 ) : float( 0.0 ), 
			environmentTexture, 
			environmentMatrix, 
			environmentIntensity 
		),

		// Importance sampling
		sampleIS: useEnvMapIS && envMarginalWeights && envConditionalWeights ? ( randomVec2 ) =>
			sampleEquirectProbability( 
				randomVec2, 
				environmentTexture, 
				envMarginalWeights, 
				envConditionalWeights, 
				environmentMatrix, 
				environmentIntensity, 
				envTotalSum, 
				envResolution 
			)
			: null,

		// Evaluate PDF for MIS
		evaluatePDF: ( direction ) => sampleEquirect( direction, environmentTexture, environmentMatrix, envTotalSum, envResolution ),

		// Direct PDF calculation
		directionPDF: ( direction ) => equirectDirectionPdf( direction, environmentMatrix ),

		// Coordinate conversions
		directionToUV: ( direction ) => equirectDirectionToUv( direction, environmentMatrix ),
		uvToDirection: ( uv ) => equirectUvToDirection( uv, environmentMatrix )
	};

};

/**
 * Summary of exported functions:
 * 
 * Coordinate Conversion:
 * - equirectDirectionToUv(direction, matrix) - Direction to UV with environment matrix
 * - equirectUvToDirection(uv, matrix) - UV to direction with environment matrix
 * 
 * Sampling:
 * - sampleEquirectColor(direction, tex, matrix) - Simple color lookup
 * - sampleEnvironment(direction, enabled, tex, matrix, intensity) - Full environment lookup
 * - sampleEquirectProbability(r, tex, marginal, conditional, matrix, intensity, sum, resolution) - Importance sampling
 * 
 * PDF Evaluation:
 * - equirectDirectionPdf(direction, matrix) - Calculate PDF for direction with matrix
 * - sampleEquirect(direction, tex, matrix, sum, resolution) - Evaluate PDF for MIS
 * 
 * Factory:
 * - createEnvironmentSampler(options) - Create complete sampler with all functions
 */

