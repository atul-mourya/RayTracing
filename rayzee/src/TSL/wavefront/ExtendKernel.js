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
	atomicLoad,
	Return,
} from 'three/tsl';

import { traverseBVH } from '../BVHTraversal.js';
import { Ray, HitInfo } from '../Struct.js';
import {
	readRayOrigin, readRayDirection, readMediumStack,
	writeHitPacked,
} from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

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
		// Atomic counters (for ENTERING_COUNT bound)
		counters,
		// Max active count for bounds check (fallback when counters absent)
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// Bounds check: process only the dense active list [0, ENTERING_COUNT).
		// ENTERING_COUNT is the entering ray count for this bounce; surplus threads
		// from an over-sized (margin) dispatch return here without touching stale slots.
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : maxRayCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

		} );

		// Get ray ID from active indices
		const rayID = activeIndicesRO.element( threadIdx );

		// Read ray from packed buffer
		const origin = readRayOrigin( rayBufferRO, rayID ).toVar();
		const direction = readRayDirection( rayBufferRO, rayID ).toVar();

		// Create Ray struct for traverseBVH
		const ray = Ray( { origin, direction } );

		// BVH traversal — reuses existing function directly.
		// main's traverseBVH no longer takes materialBuffer (Woop watertight + materialIndex
		// now read from triangle data); 4th arg is insideMedium — a ray inside a glass/SSS medium
		// bypasses front/back culling so it can hit the medium's back-facing boundary geometry
		// (mirror PathTracerCore:672). Read the per-ray medium-stack depth to decide.
		const insideMedium = readMediumStack( rayBufferRO, rayID ).stackDepth.greaterThan( uint( 0 ) );
		const hitInfo = HitInfo.wrap( traverseBVH(
			ray, bvhBuffer, triangleBuffer, insideMedium,
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
