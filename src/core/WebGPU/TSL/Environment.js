/**
 * Environment_v2.js - Pure TSL HDR Environment Sampling
 *
 * Exact port of environment.fs GLSL shader to TSL.
 * Provides environment map sampling with importance sampling support
 * for efficient Monte Carlo path tracing.
 *
 * NO wgslFn() - Pure TSL using Fn(), If(), Return(), .toVar(), .assign()
 */

import { Fn, vec2, vec3, vec4, float, mat4, If, texture, normalize, dot, sin, cos, atan2, acos, select } from 'three/tsl';

const PI = Math.PI;
const TWO_PI = 2.0 * PI;

// Rec. 709 luminance coefficients (same as GLSL)
const REC709_LUMINANCE_COEFFICIENTS = vec3( 0.2126, 0.7152, 0.0722 );

/**
 * Convert direction to UV coordinates for equirectangular map
 * Exact implementation from three-gpu-pathtracer / environment.fs
 *
 * @param {vec3} direction - World space direction (normalized)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @returns {vec2} UV coordinates [0, 1]
 */
export const equirectDirectionToUv = Fn( ( [ direction, environmentMatrix ] ) => {

	// Apply environment matrix rotation
	const d = normalize( environmentMatrix.mul( vec4( direction, 0.0 ) ).xyz ).toVar( 'd' );

	// Convert to spherical coordinates
	// atan2(z, x) for longitude, acos(y) for latitude
	const uv = vec2( atan2( d.z, d.x ), acos( d.y ) ).toVar( 'uv' );
	uv.assign( uv.div( vec2( TWO_PI, PI ) ) );

	// Adjust to [0, 1] range and flip Y
	uv.x.addAssign( 0.5 );
	uv.y.assign( float( 1.0 ).sub( uv.y ) );

	return uv;

} ).setLayout( {
	name: 'equirectDirectionToUv',
	type: 'vec2',
	inputs: [
		{ name: 'direction', type: 'vec3' },
		{ name: 'environmentMatrix', type: 'mat4' }
	]
} );

/**
 * Convert UV coordinates to direction
 * Exact implementation from three-gpu-pathtracer / environment.fs
 *
 * @param {vec2} uv - UV coordinates [0, 1]
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @returns {vec3} World space direction (normalized)
 */
export const equirectUvToDirection = Fn( ( [ uv, environmentMatrix ] ) => {

	// Undo UV adjustments
	const adjustedUv = vec2( uv.x.sub( 0.5 ), float( 1.0 ).sub( uv.y ) ).toVar( 'adjustedUv' );

	// Convert from spherical coordinates
	const theta = adjustedUv.x.mul( TWO_PI ).toVar( 'theta' );
	const phi = adjustedUv.y.mul( PI ).toVar( 'phi' );

	const sinPhi = sin( phi ).toVar( 'sinPhi' );

	const localDir = vec3(
		sinPhi.mul( cos( theta ) ),
		cos( phi ),
		sinPhi.mul( sin( theta ) )
	).toVar( 'localDir' );

	// Apply inverse environment matrix rotation
	// Using transpose for orthogonal rotation matrix (faster than inverse)
	const transposed = mat4(
		environmentMatrix.element( 0 ).element( 0 ), environmentMatrix.element( 1 ).element( 0 ), environmentMatrix.element( 2 ).element( 0 ), environmentMatrix.element( 3 ).element( 0 ),
		environmentMatrix.element( 0 ).element( 1 ), environmentMatrix.element( 1 ).element( 1 ), environmentMatrix.element( 2 ).element( 1 ), environmentMatrix.element( 3 ).element( 1 ),
		environmentMatrix.element( 0 ).element( 2 ), environmentMatrix.element( 1 ).element( 2 ), environmentMatrix.element( 2 ).element( 2 ), environmentMatrix.element( 3 ).element( 2 ),
		environmentMatrix.element( 0 ).element( 3 ), environmentMatrix.element( 1 ).element( 3 ), environmentMatrix.element( 2 ).element( 3 ), environmentMatrix.element( 3 ).element( 3 )
	).toVar( 'transposed' );

	return normalize( transposed.mul( vec4( localDir, 0.0 ) ).xyz );

} ).setLayout( {
	name: 'equirectUvToDirection',
	type: 'vec3',
	inputs: [
		{ name: 'uv', type: 'vec2' },
		{ name: 'environmentMatrix', type: 'mat4' }
	]
} );

/**
 * Sample environment map color in a given direction
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {vec3} direction - World space direction (normalized)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @returns {vec3} Environment color (RGB)
 */
export const sampleEquirectColor = Fn( ( [ environment, direction, environmentMatrix ] ) => {

	const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar( 'uv' );
	return texture( environment, uv, 0 ).rgb;

} );

/**
 * Calculate PDF for uniform sphere sampling with Jacobian
 *
 * @param {vec3} direction - World space direction (normalized)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @returns {float} PDF value
 */
export const equirectDirectionPdf = Fn( ( [ direction, environmentMatrix ] ) => {

	const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar( 'uv' );
	const theta = uv.y.mul( PI ).toVar( 'theta' );
	const sinTheta = sin( theta ).toVar( 'sinTheta' );

	const pdf = float( 0.0 ).toVar( 'pdf' );

	If( sinTheta.equal( 0.0 ), () => {

		pdf.assign( 0.0 );

	} ).Else( () => {

		pdf.assign( float( 1.0 ).div( float( TWO_PI * PI ).mul( sinTheta ) ) );

	} );

	return pdf;

} ).setLayout( {
	name: 'equirectDirectionPdf',
	type: 'float',
	inputs: [
		{ name: 'direction', type: 'vec3' },
		{ name: 'environmentMatrix', type: 'mat4' }
	]
} );

/**
 * Evaluate PDF for a given direction (for MIS)
 * Exact implementation from three-gpu-pathtracer / environment.fs
 *
 * Returns the PDF and outputs the sampled color.
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {vec3} direction - World space direction (normalized)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @param {float} envTotalSum - Total luminance sum of environment
 * @param {ivec2} envResolution - Environment map resolution
 * @returns {vec4} xyz = color, w = pdf
 */
export const sampleEquirect = Fn( ( [ environment, direction, environmentMatrix, envTotalSum, envResolution ] ) => {

	const result = vec4( 0.0, 0.0, 0.0, 0.0 ).toVar( 'result' );

	If( envTotalSum.equal( 0.0 ), () => {

		// Exclude black environments from MIS
		result.assign( vec4( 0.0, 0.0, 0.0, 0.0 ) );

	} ).Else( () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar( 'uv' );
		const color = texture( environment, uv, 0 ).rgb.toVar( 'color' );

		const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar( 'lum' );
		const pdf = lum.div( envTotalSum ).toVar( 'pdf' );

		const dirPdf = equirectDirectionPdf( direction, environmentMatrix ).toVar( 'dirPdf' );
		const finalPdf = float( envResolution.x ).mul( float( envResolution.y ) ).mul( pdf ).mul( dirPdf ).toVar( 'finalPdf' );

		result.assign( vec4( color, finalPdf ) );

	} );

	return result;

} );

/**
 * Sample environment map using importance sampling
 * Returns PDF, outputs color and direction
 * Exact implementation from three-gpu-pathtracer / environment.fs
 *
 * Uses precomputed CDF textures (marginal and conditional weights)
 * for efficient importance sampling based on luminance distribution.
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {TextureNode} envMarginalWeights - Marginal CDF texture node (vertical distribution)
 * @param {TextureNode} envConditionalWeights - Conditional CDF texture node (horizontal per row)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @param {float} environmentIntensity - Environment intensity multiplier
 * @param {float} envTotalSum - Total luminance sum
 * @param {ivec2} envResolution - Environment map resolution
 * @param {vec2} r - Random values [0,1]
 * @returns {vec4} xyz = direction, w = pdf (color returned separately via sampleEquirectProbabilityColor)
 */
export const sampleEquirectProbability = Fn( ( [
	environment,
	envMarginalWeights,
	envConditionalWeights,
	environmentMatrix,
	environmentIntensity,
	envTotalSum,
	envResolution,
	r
] ) => {

	// Sample marginal CDF for V coordinate
	// The CDF textures store the inverse CDF, so a single lookup gives the sampled coordinate
	const v = texture( envMarginalWeights, vec2( r.x, 0.0 ), 0 ).x.toVar( 'v' );

	// Sample conditional CDF for U coordinate
	const u = texture( envConditionalWeights, vec2( r.y, v ), 0 ).x.toVar( 'u' );

	const uv = vec2( u, v ).toVar( 'uv' );

	// Convert UV to direction
	const direction = equirectUvToDirection( uv, environmentMatrix ).toVar( 'direction' );

	// Sample color
	const color = texture( environment, uv, 0 ).rgb.mul( environmentIntensity ).toVar( 'color' );

	// Calculate PDF
	const lum = dot( color.div( environmentIntensity ), REC709_LUMINANCE_COEFFICIENTS ).toVar( 'lum' );
	const pdf = lum.div( envTotalSum ).toVar( 'pdf' );

	const dirPdf = equirectDirectionPdf( direction, environmentMatrix ).toVar( 'dirPdf' );
	const finalPdf = float( envResolution.x ).mul( float( envResolution.y ) ).mul( pdf ).mul( dirPdf ).toVar( 'finalPdf' );

	// Return direction and pdf (color needs separate accessor)
	return vec4( direction, finalPdf );

} );

/**
 * Get color from importance sampled direction
 * Helper to retrieve color after calling sampleEquirectProbability
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {TextureNode} envMarginalWeights - Marginal CDF texture node
 * @param {TextureNode} envConditionalWeights - Conditional CDF texture node
 * @param {float} environmentIntensity - Environment intensity multiplier
 * @param {vec2} r - Same random values used in sampleEquirectProbability
 * @returns {vec3} Sampled color with intensity applied
 */
export const sampleEquirectProbabilityColor = Fn( ( [
	environment,
	envMarginalWeights,
	envConditionalWeights,
	environmentIntensity,
	r
] ) => {

	// Reconstruct UV from same random values
	const v = texture( envMarginalWeights, vec2( r.x, 0.0 ), 0 ).x.toVar( 'v' );
	const u = texture( envConditionalWeights, vec2( r.y, v ), 0 ).x.toVar( 'u' );
	const uv = vec2( u, v ).toVar( 'uv' );

	return texture( environment, uv, 0 ).rgb.mul( environmentIntensity );

} );

/**
 * Sample environment direction using importance sampling or uniform sampling
 * This is the main entry point for direct lighting calculations.
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {TextureNode} marginalCDF - Marginal CDF texture for importance sampling
 * @param {TextureNode} conditionalCDF - Conditional CDF texture for importance sampling
 * @param {vec2} envSize - Environment map resolution
 * @param {bool} hasImportanceSampling - Whether importance sampling is available
 * @param {vec2} randomSample - Random values [0,1]
 * @returns {vec4} xyz = sampled direction, w = pdf
 */
export const sampleEnvironmentDirection = Fn( ( [
	environment,
	marginalCDF,
	conditionalCDF,
	envSize,
	hasImportanceSampling,
	randomSample
] ) => {

	const result = vec4( 0.0, 1.0, 0.0, 1.0 ).toVar( 'envSampleResult' );

	If( hasImportanceSampling, () => {

		// Use importance sampling via CDF textures
		const v = texture( marginalCDF, vec2( randomSample.x, 0.0 ), 0 ).x.toVar( 'isV' );
		const u = texture( conditionalCDF, vec2( randomSample.y, v ), 0 ).x.toVar( 'isU' );
		const uv = vec2( u, v ).toVar( 'isUV' );

		// Convert UV to direction (assuming identity matrix - direction will be rotated at call site if needed)
		const theta = uv.x.sub( 0.5 ).mul( TWO_PI ).toVar( 'isTheta' );
		const phi = float( 1.0 ).sub( uv.y ).mul( PI ).toVar( 'isPhi' );

		const sinPhi = sin( phi ).toVar( 'isSinPhi' );
		const direction = vec3(
			sinPhi.mul( cos( theta ) ),
			cos( phi ),
			sinPhi.mul( sin( theta ) )
		).toVar( 'isDirection' );

		// Calculate PDF
		const color = texture( environment, uv, 0 ).rgb.toVar( 'isColor' );
		const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar( 'isLum' );

		// PDF = (lum / totalSum) * (width * height) * (1 / (2 * PI * PI * sinTheta))
		// Simplified: we approximate the jacobian
		const sinTheta = sin( uv.y.mul( PI ) ).toVar( 'isSinTheta' );
		const pdf = select(
			sinTheta.lessThan( 0.0001 ),
			float( 0.0001 ),
			lum.mul( envSize.x ).mul( envSize.y ).div( float( TWO_PI * PI ).mul( sinTheta ) ).add( 0.0001 )
		).toVar( 'isPdf' );

		result.assign( vec4( normalize( direction ), pdf ) );

	} ).Else( () => {

		// Uniform sphere sampling
		const theta = randomSample.x.mul( TWO_PI ).toVar( 'uTheta' );
		const phi = acos( float( 1.0 ).sub( randomSample.y.mul( 2.0 ) ) ).toVar( 'uPhi' );

		const sinPhi = sin( phi ).toVar( 'uSinPhi' );
		const direction = vec3(
			sinPhi.mul( cos( theta ) ),
			cos( phi ),
			sinPhi.mul( sin( theta ) )
		).toVar( 'uDirection' );

		// Uniform sphere PDF = 1 / (4 * PI)
		const pdf = float( 1.0 / ( 4.0 * PI ) ).toVar( 'uPdf' );

		result.assign( vec4( normalize( direction ), pdf ) );

	} );

	return result;

} );

/**
 * Simple environment lookup (no importance sampling)
 *
 * @param {TextureNode} environment - Environment map texture node
 * @param {vec3} direction - World space direction (normalized)
 * @param {mat4} environmentMatrix - Environment rotation matrix
 * @param {float} environmentIntensity - Environment intensity multiplier
 * @param {bool} enableEnvironmentLight - Whether environment lighting is enabled
 * @returns {vec4} Environment color with intensity (RGBA)
 */
export const sampleEnvironmentLookup = Fn( ( [
	environment,
	direction,
	environmentMatrix,
	environmentIntensity,
	enableEnvironmentLight
] ) => {

	const result = vec4( 0.0 ).toVar( 'result' );

	If( enableEnvironmentLight.not(), () => {

		result.assign( vec4( 0.0 ) );

	} ).Else( () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar( 'uv' );
		const texSample = texture( environment, uv, 0 ).toVar( 'texSample' );

		result.assign( texSample.mul( environmentIntensity ) );

	} );

	return result;

} );

/**
 * MIS heuristic (power heuristic with beta=2)
 * Matches the implementation in lights_core.fs
 *
 * @param {float} a - First PDF value
 * @param {float} b - Second PDF value
 * @returns {float} MIS weight
 */
export const misHeuristic = Fn( ( [ a, b ] ) => {

	const a2 = a.mul( a ).toVar( 'a2' );
	const b2 = b.mul( b ).toVar( 'b2' );

	return a2.div( a2.add( b2 ) );

} ).setLayout( {
	name: 'misHeuristic',
	type: 'float',
	inputs: [
		{ name: 'a', type: 'float' },
		{ name: 'b', type: 'float' }
	]
} );
