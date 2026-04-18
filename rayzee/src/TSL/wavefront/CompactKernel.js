/**
 * CompactKernel.js — Wavefront Stream Compaction
 *
 * 256×1 workgroup, 1D dispatch over current active ray count.
 * Compacts active rays into a dense index array for the next bounce.
 * Uses atomic append to build the compacted list.
 *
 * Storage buffer bindings: 4
 *   rayBuffer_RO(1) + activeIndicesRead_RO(1) + activeIndicesWrite_WR(1) + counters(1)
 */

import {
	Fn, uint,
	If,
	instanceIndex,
	atomicAdd,
} from 'three/tsl';

import { readRayBounceFlags } from '../../Processor/PackedRayBuffer.js';
import { RAY_FLAG, COUNTER } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;

/**
 * Build the Compact compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildCompactKernel( params ) {

	const {
		// Ray buffer (RO) — read bounceFlags to check activity
		rayBufferRO,
		// Active indices ping-pong
		activeIndicesReadRO,
		activeIndicesWriteRW,
		// Atomic counters
		counters,
		// Current active count for bounds check
		currentActiveCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		If( threadIdx.greaterThanEqual( currentActiveCount ), () => {

			return;

		} );

		// Get ray ID from current active list
		const rayID = activeIndicesReadRO.element( threadIdx );

		// Check if still active
		const flags = readRayBounceFlags( rayBufferRO, rayID );

		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).notEqual( uint( 0 ) ), () => {

			// Atomic append to next bounce's active list
			const writeIdx = atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 1 ) );
			activeIndicesWriteRW.element( writeIdx ).assign( rayID );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as COMPACT_WG_SIZE };
