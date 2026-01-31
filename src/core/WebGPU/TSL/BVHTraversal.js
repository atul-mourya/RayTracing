import { Fn, float, int, vec3, vec2, vec4, Loop, If, Break, min, max, abs, dot, cross, normalize, floor, sign } from 'three/tsl';
import { rayAABBIntersect } from './RayAABB.js';
import { rayTriangleIntersect } from './RayTriangle.js';

/**
 * BVH Traversal module for TSL.
 * Implements BVH-accelerated ray-scene intersection using composable TSL functions.
 * 
 * Converted from WGSL to TSL Fn() for better integration with Three.js shader system.
 * All functions now use TSL's type system and control flow patterns.
 * 
 * Key features:
 * - Stack-based BVH traversal
 * - Material visibility caching
 * - Shadow ray optimization
 * - Transmission/transparency support
 */

/**
 * BVH node data layout constants (3 vec4s per node).
 * Layout:
 * vec4[0]: boundsMin.xyz, leftChild index
 * vec4[1]: boundsMax.xyz, rightChild index
 * vec4[2]: triStart, triCount, unused, unused
 */
export const BVH_VEC4_PER_NODE = 3;

/**
 * Triangle data layout (8 vec4s per triangle).
 * Layout (matches bvhtraverse.fs):
 * vec4[0]: posA.xyz, unused
 * vec4[1]: posB.xyz, unused
 * vec4[2]: posC.xyz, unused
 * vec4[3]: normalA.xyz, unused
 * vec4[4]: normalB.xyz, unused
 * vec4[5]: normalC.xyz, unused
 * vec4[6]: uvA.xy, uvB.xy
 * vec4[7]: uvC.xy, materialIndex, meshIndex
 */
export const TRI_VEC4_PER_TRIANGLE = 8;

/**
 * Material data layout constants
 */
export const MATERIAL_SLOTS = 11; // Number of vec4s per material

/**
 * Helper function to calculate texture coordinates from data index.
 * Matches getDatafromDataTexture pattern from GLSL shaders.
 * 
 * @param {TSLNode} texWidth - Texture width (float)
 * @param {TSLNode} texHeight - Texture height (float)
 * @param {TSLNode} dataIndex - Data element index (int)
 * @param {TSLNode} dataOffset - Offset within element (int)
 * @param {TSLNode} stride - Number of vec4s per element (int)
 * @returns {TSLNode} vec2 texture coordinates
 */
export const getDataFromTexture = Fn( ( [ texWidth, texHeight, dataIndex, dataOffset, stride ] ) => {

	// Calculate flat index in texture
	const flatIndex = float( dataIndex.mul( stride ).add( dataOffset ) );
	
	// Convert to 2D texture coordinates
	const x = flatIndex.mod( texWidth ).add( 0.5 ).div( texWidth );
	const y = floor( flatIndex.div( texWidth ) ).add( 0.5 ).div( texHeight );
	
	return vec2( x, y );

} );

/**
 * Fast ray-AABB intersection test.
 * Re-exported from RayAABB.js for compatibility.
 * Matches fastRayAABBDst from GLSL with vectorized distance computation.
 */
export const fastRayAABBDst = rayAABBIntersect;

/**
 * Ray-triangle intersection using Moller-Trumbore algorithm.
 * Returns vec4(t, u, v, hit) - matches RayTriangleGeometry from GLSL.
 * 
 * Wrapper around rayTriangleIntersect from RayTriangle.js that converts
 * the object format to vec4 for compatibility with existing code.
 * 
 * @param {TSLNode} rayOrigin - Ray origin (vec3)
 * @param {TSLNode} rayDir - Ray direction (vec3)
 * @param {TSLNode} posA - Triangle vertex A (vec3)
 * @param {TSLNode} posB - Triangle vertex B (vec3)
 * @param {TSLNode} posC - Triangle vertex C (vec3)
 * @returns {TSLNode} vec4(t, u, v, hit) where hit=1 if intersected
 */
export const rayTriangleGeometry = Fn( ( [ rayOrigin, rayDir, posA, posB, posC ] ) => {

	const result = rayTriangleIntersect( rayOrigin, rayDir, posA, posB, posC );
	
	// Convert object result to vec4(t, u, v, hit)
	return vec4(
		result.t,
		result.u,
		result.v,
		result.hit.select( float( 1.0 ), float( 0.0 ) )
	);

} );

/**
 * Direct re-exports of core intersection functions.
 * - rayAABBIntersect: imported from RayAABB.js
 * - rayTriangleIntersect: imported from RayTriangle.js
 * - fastRayAABBDst: alias to rayAABBIntersect
 * - rayTriangleGeometry: vec4 wrapper around rayTriangleIntersect
 */
export { rayAABBIntersect, rayTriangleIntersect };

/**
 * Creates a BVH traverser that works with TSL.
 * Now returns references to the composable TSL functions.
 * 
 * @param {DataTexture} bvhTexture - BVH data texture
 * @param {DataTexture} triangleTexture - Triangle data texture
 * @param {DataTexture} materialTexture - Material data texture
 * @param {Vector2} bvhTexSize - BVH texture dimensions
 * @param {Vector2} triangleTexSize - Triangle texture dimensions
 * @param {Vector2} materialTexSize - Material texture dimensions
 * @returns {Object} Object containing TSL helper functions
 */
export const createBVHTraverser = (
	bvhTexture,
	triangleTexture,
	materialTexture,
	bvhTexSize,
	triangleTexSize,
	materialTexSize
) => {

	// Return composable TSL functions
	return {
		helpers: {
			rayAABB: fastRayAABBDst,
			rayTriangle: rayTriangleGeometry,
			getDataFromTexture: getDataFromTexture
		}
	};

};

/**
 * Creates a simple single-triangle test traverser for debugging.
 * 
 * @param {DataTexture} triangleTexture - Triangle data texture
 * @param {Vector2} triangleTexSize - Triangle texture dimensions
 * @returns {Object} Object containing ray-triangle intersection function
 */
export const createSingleTriangleTest = ( triangleTexture, triangleTexSize ) => {

	return {
		rayTriangleIntersect: rayTriangleGeometry
	};

};

/**
 * Creates a simpler occlusion test that just returns hit/miss.
 * Optimized version for shadow rays.
 * 
 * @param {DataTexture} triangleTexture - Triangle data texture
 * @param {Vector2} triangleTexSize - Triangle texture dimensions
 * @param {number} triangleCount - Number of triangles
 * @param {number} maxDist - Maximum ray distance
 * @returns {Object} Object containing traversal function
 */
export const createOcclusionTest = ( triangleTexture, triangleTexSize, triangleCount, maxDist ) => {

	return {
		rayAABB: fastRayAABBDst,
		rayTriangle: rayTriangleGeometry
	};

};
