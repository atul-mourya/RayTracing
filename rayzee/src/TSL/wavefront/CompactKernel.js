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
	Fn, uint, select,
	If,
	instanceIndex,
	atomicAdd, atomicLoad,
	subgroupExclusiveAdd, subgroupAdd, subgroupBroadcast,
	Return,
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
		// Current active count for bounds check (fallback when counters bound absent)
		currentActiveCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// Bound on ENTERING_COUNT (the count entering this bounce = dense list length).
		// resetActiveCounter zeroes ACTIVE_RAY_COUNT before compact, so the entering
		// count is read from the preserved ENTERING_COUNT slot, not ACTIVE_RAY_COUNT.
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : currentActiveCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

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

/**
 * Phase 2a — subgroup prefix-sum compaction.
 *
 * Same result as buildCompactKernel (dense survivor list), but instead of one global
 * atomicAdd per surviving ray, each subgroup does ONE global atomicAdd: lanes compute
 * their slot via subgroupExclusiveAdd, the elected lane reserves a contiguous block for
 * the whole subgroup, and the base is broadcast back. Cuts global-atomic contention from
 * O(survivors) to O(survivors / subgroupSize). Order-preserving within a subgroup.
 *
 * Control flow is uniform (no divergent Return before the subgroup ops) — required for
 * WGSL subgroup-builtin uniformity. Requires renderer.hasFeature('subgroups').
 */
export function buildCompactSubgroupKernel( params ) {

	const {
		rayBufferRO,
		activeIndicesReadRO,
		activeIndicesWriteRW,
		counters,
		currentActiveCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : currentActiveCount;

		// NOTE: no early Return — all lanes must reach the subgroup ops. Out-of-range /
		// inactive lanes simply contribute 0. Reads at threadIdx are within the allocated
		// capacity (stale, not OOB) so they're safe to issue unconditionally.
		const inRange = threadIdx.lessThan( bound );
		const rayID = activeIndicesReadRO.element( threadIdx );
		const flags = readRayBounceFlags( rayBufferRO, rayID );
		const isActive = inRange.and( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).notEqual( uint( 0 ) ) );
		const activeU = select( isActive, uint( 1 ), uint( 0 ) );

		// Slot within this subgroup's survivors + total survivors in the subgroup.
		// .toVar() materializes each subgroup op at the (uniform) top-level control flow —
		// otherwise TSL inlines them into the divergent If(isActive) write, which WGSL
		// rejects ("subgroup op must be in subgroup-uniform control flow").
		const localOffset = subgroupExclusiveAdd( activeU ).toVar();
		const sgCount = subgroupAdd( activeU ).toVar();

		// Subgroup-relative lane id: exclusiveAdd of 1 per lane → 0,1,2,…
		// (TSL has no subgroup_invocation_id builtin, and subgroupBroadcastFirst is
		// declared with parameterLength 2 → emits invalid WGSL, so we broadcast from a
		// fixed lane 0 instead.) Lane 0 does the single per-subgroup global atomicAdd.
		const laneId = subgroupExclusiveAdd( uint( 1 ) ).toVar();
		const base = uint( 0 ).toVar();
		If( laneId.equal( uint( 0 ) ), () => {

			base.assign( atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), sgCount ) );

		} );
		const sgBase = subgroupBroadcast( base, uint( 0 ) ).toVar(); // lane-0's reserved block base

		If( isActive, () => {

			activeIndicesWriteRW.element( sgBase.add( localOffset ) ).assign( rayID );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as COMPACT_WG_SIZE };
