/**
 * SortGlobalKernels.js — global counting sort (histogram → prefixSum → scatter) ordering rays by material
 * across all workgroups, unlike SortKernel.js's per-workgroup sort. Caller must zero the histogram before histogram.
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

// Dispatch must be [1,1,1] with workgroup size [1,1,1].
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
