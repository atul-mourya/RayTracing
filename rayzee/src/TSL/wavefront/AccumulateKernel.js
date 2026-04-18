/**
 * AccumulateKernel.js — Apply Shadow Ray Results to Radiance
 *
 * 256×1 workgroup, 1D dispatch over shadow ray count.
 * For each visible shadow ray, adds pending radiance to the parent ray's
 * accumulated radiance in the packed ray buffer.
 *
 * Phase 1B: Each parent ray has exactly 1 shadow ray, so no race conditions.
 *
 * Storage buffer bindings: 3
 *   shadowBuffer_RO(1) + visibilityBuffer_RO(1) + rayBuffer_RW(1)
 */

import {
	Fn, uint, vec4,
	If,
	instanceIndex,
	atomicLoad,
	Return,
} from 'three/tsl';

import {
	RAY_STRIDE, RAY,
	readShadowPendingRadiance, readShadowParentRayID,
} from '../../Processor/PackedRayBuffer.js';
import { COUNTER } from '../../Processor/QueueManager.js';

const WG_SIZE = 256;

/**
 * Build the Accumulate compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildAccumulateKernel( params ) {

	const {
		// Shadow buffer (RO)
		shadowBufferRO,
		// Visibility buffer (RO)
		visibilityBufferRO,
		// Ray buffer (RW) — scatter-add to radiance slot
		rayBufferRW,
		// Atomic counters (for real shadow ray count)
		counters,
	} = params;

	const computeFn = Fn( () => {

		const shadowID = instanceIndex;
		const shadowRayCount = atomicLoad( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ) );

		If( shadowID.greaterThanEqual( shadowRayCount ), () => {

			Return();

		} );

		const visible = visibilityBufferRO.element( shadowID );

		If( visible.equal( uint( 1 ) ), () => {

			const parentRayID = readShadowParentRayID( shadowBufferRO, shadowID );
			const pendingRadiance = readShadowPendingRadiance( shadowBufferRO, shadowID );

			// Read current radiance from packed ray buffer (slot 3)
			const radianceSlot = parentRayID.mul( RAY_STRIDE ).add( RAY.RADIANCE_ALPHA );
			const currentRadiance = rayBufferRW.element( radianceSlot ).toVar();

			// Scatter-add pending radiance (safe: 1 shadow ray per parent in Phase 1B)
			rayBufferRW.element( radianceSlot ).assign(
				vec4( currentRadiance.xyz.add( pendingRadiance ), currentRadiance.w )
			);

		} );

	} );

	return computeFn;

}

export { WG_SIZE as ACCUMULATE_WG_SIZE };
