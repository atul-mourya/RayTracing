/**
 * ReSTIRCaptureKernel.js — capture the EXACT bounce-0 primary-hit world point for ReSTIR DI.
 *
 * Runs after the bounce-0 Extend and BEFORE Shade overwrites the ray buffer with the bounce-1
 * continuation. Reads the ACTUAL (AA-jittered) primary ray (origin + direction) + the hit distance
 * and writes P = origin + direction·dist into the pool's primary-hit buffer (1 vec4/pixel).
 *
 * Why: the initial/temporal/resolve kernels previously reconstructed P via reconstructPrimaryHit, which
 * uses the pixel CENTRE (no sub-pixel jitter). ShadeKernel/NEE evaluate at the jittered hit, so the
 * progressive average over frames samples sub-pixel lighting variation; the centre-only ReSTIR eval did
 * not → a systematic ~−5-7% dark bias on detailed/multi-light scenes. Capturing the real per-frame hit
 * makes the ReSTIR kernels average the jitter identically to brute-force NEE (verified unbiased).
 *
 * Storage buffers (≤10): rayBufferRO, hitBufferRO, primaryHitRW = 3 SB. S is forced to 1 when ReSTIR is
 * on, so rayID == pixelIndex.
 */

import {
	Fn, float, int, uint, vec4, If,
	localId, workgroupId,
} from 'three/tsl';

import { readRayOrigin, readRayDirection, readHitDistance } from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

export function buildRestirCaptureKernel( params ) {

	const {
		rayBufferRO, hitBufferRO, primaryHitRW, resolutionUniform,
		// PT-2b (GI only): the primaryHit buffer ping-pongs cur/prev — write at pixel·slots + parity so
		// gi-temporal can read the TRUE previous-frame jittered x0. DI keeps the defaults (stride 1).
		primaryHitSlots = 1, frameParityUniform = null,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const pixelIndex = gy.mul( int( resolutionUniform.x ) ).add( gx );
			const rayID = uint( pixelIndex );

			// Bounce-0 ray is still intact here (Shade runs after this kernel). P = origin + dir·dist.
			// Misses get a far P but are skipped downstream via the hit-distance check.
			const origin = readRayOrigin( rayBufferRO, rayID ).toVar();
			const direction = readRayDirection( rayBufferRO, rayID ).toVar();
			const dist = readHitDistance( hitBufferRO, rayID ).toVar();
			const P = origin.add( direction.mul( dist ) ).toVar();

			const writeIdx = primaryHitSlots > 1
				? pixelIndex.mul( int( primaryHitSlots ) ).add( frameParityUniform )
				: pixelIndex;
			primaryHitRW.element( writeIdx ).assign( vec4( P, float( 0.0 ) ) );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_CAPTURE_WG_SIZE };
