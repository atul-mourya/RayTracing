import { Fn, float, vec3, vec2, dot, normalize, sqrt, abs, cross, min, max } from 'three/tsl';

/**
 * Ray Intersection module for TSL/WGSL.
 * Complete port of rayintersection.fs from GLSL to TSL/WGSL.
 * 
 * Provides comprehensive ray-geometry intersection functions:
 * - Ray-Triangle (geometry-only variant for early testing)
 * - Ray-Sphere (analytical intersection)
 * 
 * Note: Full ray-triangle intersection with attribute interpolation
 * is available in RayTriangle.js. AABB intersection is in RayAABB.js.
 * 
 * Camera uniforms (focusDistance, aperture, etc.) are handled by CameraRay.js
 */

/**
 * Optimized ray-triangle intersection (geometry only).
 * Returns intersection data through output-like pattern.
 * No attribute interpolation - used for early visibility tests.
 * 
 * Uses Möller-Trumbore algorithm for efficiency.
 * 
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} rayDir - Ray direction (normalized vec3)
 * @param {TSLNode} posA - First triangle vertex (vec3)
 * @param {TSLNode} posB - Second triangle vertex (vec3)
 * @param {TSLNode} posC - Third triangle vertex (vec3)
 * @returns {Object} { hit: bool, t: float, u: float, v: float }
 */
export const rayTriangleGeometry = Fn( ( [ rayOrigin, rayDir, posA, posB, posC ] ) => {

	const edge1 = posB.sub( posA ).toVar();
	const edge2 = posC.sub( posA ).toVar();
	const h = cross( rayDir, edge2 ).toVar();
	const a = dot( edge1, h ).toVar();

	// Check if ray is parallel to triangle
	const EPSILON = float( 1e-8 );
	const parallel = abs( a ).lessThan( EPSILON );

	const f = float( 1.0 ).div( a ).toVar();
	const s = rayOrigin.sub( posA ).toVar();
	const u = f.mul( dot( s, h ) ).toVar();

	// Early exit conditions
	const validU = u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) );

	const q = cross( s, edge1 ).toVar();
	const v = f.mul( dot( rayDir, q ) ).toVar();

	const validV = v.greaterThanEqual( 0.0 );
	const validUV = u.add( v ).lessThanEqual( 1.0 );

	const t = f.mul( dot( edge2, q ) ).toVar();
	const validT = t.greaterThan( EPSILON );

	// Combined hit condition
	const hit = parallel.not().and( validU ).and( validV ).and( validUV ).and( validT );

	return {
		hit,
		t: hit.select( t, float( 1e20 ) ),
		u: hit.select( u, float( 0.0 ) ),
		v: hit.select( v, float( 0.0 ) )
	};

} );

/**
 * Full ray-triangle intersection with all attributes.
 * Returns complete HitInfo structure with interpolated normals, UVs, etc.
 * 
 * Uses Möller-Trumbore algorithm.
 * 
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} rayDir - Ray direction (normalized vec3)
 * @param {TSLNode} posA - First triangle vertex (vec3)
 * @param {TSLNode} posB - Second triangle vertex (vec3)
 * @param {TSLNode} posC - Third triangle vertex (vec3)
 * @param {TSLNode} normalA - Normal at vertex A (vec3)
 * @param {TSLNode} normalB - Normal at vertex B (vec3)
 * @param {TSLNode} normalC - Normal at vertex C (vec3)
 * @param {TSLNode} uvA - UV coordinates at vertex A (vec2)
 * @param {TSLNode} uvB - UV coordinates at vertex B (vec2)
 * @param {TSLNode} uvC - UV coordinates at vertex C (vec2)
 * @param {TSLNode} materialIndex - Material index (int)
 * @returns {Object} HitInfo structure { didHit, dst, hitPoint, normal, uv, materialIndex }
 */
export const rayTriangleFull = Fn( ( [ 
	rayOrigin, rayDir, 
	posA, posB, posC,
	normalA, normalB, normalC,
	uvA, uvB, uvC,
	materialIndex 
] ) => {

	// Initialize result
	const didHit = float( 0.0 ).toVar();
	const dst = float( 1.0e20 ).toVar();
	const hitPoint = vec3( 0.0 ).toVar();
	const normal = vec3( 0.0, 0.0, 1.0 ).toVar();
	const uv = vec2( 0.0 ).toVar();

	// Möller-Trumbore algorithm
	const edge1 = posB.sub( posA );
	const edge2 = posC.sub( posA );
	const h = cross( rayDir, edge2 );
	const a = dot( edge1, h );

	// Check if ray is parallel to triangle
	const EPSILON = float( 1e-8 );
	const notParallel = abs( a ).greaterThanEqual( EPSILON );

	const f = float( 1.0 ).div( a );
	const s = rayOrigin.sub( posA );
	const u_param = f.mul( dot( s, h ) );

	const validU = u_param.greaterThanEqual( 0.0 ).and( u_param.lessThanEqual( 1.0 ) );

	const q = cross( s, edge1 );
	const v_param = f.mul( dot( rayDir, q ) );

	const validV = v_param.greaterThanEqual( 0.0 );
	const validUV = u_param.add( v_param ).lessThanEqual( 1.0 );

	const t = f.mul( dot( edge2, q ) );
	const validT = t.greaterThan( EPSILON ).and( t.lessThan( dst ) );

	// Combined hit test
	const hit = notParallel.and( validU ).and( validV ).and( validUV ).and( validT );

	// Update result if hit
	didHit.assign( hit.select( float( 1.0 ), didHit ) );
	dst.assign( hit.select( t, dst ) );
	hitPoint.assign( hit.select( rayOrigin.add( rayDir.mul( t ) ), hitPoint ) );

	// Interpolate normal using barycentric coordinates
	const w = float( 1.0 ).sub( u_param ).sub( v_param );
	const interpolatedNormal = normalize( 
		normalA.mul( w ).add( normalB.mul( u_param ) ).add( normalC.mul( v_param ) )
	);
	normal.assign( hit.select( interpolatedNormal, normal ) );

	// Interpolate UV coordinates
	const interpolatedUV = uvA.mul( w ).add( uvB.mul( u_param ) ).add( uvC.mul( v_param ) );
	uv.assign( hit.select( interpolatedUV, uv ) );

	return {
		didHit,
		dst,
		hitPoint,
		normal,
		uv,
		materialIndex
	};

} );

/**
 * Ray-sphere intersection using analytical solution.
 * Solves quadratic equation for ray-sphere intersection.
 * 
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} rayDir - Ray direction (normalized vec3)
 * @param {TSLNode} spherePosition - Sphere center position (vec3)
 * @param {TSLNode} sphereRadius - Sphere radius (float)
 * @param {TSLNode} materialIndex - Material index (int/float)
 * @returns {Object} HitInfo structure { didHit, dst, hitPoint, normal, materialIndex }
 */
export const raySphere = Fn( ( [ rayOrigin, rayDir, spherePosition, sphereRadius, materialIndex ] ) => {

	// Initialize result
	const didHit = float( 0.0 ).toVar();
	const dst = float( 1.0e20 ).toVar();
	const hitPoint = vec3( 0.0 ).toVar();
	const normal = vec3( 0.0, 0.0, 1.0 ).toVar();

	// Quadratic equation coefficients
	const oc = rayOrigin.sub( spherePosition );
	const a = dot( rayDir, rayDir );
	const b = float( 2.0 ).mul( dot( oc, rayDir ) );
	const c = dot( oc, oc ).sub( sphereRadius.mul( sphereRadius ) );
	const discriminant = b.mul( b ).sub( float( 4.0 ).mul( a ).mul( c ) );

	// Check if ray intersects sphere
	const hasHit = discriminant.greaterThan( 0.0 );

	// Calculate intersection distance
	const sqrtDiscriminant = sqrt( discriminant );
	const t = b.negate().sub( sqrtDiscriminant ).div( float( 2.0 ).mul( a ) );
	const validT = t.greaterThan( 0.0 );

	// Final hit test
	const hit = hasHit.and( validT );

	// Update result if hit
	didHit.assign( hit.select( float( 1.0 ), didHit ) );
	dst.assign( hit.select( t, dst ) );

	const computedHitPoint = rayOrigin.add( rayDir.mul( t ) );
	hitPoint.assign( hit.select( computedHitPoint, hitPoint ) );

	const computedNormal = normalize( computedHitPoint.sub( spherePosition ) );
	normal.assign( hit.select( computedNormal, normal ) );

	return {
		didHit,
		dst,
		hitPoint,
		normal,
		uv: vec2( 0.0, 0.0 ), // Spheres don't have UVs in basic implementation
		materialIndex
	};

} );

/**
 * Fast ray-AABB distance calculation with early exit optimization.
 * Optimized slab method for AABB intersection.
 * 
 * Note: This is a legacy compatibility function. For new code,
 * use rayAABBIntersect from RayAABB.js instead.
 * 
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} invDir - Inverse ray direction (1/dir) (vec3)
 * @param {TSLNode} boxMin - AABB minimum corner (vec3)
 * @param {TSLNode} boxMax - AABB maximum corner (vec3)
 * @returns {TSLNode} Distance to near intersection, or 1e20 if miss
 */
export const fastRayAABBDst = Fn( ( [ rayOrigin, invDir, boxMin, boxMax ] ) => {

	const t1 = boxMin.sub( rayOrigin ).mul( invDir );
	const t2 = boxMax.sub( rayOrigin ).mul( invDir );

	const tMin = min( t1, t2 );
	const tMax = max( t1, t2 );

	const dstNear = max( max( tMin.x, tMin.y ), tMin.z );
	const dstFar = min( min( tMax.x, tMax.y ), tMax.z );

	// Optimized early rejection
	const hit = dstFar.greaterThanEqual( max( dstNear, float( 0.0 ) ) );

	return hit.select( max( dstNear, float( 0.0 ) ), float( 1e20 ) );

} );

/**
 * Helper function to compute barycentric weights from u, v parameters.
 * 
 * @param {TSLNode} u - U barycentric coordinate
 * @param {TSLNode} v - V barycentric coordinate
 * @returns {Object} { u, v, w } where w = 1 - u - v
 */
export const computeBarycentricWeights = Fn( ( [ u, v ] ) => {

	const w = float( 1.0 ).sub( u ).sub( v );

	return {
		u,
		v,
		w
	};

} );

/**
 * Interpolate any vertex attribute using barycentric coordinates.
 * Generic interpolation helper for normals, UVs, colors, etc.
 * 
 * @param {TSLNode} attrA - Attribute at vertex A
 * @param {TSLNode} attrB - Attribute at vertex B
 * @param {TSLNode} attrC - Attribute at vertex C
 * @param {TSLNode} u - U barycentric coordinate
 * @param {TSLNode} v - V barycentric coordinate
 * @param {TSLNode} w - W barycentric coordinate (1 - u - v)
 * @returns {TSLNode} Interpolated attribute
 */
export const interpolateAttribute = Fn( ( [ attrA, attrB, attrC, u, v, w ] ) => {

	return attrA.mul( w ).add( attrB.mul( u ) ).add( attrC.mul( v ) );

} );
