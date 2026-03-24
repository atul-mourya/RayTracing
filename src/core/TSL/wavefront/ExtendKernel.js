/**
 * ExtendKernel.js — Wavefront BVH Traversal
 *
 * 256×1 workgroup, 1D ray-parallel dispatch.
 * For each active ray, runs BVH traversal and writes hit data to packed buffer.
 *
 * Storage buffer bindings: 6
 *   bvhBuffer(1) + triangleBuffer(1) + materialBuffer(1)
 *   + rayBuffer_RO(1) + hitBuffer_WR(1) + activeIndices_RO(1)
 */

import {
	Fn, uint,
	If,
	instanceIndex,
} from 'three/tsl';

import { traverseBVH } from '../BVHTraversal.js';
import { Ray, HitInfo } from '../Struct.js';
import {
	readRayOrigin, readRayDirection,
	writeHitPacked,
} from '../../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;

/**
 * Build the Extend compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildExtendKernel( params ) {

	const {
		// Scene storage buffers (3)
		bvhBuffer, triangleBuffer, materialBuffer,
		// Packed ray buffer (RO)
		rayBufferRO,
		// Packed hit buffer (WR)
		hitBufferRW,
		// Active ray indices (RO)
		activeIndicesRO,
		// Max active count for bounds check
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// Bounds check
		If( threadIdx.greaterThanEqual( maxRayCount ), () => {

			return;

		} );

		// Get ray ID from active indices
		const rayID = activeIndicesRO.element( threadIdx );

		// Read ray from packed buffer
		const origin = readRayOrigin( rayBufferRO, rayID ).toVar();
		const direction = readRayDirection( rayBufferRO, rayID ).toVar();

		// Create Ray struct for traverseBVH
		const ray = Ray( { origin, direction } );

		// BVH traversal — reuses existing function directly
		const hitInfo = HitInfo.wrap( traverseBVH(
			ray, bvhBuffer, triangleBuffer, materialBuffer,
		) ).toVar();

		// Write packed hit data
		// For misses: distance = 1e20 (HUGE_VAL from BVHTraversal), triIndex = 0
		writeHitPacked(
			hitBufferRW, rayID,
			hitInfo.dst,
			uint( hitInfo.triangleIndex ),
			hitInfo.uv.x, hitInfo.uv.y,
			hitInfo.normal,
			uint( hitInfo.materialIndex ),
			uint( hitInfo.meshIndex ),
		);

	} );

	return computeFn;

}

export { WG_SIZE as EXTEND_WG_SIZE };
