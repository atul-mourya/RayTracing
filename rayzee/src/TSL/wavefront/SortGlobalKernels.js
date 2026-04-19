/**
 * SortGlobalKernels.js — Global Counting Sort (item 34)
 *
 * Three-kernel pipeline that produces a GLOBAL ordering of rays by material
 * index (as opposed to SortKernel.js which is per-workgroup). Rays with the
 * same material end up in contiguous memory across all workgroups, giving
 * true cross-workgroup subgroup coherence in the subsequent Shade dispatch.
 *
 * Kernels (dispatched in order):
 *   1. histogram  — each thread atomic-adds to a single shared 16-bin histogram
 *   2. prefixSum  — thread 0 converts bin counts → exclusive prefix sums
 *   3. scatter    — each thread atomic-adds to its bin's position and writes
 *                   its rayID into sortedIndices[position]
 *
 * The caller must zero the 16-bin histogram before every dispatch of step 1
 * (the existing `resetSortHistogram` kernel clears the full histogram buffer,
 * which includes these 16 slots since they share storage).
 */

import {
	Fn, uint, int,
	If, Loop,
	instanceIndex,
	storageBarrier,
	atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';

import { readHitMaterialIndex } from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';
import { ENGINE_DEFAULTS } from '../../EngineDefaults.js';

const WG_SIZE = 256;
const MAX_BINS = ENGINE_DEFAULTS.wavefrontSortBins ?? 16;

/**
 * Build the global histogram kernel. Each active ray contributes +1 to the
 * appropriate bin. Bin chosen via remap (if provided) else direct clamp.
 */
export function buildSortGlobalHistogramKernel( params ) {

	const {
		hitBufferRO, activeIndicesReadRO,
		sortGlobalHistogram, counters,
		materialBinRemap,
	} = params;

	const useRemap = !! materialBinRemap;

	return Fn( () => {

		const tid = instanceIndex;
		const activeCount = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );

		If( tid.lessThan( activeCount ), () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			const bin = useRemap
				? materialBinRemap.element( matIdx ).clamp( uint( 0 ), uint( MAX_BINS - 1 ) )
				: matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );
			atomicAdd( sortGlobalHistogram.element( bin ), uint( 1 ) );

		} );

	} );

}

/**
 * Single-thread prefix-sum kernel. Converts the 16 bin counts to exclusive
 * prefix sums so each bin's starting scatter offset is known. Dispatch must be
 * [1,1,1] with workgroup size [1,1,1].
 */
export function buildSortGlobalPrefixSumKernel( params ) {

	const { sortGlobalHistogram } = params;

	return Fn( () => {

		If( instanceIndex.equal( uint( 0 ) ), () => {

			const running = uint( 0 ).toVar();
			Loop( { start: uint( 0 ), end: uint( MAX_BINS ), type: 'uint' }, ( { i } ) => {

				const count = atomicLoad( sortGlobalHistogram.element( i ) );
				atomicStore( sortGlobalHistogram.element( i ), running );
				running.addAssign( count );

			} );

		} );

	} );

}

/**
 * Global scatter kernel. Each active thread atomically increments its bin's
 * running offset (now holding prefix-sum base) and writes its rayID to that
 * global position in sortedIndices.
 */
export function buildSortGlobalScatterKernel( params ) {

	const {
		hitBufferRO, activeIndicesReadRO, sortedIndicesRW,
		sortGlobalHistogram, counters,
		materialBinRemap,
	} = params;

	const useRemap = !! materialBinRemap;

	return Fn( () => {

		const tid = instanceIndex;
		const activeCount = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );

		If( tid.lessThan( activeCount ), () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			const bin = useRemap
				? materialBinRemap.element( matIdx ).clamp( uint( 0 ), uint( MAX_BINS - 1 ) )
				: matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );
			const pos = atomicAdd( sortGlobalHistogram.element( bin ), uint( 1 ) );
			sortedIndicesRW.element( pos ).assign( rayID );

		} );

	} );

}

export { WG_SIZE as SORT_GLOBAL_WG_SIZE };
