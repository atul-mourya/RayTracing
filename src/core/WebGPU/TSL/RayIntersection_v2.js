import { Fn, vec3, float, bool as tslBool, dot, cross, abs, min, max, If, Return } from 'three/tsl';

/**
 * Ray Intersection Tests - Pure TSL
 *
 * Möller-Trumbore ray-triangle intersection
 * Ray-AABB intersection for BVH traversal
 *
 * NO wgslFn() - compatible with PathTracingStage.js
 */

const EPSILON = 1e-8;

// ================================================================================
// RAY-TRIANGLE INTERSECTION
// ================================================================================

/**
 * Möller-Trumbore ray-triangle intersection
 * Returns { hit: bool, t: float, u: float, v: float, w: float }
 * Barycentric coords: w = 1 - u - v
 *
 * @param {vec3} rayOrigin - Ray origin
 * @param {vec3} rayDir - Ray direction (normalized)
 * @param {vec3} v0 - Triangle vertex A
 * @param {vec3} v1 - Triangle vertex B
 * @param {vec3} v2 - Triangle vertex C
 * @param {float} tMax - Maximum distance (for early rejection)
 * @returns {object} { hit, t, u, v, w }
 */
export const intersectTriangle = Fn( ( [ rayOrigin, rayDir, v0, v1, v2, tMax ] ) => {

	// Initialize result
	const result = {
		hit: tslBool( false ).toVar( 'hit' ),
		t: float( tMax ).toVar( 't' ),
		u: float( 0.0 ).toVar( 'u' ),
		v: float( 0.0 ).toVar( 'v' ),
		w: float( 0.0 ).toVar( 'w' )
	};

	// Edge vectors
	const edge1 = v1.sub( v0 ).toVar( 'edge1' );
	const edge2 = v2.sub( v0 ).toVar( 'edge2' );

	// Begin calculating determinant
	const h = cross( rayDir, edge2 ).toVar( 'h' );
	const a = dot( edge1, h ).toVar( 'a' );

	// Check if ray is parallel to triangle
	If( abs( a ).lessThan( EPSILON ), () => {

		Return( result );

	} );

	const f = float( 1.0 ).div( a ).toVar( 'f' );
	const s = rayOrigin.sub( v0 ).toVar( 's' );
	const u = f.mul( dot( s, h ) ).toVar( 'u' );

	// Check barycentric coordinate u
	If( u.lessThan( 0.0 ).or( u.greaterThan( 1.0 ) ), () => {

		Return( result );

	} );

	const q = cross( s, edge1 ).toVar( 'q' );
	const v = f.mul( dot( rayDir, q ) ).toVar( 'v' );

	// Check barycentric coordinate v
	If( v.lessThan( 0.0 ).or( u.add( v ).greaterThan( 1.0 ) ), () => {

		Return( result );

	} );

	// Calculate t (ray parameter)
	const t = f.mul( dot( edge2, q ) ).toVar( 't' );

	// Check if intersection is valid (positive t, within tMax)
	If( t.greaterThan( EPSILON ).and( t.lessThan( tMax ) ), () => {

		result.hit.assign( true );
		result.t.assign( t );
		result.u.assign( u );
		result.v.assign( v );
		result.w.assign( float( 1.0 ).sub( u ).sub( v ) );

	} );

	return result;

} );

// ================================================================================
// RAY-AABB INTERSECTION
// ================================================================================

/**
 * Ray-AABB slab intersection (Optimized for BVH)
 * Returns distance to intersection (or very large value if miss)
 *
 * @param {vec3} rayOrigin - Ray origin
 * @param {vec3} invRayDir - Pre-computed 1/rayDir for each axis
 * @param {vec3} boxMin - AABB minimum corner
 * @param {vec3} boxMax - AABB maximum corner
 * @returns {float} Distance to nearest intersection (1e20 if miss)
 */
export const rayAABBIntersect = Fn( ( [ rayOrigin, invRayDir, boxMin, boxMax ] ) => {

	// Slab method - compute intersection distances for each axis
	const t1 = boxMin.sub( rayOrigin ).mul( invRayDir ).toVar( 't1' );
	const t2 = boxMax.sub( rayOrigin ).mul( invRayDir ).toVar( 't2' );

	// Get min/max for each axis (handles negative inv values)
	const tmin = min( t1, t2 ).toVar( 'tmin' );
	const tmax = max( t1, t2 ).toVar( 'tmax' );

	// Find the largest tmin and smallest tmax
	const tNear = max( max( tmin.x, tmin.y ), tmin.z ).toVar( 'tNear' );
	const tFar = min( min( tmax.x, tmax.y ), tmax.z ).toVar( 'tFar' );
	// Check for valid intersection
	// Returns tNear if hit, 1e20 if miss
	return tNear.lessThanEqual( tFar ).and( tFar.greaterThan( 0.0 ) )
		.select( max( tNear, 0.0 ), float( 1e20 ) );

} );

/**
 * Compute inverse ray direction with proper sign handling
 * Avoids division by zero and maintains proper traversal direction
 *
 * @param {vec3} rayDir - Ray direction
 * @returns {vec3} Inverse direction (1/dir) with sign preservation
 */
export const computeInvRayDir = Fn( ( [ rayDir ] ) => {

	const HUGE_VAL = float( 1e8 ).toVar( 'HUGE_VAL' );

	// Get sign for each axis (fallback to 1.0 if zero)
	const signX = rayDir.x.notEqual( 0.0 ).select( rayDir.x.sign(), 1.0 );
	const signY = rayDir.y.notEqual( 0.0 ).select( rayDir.y.sign(), 1.0 );
	const signZ = rayDir.z.notEqual( 0.0 ).select( rayDir.z.sign(), 1.0 );

	// Compute safe inverse (avoid division by zero)
	const invX = abs( rayDir.x ).greaterThan( 1e-8 ).select( float( 1.0 ).div( rayDir.x ), HUGE_VAL.mul( signX ) );
	const invY = abs( rayDir.y ).greaterThan( 1e-8 ).select( float( 1.0 ).div( rayDir.y ), HUGE_VAL.mul( signY ) );
	const invZ = abs( rayDir.z ).greaterThan( 1e-8 ).select( float( 1.0 ).div( rayDir.z ), HUGE_VAL.mul( signZ ) );

	return vec3( invX, invY, invZ );

} );
