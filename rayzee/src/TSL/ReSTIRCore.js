/**
 * ReSTIRCore.js — RIS / reservoir primitives for UNBIASED ReSTIR DI (interactive-only).
 *
 * Spec: docs/specs/restir-di-phase01.md. This supersedes the shelved Algorithm-4 salvage:
 * the combine here uses the GRIS generalized-balance-heuristic MIS weight (the unbiased term),
 * NOT Bitterli Alg-4's `b.M + 1/M_total`. See §3.4.
 *
 * Phase-1 layout (§2.1/§2.2): 2 vec4 / slot = 32 B / reservoir.
 *   core = vec4( lightSampleId, wSum, W, M )
 *   aux  = vec4( samplePosX, samplePosY, samplePosZ, pHatOwn )
 *
 * The sample y is a WORLD light POINT (not a direction) so p̂ can be re-evaluated at any pixel
 * (direction = normalize(samplePos − P), d = |samplePos − P|) → the DI shift Jacobian is 1 (§3.6).
 *
 * `pHatOwn` is the sample's target at its PRODUCING pixel — write-once metadata for the MIS
 * numerator; it is NEVER the same as the freshly-recomputed current-pixel target used for W (§2.1 R2).
 *
 * All Fns return NEW reservoirs — TSL struct field mutation across Fn boundaries is unreliable.
 */

import { Fn, float, vec2, vec4, int, If } from 'three/tsl';

import { struct } from './patches.js';
import { RandomValue } from './Random.js';
// Slot layout (single source of truth, pure JS) so the DI stride can never drift from the pool allocation.
import { DI_SLOT_STRIDE, DI_VEC4S_PER_SLOT } from '../Processor/ReSTIRLayout.js';

// lightSampleId encoding: lightType * RESTIR_ID_STRIDE + indexWithinType.
// STRIDE = 100000 (not 100): emissive triangles (type 5) can number in the thousands; index must not
// collide with the type multiplier. float32 mantissa is 24-bit (16.7M exact), so type·100000 + index is
// exact for type ≤ 5 and index < 100000 (max id 599999 ≪ 16.7M). Encode/decode are stride-agnostic.
export const RESTIR_ID_STRIDE = 100000;
export const RESTIR_ID_NONE = 9999999.0;

export const RESTIR_LIGHT_TYPE_DIRECTIONAL = 0;
export const RESTIR_LIGHT_TYPE_AREA = 1;
export const RESTIR_LIGHT_TYPE_POINT = 2;
export const RESTIR_LIGHT_TYPE_SPOT = 3;
// Environment (HDRI/sky): samplePos stores a UNIT DIRECTION (not a world point); env Le(ω) is
// shading-point-independent → wi = samplePos directly (no normalize(samplePos−P)), no distance
// attenuation, and the spatial-reuse shift Jacobian is exactly 1 (direction shared verbatim across pixels).
export const RESTIR_LIGHT_TYPE_ENV = 4;
// Emissive triangle (mesh light): samplePos stores a world POINT on the triangle (like area lights); the
// index is the EMISSIVE-LIST index → deriveAnalyticLe reads the CACHED emission from the packed light
// buffer + the triangle's geometric normal for the front-face gate. MIS = env model (powerHeuristic),
// NOT full-replace: its BSDF partner (emissive-on-hit) fires at the next bounce, ungatable at bounce-0.
export const RESTIR_LIGHT_TYPE_EMISSIVE_TRI = 5;

// prev.M is capped to this × current.M before a temporal merge — bounds history correlation
// (the thing that defeated the accumulator). Legal in GRIS: any positive confidence weight is fine.
export const RESTIR_TEMPORAL_M_CAP_MULTIPLIER = 20.0;

// Spatial reuse: confidence cap on each gathered neighbor (× the running survivor's M) + the fixed pool slot
// the temporal pass writes its result to and the spatial pass reads as a race-free post-temporal snapshot.
export const RESTIR_SPATIAL_M_CAP_MULTIPLIER = 20.0;
export const RESTIR_SNAPSHOT_SLOT = 2;

export const Reservoir = struct( {
	lightSampleId: 'float',
	wSum: 'float', // Σ resampling weights (RIS numerator)
	W: 'float', // UCW: unbiased contribution weight
	M: 'float', // confidence weight (capped sample count)
	samplePosX: 'float', // world light point (area/emissive: sampled point; point/spot: light pos;
	samplePosY: 'float', //   directional: shadingPos + dir·LARGE). ENV: a UNIT DIRECTION (wi), not a point.
	samplePosZ: 'float',
	pHatOwn: 'float', // p̂ of y at its PRODUCING pixel — MIS numerator metadata (write-once, §2.1)
} );

export const emptyReservoir = Fn( () => {

	return Reservoir( {
		lightSampleId: float( RESTIR_ID_NONE ),
		wSum: float( 0.0 ),
		W: float( 0.0 ),
		M: float( 0.0 ),
		samplePosX: float( 0.0 ),
		samplePosY: float( 0.0 ),
		samplePosZ: float( 0.0 ),
		pHatOwn: float( 0.0 ),
	} );

} );

// ── pack / unpack for storage-buffer I/O (1 vec4 each; 2 vec4 per slot) ──

export const packReservoirCore = Fn( ( [ r ] ) => {

	return vec4( r.lightSampleId, r.wSum, r.W, r.M );

} );

export const packReservoirAux = Fn( ( [ r ] ) => {

	return vec4( r.samplePosX, r.samplePosY, r.samplePosZ, r.pHatOwn );

} );

export const unpackReservoir = Fn( ( [ core, aux ] ) => {

	return Reservoir( {
		lightSampleId: core.x,
		wSum: core.y,
		W: core.z,
		M: core.w,
		samplePosX: aux.x,
		samplePosY: aux.y,
		samplePosZ: aux.z,
		pHatOwn: aux.w,
	} );

} );

// Base storage-buffer element index for (pixel, ping-pong slot). Each slot = 2 vec4 (core+aux).
// buffer.element(base) → core, buffer.element(base+1) → aux.
export const reservoirSlotIndex = Fn( ( [ pixelX, pixelY, width, slotBit ] ) => {

	const pixelIdx = pixelY.mul( width ).add( pixelX );
	// stride = SLOTS_PER_PIXEL(3) × DI_VEC4S_PER_SLOT(2) = 6 (DI_SLOT_STRIDE). slotBit ∈ {0,1}=ping-pong, 2=snapshot S.
	// Derived from ReSTIRLayout — the same source the pool allocates from, so they cannot drift out of lockstep.
	return pixelIdx.mul( int( DI_SLOT_STRIDE ) ).add( slotBit.mul( int( DI_VEC4S_PER_SLOT ) ) );

} );

// ── RIS / reservoir primitives ──

/**
 * RIS candidate update (streaming WRS). On adoption stores the candidate's world point +
 * its target p̂ as the write-once pHatOwn. Returns a NEW reservoir.
 */
export const reservoirUpdate = Fn( ( [ r, candidateId, candPosX, candPosY, candPosZ, candidateWeight, candPHat, rngState ] ) => {

	const newWSum = r.wSum.add( candidateWeight );
	const newM = r.M.add( 1.0 );

	const rand = RandomValue( rngState );
	const takeCandidate = newWSum.mul( rand ).lessThan( candidateWeight );

	return Reservoir( {
		lightSampleId: takeCandidate.select( candidateId, r.lightSampleId ),
		wSum: newWSum,
		W: r.W,
		M: newM,
		samplePosX: takeCandidate.select( candPosX, r.samplePosX ),
		samplePosY: takeCandidate.select( candPosY, r.samplePosY ),
		samplePosZ: takeCandidate.select( candPosZ, r.samplePosZ ),
		pHatOwn: takeCandidate.select( candPHat, r.pHatOwn ),
	} );

} );

/**
 * Finalize the canonical RIS reservoir (restirInitial, §3.2 Eq. 3b): W = wSum / (M · p̂(chosen)).
 * `pHatChosen` is the current-pixel target of the chosen sample (= r.pHatOwn here, since the
 * canonical is produced at the current pixel). Returns a NEW reservoir.
 */
export const reservoirFinalizeInitial = Fn( ( [ r, pHatChosen ] ) => {

	const denom = r.M.mul( pHatChosen );
	const finalW = float( 0.0 ).toVar();
	If( denom.greaterThan( float( 1e-10 ) ), () => {

		finalW.assign( r.wSum.div( denom ) );

	} );

	return Reservoir( {
		lightSampleId: r.lightSampleId,
		wSum: r.wSum,
		W: finalW,
		M: r.M,
		samplePosX: r.samplePosX,
		samplePosY: r.samplePosY,
		samplePosZ: r.samplePosZ,
		pHatOwn: r.pHatOwn,
	} );

} );

/**
 * UNBIASED temporal combine (§3.4). Merges the (M-capped) temporal reservoir into the canonical
 * one via the GRIS generalized balance heuristic mᵢ = cᵢ·p̂ᵢ / Σⱼ cⱼ·p̂ⱼ.
 *
 * For TEMPORAL-ONLY reuse both reservoirs live at the current pixel after the disocclusion gate,
 * so they share the target function p̂_q and the balance heuristic COLLAPSES to confidence weights
 * mᵢ = cᵢ / Σⱼ cⱼ (partition of unity exact). Contributions use the current-pixel target at each
 * sample; W drops the M (Eq. 8). pHatOwn travels with the winning sample as immutable metadata (R2).
 *
 *   pHatCanonicalCurrent = canonical sample's target at the current pixel (= canonical.pHatOwn).
 *   pHatTemporalCurrent  = temporal sample's target FRESHLY re-evaluated at the current pixel (Eq. 5).
 *
 * Spatial reuse (deferred) does NOT share the target → it needs the full cross-evaluated denominator
 * (and a neighbor material handle); do not reuse this collapsed form for spatial. Returns a NEW reservoir.
 */
export const reservoirCombineUnbiased = Fn( ( [ canonical, temporal, pHatCanonicalCurrent, pHatTemporalCurrent, rngState ] ) => {

	const cC = canonical.M;
	const cT = temporal.M;
	const denom = cC.add( cT );

	// Balance-heuristic MIS weights for TEMPORAL-ONLY reuse. Both reservoirs are evaluated at the SAME
	// (current) pixel — the temporal sample is re-projected and its target RE-EVALUATED here
	// (pHatTemporalCurrent) — so the two strategies share the target function and the generalized balance
	// heuristic COLLAPSES to confidence weights mᵢ = cᵢ / Σⱼ cⱼ (exact partition of unity). This is the
	// theoretically-correct form for temporal reuse. (An earlier asymmetric variant weighted the temporal
	// sample's stored producing-pixel target temporal.pHatOwn against pHatTemporalCurrent to band-aid a
	// firefly tail — but that broke the partition whenever the two differ (≈always, due to the initial-vs-
	// temporal target-eval path mismatch) and over-brightened the converged image by ~20-30%. The firefly
	// tail it targeted is the proper job of the disocclusion gate, which now actually engages.)
	const mC = float( 0.0 ).toVar();
	const mT = float( 0.0 ).toVar();
	If( denom.greaterThan( float( 1e-10 ) ), () => {

		mC.assign( cC.div( denom ) );
		mT.assign( cT.div( denom ) );

	} );

	// wᵢ = mᵢ · p̂_canonical(yᵢ) · Wᵢ
	const wC = canonical.W.mul( pHatCanonicalCurrent ).mul( mC );
	const wT = temporal.W.mul( pHatTemporalCurrent ).mul( mT );
	const newWSum = wC.add( wT );

	const rand = RandomValue( rngState );
	const takeT = newWSum.mul( rand ).lessThan( wT );

	const survivorPHat = takeT.select( pHatTemporalCurrent, pHatCanonicalCurrent );
	const newW = float( 0.0 ).toVar();
	If( survivorPHat.greaterThan( float( 1e-10 ) ), () => {

		newW.assign( newWSum.div( survivorPHat ) ); // Eq. 8: W = wSum / p̂(survivor) — NO M

	} );

	return Reservoir( {
		lightSampleId: takeT.select( temporal.lightSampleId, canonical.lightSampleId ),
		wSum: newWSum,
		W: newW,
		M: denom,
		samplePosX: takeT.select( temporal.samplePosX, canonical.samplePosX ),
		samplePosY: takeT.select( temporal.samplePosY, canonical.samplePosY ),
		samplePosZ: takeT.select( temporal.samplePosZ, canonical.samplePosZ ),
		pHatOwn: takeT.select( temporal.pHatOwn, canonical.pHatOwn ), // winner's producing-pixel target
	} );

} );

/**
 * UNBIASED SPATIAL combine (GRIS generalized balance heuristic, Eq. 9, K=2) — for reusing a screen-space
 * NEIGHBOR reservoir at the current pixel q. Unlike the temporal combine, the neighbor's OWN domain is its
 * pixel q′ (different material/normal/view), so the target functions DIFFER (p̂_{q′} ≠ p̂_q) and the MIS weight
 * must NOT collapse to cᵢ/Σc — it needs the full cross-evaluated denominator. (The delta-light shift Jacobian
 * is 1, but that is a MEASURE term independent of the MIS denominator — §3.6.) Caller supplies all FOUR
 * cross-target evaluations (each = luminance(f·max(n·ωᵢ,0)·Le), re-evaluated fresh, the same recipe as Initial):
 *   pHatCanonAtQ       = canonical (running survivor) sample's target at MY pixel q   (its own domain)
 *   pHatCanonAtQprime  = canonical sample's target at the NEIGHBOR's pixel q′
 *   pHatNeighAtQ       = neighbor sample's target at MY pixel q
 *   pHatNeighAtQprime  = neighbor sample's target at the NEIGHBOR's pixel q′           (its own domain)
 * For the K-fold streaming gather, recompute these FRESH each fold — never reuse a reservoir's stored pHatOwn
 * (it is a producing-pixel value, not the current-pixel target). Returns a NEW reservoir; W = wSum/p̂_q(survivor).
 */
export const reservoirCombineSpatialUnbiased = Fn( ( [
	canonical, neighbor, pHatCanonAtQ, pHatCanonAtQprime, pHatNeighAtQ, pHatNeighAtQprime, rngState,
] ) => {

	const cC = canonical.M;
	const cN = neighbor.M;

	// mᵢ(yᵢ) = cᵢ·p̂ᵢ(yᵢ) / Σⱼ cⱼ·p̂ⱼ(yᵢ), each p̂ⱼ = reservoir j's OWN-domain target evaluated at yᵢ.
	const denomC = cC.mul( pHatCanonAtQ ).add( cN.mul( pHatCanonAtQprime ) );
	const denomN = cN.mul( pHatNeighAtQprime ).add( cC.mul( pHatNeighAtQ ) );
	const mC = float( 0.0 ).toVar();
	If( denomC.greaterThan( float( 1e-10 ) ), () => {

		mC.assign( cC.mul( pHatCanonAtQ ).div( denomC ) );

	} );
	const mN = float( 0.0 ).toVar();
	If( denomN.greaterThan( float( 1e-10 ) ), () => {

		mN.assign( cN.mul( pHatNeighAtQprime ).div( denomN ) );

	} );

	// wᵢ = mᵢ · p̂_q(yᵢ) · Wᵢ — target at the integration domain q (my pixel).
	const wC = canonical.W.mul( pHatCanonAtQ ).mul( mC );
	const wN = neighbor.W.mul( pHatNeighAtQ ).mul( mN );
	const newWSum = wC.add( wN );

	const rand = RandomValue( rngState );
	const takeN = newWSum.mul( rand ).lessThan( wN );

	const survivorPHat = takeN.select( pHatNeighAtQ, pHatCanonAtQ );
	const newW = float( 0.0 ).toVar();
	If( survivorPHat.greaterThan( float( 1e-10 ) ), () => {

		newW.assign( newWSum.div( survivorPHat ) ); // Eq. 8: W = wSum / p̂(survivor) — NO M

	} );

	return Reservoir( {
		lightSampleId: takeN.select( neighbor.lightSampleId, canonical.lightSampleId ),
		wSum: newWSum,
		W: newW,
		M: cC.add( cN ),
		samplePosX: takeN.select( neighbor.samplePosX, canonical.samplePosX ),
		samplePosY: takeN.select( neighbor.samplePosY, canonical.samplePosY ),
		samplePosZ: takeN.select( neighbor.samplePosZ, canonical.samplePosZ ),
		pHatOwn: takeN.select( neighbor.pHatOwn, canonical.pHatOwn ),
	} );

} );

/** Cap M (temporal history): prev.M ≤ maxM. Returns a NEW reservoir. */
export const reservoirCapM = Fn( ( [ r, maxM ] ) => {

	return Reservoir( {
		lightSampleId: r.lightSampleId,
		wSum: r.wSum,
		W: r.W,
		M: r.M.greaterThan( maxM ).select( maxM, r.M ),
		samplePosX: r.samplePosX,
		samplePosY: r.samplePosY,
		samplePosZ: r.samplePosZ,
		pHatOwn: r.pHatOwn,
	} );

} );

// ── lightSampleId encode / decode ──

export const decodeLightSampleId = Fn( ( [ lightSampleId ] ) => {

	const typeF = lightSampleId.div( float( RESTIR_ID_STRIDE ) ).floor();
	const indexF = lightSampleId.sub( typeF.mul( float( RESTIR_ID_STRIDE ) ) );
	return vec2( typeF, indexF );

} );

export const encodeLightSampleId = Fn( ( [ lightType, lightIndex ] ) => {

	return float( lightType ).mul( float( RESTIR_ID_STRIDE ) ).add( float( lightIndex ) );

} );
