import { Fn, vec3, vec4, vec2, int, uint, float, If, Loop, Break, max, min, clamp, dot, normalize, mix, sqrt, cos, sin, pow, exp } from 'three/tsl';

/**
 * Path Tracing Helper Functions
 * Extracted from PathTracingStage.js inline implementation
 *
 * These are working TSL functions that can be reused across different stages.
 */

/**
 * Initialize RNG state from pixel coordinates and frame number
 * @param {vec2} pixelCoord - Pixel coordinates (int values)
 * @param {uint} frame - Frame number for temporal variation
 * @returns {uint} RNG state
 */
export const initRNG = Fn( ( [ pixelX, pixelY, frame ] ) => {

	// Hash-based RNG initialization
	const h1 = uint( pixelX ).add( uint( pixelY ).mul( 1920 ) );
	const h2 = h1.add( frame.mul( 747796405 ) );
	const h3 = h2.mul( 2891336453 );

	return h3.toVar();

} );

/**
 * Generate random float [0, 1) from RNG state
 * @param {uint} state - RNG state (mutable)
 * @returns {float} Random value
 */
export const randomFloat = Fn( ( [ state ] ) => {

	// PCG hash
	const oldState = state.toVar();
	state.assign( oldState.mul( 747796405 ).add( 2891336453 ) );
	const word = oldState.xor( oldState.shiftRight( 22 ) ).shiftRight( oldState.shiftRight( 28 ).add( 4 ) );
	const result = word.xor( word.shiftRight( 22 ) );

	return float( result ).div( 4294967296.0 );

} );

/**
 * Fresnel-Schlick approximation
 * @param {float} cosTheta - Cosine of angle
 * @param {vec3} F0 - Base reflectance
 * @returns {vec3} Fresnel factor
 */
export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const oneMinusCos = float( 1.0 ).sub( cosTheta ).toVar();
	const oneMinusCos2 = oneMinusCos.mul( oneMinusCos ).toVar();
	const oneMinusCos5 = oneMinusCos2.mul( oneMinusCos2 ).mul( oneMinusCos ).toVar();

	return F0.add( vec3( 1.0 ).sub( F0 ).mul( oneMinusCos5 ) );

} );

/**
 * GGX Normal Distribution Function
 * @param {float} NdotH - Dot product of normal and half vector
 * @param {float} roughness - Material roughness
 * @returns {float} Distribution value
 */
export const distributionGGX = Fn( ( [ NdotH, roughness ] ) => {

	const a = roughness.mul( roughness ).toVar();
	const a2 = a.mul( a ).toVar();
	const NdotH2 = NdotH.mul( NdotH ).toVar();

	const denom = NdotH2.mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();
	const denomSq = denom.mul( denom ).toVar();

	return a2.div( denomSq.mul( Math.PI ) );

} );

/**
 * Smith Geometry Function (GGX)
 * @param {float} NdotV - Dot product of normal and view
 * @param {float} NdotL - Dot product of normal and light
 * @param {float} roughness - Material roughness
 * @returns {float} Geometry attenuation
 */
export const geometrySmith = Fn( ( [ NdotV, NdotL, roughness ] ) => {

	const r = roughness.add( 1.0 ).toVar();
	const k = r.mul( r ).div( 8.0 ).toVar();

	const ggx1 = NdotV.div( NdotV.mul( float( 1.0 ).sub( k ) ).add( k ) ).toVar();
	const ggx2 = NdotL.div( NdotL.mul( float( 1.0 ).sub( k ) ).add( k ) ).toVar();

	return ggx1.mul( ggx2 );

} );

/**
 * Convert direction to equirectangular UV coordinates
 * @param {vec3} direction - Normalized direction vector
 * @returns {vec2} UV coordinates [0, 1]
 */
export const equirectDirectionToUv = Fn( ( [ direction, rotationMatrix ] ) => {

	// Apply rotation if provided
	const rotatedDir = rotationMatrix.mul( vec4( direction, 0.0 ) ).xyz.toVar();

	const u = float( 0.5 ).add( rotatedDir.x.atan2( rotatedDir.z ).div( Math.PI * 2 ) ).toVar();
	const v = float( 0.5 ).sub( rotatedDir.y.asin().div( Math.PI ) ).toVar();

	return vec2( u, v );

} );

/**
 * Sample cosine-weighted hemisphere
 * @param {vec2} xi - Random samples [0, 1]
 * @returns {vec3} Direction in local space (z-up)
 */
export const importanceSampleCosine = Fn( ( [ xi ] ) => {

	const r = xi.x.sqrt().toVar();
	const phi = xi.y.mul( Math.PI * 2 ).toVar();

	const x = r.mul( phi.cos() ).toVar();
	const y = r.mul( phi.sin() ).toVar();
	const z = float( 1.0 ).sub( xi.x ).sqrt().toVar();

	return vec3( x, y, z );

} );

/**
 * Build orthonormal basis from normal (TBN matrix)
 * @param {vec3} normal - Surface normal
 * @returns {Object} { tangent, bitangent, normal }
 */
export const buildOrthonormalBasis = Fn( ( [ normal ] ) => {

	const upAlt = vec3( 1.0, 0.0, 0.0 ).toVar();
	const up = vec3( 0.0, 1.0, 0.0 ).toVar();
	const useAlt = normal.y.abs().greaterThan( 0.999 ).toVar();
	const helper = useAlt.select( upAlt, up ).toVar();

	const tangent = helper.cross( normal ).normalize().toVar();
	const bitangent = normal.cross( tangent ).toVar();

	return { tangent, bitangent, normal };

} );

/**
 * Transform direction from local (TBN) space to world space
 * @param {vec3} localDir - Direction in tangent space (z-up)
 * @param {vec3} tangent - Tangent vector
 * @param {vec3} bitangent - Bitangent vector
 * @param {vec3} normal - Normal vector
 * @returns {vec3} Direction in world space
 */
export const localToWorld = Fn( ( [ localDir, tangent, bitangent, normal ] ) => {

	return tangent.mul( localDir.x )
		.add( bitangent.mul( localDir.y ) )
		.add( normal.mul( localDir.z ) )
		.normalize();

} );
