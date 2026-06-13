/**
 * ReSTIR GI Phase-2 step-1 guards (docs/specs/restir-gi-phase02.md §2, §5, §8.1):
 *   1. STRIDE PARITY — the documented corruption footgun: the per-pixel slot stride MUST equal
 *      vec4sPerSlot × SLOTS_PER_PIXEL, in lockstep with the pool allocation. We import the EXACT shipping
 *      constants from ReSTIRLayout.js (pure JS — the pool/core can't load under node) so this pins the
 *      real values, not a re-typed copy.
 *   2. OCT NORMAL round-trip — 12-bit/axis octahedral pack into one f32 lane (exact integer base-4096).
 *   3. RECONNECTION JACOBIAN — reciprocity + identity (§5: the bias trap).
 *
 * Pure JS — no TSL/GPU import. The oct + Jacobian + slot-index helpers below are LITERAL TRANSCRIPTIONS of
 * the TSL in ReSTIRGICore.js and MUST be kept in lockstep with it (same pattern as restirMIS.test.js).
 */

import { describe, it, expect } from 'vitest';
import {
	SLOTS_PER_PIXEL,
	DI_VEC4S_PER_SLOT, GI_VEC4S_PER_SLOT,
	DI_SLOT_STRIDE, GI_SLOT_STRIDE,
} from '../../../rayzee/src/Processor/ReSTIRLayout.js';

// ── JS mirrors of ReSTIRGICore.js (keep textually faithful) ──

// reservoirSlotIndexGI
function slotIndexGI( pixelX, pixelY, width, slotBit ) {

	const pixelIdx = pixelY * width + pixelX;
	return pixelIdx * GI_SLOT_STRIDE + slotBit * GI_VEC4S_PER_SLOT;

}

const NORM_QUANT = 4095.0;
const NORM_BASE = 4096.0;
const signNotZero = x => ( x < 0 ? - 1.0 : 1.0 );

function octEncodeUnit( n ) { // vec3 → [-1,1]^2

	const l1 = Math.max( Math.abs( n[ 0 ] ) + Math.abs( n[ 1 ] ) + Math.abs( n[ 2 ] ), 1e-8 );
	let px = n[ 0 ] / l1, py = n[ 1 ] / l1;
	if ( n[ 2 ] < 0 ) {

		const fx = ( 1 - Math.abs( py ) ) * signNotZero( px );
		const fy = ( 1 - Math.abs( px ) ) * signNotZero( py );
		px = fx; py = fy;

	}

	return [ px, py ];

}

function octDecodeUnit( f ) { // [-1,1]^2 → unit vec3

	const nz = 1 - Math.abs( f[ 0 ] ) - Math.abs( f[ 1 ] );
	let nx = f[ 0 ], ny = f[ 1 ];
	if ( nz < 0 ) {

		nx = ( 1 - Math.abs( f[ 1 ] ) ) * signNotZero( f[ 0 ] );
		ny = ( 1 - Math.abs( f[ 0 ] ) ) * signNotZero( f[ 1 ] );

	}

	const len = Math.hypot( nx, ny, nz );
	return [ nx / len, ny / len, nz / len ];

}

function octEncodeNormal( n ) { // unit vec3 → single f32 (Math.fround to model GPU f32)

	const o = octEncodeUnit( n );
	const ux = Math.min( Math.max( o[ 0 ] * 0.5 + 0.5, 0 ), 1 );
	const uy = Math.min( Math.max( o[ 1 ] * 0.5 + 0.5, 0 ), 1 );
	const qx = Math.floor( ux * NORM_QUANT + 0.5 );
	const qy = Math.floor( uy * NORM_QUANT + 0.5 );
	return Math.fround( qx * NORM_BASE + qy );

}

function octDecodeNormal( e ) {

	const qy = e % NORM_BASE;
	const qx = Math.floor( e / NORM_BASE );
	const ux = qx / NORM_QUANT, uy = qy / NORM_QUANT;
	return octDecodeUnit( [ ux * 2 - 1, uy * 2 - 1 ] );

}

// giReconnectionJacobian: |J_{src→tgt}| = (cosTgt/cosSrc)·(dSrc²/dTgt²)
function jacobian( x1, n1, xTgt, xSrc ) {

	const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
	const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
	const norm = a => {

		const l = Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] ); return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ];

	};

	const toTgt = sub( xTgt, x1 ), toSrc = sub( xSrc, x1 );
	const dTgt2 = Math.max( dot( toTgt, toTgt ), 1e-8 );
	const dSrc2 = Math.max( dot( toSrc, toSrc ), 1e-8 );
	const cosTgt = Math.max( Math.abs( dot( n1, norm( toTgt ) ) ), 1e-4 );
	const cosSrc = Math.max( Math.abs( dot( n1, norm( toSrc ) ) ), 1e-4 );
	return ( cosTgt / cosSrc ) * ( dSrc2 / dTgt2 );

}

const normalize3 = a => {

	const l = Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] ); return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ];

};

describe( 'ReSTIR GI Phase-2 §2 — slot stride parity (the corruption footgun)', () => {

	it( 'shipping constants are the expected layout', () => {

		expect( SLOTS_PER_PIXEL ).toBe( 3 );
		expect( DI_VEC4S_PER_SLOT ).toBe( 2 );
		// PT-3a: 7 vec4 = core + sample + radiA + suffix + recon + emissive + prefix(seed/k)
		expect( GI_VEC4S_PER_SLOT ).toBe( 7 );

	} );

	it( 'slot stride EQUALS vec4sPerSlot × SLOTS_PER_PIXEL (DI=6, GI=21) — the lockstep invariant', () => {

		expect( DI_SLOT_STRIDE ).toBe( DI_VEC4S_PER_SLOT * SLOTS_PER_PIXEL );
		expect( GI_SLOT_STRIDE ).toBe( GI_VEC4S_PER_SLOT * SLOTS_PER_PIXEL );
		expect( DI_SLOT_STRIDE ).toBe( 6 );
		expect( GI_SLOT_STRIDE ).toBe( 21 );

	} );

	it( 'reservoirSlotIndexGI: each pixel owns GI_SLOT_STRIDE vec4s; slots are non-overlapping & in-range', () => {

		const W = 1920;
		for ( const [ px, py ] of [[ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1919, 1079 ], [ 960, 540 ]] ) {

			const pixelIdx = py * W + px;
			const slot0 = slotIndexGI( px, py, W, 0 );
			const slot1 = slotIndexGI( px, py, W, 1 );
			const slot2 = slotIndexGI( px, py, W, 2 );

			expect( slot0 ).toBe( pixelIdx * 21 );
			expect( slot1 ).toBe( pixelIdx * 21 + 7 );
			expect( slot2 ).toBe( pixelIdx * 21 + 14 );

			// slot 2's seven vec4s stay inside this pixel's [base, base+21)
			expect( slot2 + ( GI_VEC4S_PER_SLOT - 1 ) ).toBeLessThan( ( pixelIdx + 1 ) * GI_SLOT_STRIDE );

		}

	} );

	it( 'adjacent pixels do not overlap', () => {

		const W = 1920;
		const aEnd = slotIndexGI( 0, 0, W, SLOTS_PER_PIXEL - 1 ) + ( GI_VEC4S_PER_SLOT - 1 );
		const bStart = slotIndexGI( 1, 0, W, 0 );
		expect( bStart ).toBeGreaterThan( aEnd );

	} );

} );

describe( 'ReSTIR GI Phase-2 §2 — octahedral normal pack/unpack (one f32 lane, 12-bit/axis)', () => {

	it( 'encoded value is an integer in [0, 2^24) (exact in f32)', () => {

		for ( const n of [[ 1, 0, 0 ], [ 0, 0, - 1 ], normalize3( [ 0.3, - 0.6, 0.74 ] ) ] ) {

			const e = octEncodeNormal( n );
			expect( Number.isInteger( e ) ).toBe( true );
			expect( e ).toBeGreaterThanOrEqual( 0 );
			expect( e ).toBeLessThan( 2 ** 24 );

		}

	} );

	it( 'round-trips a battery of normals to < 0.0001 cosine error', () => {

		const normals = [
			[ 1, 0, 0 ], [ - 1, 0, 0 ], [ 0, 1, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, - 1 ],
			normalize3( [ 1, 1, 1 ] ), normalize3( [ - 1, 1, 1 ] ), normalize3( [ 1, - 1, 1 ] ),
			normalize3( [ 1, 1, - 1 ] ), normalize3( [ - 1, - 1, - 1 ] ),
		];
		// deterministic spread of off-axis directions
		for ( let i = 0; i < 200; i ++ ) {

			const a = ( i * 2.39996 ); // golden-angle-ish, deterministic
			const z = ( i / 199 ) * 2 - 1;
			const r = Math.sqrt( Math.max( 0, 1 - z * z ) );
			normals.push( [ r * Math.cos( a ), r * Math.sin( a ), z ] );

		}

		let worst = 1;
		for ( const n of normals ) {

			const d = octDecodeNormal( octEncodeNormal( n ) );
			const cos = n[ 0 ] * d[ 0 ] + n[ 1 ] * d[ 1 ] + n[ 2 ] * d[ 2 ];
			worst = Math.min( worst, cos );

		}

		expect( worst ).toBeGreaterThan( 0.9999 );

	} );

} );

describe( 'ReSTIR GI Phase-2 §5 — reconnection Jacobian (the bias trap)', () => {

	const x1 = [ 0, 0, 0 ];
	const n1 = normalize3( [ 0.2, 0.3, 1.0 ] );
	const q = [ 1.0, 0.5, 2.0 ]; // my prefix x0_q
	const r = [ - 0.7, 1.2, 1.5 ]; // source prefix x0_r

	it( 'identity: J(a,a) = 1', () => {

		expect( jacobian( x1, n1, q, q ) ).toBeCloseTo( 1, 10 );

	} );

	it( 'reciprocity: J(tgt←src) · J(src←tgt) = 1 (same sample, forward/back maps reciprocal)', () => {

		const fwd = jacobian( x1, n1, q, r );
		const bwd = jacobian( x1, n1, r, q );
		expect( fwd * bwd ).toBeCloseTo( 1, 10 );

	} );

	it( 'pure distance change (collinear from x1) gives the d² ratio, cos ratio = 1', () => {

		// both prefixes along the SAME ray from x1 → cosθ identical → J = d_src²/d_tgt²
		const dir = normalize3( [ 0.2, 0.3, 1.0 ] );
		const tgt = [ dir[ 0 ] * 2, dir[ 1 ] * 2, dir[ 2 ] * 2 ]; // d_tgt = 2
		const src = [ dir[ 0 ] * 5, dir[ 1 ] * 5, dir[ 2 ] * 5 ]; // d_src = 5
		expect( jacobian( x1, n1, tgt, src ) ).toBeCloseTo( ( 5 * 5 ) / ( 2 * 2 ), 6 );

	} );

} );

// ── node-graph build smoke test (three/tsl loads under node — pure graph construction, no GPU) ──
// Catches the class of bug the pure-JS mirrors above CANNOT: a wrong/nonexistent TSL API in ReSTIRGICore.js.
// If a Fn uses an invalid node method, importing/exercising it throws at graph-build time → this fails.
describe( 'ReSTIR GI Phase-2 §2/§5 — TSL Fns build valid node graphs', () => {

	it( 'every exported GI Fn constructs without error (PT-2 6-vec4 layout)', async () => {

		const tsl = await import( 'three/tsl' );
		const gi = await import( '../../../rayzee/src/TSL/ReSTIRGICore.js' );
		const { vec2, vec3, float, int, uint } = tsl;

		const r = gi.emptyGIReservoir();
		const core = gi.packGICore( r );
		const sample = gi.packGISample( r );
		const radiA = gi.packGIRadiA( r );
		const suffix = gi.packGISuffix( r );
		const recon = gi.packGIRecon( r );
		const emis = gi.packGIEmissive( r );
		const prefix = gi.packGIPrefix( r );
		const r2 = gi.GIReservoir.wrap( gi.unpackGIReservoir( core, sample, radiA, suffix, recon, emis, prefix ) );
		const cand = gi.GIReservoir.wrap( gi.emptyGIReservoir() );

		const built = [
			r, core, sample, radiA, suffix, recon, emis, prefix, r2,
			gi.giX1( r2 ), gi.giA( r2 ), gi.giB( r2 ), gi.giLe( r2 ), gi.giN1( r2 ), gi.giOm1( r2 ),
			gi.giIsValid( r2 ), gi.giFlipBit( r2 ), gi.giIsReusable( r2 ),
			gi.makeValidFlip( float( 1 ).greaterThan( 0 ), float( 0 ).greaterThan( 1 ) ),
			gi.octEncodeNormal( vec3( 0, 0, 1 ) ),
			gi.octDecodeNormal( float( 12345 ) ),
			gi.octEncodeDir2( vec3( 0, 1, 0 ) ),
			gi.octDecodeDir2( vec2( 0.5, - 0.25 ) ),
			gi.giReconnectionJacobian( vec3( 0, 0, 0 ), vec3( 0, 0, 1 ), vec3( 1, 0, 1 ), vec3( 0, 1, 1 ) ),
			gi.reservoirSlotIndexGI( int( 1 ), int( 2 ), int( 100 ), int( 2 ) ),
			gi.giReservoirCapM( r, float( 20 ) ),
			gi.GIReservoir.wrap( gi.giReservoirUpdate(
				r, cand, float( 0.1 ), float( 0.2 ), float( 0.4 ),
			) ),
			gi.GIReservoir.wrap( gi.giReservoirFinalizeInitial( r, float( 0.5 ) ) ),
			gi.GIReservoir.wrap( gi.reservoirCombineGIShifted(
				r, r2, float( 0.8 ), float( 0.3 ), float( 0.5 ), float( 0.9 ), float( 1.2 ), float( 0.7 ), float( 0.6 ),
			) ),
		];

		for ( const node of built ) expect( node ).toBeTruthy();

	} );

	it( 'PT-2 field-roundtrip: every reservoir-constructing Fn carries all 24 lanes (forgotten-select tripwire)', async () => {

		const tsl = await import( 'three/tsl' );
		const gi = await import( '../../../rayzee/src/TSL/ReSTIRGICore.js' );
		const { float, uint } = tsl;

		const FIELDS = [
			'wSum', 'W', 'M', 'pHatOwn',
			'x1x', 'x1y', 'x1z', 'n1packed',
			'AR', 'AG', 'AB', 'validFlip',
			'BR', 'BG', 'BB', 'om1x',
			'matIdx1', 'uv1x', 'uv1y', 'om1y',
			'LeR', 'LeG', 'LeB', 'triIdx1',
			'seedLo', 'seedHi', 'kPrefix', 'prefixPHatCache',
		];
		// distinct sentinel per lane
		const sentinel = Object.fromEntries( FIELDS.map( ( f, i ) => [ f, float( 100 + i ) ] ) );
		const r = gi.GIReservoir.wrap( gi.GIReservoir( sentinel ) );

		// pack → unpack must reference every lane (a dropped lane shows as an undefined field node)
		const r2 = gi.GIReservoir.wrap( gi.unpackGIReservoir(
			gi.packGICore( r ), gi.packGISample( r ), gi.packGIRadiA( r ),
			gi.packGISuffix( r ), gi.packGIRecon( r ), gi.packGIEmissive( r ), gi.packGIPrefix( r ),
		) );
		for ( const f of FIELDS ) expect( r2[ f ] ).toBeTruthy();

		// every reservoir-returning Fn must produce all lanes (adoption rand now hoisted to the caller)
		for ( const out of [
			gi.GIReservoir.wrap( gi.giReservoirCapM( r, float( 20 ) ) ),
			gi.GIReservoir.wrap( gi.giReservoirUpdate( r, r2, float( 0.1 ), float( 0.2 ), float( 0.4 ) ) ),
			gi.GIReservoir.wrap( gi.giReservoirFinalizeInitial( r, float( 0.5 ) ) ),
			gi.GIReservoir.wrap( gi.reservoirCombineGIShifted(
				r, r2, float( 0.8 ), float( 0.3 ), float( 0.5 ), float( 0.9 ), float( 1 ), float( 1 ), float( 0.6 ),
			) ),
		] ) {

			for ( const f of FIELDS ) expect( out[ f ] ).toBeTruthy();

		}

	} );

	it( 'PT walker module: PTWalkResult struct (PT-2 split payload + PT-3c anchor lanes) + flags construct without error', async () => {

		const tsl = await import( 'three/tsl' );
		const pt = await import( '../../../rayzee/src/TSL/ReSTIRPTWalk.js' );
		const { vec2, vec3, float } = tsl;

		// makeSuffixWalker needs live scene buffers (kernel-class TSL) — the GPU build smoke covers it; here
		// we pin the module imports + the result-struct shape the kernels unpack.
		expect( typeof pt.makeSuffixWalker ).toBe( 'function' );
		expect( pt.PT_WALK_INVALID ).toBe( 0.0 );
		expect( pt.PT_WALK_SURFACE ).toBe( 1.0 );
		expect( pt.PT_WALK_ENV ).toBe( 2.0 );
		// PT-3c anchor-pair gates — exported so the replay tests THE SAME values (stratum lockstep)
		expect( pt.RESTIR_PT_TAU1 ).toBe( 0.1 );
		expect( pt.RESTIR_PT_DMIN ).toBe( 0.05 );
		const res = pt.PTWalkResult( {
			x1: vec3( 1, 2, 3 ), n1: vec3( 0, 0, 1 ), flip: float( 0 ),
			A: vec3( 0.5 ), B: vec3( 0.25 ), om1: vec2( 0.1, 0.2 ),
			matIdx1: float( 3 ), uv1: vec2( 0.3, 0.4 ),
			Le: vec3( 0 ), triIdx1: float( 0 ), flags: float( 1 ),
			prefixRad: vec3( 0.1 ), kOut: float( 2 ), pAnchor: float( 0.5 ),
		} );
		expect( res ).toBeTruthy();
		const wrapped = pt.PTWalkResult.wrap( res );
		for ( const f of [
			'x1', 'n1', 'flip', 'A', 'B', 'om1', 'matIdx1', 'uv1', 'Le', 'triIdx1', 'flags',
			'prefixRad', 'kOut', 'pAnchor',
		] ) {

			expect( wrapped[ f ] ).toBeTruthy();

		}

	} );

	it( 'PT-3c replay module: GIReplayResult struct constructs without error (shared k-selection consts)', async () => {

		const tsl = await import( 'three/tsl' );
		const rp = await import( '../../../rayzee/src/TSL/ReSTIRGIReplay.js' );
		const { vec2, vec3, float } = tsl;

		// makeGIPrefixReplay needs live scene buffers (kernel-class TSL) — the GPU build smoke covers it;
		// here we pin the module imports + the result-struct shape gi-initial/resolve unpack.
		expect( typeof rp.makeGIPrefixReplay ).toBe( 'function' );
		const res = rp.GIReplayResult( {
			valid: float( 1 ), prefixFactor: vec3( 0.5 ),
			xPrev: vec3( 1, 2, 3 ), nPrev: vec3( 0, 0, 1 ), vPrev: vec3( 0, 1, 0 ),
			nGeoPrev: vec3( 0, 0, 1 ), matIdxPrev: float( 2 ), uvPrev: vec2( 0.1, 0.2 ),
		} );
		expect( res ).toBeTruthy();
		const wrapped = rp.GIReplayResult.wrap( res );
		for ( const f of [
			'valid', 'prefixFactor', 'xPrev', 'nPrev', 'vPrev', 'nGeoPrev', 'matIdxPrev', 'uvPrev',
		] ) {

			expect( wrapped[ f ] ).toBeTruthy();

		}

	} );

} );

// ── reservoirCombineGIShifted math (JS mirror, §4.2) ──
// MUST mirror ReSTIRGICore.reservoirCombineGIShifted. Verifies the J=1 reduction to the validated DI spatial
// combine AND that the Jacobian appears in BOTH the MIS denominators (cross-terms) and the shifted weight wS.
describe( 'ReSTIR GI Phase-2 §4.2 — cross-evaluated GRIS combine + Jacobian placement', () => {

	// deterministic-weights mirror (everything except the stochastic survivor selection)
	function combineWeights( cC, cS, WC, WS, pCq, pCqp, pSq, pSqp, jacC, jacS ) {

		const denomC = cC * pCq + cS * pCqp * jacC;
		const denomS = cS * pSqp + cC * pSq * jacS;
		const mC = denomC > 1e-10 ? ( cC * pCq ) / denomC : 0;
		const mS = denomS > 1e-10 ? ( cS * pSqp ) / denomS : 0;
		const wC = WC * pCq * mC;
		const wS = WS * pSq * mS * jacS;
		return { denomC, denomS, mC, mS, wC, wS, newWSum: wC + wS };

	}

	// DI reservoirCombineSpatialUnbiased weights (the J=1 target form)
	function diSpatialWeights( cC, cN, WC, WN, pCq, pCqp, pNq, pNqp ) {

		const denomC = cC * pCq + cN * pCqp;
		const denomN = cN * pNqp + cC * pNq;
		const mC = ( cC * pCq ) / denomC;
		const mN = ( cN * pNqp ) / denomN;
		return { denomC, denomN, mC, mN, wC: WC * pCq * mC, wN: WN * pNq * mN, newWSum: WC * pCq * mC + WN * pNq * mN };

	}

	it( 'jacC=jacS=1 reduces EXACTLY to the DI spatial combine (the validated J=1 degenerate)', () => {

		const a = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9, 1, 1 );
		const b = diSpatialWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9 );
		for ( const k of [ 'denomC', 'mC', 'wC', 'newWSum' ] ) expect( a[ k ] ).toBeCloseTo( b[ k ], 12 );
		expect( a.denomS ).toBeCloseTo( b.denomN, 12 );
		expect( a.mS ).toBeCloseTo( b.mN, 12 );
		expect( a.wS ).toBeCloseTo( b.wN, 12 );

	} );

	it( 'Jacobian scales BOTH the denomC cross-term and the shifted weight wS (not the canonical own-term)', () => {

		const base = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9, 1.0, 1.0 );
		const jc = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9, 2.0, 1.0 ); // jacC ×2
		// denomC's cross-term (cS·pCqp·jacC) doubles its jacC part; the own-term (cC·pCq) is unchanged
		expect( jc.denomC - 4 * 0.8 ).toBeCloseTo( 2 * ( base.denomC - 4 * 0.8 ), 12 );
		const js = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9, 1.0, 2.0 ); // jacS ×2
		// wS carries jacS linearly (via mS's denom too, so not exactly ×2, but strictly increases); denomS cross-term scales
		expect( js.denomS - 20 * 0.9 ).toBeCloseTo( 2 * ( base.denomS - 20 * 0.9 ), 12 );
		expect( js.wS ).toBeGreaterThan( base.wS );

	} );

	it( 'partition of unity holds at the canonical sample (generalized balance, J≠1)', () => {

		// At the canonical sample y_C: m_C(y_C) + m_S→C(y_C) = 1, where m's denominator is the generalized
		// balance Σ c_k p̂_k(y_C)|J|. Here m_C uses denomC; the shifted arm's weight at y_C is cS·pCqp·jacC/denomC.
		const cC = 4, cS = 20, pCq = 0.8, pCqp = 0.3, jacC = 1.4;
		const denomC = cC * pCq + cS * pCqp * jacC;
		const mC = ( cC * pCq ) / denomC;
		const mShiftAtYC = ( cS * pCqp * jacC ) / denomC;
		expect( mC + mShiftAtYC ).toBeCloseTo( 1, 12 );

	} );

	// ── PT-4: generalized balance over hybrid-shifted arms ──
	// The combine is k-agnostic: for k>1 arms the call sites feed replay-evaluated targets and Jacobians
	// whose endpoints are the replays' terminal vertices x'_{k−1} — at this level just different scalars.
	// Mixed-k pairs therefore reduce to the asymmetric-J / target-0 cases verified here.

	it( 'PT-4: partition of unity on BOTH arms under asymmetric NON-reciprocal Jacobians (the mixed-k shape)', () => {

		const cC = 4, cS = 20, pCq = 0.8, pCqp = 0.3, pSq = 0.5, pSqp = 0.9;
		const jacC = 1.4, jacS = 0.7; // at DIFFERENT samples ⇒ deliberately NOT reciprocals
		const w = combineWeights( cC, cS, 1.1, 0.7, pCq, pCqp, pSq, pSqp, jacC, jacS );

		// at y_C: m_C(y_C) + m_{S→C}(y_C) = 1 over denomC
		expect( w.mC + ( cS * pCqp * jacC ) / w.denomC ).toBeCloseTo( 1, 12 );
		// at y_S: m_S(y_S) + m_{C→S}(y_S) = 1 over denomS
		expect( w.mS + ( cC * pSq * jacS ) / w.denomS ).toBeCloseTo( 1, 12 );
		// proper weights
		expect( w.mC ).toBeGreaterThan( 0 );
		expect( w.mC ).toBeLessThan( 1 );
		expect( w.mS ).toBeGreaterThan( 0 );
		expect( w.mS ).toBeLessThan( 1 );

	} );

	it( 'PT-4: canonical foreign-target 0 (nonReusable / replay failure, T(y_C)=⊥) degenerates ITS partition to m_C=1 without touching the other arm', () => {

		const base = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.5, 0.9, 1.4, 0.7 );
		const z = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.0, 0.5, 0.9, 1.4, 0.7 ); // pCqp = 0
		expect( z.mC ).toBe( 1 ); // only one arm can produce y_C ⇒ its m-weight is the whole partition
		expect( z.wC ).toBeCloseTo( 1.1 * 0.8, 12 ); // WC·pCq·1
		// the shifted arm's own partition references pCqp nowhere — bit-identical
		expect( z.denomS ).toBe( base.denomS );
		expect( z.mS ).toBe( base.mS );
		expect( z.wS ).toBe( base.wS );

	} );

	it( 'PT-4: shifted target 0 at the integration domain (T(y_S)=⊥ at Q) zeroes its w-arm but keeps its own partition normalized (no leak)', () => {

		const z = combineWeights( 4, 20, 1.1, 0.7, 0.8, 0.3, 0.0, 0.9, 1.4, 0.7 ); // pSq = 0
		expect( z.wS ).toBe( 0 ); // contributes nothing at the domain
		expect( z.mS ).toBe( 1 ); // denomS cross-term = cC·pSq·jacS = 0 ⇒ own-sample partition exactly normalized
		expect( z.newWSum ).toBe( z.wC );
		// survivor algebra (Eq. 8): wS=0 ⇒ canonical always survives ⇒ W = newWSum/pCq = WC·mC
		expect( z.newWSum / 0.8 ).toBeCloseTo( 1.1 * z.mC, 12 );

	} );

	// ── PT-3c-2 explosion regression: the Eq. 8 W·p̂ pairing bounds the shifted arm ──
	// wS = WS·pSq·mS·jacS with WS = wSumS/p̂_norm. IFF the own-domain target fed to mS IS p̂_norm
	// (the STORED pHatOwn), pSqp cancels: wS ≤ wSumS·cS/cC for ANY pSq/jacS. Re-evaluating it fresh
	// across frames (perturbed domain rebuild × discontinuous k>1 replay) breaks the cancellation —
	// the mb4 reuse ×10³ blow-up. The temporal kernel MUST feed shifted.pHatOwn for k>1.

	it( 'PT-3c-2: with the Eq. 8 pairing, wS ≤ wSumS·cS/cC for ANY target/Jacobian magnitudes', () => {

		const cC = 1, cS = 20, wSumS = 0.9;
		for ( const pNorm of [ 1e-9, 1e-4, 1.0, 1e3 ] ) {

			for ( const pSq of [ 1e-9, 1.0, 1e6 ] ) {

				for ( const jacS of [ 1e-6, 1.0, 1e8 ] ) {

					const WS = wSumS / pNorm;
					const w = combineWeights( cC, cS, 1.1, WS, 0.8, 0.3, pSq, pNorm, 1.0, jacS );
					expect( w.wS ).toBeLessThanOrEqual( wSumS * ( cS / cC ) * ( 1 + 1e-9 ) );
					expect( Number.isFinite( w.wS ) ).toBe( true );

				}

			}

		}

	} );

	it( 'PT-3c-2: a fresh own-domain re-eval that diverges from p̂_norm is UNBOUNDED (why stored pHatOwn is mandatory)', () => {

		// normalized against a graze (p̂_norm tiny), re-evaluated healthy (pSqp' ≫ p̂_norm) ⇒ wS explodes
		const pNorm = 1e-8, pFresh = 1.0, wSumS = 0.9, cC = 1, cS = 20;
		const WS = wSumS / pNorm;
		const broken = combineWeights( cC, cS, 1.1, WS, 0.8, 0.3, 1.0, pFresh, 1.0, 1.0 );
		expect( broken.wS ).toBeGreaterThan( 1e6 ); // the explosion
		const paired = combineWeights( cC, cS, 1.1, WS, 0.8, 0.3, 1.0, pNorm, 1.0, 1.0 );
		expect( paired.wS ).toBeLessThanOrEqual( wSumS * ( cS / cC ) * ( 1 + 1e-9 ) );

	} );

} );
