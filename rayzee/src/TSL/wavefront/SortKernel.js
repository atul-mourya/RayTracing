/**
 * SortKernel.js — per-workgroup counting sort of active rays by materialIndex.
 * Histogram lives in storage (numWorkgroups × 16 atomic u32) since TSL workgroupArray can't hold atomics.
 * Caller must zero sortHistogram before every dispatch.
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
import { ENGINE_DEFAULTS } from '../../EngineDefaults.js';

const WG_SIZE = 256;
const MAX_BINS = ENGINE_DEFAULTS.wavefrontSortBins ?? 16;

// materialBinRemap (optional): declaredMatIdx → denseBinIdx; absent → direct clamp (pathological on dense scenes).
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

		If( isActive, () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
			const bin = useRemap
				? materialBinRemap.element( matIdx ).clamp( uint( 0 ), uint( MAX_BINS - 1 ) )
				: matIdx.clamp( uint( 0 ), uint( MAX_BINS - 1 ) );
			atomicAdd( sortHistogram.element( histBase.add( bin ) ), uint( 1 ) );

		} );

		storageBarrier();

		// thread 0 converts bin counts → exclusive prefix sum, in place
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

		// scatter: atomicAdd on the exclusive prefix gives this ray's slot in its workgroup's output region
		If( isActive, () => {

			const rayID = activeIndicesReadRO.element( tid );
			const matIdx = uint( readHitMaterialIndex( hitBufferRO, rayID ) );
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
