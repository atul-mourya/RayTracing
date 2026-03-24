/**
 * BufferAccess.js
 *
 * TSL helper functions for reading and writing wavefront SoA buffers.
 * Each function wraps `.element(index)` access patterns and provides
 * structured read/write interfaces for ray, hit, shadow, and first-hit data.
 *
 * Usage in compute kernels:
 *   const ray = loadRay( rayID, buffers );
 *   // ... modify ray ...
 *   storeRay( rayID, buffers, ray );
 */

import { Fn } from 'three/tsl';

/**
 * Load ray data from SoA buffers at the given ray index.
 *
 * @param {Node} rayID - uint index into the ray buffers
 * @param {Object} b - Buffer nodes object with RO (read-only) entries:
 *   { rayOriginRO, rayDirectionRO, rayThroughputRO, rayRadianceRO,
 *     rayPixelIndexRO, rayRngStateRO, rayBounceFlagsRO, rayPdfRO, rayLastNormalRO }
 * @returns {Object} TSL nodes: { origin, direction, throughput, radiance, pixelIndex, rngState, bounceFlags, pdf, lastNormal }
 */
export const loadRay = Fn( ( [ rayID, rayOriginBuf, rayDirectionBuf, rayThroughputBuf,
	rayRadianceBuf, rayPixelIndexBuf, rayRngStateBuf, rayBounceFlagsBuf,
	rayPdfBuf, rayLastNormalBuf ] ) => {

	return {
		origin: rayOriginBuf.element( rayID ),
		direction: rayDirectionBuf.element( rayID ),
		throughput: rayThroughputBuf.element( rayID ),
		radiance: rayRadianceBuf.element( rayID ),
		pixelIndex: rayPixelIndexBuf.element( rayID ),
		rngState: rayRngStateBuf.element( rayID ),
		bounceFlags: rayBounceFlagsBuf.element( rayID ),
		pdf: rayPdfBuf.element( rayID ),
		lastNormal: rayLastNormalBuf.element( rayID ),
	};

} );

/**
 * Load hit data from SoA buffers at the given ray index.
 *
 * @param {Node} rayID - uint index
 * @param {Object} b - Hit buffer RO nodes
 * @returns {Object} TSL nodes: { distance, triangleIndex, barycentrics, materialMesh, geometricNormal }
 */
export const loadHit = Fn( ( [ rayID, hitDistanceBuf, hitTriangleIndexBuf,
	hitBarycentricsBuf, hitMaterialMeshBuf, hitGeometricNormalBuf ] ) => {

	return {
		distance: hitDistanceBuf.element( rayID ),
		triangleIndex: hitTriangleIndexBuf.element( rayID ),
		barycentrics: hitBarycentricsBuf.element( rayID ),
		materialMesh: hitMaterialMeshBuf.element( rayID ),
		geometricNormal: hitGeometricNormalBuf.element( rayID ),
	};

} );

/**
 * Store ray data to SoA buffers. Only writes the fields that typically change
 * during shading: origin, direction, throughput, radiance, bounceFlags, pdf, lastNormal, rngState.
 * pixelIndex is write-once (in Generate) and not updated during bounces.
 *
 * @param {Node} rayID - uint index
 * @param {Object} bufRW - RW buffer nodes
 * @param {Object} data - Values to store
 */
export function storeRayBounce( rayID, bufRW, data ) {

	bufRW.rayOriginRW.element( rayID ).assign( data.origin );
	bufRW.rayDirectionRW.element( rayID ).assign( data.direction );
	bufRW.rayThroughputRW.element( rayID ).assign( data.throughput );
	bufRW.rayRadianceRW.element( rayID ).assign( data.radiance );
	bufRW.rayBounceFlagsRW.element( rayID ).assign( data.bounceFlags );
	bufRW.rayPdfRW.element( rayID ).assign( data.pdf );
	bufRW.rayLastNormalRW.element( rayID ).assign( data.lastNormal );
	bufRW.rayRngStateRW.element( rayID ).assign( data.rngState );

}

/**
 * Store a primary ray (Generate kernel). Writes all fields including pixelIndex.
 *
 * @param {Node} rayID - uint index
 * @param {Object} bufRW - RW buffer nodes
 * @param {Object} data - All ray fields
 */
export function storeRayPrimary( rayID, bufRW, data ) {

	bufRW.rayOriginRW.element( rayID ).assign( data.origin );
	bufRW.rayDirectionRW.element( rayID ).assign( data.direction );
	bufRW.rayThroughputRW.element( rayID ).assign( data.throughput );
	bufRW.rayRadianceRW.element( rayID ).assign( data.radiance );
	bufRW.rayPixelIndexRW.element( rayID ).assign( data.pixelIndex );
	bufRW.rayRngStateRW.element( rayID ).assign( data.rngState );
	bufRW.rayBounceFlagsRW.element( rayID ).assign( data.bounceFlags );
	bufRW.rayPdfRW.element( rayID ).assign( data.pdf );
	bufRW.rayLastNormalRW.element( rayID ).assign( data.lastNormal );

}

/**
 * Store hit result from BVH traversal (Extend kernel).
 *
 * @param {Node} rayID - uint index
 * @param {Object} bufRW - Hit buffer RW nodes
 * @param {Object} data - Hit fields: { distance, triangleIndex, barycentrics, materialMesh, geometricNormal }
 */
export function storeHit( rayID, bufRW, data ) {

	bufRW.hitDistanceRW.element( rayID ).assign( data.distance );
	bufRW.hitTriangleIndexRW.element( rayID ).assign( data.triangleIndex );
	bufRW.hitBarycentricsRW.element( rayID ).assign( data.barycentrics );
	bufRW.hitMaterialMeshRW.element( rayID ).assign( data.materialMesh );
	bufRW.hitGeometricNormalRW.element( rayID ).assign( data.geometricNormal );

}

/**
 * Store a shadow ray into the shadow queue (Shade kernel).
 *
 * @param {Node} shadowID - uint index into shadow queue
 * @param {Object} bufRW - Shadow buffer RW nodes
 * @param {Object} data - Shadow ray fields
 */
export function storeShadowRay( shadowID, bufRW, data ) {

	bufRW.shadowOriginRW.element( shadowID ).assign( data.origin );
	bufRW.shadowDirectionRW.element( shadowID ).assign( data.direction );
	bufRW.shadowMaxDistRW.element( shadowID ).assign( data.maxDist );
	bufRW.shadowPendingRadianceRW.element( shadowID ).assign( data.pendingRadiance );
	bufRW.shadowParentRayIDRW.element( shadowID ).assign( data.parentRayID );

}

/**
 * Store first-hit data for denoiser MRT output (Shade kernel, bounce 0 only).
 *
 * @param {Node} rayID - uint index
 * @param {Object} bufRW - First-hit buffer RW nodes
 * @param {Object} data - { normalDepth: vec4, albedo: vec4 }
 */
export function storeFirstHit( rayID, bufRW, data ) {

	bufRW.firstHitNormalDepthRW.element( rayID ).assign( data.normalDepth );
	bufRW.firstHitAlbedoRW.element( rayID ).assign( data.albedo );

}

/**
 * Store shadow visibility result (Connect kernel).
 *
 * @param {Node} shadowID - uint index
 * @param {Object} bufRW - Visibility buffer RW nodes
 * @param {Node} visible - uint (0 = occluded, 1 = visible)
 */
export function storeVisibility( shadowID, bufRW, visible ) {

	bufRW.shadowVisibilityRW.element( shadowID ).assign( visible );

}

/**
 * Load shadow ray data for Connect kernel.
 *
 * @param {Node} shadowID - uint index
 * @param {Object} bufRO - Shadow buffer RO nodes
 * @returns {Object} { origin, direction, maxDist, pendingRadiance, parentRayID }
 */
export function loadShadowRay( shadowID, bufRO ) {

	return {
		origin: bufRO.shadowOriginRO.element( shadowID ),
		direction: bufRO.shadowDirectionRO.element( shadowID ),
		maxDist: bufRO.shadowMaxDistRO.element( shadowID ),
		pendingRadiance: bufRO.shadowPendingRadianceRO.element( shadowID ),
		parentRayID: bufRO.shadowParentRayIDRO.element( shadowID ),
	};

}

/**
 * Load first-hit data for FinalWrite kernel.
 *
 * @param {Node} rayID - uint index
 * @param {Object} bufRO - First-hit buffer RO nodes
 * @returns {Object} { normalDepth, albedo }
 */
export function loadFirstHit( rayID, bufRO ) {

	return {
		normalDepth: bufRO.firstHitNormalDepthRO.element( rayID ),
		albedo: bufRO.firstHitAlbedoRO.element( rayID ),
	};

}

/**
 * Load visibility result for Accumulate kernel.
 *
 * @param {Node} shadowID - uint index
 * @param {Object} bufRO - Visibility buffer RO nodes
 * @returns {Node} uint (0 = occluded, 1 = visible)
 */
export function loadVisibility( shadowID, bufRO ) {

	return bufRO.shadowVisibilityRO.element( shadowID );

}
