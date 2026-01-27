import { Fn, float, cross, dot, abs } from 'three/tsl';

/**
 * Ray-Triangle intersection using the Moller-Trumbore algorithm.
 * This is an efficient algorithm for computing ray-triangle intersections.
 *
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} rayDir - Ray direction (normalized vec3)
 * @param {TSLNode} posA - First triangle vertex (vec3)
 * @param {TSLNode} posB - Second triangle vertex (vec3)
 * @param {TSLNode} posC - Third triangle vertex (vec3)
 * @returns {Object} Intersection result with hit (bool), t (distance), u, v, w (barycentric)
 */
export const rayTriangleIntersect = Fn( ( [ rayOrigin, rayDir, posA, posB, posC ] ) => {

	// Calculate triangle edges
	const edge1 = posB.sub( posA );
	const edge2 = posC.sub( posA );

	// Calculate determinant
	const h = cross( rayDir, edge2 );
	const a = dot( edge1, h );

	// Check if ray is parallel to triangle
	const EPSILON = float( 1e-8 );
	const miss = abs( a ).lessThan( EPSILON );

	// Calculate inverse determinant
	const f = float( 1.0 ).div( a );

	// Calculate distance from posA to ray origin
	const s = rayOrigin.sub( posA );

	// Calculate U barycentric coordinate
	const u = f.mul( dot( s, h ) );

	// Calculate V barycentric coordinate
	const q = cross( s, edge1 );
	const v = f.mul( dot( rayDir, q ) );

	// Calculate T (distance along ray)
	const t = f.mul( dot( edge2, q ) );

	// Calculate W barycentric coordinate (for interpolation)
	const w = float( 1.0 ).sub( u ).sub( v );

	// Validate hit conditions:
	// - Not parallel (miss = false)
	// - U in [0, 1]
	// - V >= 0
	// - U + V <= 1
	// - T > epsilon (hit in front of ray)
	const validU = u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) );
	const validV = v.greaterThanEqual( 0.0 );
	const validUV = u.add( v ).lessThanEqual( 1.0 );
	const validT = t.greaterThan( EPSILON );
	const validHit = miss.not().and( validU ).and( validV ).and( validUV ).and( validT );

	return {
		hit: validHit,
		t: validHit.select( t, float( 1e20 ) ),
		u,
		v,
		w
	};

} );

/**
 * Calculates the geometric normal of a triangle (non-interpolated).
 *
 * @param {TSLNode} posA - First triangle vertex (vec3)
 * @param {TSLNode} posB - Second triangle vertex (vec3)
 * @param {TSLNode} posC - Third triangle vertex (vec3)
 * @returns {TSLNode} Geometric normal (vec3, normalized)
 */
export const triangleGeometricNormal = Fn( ( [ posA, posB, posC ] ) => {

	const edge1 = posB.sub( posA );
	const edge2 = posC.sub( posA );
	return cross( edge1, edge2 ).normalize();

} );

/**
 * Interpolates vertex attributes using barycentric coordinates.
 *
 * @param {TSLNode} attrA - Attribute at vertex A
 * @param {TSLNode} attrB - Attribute at vertex B
 * @param {TSLNode} attrC - Attribute at vertex C
 * @param {TSLNode} u - U barycentric coordinate
 * @param {TSLNode} v - V barycentric coordinate
 * @param {TSLNode} w - W barycentric coordinate (1 - u - v)
 * @returns {TSLNode} Interpolated attribute
 */
export const barycentricInterpolate = Fn( ( [ attrA, attrB, attrC, u, v, w ] ) => {

	// Standard barycentric interpolation: w*A + u*B + v*C
	return attrA.mul( w ).add( attrB.mul( u ) ).add( attrC.mul( v ) );

} );
