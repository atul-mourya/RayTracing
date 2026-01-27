import { Fn, float, min, max } from 'three/tsl';

/**
 * Ray-AABB (Axis-Aligned Bounding Box) intersection test.
 * Returns the distance to the near intersection, or 1e20 if no hit.
 *
 * Uses the slab method for efficient AABB intersection testing.
 *
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} invDir - Inverse ray direction (1/direction) (vec3)
 * @param {TSLNode} boxMin - AABB minimum corner (vec3)
 * @param {TSLNode} boxMax - AABB maximum corner (vec3)
 * @returns {TSLNode} Distance to intersection, or 1e20 if miss
 */
export const rayAABBIntersect = Fn( ( [ rayOrigin, invDir, boxMin, boxMax ] ) => {

	// Calculate intersection distances for each axis
	const t1 = boxMin.sub( rayOrigin ).mul( invDir );
	const t2 = boxMax.sub( rayOrigin ).mul( invDir );

	// Get min/max for each component (handles negative directions)
	const tMin = min( t1, t2 );
	const tMax = max( t1, t2 );

	// Find the largest entry distance and smallest exit distance
	const dstNear = max( max( tMin.x, tMin.y ), tMin.z );
	const dstFar = min( min( tMax.x, tMax.y ), tMax.z );

	// Hit if exit is after entry and exit is in front of ray origin
	const hit = dstFar.greaterThanEqual( max( dstNear, float( 0.0 ) ) );

	// Return near distance if hit, otherwise return large value
	return hit.select( max( dstNear, float( 0.0 ) ), float( 1e20 ) );

} );

/**
 * Ray-AABB intersection test that returns both hit status and distances.
 * Useful when you need to know if a ray intersects an AABB without
 * immediately needing the distance.
 *
 * @param {TSLNode} rayOrigin - Ray origin position (vec3)
 * @param {TSLNode} invDir - Inverse ray direction (1/direction) (vec3)
 * @param {TSLNode} boxMin - AABB minimum corner (vec3)
 * @param {TSLNode} boxMax - AABB maximum corner (vec3)
 * @returns {Object} Object with hit (bool), near (float), far (float)
 */
export const rayAABBIntersectFull = Fn( ( [ rayOrigin, invDir, boxMin, boxMax ] ) => {

	const t1 = boxMin.sub( rayOrigin ).mul( invDir );
	const t2 = boxMax.sub( rayOrigin ).mul( invDir );

	const tMin = min( t1, t2 );
	const tMax = max( t1, t2 );

	const dstNear = max( max( tMin.x, tMin.y ), tMin.z );
	const dstFar = min( min( tMax.x, tMax.y ), tMax.z );

	const hit = dstFar.greaterThanEqual( max( dstNear, float( 0.0 ) ) );

	return {
		hit,
		near: max( dstNear, float( 0.0 ) ),
		far: dstFar
	};

} );
