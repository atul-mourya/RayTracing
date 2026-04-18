/**
 * ConnectKernel.js — Wavefront Shadow Ray Traversal
 *
 * 256×1 workgroup, 1D dispatch over shadow ray count.
 * For each shadow ray, traces through BVH and writes visibility result.
 *
 * Phase 1B: Opaque-only shadows (no transparency loop).
 *
 * Storage buffer bindings: 5
 *   bvhBuffer(1) + triangleBuffer(1) + materialBuffer(1)
 *   + shadowBuffer_RO(1) + visibilityBuffer_WR(1)
 */

import {
	Fn, uint,
	If, select,
	instanceIndex,
	atomicLoad,
} from 'three/tsl';

import { traverseBVHShadow } from '../BVHTraversal.js';
import { Ray, HitInfo } from '../Struct.js';
import {
	readShadowOrigin, readShadowDirection, readShadowMaxDist,
} from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;

/**
 * Build the Connect compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildConnectKernel( params ) {

	const {
		// Scene storage buffers (3)
		bvhBuffer, triangleBuffer, materialBuffer,
		// Shadow buffer (RO)
		shadowBufferRO,
		// Visibility buffer (WR)
		visibilityBufferRW,
		// Atomic counters (for real shadow ray count)
		counters,
	} = params;

	const computeFn = Fn( () => {

		const shadowID = instanceIndex;
		const shadowRayCount = atomicLoad( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ) );

		If( shadowID.greaterThanEqual( shadowRayCount ), () => {

			return;

		} );

		// Read shadow ray from packed buffer
		const origin = readShadowOrigin( shadowBufferRO, shadowID ).toVar();
		const direction = readShadowDirection( shadowBufferRO, shadowID ).toVar();
		const maxDist = readShadowMaxDist( shadowBufferRO, shadowID ).toVar();

		// Create ray for BVH traversal
		const shadowRay = Ray( { origin, direction } );

		// Phase 1B: Single opaque shadow test (no transparency loop)
		const hitInfo = HitInfo.wrap( traverseBVHShadow(
			shadowRay, bvhBuffer, triangleBuffer, materialBuffer, maxDist,
		) ).toVar();

		// Visible if no hit closer than maxDist
		const visible = select( hitInfo.dst.greaterThanEqual( maxDist ), uint( 1 ), uint( 0 ) );
		visibilityBufferRW.element( shadowID ).assign( visible );

	} );

	return computeFn;

}

export { WG_SIZE as CONNECT_WG_SIZE };
