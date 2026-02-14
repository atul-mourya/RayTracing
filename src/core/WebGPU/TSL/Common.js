import { Fn, vec3, float, dot, normalize, cross, abs, sqrt, max, min, struct } from 'three/tsl';

/**
 * Common Utility Functions - Pure TSL
 *
 * Mathematical helpers used throughout the path tracer.
 * NO wgslFn() - pure Three.js TSL
 */

export const PI = Math.PI;
export const TWO_PI = 2.0 * Math.PI;

// ================================================================================
// VECTOR UTILITIES
// ================================================================================

/**
 * Get maximum component of vec3
 */
export const maxComponent = Fn( ( [ v ] ) => {

	return max( max( v.x, v.y ), v.z );

} );

/**
 * Get minimum component of vec3
 */
export const minComponent = Fn( ( [ v ] ) => {

	return min( min( v.x, v.y ), v.z );

} );

/**
 * Luminance calculation
 */
export const luminance = Fn( ( [ color ] ) => {

	return dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );

} );

// ================================================================================
// ORTHONORMAL BASIS CONSTRUCTION
// ================================================================================

const orthoNormalBasisStruct = struct( {
	tangent: 'vec3',
	bitangent: 'vec3',
	normal: 'vec3',
} );
/**
 * Build tangent space from normal (TBN matrix)
 * @param {vec3} normal - Surface normal
 * @returns {object} { tangent, bitangent, normal }
 */
export const buildOrthonormalBasis = Fn( ( [ normal ] ) => {

	const up = vec3( 0.0, 1.0, 0.0 );
	const upAlt = vec3( 1.0, 0.0, 0.0 );

	// Choose helper vector that's not parallel to normal
	const useAlt = abs( normal.y ).greaterThan( 0.999 );
	const helper = useAlt.select( upAlt, up );

	// Build orthonormal basis
	const tangent = normalize( cross( helper, normal ) );
	const bitangent = cross( normal, tangent );

	return orthoNormalBasisStruct( { tangent, bitangent, normal } );

} );

/**
 * Transform vector from local (tangent) space to world space
 * @param {vec3} localDir - Direction in tangent space (z-up)
 * @param {vec3} tangent - Tangent vector
 * @param {vec3} bitangent - Bitangent vector
 * @param {vec3} normal - Normal vector
 * @returns {vec3} Direction in world space
 */
export const localToWorld = Fn( ( [ localDir, tangent, bitangent, normal ] ) => {

	return normalize(
		tangent.mul( localDir.x )
			.add( bitangent.mul( localDir.y ) )
			.add( normal.mul( localDir.z ) )
	);

} );

// ================================================================================
// MATERIAL UTILITIES
// ================================================================================

/**
 * Fresnel-Schlick approximation
 * @param {float} cosTheta - Dot product (V, H)
 * @param {vec3} F0 - Base reflectance at normal incidence
 * @returns {vec3} Fresnel reflectance
 */
export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const oneMinusCos = float( 1.0 ).sub( cosTheta );
	const oneMinusCos2 = oneMinusCos.mul( oneMinusCos );
	const oneMinusCos5 = oneMinusCos2.mul( oneMinusCos2 ).mul( oneMinusCos );

	return F0.add( vec3( 1.0 ).sub( F0 ).mul( oneMinusCos5 ) );

} );

/**
 * GGX Normal Distribution Function
 * @param {float} NdotH - Dot(normal, halfVector)
 * @param {float} roughness - Material roughness [0,1]
 * @returns {float} Distribution value
 */
export const distributionGGX = Fn( ( [ NdotH, roughness ] ) => {

	const a = roughness.mul( roughness );
	const a2 = a.mul( a );
	const NdotH2 = NdotH.mul( NdotH );

	const denom = NdotH2.mul( a2.sub( 1.0 ) ).add( 1.0 );
	const denomSq = denom.mul( denom );

	return a2.div( denomSq.mul( PI ) );

} );

/**
 * Smith Geometry Function (GGX)
 * @param {float} NdotV - Dot(normal, view)
 * @param {float} NdotL - Dot(normal, light)
 * @param {float} roughness - Material roughness
 * @returns {float} Geometry attenuation [0,1]
 */
export const geometrySmith = Fn( ( [ NdotV, NdotL, roughness ] ) => {

	const r = roughness.add( 1.0 );
	const k = r.mul( r ).div( 8.0 );

	const ggx1 = NdotV.div( NdotV.mul( float( 1.0 ).sub( k ) ).add( k ) );
	const ggx2 = NdotL.div( NdotL.mul( float( 1.0 ).sub( k ) ).add( k ) );

	return ggx1.mul( ggx2 );

} );

// ================================================================================
// SAMPLING UTILITIES
// ================================================================================

/**
 * Cosine-weighted hemisphere sampling
 * @param {vec2} xi - Random samples [0,1]
 * @returns {vec3} Direction in local space (z-up)
 */
export const importanceSampleCosine = Fn( ( [ xi ] ) => {

	const r = sqrt( xi.x );
	const phi = xi.y.mul( TWO_PI );

	const x = r.mul( phi.cos() );
	const y = r.mul( phi.sin() );
	const z = sqrt( float( 1.0 ).sub( xi.x ) );

	return vec3( x, y, z );

} );

/**
 * GGX importance sampling (generate half vector)
 * @param {vec2} xi - Random samples [0,1]
 * @param {float} roughness - Material roughness
 * @returns {vec3} Half vector in local space (z-up)
 */
export const importanceSampleGGX = Fn( ( [ xi, roughness ] ) => {

	const a = roughness.mul( roughness );
	const a2 = a.mul( a );

	const phi = xi.x.mul( TWO_PI );
	const cosTheta = sqrt( float( 1.0 ).sub( xi.y ).div( xi.y.mul( a2.sub( 1.0 ) ).add( 1.0 ) ) );
	const sinTheta = sqrt( max( 0.0, float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) );

	// Local space half vector
	const x = sinTheta.mul( phi.cos() );
	const y = sinTheta.mul( phi.sin() );
	const z = cosTheta;

	return vec3( x, y, z );

} );
