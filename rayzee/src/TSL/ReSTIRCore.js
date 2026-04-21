/**
 * ReSTIRCore.js — RIS / Reservoir primitives for ReSTIR DI (Bitterli et al. 2020).
 *
 * Pure TSL. Exports:
 *  - Reservoir struct             — per-pixel RIS state
 *  - emptyReservoir               — zero-initialized reservoir
 *  - packReservoir / unpack...    — vec4 ↔ Reservoir conversion for storage-buffer I/O
 *  - reservoirSlotIndex           — pixel coords → buffer element index (with parity)
 *  - reservoirUpdate              — RIS candidate update (immutable: returns new Reservoir)
 *  - reservoirCombine             — weighted merge of two reservoirs (immutable)
 *  - reservoirFinalize            — compute W = sumWeights / (M * p_hat(chosen))
 *
 * Phase 3 layout: 1 vec4 per slot (16 bytes) × 2 slots per pixel = 32 bytes/pixel.
 *   slot vec4: (lightSampleId, W, sumWeights, M)
 *
 * lightSampleId is encoded as `lightType * 100 + indexWithinType`:
 *   type 0 = directional  (IDs 0..15)
 *   type 1 = area        (IDs 100..115) — not handled in Phase 3 MVP
 *   type 2 = point       (IDs 200..215)
 *   type 3 = spot        (IDs 300..315)
 *   type 99 = sentinel for "no sample"
 *
 * The Fns return NEW reservoir values rather than mutating — TSL struct field
 * mutation across Fn boundaries is unreliable. Callers do `r = update(r, ...)`.
 */

import { Fn, wgslFn, float, vec2, vec4, int, If } from 'three/tsl';

import { struct } from './patches.js';
import { RandomValue } from './Random.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// lightSampleId encoding
export const RESTIR_ID_STRIDE = 100;
export const RESTIR_ID_NONE = 9999.0; // "no sample chosen"

// Light type codes (mirror LightsCore.js)
export const RESTIR_LIGHT_TYPE_DIRECTIONAL = 0;
export const RESTIR_LIGHT_TYPE_AREA = 1;
export const RESTIR_LIGHT_TYPE_POINT = 2;
export const RESTIR_LIGHT_TYPE_SPOT = 3;
// Env sampling — the sampled direction is stored octahedral-encoded in
// the reservoir's aux.zw (not resolvable from lightSampleId alone).
export const RESTIR_LIGHT_TYPE_ENV = 4;

// Temporal bias cap — prev.M is clamped to this × current.M before merging.
// Prevents an old reservoir from dominating forever when the scene is static.
// (Bitterli §5 uses ~20 for temporal — reservoirs accumulate at the SAME pixel
// across frames, so a large cap is safe and improves variance.)
export const RESTIR_TEMPORAL_M_CAP_MULTIPLIER = 20.0;

// Spatial bias cap — neighbor.M is clamped to this × current.M before merging.
// Must be MUCH smaller than the temporal cap: spatial pulls ONE neighbor's
// reservoir, which has its own temporally-accumulated M. Without a tight cap,
// a neighbor with M=80 (temporal-capped) drowns the current pixel's fresh
// M=4 candidates, driving RIS adoption probability to ~99% every frame and
// wiping the visibility cache (which resets on spatial adoption, by design).
// Capping neighbor contribution at 1×current.M makes spatial behave like a
// single extra candidate — the paper-standard treatment for biased-combine
// with K=1. The visibility cache survives across frames when the neighbor
// doesn't win adoption.
export const RESTIR_SPATIAL_M_CAP_MULTIPLIER = 1.0;

// ---------------------------------------------------------------------------
// Reservoir struct
// ---------------------------------------------------------------------------

export const Reservoir = struct( {
	lightSampleId: 'float', // encoded: type * 100 + index, or RESTIR_ID_NONE
	W: 'float', // final weight (sumWeights / (M * p_hat(chosen)))
	sumWeights: 'float', // Σ candidate weights seen so far
	M: 'float', // effective sample count
	visibility: 'float', // 0 or 1 — last tested visibility of the chosen sample
	frameAge: 'float', // frames since last shadow-test (0 = untested, >0 = known)
	dirX: 'float', // octahedral-encoded direction X (used by env samples)
	dirY: 'float', // octahedral-encoded direction Y
} );

// Max frames before a cached visibility must be re-validated. Prevents stale
// shadows when occluders move while the disocclusion test still passes.
export const RESTIR_VISIBILITY_MAX_AGE = 4;

/**
 * Zero-initialized reservoir. Use at the start of per-pixel RIS processing
 * before adding candidates.
 */
export const emptyReservoir = Fn( () => {

	return Reservoir( {
		lightSampleId: float( RESTIR_ID_NONE ),
		W: float( 0.0 ),
		sumWeights: float( 0.0 ),
		M: float( 0.0 ),
		visibility: float( 0.0 ),
		frameAge: float( 0.0 ),
		dirX: float( 0.0 ),
		dirY: float( 0.0 ),
	} );

} );

// ---------------------------------------------------------------------------
// Pack / unpack for storage-buffer I/O
// ---------------------------------------------------------------------------

/**
 * Encode the core (RIS state) half of a Reservoir as a vec4.
 * Callers write BOTH packReservoirCore and packReservoirAux per slot.
 */
export const packReservoirCore = Fn( ( [ r ] ) => {

	return vec4( r.lightSampleId, r.W, r.sumWeights, r.M );

} );

/**
 * Encode the aux (visibility cache + direction) half of a Reservoir as a vec4.
 * .zw carry the octahedral-encoded sampled direction — used by env samples
 * so the exact direction can be re-resolved next frame.
 */
export const packReservoirAux = Fn( ( [ r ] ) => {

	return vec4( r.visibility, r.frameAge, r.dirX, r.dirY );

} );

/**
 * Decode both vec4 halves back into a Reservoir struct.
 */
export const unpackReservoir = Fn( ( [ core, aux ] ) => {

	return Reservoir( {
		lightSampleId: core.x,
		W: core.y,
		sumWeights: core.z,
		M: core.w,
		visibility: aux.x,
		frameAge: aux.y,
		dirX: aux.z,
		dirY: aux.w,
	} );

} );

// ---------------------------------------------------------------------------
// Slot indexing (pixel coords + parity → buffer element index)
// ---------------------------------------------------------------------------

/**
 * Compute the BASE storage-buffer element index (first of 2 vec4s) for a given
 * pixel and ping-pong slot. Each slot occupies 2 vec4s: core + aux.
 *
 * Layout: [pixel 0 slot 0 core, pixel 0 slot 0 aux, pixel 0 slot 1 core,
 *          pixel 0 slot 1 aux, pixel 1 slot 0 core, ...]
 *
 * Callers access:
 *   buffer.element(baseIdx)     → core vec4
 *   buffer.element(baseIdx + 1) → aux vec4
 *
 * @param pixelX  int x coord
 * @param pixelY  int y coord
 * @param width   int render width in pixels
 * @param slotBit int (0 or 1) selecting which ping-pong slot to address
 */
export const reservoirSlotIndex = Fn( ( [ pixelX, pixelY, width, slotBit ] ) => {

	const pixelIdx = pixelY.mul( width ).add( pixelX );
	// pixelIdx * 4 + slotBit * 2 → base of the slot's 2-vec4 block
	return pixelIdx.mul( int( 4 ) ).add( slotBit.mul( int( 2 ) ) );

} );

// ---------------------------------------------------------------------------
// RIS primitives
// ---------------------------------------------------------------------------

/**
 * Update a reservoir with a new candidate. RIS algorithm:
 *   sumWeights += w_i
 *   with probability w_i / sumWeights, adopt this candidate as the new sample
 *
 * Returns a NEW Reservoir. Call sites: `r = reservoirUpdate(r, id, w, rng);`
 */
export const reservoirUpdate = Fn( ( [ r, candidateId, candidateDirX, candidateDirY, candidateWeight, rngState ] ) => {

	const newSumWeights = r.sumWeights.add( candidateWeight );
	const newM = r.M.add( 1.0 );

	// RIS replacement test: take candidate with probability (w_i / sumWeights)
	const rand = RandomValue( rngState );
	const threshold = newSumWeights.mul( rand );
	const takeCandidate = threshold.lessThan( candidateWeight );

	const newId = takeCandidate.select( candidateId, r.lightSampleId );
	// When a fresh candidate is adopted its visibility is unknown (not yet
	// shadow-tested); reset the cache. When the existing sample is kept,
	// carry the existing visibility/age through.
	const newVis = takeCandidate.select( float( 0.0 ), r.visibility );
	const newAge = takeCandidate.select( float( 0.0 ), r.frameAge );
	const newDirX = takeCandidate.select( candidateDirX, r.dirX );
	const newDirY = takeCandidate.select( candidateDirY, r.dirY );

	return Reservoir( {
		lightSampleId: newId,
		W: r.W, // final W computed in reservoirFinalize, not here
		sumWeights: newSumWeights,
		M: newM,
		visibility: newVis,
		frameAge: newAge,
		dirX: newDirX,
		dirY: newDirY,
	} );

} );

/**
 * Combine two reservoirs (weighted merge).
 *
 * To merge `b` into `a`, we treat b.lightSampleId as a single candidate whose
 * weight is `b.W * p_hat_a(b.sample) * b.M` — the "bias-correcting" form from
 * Bitterli §4. The caller must evaluate p_hat_a (the current pixel's target
 * distribution) at b's sample and pass it in.
 *
 * Returns a NEW Reservoir.
 */
export const reservoirCombine = Fn( ( [ a, b, targetPdfAtB, rngState ] ) => {

	// Weight of b's sample, re-evaluated at pixel a's shading context.
	const bWeight = b.W.mul( targetPdfAtB ).mul( b.M );

	const newSumWeights = a.sumWeights.add( bWeight );
	const newM = a.M.add( b.M );

	const rand = RandomValue( rngState );
	const threshold = newSumWeights.mul( rand );
	const takeB = threshold.lessThan( bWeight );

	const newId = takeB.select( b.lightSampleId, a.lightSampleId );
	// Inherit the visibility/age/direction of whichever reservoir's sample was adopted.
	// NOTE: for TEMPORAL merges this is correct (same pixel, disocclusion-tested so
	// geometry+visibility context is preserved). For SPATIAL merges this IS WRONG —
	// the neighbor's visibility was tested at THEIR geometry, not ours, and reusing
	// it bleeds light across occlusion boundaries. Spatial callers must use
	// reservoirCombineSpatial instead.
	const newVis = takeB.select( b.visibility, a.visibility );
	const newAge = takeB.select( b.frameAge, a.frameAge );
	const newDirX = takeB.select( b.dirX, a.dirX );
	const newDirY = takeB.select( b.dirY, a.dirY );

	return Reservoir( {
		lightSampleId: newId,
		W: a.W,
		sumWeights: newSumWeights,
		M: newM,
		visibility: newVis,
		frameAge: newAge,
		dirX: newDirX,
		dirY: newDirY,
	} );

} );

/**
 * Spatial-merge variant: like reservoirCombine but invalidates the visibility
 * cache when the neighbor's sample is adopted. The neighbor was shadow-tested
 * at THEIR pixel's geometry, so reusing their cached visibility would make
 * shadowed pixels look lit if their neighbors saw a light they themselves can't.
 * Setting (vis=0, age=0) forces a fresh shadow trace at the current pixel
 * before contribution is applied.
 */
export const reservoirCombineSpatial = Fn( ( [ a, b, targetPdfAtB, rngState ] ) => {

	const bWeight = b.W.mul( targetPdfAtB ).mul( b.M );
	const newSumWeights = a.sumWeights.add( bWeight );
	const newM = a.M.add( b.M );

	const rand = RandomValue( rngState );
	const threshold = newSumWeights.mul( rand );
	const takeB = threshold.lessThan( bWeight );

	const newId = takeB.select( b.lightSampleId, a.lightSampleId );
	// Visibility+age reset to 0 when adopting neighbor's sample — shadow ray
	// will be traced this frame at our own geometry. Direction still carries
	// through (it's the sample identity, valid regardless of pixel).
	const newVis = takeB.select( float( 0.0 ), a.visibility );
	const newAge = takeB.select( float( 0.0 ), a.frameAge );
	const newDirX = takeB.select( b.dirX, a.dirX );
	const newDirY = takeB.select( b.dirY, a.dirY );

	return Reservoir( {
		lightSampleId: newId,
		W: a.W,
		sumWeights: newSumWeights,
		M: newM,
		visibility: newVis,
		frameAge: newAge,
		dirX: newDirX,
		dirY: newDirY,
	} );

} );

/**
 * Compute the final reservoir weight W from accumulated sumWeights + M.
 * W = sumWeights / (M * p_hat(chosen))
 *
 * The caller must supply the target PDF value of the CHOSEN sample (the one
 * currently referenced by r.lightSampleId), evaluated at the current pixel.
 *
 * Returns a NEW Reservoir with .W set.
 */
export const reservoirFinalize = Fn( ( [ r, targetPdfChosen ] ) => {

	const denom = r.M.mul( targetPdfChosen );
	const finalW = float( 0.0 ).toVar();

	If( denom.greaterThan( float( 1e-10 ) ), () => {

		finalW.assign( r.sumWeights.div( denom ) );

	} );

	return Reservoir( {
		lightSampleId: r.lightSampleId,
		W: finalW,
		sumWeights: r.sumWeights,
		M: r.M,
		visibility: r.visibility,
		frameAge: r.frameAge,
		dirX: r.dirX,
		dirY: r.dirY,
	} );

} );

/**
 * Cap the M count of a reservoir. Used to prevent stale temporal reservoirs
 * from over-dominating the merge: prev.M <= TEMPORAL_M_CAP_MULTIPLIER × curr.M.
 */
export const reservoirCapM = Fn( ( [ r, maxM ] ) => {

	const cappedM = r.M.greaterThan( maxM ).select( maxM, r.M );

	return Reservoir( {
		lightSampleId: r.lightSampleId,
		W: r.W,
		sumWeights: r.sumWeights,
		M: cappedM,
		visibility: r.visibility,
		frameAge: r.frameAge,
		dirX: r.dirX,
		dirY: r.dirY,
	} );

} );

// ---------------------------------------------------------------------------
// lightSampleId encode / decode helpers
// ---------------------------------------------------------------------------

/**
 * Decode lightSampleId → vec2(lightType, indexWithinType) both as floats.
 * Caller converts to int via int() as needed.
 */
export const decodeLightSampleId = Fn( ( [ lightSampleId ] ) => {

	const typeF = lightSampleId.div( float( RESTIR_ID_STRIDE ) ).floor();
	const indexF = lightSampleId.sub( typeF.mul( float( RESTIR_ID_STRIDE ) ) );
	return vec2( typeF, indexF );

} );

/**
 * Encode (lightType, indexWithinType) → lightSampleId as float.
 */
export const encodeLightSampleId = Fn( ( [ lightType, lightIndex ] ) => {

	return float( lightType ).mul( float( RESTIR_ID_STRIDE ) ).add( float( lightIndex ) );

} );

// ---------------------------------------------------------------------------
// Octahedral direction encoding (unit vec3 ↔ 2 floats in [0,1])
// ---------------------------------------------------------------------------
// Used to pack the sampled env direction into 2 floats of the reservoir's aux
// slot, so env samples can be resolved + re-evaluated across frames.
// Loss is bounded (~0.1° for unit vectors) — acceptable for shadow-ray reuse.

export const encodeOctahedral = /*@__PURE__*/ wgslFn( `
	fn encodeOctahedral( n: vec3f ) -> vec2f {
		let invL = 1.0f / ( abs( n.x ) + abs( n.y ) + abs( n.z ) + 1e-8f );
		let nxy = n.xy * invL;
		var r = nxy;
		if ( n.z < 0.0f ) {
			r = ( 1.0f - abs( vec2f( nxy.y, nxy.x ) ) ) * vec2f( select( -1.0f, 1.0f, nxy.x >= 0.0f ), select( -1.0f, 1.0f, nxy.y >= 0.0f ) );
		}
		return r * 0.5f + 0.5f;
	}
` );

export const decodeOctahedral = /*@__PURE__*/ wgslFn( `
	fn decodeOctahedral( e: vec2f ) -> vec3f {
		let f = e * 2.0f - 1.0f;
		var n = vec3f( f.x, f.y, 1.0f - abs( f.x ) - abs( f.y ) );
		let t = max( -n.z, 0.0f );
		n.x = n.x + select( t, -t, n.x >= 0.0f );
		n.y = n.y + select( t, -t, n.y >= 0.0f );
		return normalize( n );
	}
` );
