/**
 * SortKernel.js — Material Sorting via Counting Sort (storage-atomic version)
 *
 * 256×1 workgroup, 1D dispatch over max ray count.
 * Sorts active ray indices by materialIndex so the Shade kernel processes
 * rays with the same material in adjacent threads for subgroup coherence.
 *
 * Histogram + prefix sum live in a storage buffer (numWorkgroups × 16 atomic u32)
 * rather than workgroup memory, because TSL's workgroupArray does not support
 * atomic<T> element type (see docs/specs/WAVEFRONT_TODO.md item 22).
 * Each workgroup owns its own 16 slots so no cross-workgroup contention occurs.
 *
 * Storage buffer bindings: 5
 *   hitBuffer_RO(1) + activeIndicesRead_RO(1) + sortedIndices_WR(1)
 *   + sortHistogram(atomic)(1) + counters(1)
 *
 * The caller must zero sortHistogram before every Sort dispatch.
 */

import {
	Fn, uint,
	If, Loop,
	instanceIndex,
	workgroupId, localId,
	storageBarrier,
	atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';

import { readHitMaterialIndex } from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;
const MAX_BINS = 16;

/**
 * Build the Sort compute kernel (counting sort by materialIndex).
 *
 * @param {Object} params
 * @param {StorageBufferNode} params.hitBufferRO - Read-only hit data (provides materialIndex per rayID)
 * @param {StorageBufferNode} params.activeIndicesReadRO - Read-only active ray index queue
 * @param {StorageBufferNode} params.sortedIndicesRW - Output: sorted ray indices (per-workgroup regions)
 * @param {StorageBufferNode} params.sortHistogram - Atomic histogram + prefix-sum scratch (numWorkgroups × 16)
 * @param {StorageBufferNode} params.counters - Atomic counters (for activeRayCount)
 * @param {StorageBufferNode} [params.materialBinRemap] - Optional read-only remap:
 *   declaredMatIdx → denseBinIdx (item 41). When omitted, falls back to
 *   `matIdx.clamp(0, MAX_BINS-1)` which is pathological on dense scenes.
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildSortKernel( params ) {

	const {
		hitBufferRO,
		activeIndicesReadRO,
		sortedIndicesRW,
		sortHistogram,
		counters,
		materialBinRemap,
	} = params;

	const useRemap = !! materialBinRemap;

	const computeFn = Fn( () => {

		const tid = instanceIndex;
		const lid = localId.x;
		const wgid = workgroupId.x;
		const histBase = wgid.mul( uint( MAX_BINS ) );

		const activeCount = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
		const isActive = tid.lessThan( activeCount );

		// Phase 1: per-thread histogram contribution
		If( isActive, () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			// Remap declared materialIndex → dense bin ranked by triangle frequency (item 41).
			// Falls back to direct clamp when remap buffer wasn't wired.
			const bin = useRemap
				? materialBinRemap.element( matIdx ).clamp( uint( 0 ), uint( MAX_BINS - 1 ) )
				: matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );
			atomicAdd( sortHistogram.element( histBase.add( bin ) ), uint( 1 ) );

		} );

		storageBarrier();

		// Phase 2: thread 0 converts bin counts → exclusive prefix sum, in place
		If( lid.equal( uint( 0 ) ), () => {

			const running = uint( 0 ).toVar();
			Loop( { start: uint( 0 ), end: uint( MAX_BINS ), type: 'uint' }, ( { i } ) => {

				const slot = histBase.add( i );
				const count = atomicLoad( sortHistogram.element( slot ) );
				atomicStore( sortHistogram.element( slot ), running );
				running.addAssign( count );

			} );

		} );

		storageBarrier();

		// Phase 3: scatter — atomicAdd on the exclusive prefix gives this ray's
		// unique position within its workgroup's sorted output region.
		If( isActive, () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			// Remap declared materialIndex → dense bin ranked by triangle frequency (item 41).
			// Falls back to direct clamp when remap buffer wasn't wired.
			const bin = useRemap
				? materialBinRemap.element( matIdx ).clamp( uint( 0 ), uint( MAX_BINS - 1 ) )
				: matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );
			const localPos = atomicAdd( sortHistogram.element( histBase.add( bin ) ), uint( 1 ) );
			const globalBase = wgid.mul( uint( WG_SIZE ) );
			sortedIndicesRW.element( globalBase.add( localPos ) ).assign( rayID );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as SORT_WG_SIZE };
