/**
 * ReSTIRGICore.js — reservoir primitives for UNBIASED ReSTIR GI/PT (full-path reservoirs,
 * reconnection shift at x1, PT-2 reconnection-vertex re-evaluation).
 *
 * Specs: docs/specs/restir-gi-phase02.md + docs/specs/restir-pt-phase03.md (PT-1 suffix walk, PT-2 §layout).
 * Separate from ReSTIRCore.js (DI) on purpose. All Fns return NEW reservoirs (TSL struct field mutation
 * across Fn boundaries is unreliable — the DI cardinal rule).
 *
 * GI/PT-2 reservoir = 6 vec4 = 96 B / slot:
 *   core   = vec4( wSum, W, M, pHatOwn )
 *   sample = vec4( x1.xyz, octEncodeNormal(n1) )   // n1 = UNFLIPPED interpolated normal (the texture-
 *                                                  // rebuild perturbation basis; Jacobian is flip-blind)
 *   radiA  = vec4( A.rgb, validFlip )              // frozen d=1 terms (NEE@x1; everything for
 *                                                  // non-factorizable x1). validFlip: 0=invalid,
 *                                                  // 1=valid (front-face shaded), 3=valid (back-face)
 *   suffix = vec4( B.rgb, ω1oct.x )                // B = throughputNoF1·L_suffix (NO f_{x1}); ω1out
 *                                                  // across TWO full-f32 oct lanes (12-bit oct error
 *                                                  // ≈ the GGX lobe width at roughness 0.05)
 *   recon  = vec4( matIdx1, uv1.x, uv1.y, ω1oct.y )// x1 material handle. matIdx1 sentinels:
 *                                                  // −1 = env candidate, −2 = non-factorizable
 *   emis   = vec4( Le.rgb, triIdx1 )               // d=1 emissive-hit UNWEIGHTED Le + triangle index
 *                                                  // (per-domain MIS re-derivation); for env (−1):
 *                                                  // Le = env radiance, triIdx1 lane = stored envPdf
 *
 * x1 stays Float32 (d² Jacobian precision). The PT-2 evaluation contract (the SAME evalLo function at
 * every touch-point, fed the STORED/quantized representation) lives in ReSTIRGIEval.js.
 */

import { Fn, float, vec2, vec3, vec4, int, abs, dot, normalize, max, clamp, If, select } from 'three/tsl';

import { struct } from './patches.js';
// Slot layout (single source of truth, pure JS, node-importable for the stride-parity test).
import { GI_VEC4S_PER_SLOT, GI_SLOT_STRIDE, SLOTS_PER_PIXEL, GI_PRIMARY_HIT_SLOTS } from '../Processor/ReSTIRLayout.js';

// Re-export so the GI kernels import layout + math from one place; GI_SLOTS_PER_PIXEL is the shared slot count.
export { GI_VEC4S_PER_SLOT, GI_SLOT_STRIDE, GI_PRIMARY_HIT_SLOTS };
export const GI_SLOTS_PER_PIXEL = SLOTS_PER_PIXEL;

export const GI_VALID = 1.0;
export const GI_INVALID = 0.0;

// matIdx1 sentinels (recon.x): ≥0 = factorizable surface; −1 = env candidate; −2 = non-factorizable
// (clearcoat x1 / LightsIndirect validInput fallback — everything frozen in A, B=0, PT-1 semantics).
export const GI_MAT_ENV = - 1.0;
export const GI_MAT_FROZEN = - 2.0;

// Same fixed snapshot slot convention as DI (slot 2 = post-temporal, read-only source for spatial gather).
export const GI_SNAPSHOT_SLOT = 2;
export const GI_TEMPORAL_M_CAP_MULTIPLIER = 20.0;
export const GI_SPATIAL_M_CAP_MULTIPLIER = 20.0;

// 12-bit-per-axis octahedral normal packing. NORM_QUANT levels per axis; base NORM_BASE = NORM_QUANT+1 = 2^12.
const NORM_QUANT = 4095.0; // 2^12 − 1
const NORM_BASE = 4096.0; // 2^12 — power of two ⇒ enc/NORM_BASE is exact in f32 (no floor/mod rounding error)

export const GIReservoir = struct( {
	wSum: 'float', // Σ resampling weights (RIS numerator)
	W: 'float', // UCW: unbiased contribution weight
	M: 'float', // confidence weight (capped sample count)
	pHatOwn: 'float', // p̂ of y at its PRODUCING pixel — MIS numerator metadata (write-once)
	x1x: 'float', // reconnection vertex x1 (Float32 — d² Jacobian precision)
	x1y: 'float',
	x1z: 'float',
	n1packed: 'float', // oct-encoded UNFLIPPED interpolated normal at x1 (Jacobian + rebuild basis)
	AR: 'float', // A: frozen d=1 radiance toward x0_src (NEE@x1; all terms when non-factorizable)
	AG: 'float',
	AB: 'float',
	validFlip: 'float', // 0 = invalid; 1 = valid front-face-shaded; 3 = valid back-face-shaded
	BR: 'float', // B: suffix radiance WITHOUT f_{x1} (throughputNoF1 · L_suffix); 0 when walk ended at x1
	BG: 'float',
	BB: 'float',
	om1x: 'float', // ω1out (x1→x2 world dir) full-precision oct .x
	matIdx1: 'float', // x1 material index, or GI_MAT_ENV / GI_MAT_FROZEN
	uv1x: 'float', // x1 texture uv (rebuild handle)
	uv1y: 'float',
	om1y: 'float', // ω1out full-precision oct .y
	LeR: 'float', // d=1 emissive-hit UNWEIGHTED Le (env: the env radiance along ω)
	LeG: 'float',
	LeB: 'float',
	triIdx1: 'float', // emissive triangle index (per-domain lightPdf re-derivation); env: stored envPdf
	seedLo: 'float', // PT-3: per-candidate PRE-xi0 rng snapshot, low 16 bits (16-bit-exact f32 lanes;
	seedHi: 'float', //       raw u32 through f32 hits the NaN-canonicalization pitfall)
	kPrefix: 'float', // PT-3: reconnection-vertex depth (1 = no replay — the PT-2 degenerate)
	prefixPHatCache: 'float', // PT-3c: own-domain prefix-p̂ scalar cache (rewritten on adoption); 0 = unset
} );

export const emptyGIReservoir = Fn( () => {

	return GIReservoir( {
		wSum: float( 0.0 ), W: float( 0.0 ), M: float( 0.0 ), pHatOwn: float( 0.0 ),
		x1x: float( 0.0 ), x1y: float( 0.0 ), x1z: float( 0.0 ), n1packed: float( 0.0 ),
		AR: float( 0.0 ), AG: float( 0.0 ), AB: float( 0.0 ), validFlip: float( GI_INVALID ),
		BR: float( 0.0 ), BG: float( 0.0 ), BB: float( 0.0 ), om1x: float( 0.0 ),
		matIdx1: float( GI_MAT_FROZEN ), uv1x: float( 0.0 ), uv1y: float( 0.0 ), om1y: float( 0.0 ),
		LeR: float( 0.0 ), LeG: float( 0.0 ), LeB: float( 0.0 ), triIdx1: float( 0.0 ),
		seedLo: float( 0.0 ), seedHi: float( 0.0 ), kPrefix: float( 0.0 ), prefixPHatCache: float( 0.0 ),
	} );

} );

// ── octahedral encode / decode ──
// signNotZero: +1 for x ≥ 0, −1 for x < 0 (zero maps to +1, matching the reference oct impl).

const signNotZero1 = Fn( ( [ x ] ) => x.lessThan( float( 0.0 ) ).select( float( - 1.0 ), float( 1.0 ) ) );

const signNotZero2 = Fn( ( [ v ] ) => vec2( signNotZero1( v.x ), signNotZero1( v.y ) ) );

// unit vec3 → oct [-1,1]^2 (full f32 precision — PT-2 stores ω1out across two lanes with this)
export const octEncodeDir2 = Fn( ( [ n ] ) => {

	const l1 = max( abs( n.x ).add( abs( n.y ) ).add( abs( n.z ) ), float( 1e-8 ) );
	const p = vec2( n.x.div( l1 ), n.y.div( l1 ) ).toVar();
	// lower hemisphere fold
	const folded = vec2( float( 1.0 ).sub( abs( p.y ) ), float( 1.0 ).sub( abs( p.x ) ) ).mul( signNotZero2( p ) );
	p.assign( n.z.lessThan( float( 0.0 ) ).select( folded, p ) );
	return p;

} );

// oct [-1,1]^2 → unit vec3
export const octDecodeDir2 = Fn( ( [ f ] ) => {

	const nz = float( 1.0 ).sub( abs( f.x ) ).sub( abs( f.y ) ).toVar();
	const foldedXY = vec2( float( 1.0 ).sub( abs( f.y ) ), float( 1.0 ).sub( abs( f.x ) ) ).mul( signNotZero2( f ) );
	const nxy = nz.lessThan( float( 0.0 ) ).select( foldedXY, vec2( f.x, f.y ) ).toVar();
	return normalize( vec3( nxy.x, nxy.y, nz ) );

} );

// unit normal → single f32 (12 bits/axis, base-4096 integer packing). Exact round-trip within quantization.
export const octEncodeNormal = Fn( ( [ n ] ) => {

	const o = octEncodeDir2( n ); // [-1,1]^2
	const u = clamp( o.mul( 0.5 ).add( 0.5 ), 0.0, 1.0 ); // [0,1]^2
	const qx = u.x.mul( NORM_QUANT ).add( 0.5 ).floor(); // [0, NORM_QUANT]
	const qy = u.y.mul( NORM_QUANT ).add( 0.5 ).floor();
	return qx.mul( NORM_BASE ).add( qy ); // integer in [0, 2^24) — exact in f32

} );

export const octDecodeNormal = Fn( ( [ e ] ) => {

	const qy = e.mod( NORM_BASE ); // low axis — exact (NORM_BASE is a power of two)
	const qx = e.div( NORM_BASE ).floor(); // high axis — exact (power-of-two divide never rounds)
	const ux = qx.div( NORM_QUANT );
	const uy = qy.div( NORM_QUANT );
	const o = vec2( ux, uy ).mul( 2.0 ).sub( 1.0 ); // [-1,1]^2
	return octDecodeDir2( o );

} );

// ── pack / unpack for storage-buffer I/O (6 vec4 per slot; SIGNATURES differ from the 3-vec4 era on
// purpose — any stale call site fails at graph-build time, not silently) ──

export const packGICore = Fn( ( [ r ] ) => vec4( r.wSum, r.W, r.M, r.pHatOwn ) );
export const packGISample = Fn( ( [ r ] ) => vec4( r.x1x, r.x1y, r.x1z, r.n1packed ) );
export const packGIRadiA = Fn( ( [ r ] ) => vec4( r.AR, r.AG, r.AB, r.validFlip ) );
export const packGISuffix = Fn( ( [ r ] ) => vec4( r.BR, r.BG, r.BB, r.om1x ) );
export const packGIRecon = Fn( ( [ r ] ) => vec4( r.matIdx1, r.uv1x, r.uv1y, r.om1y ) );
export const packGIEmissive = Fn( ( [ r ] ) => vec4( r.LeR, r.LeG, r.LeB, r.triIdx1 ) );
export const packGIPrefix = Fn( ( [ r ] ) => vec4( r.seedLo, r.seedHi, r.kPrefix, r.prefixPHatCache ) );

export const unpackGIReservoir = Fn( ( [ core, sample, radiA, suffix, recon, emis, prefix ] ) => {

	return GIReservoir( {
		wSum: core.x, W: core.y, M: core.z, pHatOwn: core.w,
		x1x: sample.x, x1y: sample.y, x1z: sample.z, n1packed: sample.w,
		AR: radiA.x, AG: radiA.y, AB: radiA.z, validFlip: radiA.w,
		BR: suffix.x, BG: suffix.y, BB: suffix.z, om1x: suffix.w,
		matIdx1: recon.x, uv1x: recon.y, uv1y: recon.z, om1y: recon.w,
		LeR: emis.x, LeG: emis.y, LeB: emis.z, triIdx1: emis.w,
		seedLo: prefix.x, seedHi: prefix.y, kPrefix: prefix.z, prefixPHatCache: prefix.w,
	} );

} );

/** Write all GI_VEC4S_PER_SLOT lanes of a reservoir to the pool at baseIdx (the single write path —
 *  partial writes leave stale lanes that survive the gates). */
export const writeGIReservoir = ( pool, baseIdx, r ) => {

	pool.element( baseIdx ).assign( packGICore( r ) );
	pool.element( baseIdx.add( int( 1 ) ) ).assign( packGISample( r ) );
	pool.element( baseIdx.add( int( 2 ) ) ).assign( packGIRadiA( r ) );
	pool.element( baseIdx.add( int( 3 ) ) ).assign( packGISuffix( r ) );
	pool.element( baseIdx.add( int( 4 ) ) ).assign( packGIRecon( r ) );
	pool.element( baseIdx.add( int( 5 ) ) ).assign( packGIEmissive( r ) );
	pool.element( baseIdx.add( int( 6 ) ) ).assign( packGIPrefix( r ) );

};

/** Read all lanes of a reservoir (returns the raw Fn result — callers GIReservoir.wrap it). */
export const readGIReservoir = ( pool, baseIdx ) => {

	return unpackGIReservoir(
		pool.element( baseIdx ),
		pool.element( baseIdx.add( int( 1 ) ) ),
		pool.element( baseIdx.add( int( 2 ) ) ),
		pool.element( baseIdx.add( int( 3 ) ) ),
		pool.element( baseIdx.add( int( 4 ) ) ),
		pool.element( baseIdx.add( int( 5 ) ) ),
		pool.element( baseIdx.add( int( 6 ) ) ),
	);

};

// convenience accessors
export const giX1 = Fn( ( [ r ] ) => vec3( r.x1x, r.x1y, r.x1z ) );
export const giA = Fn( ( [ r ] ) => vec3( r.AR, r.AG, r.AB ) );
export const giB = Fn( ( [ r ] ) => vec3( r.BR, r.BG, r.BB ) );
export const giLe = Fn( ( [ r ] ) => vec3( r.LeR, r.LeG, r.LeB ) );
export const giN1 = Fn( ( [ r ] ) => octDecodeNormal( r.n1packed ) );
export const giOm1 = Fn( ( [ r ] ) => octDecodeDir2( vec2( r.om1x, r.om1y ) ) );
// validFlip codec: {0 invalid; 1 front; 3 back; 5 front-nonreusable; 7 back-nonreusable} = 1 + 2·flip
// + 4·nonReusable. Validity tests use ≥ GI_VALID (all odd values pass); the flip decode is mod-4 (a bare
// >2 test would misread 5/7 as back-face — the PT-3 codec footgun).
export const giIsValid = Fn( ( [ r ] ) => r.validFlip.greaterThanEqual( float( GI_VALID ) ) );
export const giFlipBit = Fn( ( [ r ] ) => r.validFlip.mod( 4.0 ).greaterThan( float( 2.0 ) ) );
export const giIsReusable = Fn( ( [ r ] ) => r.validFlip.greaterThanEqual( float( GI_VALID ) ).and( r.validFlip.lessThan( float( 4.0 ) ) ) );
// PT-3b/3c-2: nonReusable (the x1-anchored glossy FALLBACK — glossy x0 whose walk found no deferred
// anchor, kOut ≤ 1; proper k>1 anchors shift via the replay and ARE reusable) is an always-fail shift
// T(y)=⊥: the reuse kernels zero this sample's FOREIGN-domain targets in the w-arms AND the
// m-denominators (target-0 at the call sites — fold-skipping would be realization-dependent
// arm selection, the valid→M bug class).
export const makeValidFlip = Fn( ( [ flipped, nonReusable ] ) =>
	float( 1.0 ).add( select( flipped, float( 2.0 ), float( 0.0 ) ) ).add( select( nonReusable, float( 4.0 ), float( 0.0 ) ) ) );

// Base storage-buffer element index for (pixel, slot). Each GI slot = GI_VEC4S_PER_SLOT(6) vec4s.
// Stride derived from the layout constants so it can NEVER drift out of lockstep with the pool allocation.
export const reservoirSlotIndexGI = Fn( ( [ pixelX, pixelY, width, slotBit ] ) => {

	const pixelIdx = pixelY.mul( width ).add( pixelX );
	return pixelIdx.mul( int( GI_SLOT_STRIDE ) ).add( slotBit.mul( int( GI_VEC4S_PER_SLOT ) ) );

} );

// PT-2b: the GI primaryHit buffer ping-pongs (GI_PRIMARY_HIT_SLOTS=2). parity = frameParityUniform for
// the CURRENT frame's capture, parity^1 for the previous frame's (the true x0_prev gi-temporal needs).
export const giPrimaryHitIndex = Fn( ( [ pixelIdx, parity ] ) => {

	return pixelIdx.mul( int( GI_PRIMARY_HIT_SLOTS ) ).add( parity );

} );

// ── the reconnection Jacobian (the bias trap, §5) ──
// At the shared vertex x1, for a sample mapped from source prefix xSrc to target prefix xTgt:
//   |J_{src→tgt}| = ( cosθ_x1^tgt / cosθ_x1^src ) · ( d_src² / d_tgt² )
// Reciprocal under role swap; equals 1 when xSrc==xTgt. abs(dot) ⇒ flip-blind (n1's stored orientation
// is irrelevant here). cos floored 1e-4, d² floored 1e-8 (clamp the INPUTS, never J itself).
export const giReconnectionJacobian = Fn( ( [ x1, n1, xTgt, xSrc ] ) => {

	const toTgt = xTgt.sub( x1 );
	const toSrc = xSrc.sub( x1 );
	const dTgt2 = max( dot( toTgt, toTgt ), float( 1e-8 ) );
	const dSrc2 = max( dot( toSrc, toSrc ), float( 1e-8 ) );
	const cosTgt = max( abs( dot( n1, normalize( toTgt ) ) ), float( 1e-4 ) );
	const cosSrc = max( abs( dot( n1, normalize( toSrc ) ) ), float( 1e-4 ) );
	return cosTgt.div( cosSrc ).mul( dSrc2.div( dTgt2 ) );

} );

/** Cap M (history confidence): r.M ≤ maxM. Returns a NEW reservoir. */
export const giReservoirCapM = Fn( ( [ r, maxM ] ) => {

	return GIReservoir( {
		wSum: r.wSum, W: r.W, M: r.M.greaterThan( maxM ).select( maxM, r.M ), pHatOwn: r.pHatOwn,
		x1x: r.x1x, x1y: r.x1y, x1z: r.x1z, n1packed: r.n1packed,
		AR: r.AR, AG: r.AG, AB: r.AB, validFlip: r.validFlip,
		BR: r.BR, BG: r.BG, BB: r.BB, om1x: r.om1x,
		matIdx1: r.matIdx1, uv1x: r.uv1x, uv1y: r.uv1y, om1y: r.om1y,
		LeR: r.LeR, LeG: r.LeG, LeB: r.LeB, triIdx1: r.triIdx1,
		seedLo: r.seedLo, seedHi: r.seedHi, kPrefix: r.kPrefix, prefixPHatCache: r.prefixPHatCache,
	} );

} );

/**
 * RIS candidate update (streaming WRS) for gi-initial. The candidate's SAMPLE-side fields are carried
 * in a GIReservoir-shaped `cand` (its core lanes are ignored). `adoptRand` is drawn by the CALLER in
 * KERNEL scope (a RandomValue on a Fn param is frozen at the call snapshot — correlated with the
 * sample's own draws; the measured WRS-adoption correlation). Returns a NEW reservoir.
 */
export const giReservoirUpdate = Fn( ( [ r, cand, candidateWeight, candPHat, adoptRand ] ) => {

	const newWSum = r.wSum.add( candidateWeight );
	const newM = r.M.add( 1.0 );

	const take = newWSum.mul( adoptRand ).lessThan( candidateWeight );

	return GIReservoir( {
		wSum: newWSum,
		W: r.W,
		M: newM,
		pHatOwn: take.select( candPHat, r.pHatOwn ),
		x1x: take.select( cand.x1x, r.x1x ),
		x1y: take.select( cand.x1y, r.x1y ),
		x1z: take.select( cand.x1z, r.x1z ),
		n1packed: take.select( cand.n1packed, r.n1packed ),
		AR: take.select( cand.AR, r.AR ),
		AG: take.select( cand.AG, r.AG ),
		AB: take.select( cand.AB, r.AB ),
		validFlip: take.select( cand.validFlip, r.validFlip ),
		BR: take.select( cand.BR, r.BR ),
		BG: take.select( cand.BG, r.BG ),
		BB: take.select( cand.BB, r.BB ),
		om1x: take.select( cand.om1x, r.om1x ),
		matIdx1: take.select( cand.matIdx1, r.matIdx1 ),
		uv1x: take.select( cand.uv1x, r.uv1x ),
		uv1y: take.select( cand.uv1y, r.uv1y ),
		om1y: take.select( cand.om1y, r.om1y ),
		LeR: take.select( cand.LeR, r.LeR ),
		LeG: take.select( cand.LeG, r.LeG ),
		LeB: take.select( cand.LeB, r.LeB ),
		triIdx1: take.select( cand.triIdx1, r.triIdx1 ),
		seedLo: take.select( cand.seedLo, r.seedLo ),
		seedHi: take.select( cand.seedHi, r.seedHi ),
		kPrefix: take.select( cand.kPrefix, r.kPrefix ),
		prefixPHatCache: take.select( cand.prefixPHatCache, r.prefixPHatCache ),
	} );

} );

/**
 * Finalize the canonical RIS reservoir: W = wSum / (M · p̂(chosen)). Returns a NEW reservoir.
 */
export const giReservoirFinalizeInitial = Fn( ( [ r, pHatChosen ] ) => {

	const denom = r.M.mul( pHatChosen );
	const finalW = float( 0.0 ).toVar();
	If( denom.greaterThan( float( 1e-10 ) ), () => {

		finalW.assign( r.wSum.div( denom ) );

	} );

	return GIReservoir( {
		wSum: r.wSum, W: finalW, M: r.M, pHatOwn: r.pHatOwn,
		x1x: r.x1x, x1y: r.x1y, x1z: r.x1z, n1packed: r.n1packed,
		AR: r.AR, AG: r.AG, AB: r.AB, validFlip: r.validFlip,
		BR: r.BR, BG: r.BG, BB: r.BB, om1x: r.om1x,
		matIdx1: r.matIdx1, uv1x: r.uv1x, uv1y: r.uv1y, om1y: r.om1y,
		LeR: r.LeR, LeG: r.LeG, LeB: r.LeB, triIdx1: r.triIdx1,
		seedLo: r.seedLo, seedHi: r.seedHi, kPrefix: r.kPrefix, prefixPHatCache: r.prefixPHatCache,
	} );

} );

/**
 * UNBIASED cross-evaluated GRIS combine for ReSTIR GI/PT reuse (temporal AND spatial — Lin 2022 Eq.11).
 * Caller supplies the FOUR cross-targets (recomputed FRESH through the shared PT-2 evalLo at the stored
 * representation — NEVER stored pHatOwn) and the TWO Jacobians (at DIFFERENT samples ⇒ NOT reciprocals).
 * Setting jacC=jacS=1 reduces EXACTLY to the DI J=1 degenerate. Returns a NEW reservoir;
 * W = wSum/p̂_q(survivor) (Eq.8, NO M).
 */
export const reservoirCombineGIShifted = Fn( ( [
	canonical, shifted,
	pHatCanonAtQ, pHatCanonAtQprime, pHatShiftAtQ, pHatShiftAtQprime,
	jacC, jacS, adoptRand,
] ) => {

	const cC = canonical.M;
	const cS = shifted.M;

	// mᵢ(yᵢ) = cᵢ·p̂ᵢ(yᵢ) / Σⱼ cⱼ·p̂ⱼ(yᵢ)·|Jⱼ→domain(yᵢ)|, each p̂ⱼ = reservoir j's OWN-domain target at yᵢ.
	const denomC = cC.mul( pHatCanonAtQ ).add( cS.mul( pHatCanonAtQprime ).mul( jacC ) );
	const denomS = cS.mul( pHatShiftAtQprime ).add( cC.mul( pHatShiftAtQ ).mul( jacS ) );
	const mC = float( 0.0 ).toVar();
	If( denomC.greaterThan( float( 1e-10 ) ), () => {

		mC.assign( cC.mul( pHatCanonAtQ ).div( denomC ) );

	} );
	const mS = float( 0.0 ).toVar();
	If( denomS.greaterThan( float( 1e-10 ) ), () => {

		mS.assign( cS.mul( pHatShiftAtQprime ).div( denomS ) );

	} );

	// wᵢ = mᵢ · p̂_q(yᵢ) · Wᵢ · |J| — target at the integration domain q (my pixel); shifted arm carries |J_S|.
	const wC = canonical.W.mul( pHatCanonAtQ ).mul( mC );
	const wS = shifted.W.mul( pHatShiftAtQ ).mul( mS ).mul( jacS );
	const newWSum = wC.add( wS );

	// adoptRand drawn by the CALLER in kernel scope (frozen-Fn-param correlation fix)
	const takeS = newWSum.mul( adoptRand ).lessThan( wS );

	const survivorPHat = takeS.select( pHatShiftAtQ, pHatCanonAtQ );
	const newW = float( 0.0 ).toVar();
	If( survivorPHat.greaterThan( float( 1e-10 ) ), () => {

		newW.assign( newWSum.div( survivorPHat ) ); // Eq.8: W = wSum / p̂_q(survivor) — NO M

	} );

	return GIReservoir( {
		wSum: newWSum,
		W: newW,
		M: cC.add( cS ),
		pHatOwn: takeS.select( shifted.pHatOwn, canonical.pHatOwn ),
		x1x: takeS.select( shifted.x1x, canonical.x1x ),
		x1y: takeS.select( shifted.x1y, canonical.x1y ),
		x1z: takeS.select( shifted.x1z, canonical.x1z ),
		n1packed: takeS.select( shifted.n1packed, canonical.n1packed ),
		AR: takeS.select( shifted.AR, canonical.AR ),
		AG: takeS.select( shifted.AG, canonical.AG ),
		AB: takeS.select( shifted.AB, canonical.AB ),
		validFlip: takeS.select( shifted.validFlip, canonical.validFlip ),
		BR: takeS.select( shifted.BR, canonical.BR ),
		BG: takeS.select( shifted.BG, canonical.BG ),
		BB: takeS.select( shifted.BB, canonical.BB ),
		om1x: takeS.select( shifted.om1x, canonical.om1x ),
		matIdx1: takeS.select( shifted.matIdx1, canonical.matIdx1 ),
		uv1x: takeS.select( shifted.uv1x, canonical.uv1x ),
		uv1y: takeS.select( shifted.uv1y, canonical.uv1y ),
		om1y: takeS.select( shifted.om1y, canonical.om1y ),
		LeR: takeS.select( shifted.LeR, canonical.LeR ),
		LeG: takeS.select( shifted.LeG, canonical.LeG ),
		LeB: takeS.select( shifted.LeB, canonical.LeB ),
		triIdx1: takeS.select( shifted.triIdx1, canonical.triIdx1 ),
		seedLo: takeS.select( shifted.seedLo, canonical.seedLo ),
		seedHi: takeS.select( shifted.seedHi, canonical.seedHi ),
		kPrefix: takeS.select( shifted.kPrefix, canonical.kPrefix ),
		prefixPHatCache: takeS.select( shifted.prefixPHatCache, canonical.prefixPHatCache ),
	} );

} );
