// Spatially Hashed Radiance Cache (SHaRC) — TSL helpers
//
// Port of NVIDIA SHaRC (github.com/NVIDIA-RTX/SHARC) to TSL/WebGPU. World-space
// hash grid that caches outgoing radiance at scene-hit points. Path tracer
// inserts samples and queries cells for early termination at deeper bounces.
//
// Storage layout (per-entry, 3 atomic u32 buffers; accum+resolved packed into
// one cellBuf to fit under WebGPU's 8-bindings-per-stage limit):
//   _hashKeyLo[i]    : low 32 bits of 64-bit packed key
//   _hashKeyHi[i]    : high 32 bits
//   _cellData[i*8..i*8+7] : 8 u32 per cell —
//                              [0..2] accum (R,G,B fixed-point)
//                              [3]    accum sampleNum
//                              [4..6] resolved (R,G,B fixed-point)
//                              [7]    resolved packed metadata
//                                     (accumFrameNum:16 | staleFrameNum:16)
//
// 64-bit hash key bit layout (matches NVIDIA HashGridCommon.h):
//   keyLo[ 0..16] = gridX (17 bits, signed)
//   keyLo[17..31] = gridY low 15 bits
//   keyHi[ 0.. 1] = gridY high 2 bits      (gridY straddles the 32-bit boundary)
//   keyHi[ 2..18] = gridZ (17 bits, signed)
//   keyHi[19..28] = level (10 bits)
//   keyHi[29..31] = normalSignBits (3 bits → 8 orientation classes)
//
//   normalSignBits = (Nx<0?1:0) | (Ny<0?2:0) | (Nz<0?4:0); reduces
//   cross-orientation aliasing where adjacent faces meeting at a corner
//   would otherwise collide into the same cell.
//
// Sentinel: an entry is empty iff keyLo == 0 && keyHi == 0. Valid cells always
// have keyHi > 0 because level >= 1 sets bit 19.

import {
	Fn,
	uint,
	int,
	float,
	If,
	Return,
	Loop,
	Break,
	select,
	atomicLoad,
	atomicStore,
	atomicMax,
	atomicAdd,
} from 'three/tsl';

// ─── Constants ────────────────────────────────────────────────────────────────

export const SHARC_BUCKET_SIZE = 16;
export const SHARC_PROBE_LIMIT = 8;
export const SHARC_RADIANCE_SCALE = 1000.0;
export const SHARC_LOG_BASE = 2.0;
export const SHARC_STALE_FRAME_NUM_MAX = 32;

// Resolve packing: [0:15] accumulatedFrameNum, [16:31] staleFrameNum
export const SHARC_FRAME_BIT_MASK = 0xFFFF;
export const SHARC_STALE_BIT_OFFSET = 16;

// ─── Hash function (Jenkins 32-bit) ──────────────────────────────────────────
// Matches HashGridCommon.h::HashGridHashJenkins32 verbatim.

export const jenkins32 = /*@__PURE__*/ Fn( ( [ aIn ] ) => {

	const a = uint( aIn ).toVar();
	a.assign( a.add( uint( 0x7ed55d16 ) ).add( a.shiftLeft( uint( 12 ) ) ) );
	a.assign( a.bitXor( uint( 0xc761c23c ) ).bitXor( a.shiftRight( uint( 19 ) ) ) );
	a.assign( a.add( uint( 0x165667b1 ) ).add( a.shiftLeft( uint( 5 ) ) ) );
	a.assign( a.add( uint( 0xd3a2646c ) ).bitXor( a.shiftLeft( uint( 9 ) ) ) );
	a.assign( a.add( uint( 0xfd7046c5 ) ).add( a.shiftLeft( uint( 3 ) ) ) );
	a.assign( a.bitXor( uint( 0xb55a4f09 ) ).bitXor( a.shiftRight( uint( 16 ) ) ) );
	return a;

} );

// ─── Grid LOD ────────────────────────────────────────────────────────────────
// level = clamp(0.5 * log_base(distance²) + levelBias, 1, 1023)

export const computeGridLevel = /*@__PURE__*/ Fn( ( [ worldPos, cameraPos, levelBias ] ) => {

	const delta = worldPos.sub( cameraPos );
	const dist2 = delta.dot( delta ).max( float( 1e-6 ) );
	const logBase = float( SHARC_LOG_BASE ).log();
	const level = float( 0.5 ).mul( dist2.log().div( logBase ) ).add( levelBias );
	return level.clamp( float( 1.0 ), float( 1023.0 ) );

} );

// voxelSize = pow(LOG_BASE, level) / (sceneScale * pow(LOG_BASE, levelBias))
export const computeVoxelSize = /*@__PURE__*/ Fn( ( [ level, sceneScale, levelBias ] ) => {

	const baseF = float( SHARC_LOG_BASE );
	return baseF.pow( level ).div( sceneScale.mul( baseF.pow( levelBias ) ) );

} );

// ─── Hash key composition ────────────────────────────────────────────────────
// Returns the low/high halves of the 64-bit hash key as two u32s. gridY
// straddles the 32-bit boundary (low 15 bits in keyLo, high 2 bits in keyHi)
// to fit the documented 17/17/17/10/3 layout into 64 total bits.

export const composeKeyLo = /*@__PURE__*/ Fn( ( [ gx, gy ] ) => {

	const x = uint( int( gx ).bitAnd( int( 0x1FFFF ) ) );
	const yLo = uint( int( gy ).bitAnd( int( 0x7FFF ) ) ); // gy low 15 bits
	return x.bitOr( yLo.shiftLeft( uint( 17 ) ) );

} );

// Normal sign-bits term for the hash key. Reference uses a 1e-3 epsilon to
// avoid axis-aligned faces flipping bits; we embed it directly into the
// `lessThan` test for correctness without an extra branch.
//
// nSigns ∈ [0..7]: bit 0 = (Nx<-eps), bit 1 = (Ny<-eps), bit 2 = (Nz<-eps).
export const normalSignBits = /*@__PURE__*/ Fn( ( [ N ] ) => {

	const eps = float( - 1e-3 );
	const xb = uint( select( N.x.lessThan( eps ), int( 1 ), int( 0 ) ) );
	const yb = uint( select( N.y.lessThan( eps ), int( 2 ), int( 0 ) ) );
	const zb = uint( select( N.z.lessThan( eps ), int( 4 ), int( 0 ) ) );
	return xb.bitOr( yb ).bitOr( zb );

} );

export const composeKeyHi = /*@__PURE__*/ Fn( ( [ gy, gz, level, nSigns ] ) => {

	const yHi = uint( int( gy ).shiftRight( int( 15 ) ).bitAnd( int( 0x3 ) ) );
	const z = uint( int( gz ).bitAnd( int( 0x1FFFF ) ) );
	const lvl = uint( int( level ).bitAnd( int( 0x3FF ) ) );
	const nb = uint( nSigns ).bitAnd( uint( 0x7 ) );
	return yHi
		.bitOr( z.shiftLeft( uint( 2 ) ) )
		.bitOr( lvl.shiftLeft( uint( 19 ) ) )
		.bitOr( nb.shiftLeft( uint( 29 ) ) );

} );

// ─── Bucket index from hash key ──────────────────────────────────────────────
// bucketBase = ((jenkins32(lo) ^ jenkins32(hi)) % numBuckets) * SHARC_BUCKET_SIZE

export const bucketBaseFromKey = /*@__PURE__*/ Fn( ( [ keyLo, keyHi, numBuckets ] ) => {

	const h = jenkins32( keyLo ).bitXor( jenkins32( keyHi ) );
	return h.mod( numBuckets ).mul( uint( SHARC_BUCKET_SIZE ) );

} );

// ─── Read-only slot lookup (Phase 3 query path) ────────────────────────────
// Walks the linear-probe window using only atomicLoad. No side effects.
//
// Caller pre-allocates two uvars and inspects `resultFound` after the call:
//   const slot  = uint(0).toVar();
//   const found = uint(0).toVar();
//   buildFindSlotReadOnlyBody({ ..., resultSlot: slot, resultFound: found });
//   If(found.equal(uint(1)), () => { /* slot is valid */ });

export function buildFindSlotReadOnlyBody( {
	keyLoBuf,
	keyHiBuf,
	bucketBase,
	keyLo,
	keyHi,
	resultSlot,
	resultFound,
} ) {

	const lo = uint( keyLo ).toVar();
	const hi = uint( keyHi ).toVar();
	const base = uint( bucketBase ).toVar();

	resultFound.assign( uint( 0 ) );
	resultSlot.assign( uint( 0 ) );

	Loop( { start: int( 0 ), end: int( SHARC_PROBE_LIMIT ), type: 'int', condition: '<' }, ( { i: probe } ) => {

		If( resultFound.equal( uint( 1 ) ), () => {

			Break();

		} );

		const slotIdx = base.add( uint( probe ) ).toVar();
		const curLo = atomicLoad( keyLoBuf.element( slotIdx ) );

		If( curLo.equal( lo ), () => {

			const curHi = atomicLoad( keyHiBuf.element( slotIdx ) );
			If( curHi.equal( hi ), () => {

				resultSlot.assign( slotIdx );
				resultFound.assign( uint( 1 ) );

			} );

		} );

	} );

}

// ─── Find-or-insert + accumulate (Phase 2 path-tracer integration) ──────────
//
// Race-correct find-or-insert using `atomicMax` as a "claim if empty" primitive:
//   - Empty slot is (keyLo == 0).
//   - `atomicMax(keyLo[slot], ourLo)` returns the prior value. If prior == 0,
//     we just claimed an empty slot. If prior == ourLo, slot already has our
//     key (or a key with the same lo half). If prior > 0 and != ourLo, slot is
//     taken by a different key — probe forward.
//
// Subtle ordering: after a successful claim we `atomicStore` keyHi non-atomic
// w.r.t. keyLo. A racing thread that reads keyLo first sees ourLo but may see
// a stale keyHi=0; it will treat the slot as "different key" and probe forward.
// This causes occasional duplicate cells (same key in two slots) but never
// corruption, never reads stale radiance into the wrong cell. Adding a
// storageBarrier between the two stores would close this race at the cost of
// a workgroup-wide sync per insert — not currently worth it.
//
// Caller invokes:
//   findOrInsertAccumulate({
//     keyLoBuf, keyHiBuf, accumBuf, capacity,
//     keyLo, keyHi, bucketBase,           // composed by caller
//     radianceR, radianceG, radianceB,    // pre-scaled to fixed-point u32
//   });
//
// Drops the sample (no-op) if no slot is found within SHARC_PROBE_LIMIT probes.

export function buildFindOrInsertAccumulateBody( {
	keyLoBuf,
	keyHiBuf,
	cellBuf,
	bucketBase,
	keyLo,
	keyHi,
	radianceR,
	radianceG,
	radianceB,
} ) {

	const lo = uint( keyLo ).toVar();
	const hi = uint( keyHi ).toVar();
	const base = uint( bucketBase ).toVar();
	const r = uint( radianceR ).toVar();
	const g = uint( radianceG ).toVar();
	const b = uint( radianceB ).toVar();
	const done = uint( 0 ).toVar();

	Loop( { start: int( 0 ), end: int( SHARC_PROBE_LIMIT ), type: 'int', condition: '<' }, ( { i: probe } ) => {

		If( done.equal( uint( 1 ) ), () => {

			Break();

		} );

		const slotIdx = base.add( uint( probe ) ).toVar();
		// 8 u32 per cell, accum slots are at offsets 0..3
		const cellBase = slotIdx.mul( uint( 8 ) ).toVar();

		const curLo = atomicLoad( keyLoBuf.element( slotIdx ) ).toVar();

		// Match: key already present in this slot.
		If( curLo.equal( lo ), () => {

			const curHi = atomicLoad( keyHiBuf.element( slotIdx ) );
			If( curHi.equal( hi ), () => {

				atomicAdd( cellBuf.element( cellBase.add( uint( 0 ) ) ), r );
				atomicAdd( cellBuf.element( cellBase.add( uint( 1 ) ) ), g );
				atomicAdd( cellBuf.element( cellBase.add( uint( 2 ) ) ), b );
				atomicAdd( cellBuf.element( cellBase.add( uint( 3 ) ) ), uint( 1 ) );
				done.assign( uint( 1 ) );

			} );

		} ).ElseIf( curLo.equal( uint( 0 ) ), () => {

			// Empty slot — try to claim via atomicMax. Race-resolution: only
			// one thread sees prior == 0; others see prior > 0 and fall
			// through to next probe.
			const prior = atomicMax( keyLoBuf.element( slotIdx ), lo ).toVar();
			If( prior.equal( uint( 0 ) ), () => {

				atomicStore( keyHiBuf.element( slotIdx ), hi );
				atomicAdd( cellBuf.element( cellBase.add( uint( 0 ) ) ), r );
				atomicAdd( cellBuf.element( cellBase.add( uint( 1 ) ) ), g );
				atomicAdd( cellBuf.element( cellBase.add( uint( 2 ) ) ), b );
				atomicAdd( cellBuf.element( cellBase.add( uint( 3 ) ) ), uint( 1 ) );
				done.assign( uint( 1 ) );

			} ).ElseIf( prior.equal( lo ), () => {

				// Race: another thread with our same keyLo just claimed this
				// slot. If it also has our keyHi, accumulate into it.
				const curHi = atomicLoad( keyHiBuf.element( slotIdx ) );
				If( curHi.equal( hi ), () => {

					atomicAdd( cellBuf.element( cellBase.add( uint( 0 ) ) ), r );
					atomicAdd( cellBuf.element( cellBase.add( uint( 1 ) ) ), g );
					atomicAdd( cellBuf.element( cellBase.add( uint( 2 ) ) ), b );
					atomicAdd( cellBuf.element( cellBase.add( uint( 3 ) ) ), uint( 1 ) );
					done.assign( uint( 1 ) );

				} );

			} );

		} );

	} );

	// If done == 0, no slot found — sample dropped. Cache too small for scene.

}


// ─── Resolve cell logic ──────────────────────────────────────────────────────
// One thread per cell — emit the per-cell resolve body inline into the calling
// Fn. Not a setLayout'd helper because it needs storage-buffer access (atomic
// ops on accum/resolved/keyLo/keyHi bound at the call site).
//
// Side-effects: zeros accum slots, writes resolved slots, evicts stale cells.

export function buildResolveCellBody( {
	cellIdx,
	keyLoBuf,
	keyHiBuf,
	cellBuf,
	staleFrameNumMax,
} ) {

	const idx = uint( cellIdx ).toVar();
	const cellBase = idx.mul( uint( 8 ) ).toVar();
	// Accum slots: cellBase + 0..3
	// Resolved slots: cellBase + 4..7

	// Skip empty entries fast
	const keyLoVal = atomicLoad( keyLoBuf.element( idx ) ).toVar();
	const keyHiVal = atomicLoad( keyHiBuf.element( idx ) ).toVar();
	If( keyLoVal.equal( uint( 0 ) ).and( keyHiVal.equal( uint( 0 ) ) ), () => {

		Return();

	} );

	const accumSampleNum = atomicLoad( cellBuf.element( cellBase.add( uint( 3 ) ) ) ).toVar();

	// Decode resolved metadata (slot 7)
	const resolvedMeta = atomicLoad( cellBuf.element( cellBase.add( uint( 7 ) ) ) ).toVar();
	const accumulatedFrameNum = resolvedMeta.bitAnd( uint( SHARC_FRAME_BIT_MASK ) ).toVar();
	const staleFrameNum = resolvedMeta.shiftRight( uint( SHARC_STALE_BIT_OFFSET ) ).bitAnd( uint( SHARC_FRAME_BIT_MASK ) ).toVar();

	If( accumSampleNum.equal( uint( 0 ) ), () => {

		// No new samples this frame → bump stale counter
		const newStale = staleFrameNum.add( uint( 1 ) ).toVar();
		If( newStale.greaterThanEqual( staleFrameNumMax ), () => {

			// Evict — zero key + all 8 cell slots
			atomicStore( keyLoBuf.element( idx ), uint( 0 ) );
			atomicStore( keyHiBuf.element( idx ), uint( 0 ) );
			for ( let i = 0; i < 8; i ++ ) {

				atomicStore( cellBuf.element( cellBase.add( uint( i ) ) ), uint( 0 ) );

			}

		} ).Else( () => {

			// Repack frame metadata with bumped stale counter
			const newMeta = accumulatedFrameNum.bitOr( newStale.shiftLeft( uint( SHARC_STALE_BIT_OFFSET ) ) );
			atomicStore( cellBuf.element( cellBase.add( uint( 7 ) ) ), newMeta );

		} );
		Return();

	} );

	// New samples present → blend (prev*N + new) / (N + accumN)
	const accumR = atomicLoad( cellBuf.element( cellBase.add( uint( 0 ) ) ) ).toVar();
	const accumG = atomicLoad( cellBuf.element( cellBase.add( uint( 1 ) ) ) ).toVar();
	const accumB = atomicLoad( cellBuf.element( cellBase.add( uint( 2 ) ) ) ).toVar();
	const prevR = atomicLoad( cellBuf.element( cellBase.add( uint( 4 ) ) ) ).toVar();
	const prevG = atomicLoad( cellBuf.element( cellBase.add( uint( 5 ) ) ) ).toVar();
	const prevB = atomicLoad( cellBuf.element( cellBase.add( uint( 6 ) ) ) ).toVar();
	const prevN = accumulatedFrameNum.toVar();

	const totalN = prevN.add( accumSampleNum ).toVar();
	const totalNf = float( totalN ).max( float( 1.0 ) );
	const prevNf = float( prevN );

	const newR = uint( float( prevR ).mul( prevNf ).add( float( accumR ) ).div( totalNf ) ).toVar();
	const newG = uint( float( prevG ).mul( prevNf ).add( float( accumG ) ).div( totalNf ) ).toVar();
	const newB = uint( float( prevB ).mul( prevNf ).add( float( accumB ) ).div( totalNf ) ).toVar();

	const newAccumFrames = totalN.min( uint( SHARC_FRAME_BIT_MASK ) );
	const newMeta = newAccumFrames; // staleFrameNum = 0 (received samples this frame)

	atomicStore( cellBuf.element( cellBase.add( uint( 4 ) ) ), newR );
	atomicStore( cellBuf.element( cellBase.add( uint( 5 ) ) ), newG );
	atomicStore( cellBuf.element( cellBase.add( uint( 6 ) ) ), newB );
	atomicStore( cellBuf.element( cellBase.add( uint( 7 ) ) ), newMeta );

	// Zero accum slots (0..3) for next frame
	atomicStore( cellBuf.element( cellBase.add( uint( 0 ) ) ), uint( 0 ) );
	atomicStore( cellBuf.element( cellBase.add( uint( 1 ) ) ), uint( 0 ) );
	atomicStore( cellBuf.element( cellBase.add( uint( 2 ) ) ), uint( 0 ) );
	atomicStore( cellBuf.element( cellBase.add( uint( 3 ) ) ), uint( 0 ) );

}
