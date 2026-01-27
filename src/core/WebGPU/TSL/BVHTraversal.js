import { Fn, float, int, vec3, bool, Loop, If, uniform } from 'three/tsl';
import { rayTriangleIntersect, barycentricInterpolate } from './RayTriangle.js';
import { TRIANGLE_OFFSETS } from './Structs.js';

/**
 * Creates a BVH traverser for ray-scene intersection.
 *
 * Phase 2 implementation uses linear triangle iteration.
 * Full stack-based BVH traversal will be implemented in Phase 3.
 *
 * @param {StorageNode} bvhBuffer - BVH node data as storage buffer (unused in Phase 2)
 * @param {StorageNode} triangleBuffer - Triangle data as storage buffer
 * @param {number} bvhSize - Number of vec4s in BVH buffer
 * @param {number} triangleSize - Number of vec4s in triangle buffer
 * @returns {Function} TSL function for ray traversal
 */
export const createBVHTraverser = ( bvhBuffer, triangleBuffer, bvhSize, triangleSize ) => {

	// Calculate number of triangles (8 vec4s per triangle)
	const triCount = Math.floor( triangleSize / TRIANGLE_OFFSETS.VEC4_PER_TRIANGLE );

	// Create uniform for triangle count (TSL needs this as a node)
	const triangleCountUniform = uniform( triCount, 'int' );
	const strideUniform = uniform( TRIANGLE_OFFSETS.VEC4_PER_TRIANGLE, 'int' );

	return Fn( ( [ rayOrigin, rayDir ] ) => {

		// Output variables (mutable)
		const closestT = float( 1e20 ).toVar( 'closestT' );
		const hitNormal = vec3( 0, 1, 0 ).toVar( 'hitNormal' );
		const didHit = bool( false ).toVar( 'didHit' );
		const hitMaterialIndex = int( - 1 ).toVar( 'hitMaterialIndex' );

		// Linear search through all triangles (Phase 2 simplification)
		Loop( triangleCountUniform, ( { i: loopIndex } ) => {

			// Calculate base index for this triangle (8 vec4s per triangle)
			const baseIdx = loopIndex.mul( strideUniform );

			// Read triangle positions (vec4s 0, 1, 2)
			const posAData = triangleBuffer.element( baseIdx );
			const posBData = triangleBuffer.element( baseIdx.add( 1 ) );
			const posCData = triangleBuffer.element( baseIdx.add( 2 ) );

			const posA = posAData.xyz;
			const posB = posBData.xyz;
			const posC = posCData.xyz;

			// Perform ray-triangle intersection
			const result = rayTriangleIntersect( rayOrigin, rayDir, posA, posB, posC );

			// Update closest hit if this is closer
			If( result.hit.and( result.t.lessThan( closestT ) ), () => {

				closestT.assign( result.t );
				didHit.assign( true );

				// Read normals (vec4s 3, 4, 5)
				const normAData = triangleBuffer.element( baseIdx.add( 3 ) );
				const normBData = triangleBuffer.element( baseIdx.add( 4 ) );
				const normCData = triangleBuffer.element( baseIdx.add( 5 ) );

				// Interpolate normal using barycentric coordinates
				const interpNormal = barycentricInterpolate(
					normAData.xyz,
					normBData.xyz,
					normCData.xyz,
					result.u,
					result.v,
					result.w
				);

				hitNormal.assign( interpNormal.normalize() );

				// Read material index from UV_C_MAT vec4 (index 7, z component)
				const uvCMatData = triangleBuffer.element( baseIdx.add( 7 ) );
				hitMaterialIndex.assign( int( uvCMatData.z ) );

			} );

		} );

		return {
			didHit,
			closestT,
			hitNormal,
			hitMaterialIndex
		};

	} );

};

/**
 * Creates a simple single-triangle test traverser for debugging.
 * Tests only the first triangle in the buffer.
 *
 * @param {StorageNode} triangleBuffer - Triangle data as storage buffer
 * @returns {Function} TSL function for single triangle test
 */
export const createSingleTriangleTest = ( triangleBuffer ) => {

	return Fn( ( [ rayOrigin, rayDir ] ) => {

		// Read first triangle (index 0)
		const posAData = triangleBuffer.element( 0 );
		const posBData = triangleBuffer.element( 1 );
		const posCData = triangleBuffer.element( 2 );

		const posA = posAData.xyz;
		const posB = posBData.xyz;
		const posC = posCData.xyz;

		// Perform ray-triangle intersection
		const result = rayTriangleIntersect( rayOrigin, rayDir, posA, posB, posC );

		// Read normals
		const normAData = triangleBuffer.element( 3 );
		const normBData = triangleBuffer.element( 4 );
		const normCData = triangleBuffer.element( 5 );

		// Interpolate normal
		const interpNormal = barycentricInterpolate(
			normAData.xyz,
			normBData.xyz,
			normCData.xyz,
			result.u,
			result.v,
			result.w
		);

		return {
			didHit: result.hit,
			closestT: result.t,
			hitNormal: interpNormal.normalize(),
			hitMaterialIndex: int( 0 )
		};

	} );

};

/**
 * Creates a simpler hit test that just returns hit/miss.
 * Useful for shadow rays or occlusion queries.
 *
 * @param {StorageNode} triangleBuffer - Triangle data as storage buffer
 * @param {number} triangleSize - Number of vec4s in triangle buffer
 * @param {TSLNode} maxDist - Maximum distance to check
 * @returns {Function} TSL function that returns bool
 */
export const createOcclusionTest = ( triangleBuffer, triangleSize, maxDist ) => {

	const triCount = Math.floor( triangleSize / TRIANGLE_OFFSETS.VEC4_PER_TRIANGLE );
	const triangleCountUniform = uniform( triCount, 'int' );
	const strideUniform = uniform( TRIANGLE_OFFSETS.VEC4_PER_TRIANGLE, 'int' );

	return Fn( ( [ rayOrigin, rayDir ] ) => {

		const isOccluded = bool( false ).toVar( 'isOccluded' );

		Loop( triangleCountUniform, ( { i: loopIndex } ) => {

			If( isOccluded.not(), () => {

				const baseIdx = loopIndex.mul( strideUniform );

				const posAData = triangleBuffer.element( baseIdx );
				const posBData = triangleBuffer.element( baseIdx.add( 1 ) );
				const posCData = triangleBuffer.element( baseIdx.add( 2 ) );

				const result = rayTriangleIntersect(
					rayOrigin, rayDir,
					posAData.xyz, posBData.xyz, posCData.xyz
				);

				If( result.hit.and( result.t.lessThan( maxDist ) ), () => {

					isOccluded.assign( true );

				} );

			} );

		} );

		return isOccluded;

	} );

};
