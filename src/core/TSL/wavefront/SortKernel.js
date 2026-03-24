/**
 * SortKernel.js — Material Sorting via Counting Sort
 *
 * 256×1 workgroup, 1D dispatch over active ray count.
 * Sorts active ray indices by materialIndex so the Shade kernel
 * processes rays with the same material type in adjacent threads,
 * maximizing subgroup coherence.
 *
 * Uses workgroupArray for per-workgroup histogram + prefix sum.
 * Supports up to 16 material bins (covers most scenes).
 *
 * Storage buffer bindings: 4
 *   hitBuffer_RO(1) + activeIndicesRead_RO(1) + sortedIndices_WR(1) + counters(1)
 */

import {
	Fn, int, uint,
	If,
	instanceIndex,
	workgroupId, localId,
	workgroupBarrier, workgroupArray,
	atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';

import { readHitMaterialIndex } from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;
const MAX_BINS = 16; // Supports up to 16 materials

/**
 * Build the Sort compute kernel (counting sort by materialIndex).
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildSortKernel( params ) {

	const {
		hitBufferRO,
		activeIndicesReadRO,
		sortedIndicesRW,
		counters, // For reading active ray count
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const tid = instanceIndex;
		const lid = localId.x;
		const wgid = workgroupId.x;

		// Shared memory: per-bin histogram + prefix sum
		const histogram = workgroupArray( 'uint', MAX_BINS );
		// Global bin offsets (atomically computed across workgroups)
		// We use a 2-pass approach simplified to single pass with global atomics

		// Phase 1: Initialize shared histogram
		If( lid.lessThan( uint( MAX_BINS ) ), () => {

			histogram.element( lid ).assign( uint( 0 ) );

		} );

		workgroupBarrier();

		// Phase 2: Each thread bins its ray
		const activeCount = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );

		If( tid.lessThan( activeCount ), () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			const bin = matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );

			// Count in shared histogram (workgroup-local)
			atomicAdd( histogram.element( bin ), uint( 1 ) );

		} );

		workgroupBarrier();

		// Phase 3: Compute local prefix sum (exclusive scan)
		// Single-thread scan within workgroup (simple, works for 16 bins)
		const prefixSum = workgroupArray( 'uint', MAX_BINS );

		If( lid.equal( uint( 0 ) ), () => {

			const running = uint( 0 ).toVar();

			// Unrolled loop for MAX_BINS = 16
			prefixSum.element( uint( 0 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 0 ) ) ) );
			prefixSum.element( uint( 1 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 1 ) ) ) );
			prefixSum.element( uint( 2 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 2 ) ) ) );
			prefixSum.element( uint( 3 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 3 ) ) ) );
			prefixSum.element( uint( 4 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 4 ) ) ) );
			prefixSum.element( uint( 5 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 5 ) ) ) );
			prefixSum.element( uint( 6 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 6 ) ) ) );
			prefixSum.element( uint( 7 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 7 ) ) ) );
			prefixSum.element( uint( 8 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 8 ) ) ) );
			prefixSum.element( uint( 9 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 9 ) ) ) );
			prefixSum.element( uint( 10 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 10 ) ) ) );
			prefixSum.element( uint( 11 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 11 ) ) ) );
			prefixSum.element( uint( 12 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 12 ) ) ) );
			prefixSum.element( uint( 13 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 13 ) ) ) );
			prefixSum.element( uint( 14 ) ).assign( running );
			running.addAssign( atomicLoad( histogram.element( uint( 14 ) ) ) );
			prefixSum.element( uint( 15 ) ).assign( running );

		} );

		workgroupBarrier();

		// Phase 4: Scatter — each thread writes its rayID to the sorted position
		// Uses atomicAdd on prefixSum to get unique position within the bin
		If( tid.lessThan( activeCount ), () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			const bin = matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );

			// Get position within this workgroup's sorted output
			const localPos = atomicAdd( prefixSum.element( bin ), uint( 1 ) );

			// Write to global sorted array offset by workgroup base
			const globalBase = wgid.mul( uint( WG_SIZE ) );
			sortedIndicesRW.element( globalBase.add( localPos ) ).assign( rayID );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as SORT_WG_SIZE };
