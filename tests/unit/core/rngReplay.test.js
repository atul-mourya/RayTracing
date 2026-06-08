/**
 * Phase-0 substrate (restir-di-phase01 §5.1 task 0.3): a byte-exact JS mirror of the
 * engine's PCG RNG, proving deterministic replay + decorrelation + the (pixel,subSample,frame)
 * seed contract. The future random-replay/hybrid shift (roadmap Phase 3) relies on this.
 *
 * The mirror reproduces, BYTE-FOR-BYTE, the WGSL in rayzee/src/TSL/Random.js:
 *   pcgHash (:89), wang_hash (:103), getDecorrelatedSeed (:502), RandomValue (:134),
 * and the GenerateKernel.js:65-66 seed init (stored seed = pcgHash(getDecorrelatedSeed(...))).
 *
 * NOTE: this is a CPU mirror; vitest runs in node and cannot execute TSL (GPU). The
 * golden vectors below were generated from this same mirror. The GPU↔CPU equivalence
 * probe (task 0.4, chrome-devtools) is the separate gate that proves the mirror still
 * matches the live WGSL after any Random.js / three-version change.
 */

import { describe, it, expect } from 'vitest';

// u32 arithmetic helpers (WGSL u32 semantics in JS)
const u32 = ( x ) => x >>> 0;
const mul32 = ( a, b ) => Math.imul( a, b ) >>> 0; // 32-bit wraparound multiply

function pcgHash( state ) {

	let s = u32( state );
	s = u32( mul32( s, 747796405 ) + 2891336453 );
	const shift = u32( ( s >>> 28 ) + 4 );
	s = u32( ( s >>> shift ) ^ s );
	s = mul32( s, 277803737 );
	s = u32( ( s >>> 22 ) ^ s );
	return s;

}

function wang_hash( seed ) {

	let s = u32( seed );
	s = u32( ( s ^ 61 ) ^ ( s >>> 16 ) );
	s = mul32( s, 9 );
	s = u32( s ^ ( s >>> 4 ) );
	s = mul32( s, 0x27d4eb2d );
	s = u32( s ^ ( s >>> 15 ) );
	return s;

}

// Random.js:502 — pixelCoord is vec2f; u32(pixelCoord.x) truncates gx+0.5 → gx.
function getDecorrelatedSeed( pixelCoordX, pixelCoordY, rayIndex, frame ) {

	const pixelSeed = u32(
		mul32( u32( Math.trunc( pixelCoordX ) ), 2654435761 ) +
		mul32( u32( Math.trunc( pixelCoordY ) ), 3266489917 )
	);
	const raySeed = mul32( u32( rayIndex ), 668265263 );
	const frameSeed = mul32( u32( frame ), 374761393 );
	let seed = wang_hash( pixelSeed );
	seed = pcgHash( u32( seed ^ raySeed ) );
	seed = wang_hash( u32( seed + frameSeed ) );
	return seed;

}

// GenerateKernel.js:65-66 — rayIndex passed to getDecorrelatedSeed IS subSample.
function storedSeed( px, py, subSample, frame ) {

	return pcgHash( getDecorrelatedSeed( px, py, subSample, frame ) );

}

// RandomValue(state): state = pcgHash(state); return (state>>8)/2^24.
function drawN( seed, n ) {

	let s = u32( seed );
	const states = [];
	const draws = [];
	for ( let i = 0; i < n; i ++ ) {

		s = pcgHash( s );
		states.push( s >>> 0 );
		draws.push( ( s >>> 8 ) * ( 1 / 16777216 ) );

	}

	return { states, draws };

}

describe( 'ReSTIR Phase 0 — RNG replay determinism (Random.js mirror)', () => {

	const PX = 128.5, PY = 72.5, FRAME = 7; // pixelCoord form (gx+0.5, gy+0.5)

	it( 'is deterministic: identical seed → identical draw sequence', () => {

		const seed = storedSeed( PX, PY, 0, FRAME );
		const a = drawN( seed, 16 );
		const b = drawN( seed, 16 );
		expect( a.states ).toEqual( b.states );
		expect( a.draws ).toEqual( b.draws );

	} );

	it( 'matches the golden vector (regression pin against Random.js drift)', () => {

		// Generated from this mirror; if Random.js WGSL changes, the GPU↔CPU probe (0.4)
		// fails first, then this golden must be regenerated intentionally.
		expect( storedSeed( PX, PY, 0, FRAME ) ).toBe( 2999624230 );
		const { states, draws } = drawN( storedSeed( PX, PY, 0, FRAME ), 4 );
		expect( states ).toEqual( [ 3751878932, 2628198970, 283604375, 608479182 ] );
		const golden = [ 0.8735523819923401, 0.6119252443313599, 0.06603175401687622, 0.1416725516319275 ];
		draws.forEach( ( d, i ) => expect( d ).toBeCloseTo( golden[ i ], 7 ) );

	} );

	it( 'produces draws in [0,1) with mean ≈ 0.5 (no bias)', () => {

		const { draws } = drawN( storedSeed( PX, PY, 0, FRAME ), 4096 );
		let sum = 0;
		for ( const d of draws ) {

			expect( d ).toBeGreaterThanOrEqual( 0 );
			expect( d ).toBeLessThan( 1 );
			sum += d;

		}

		expect( sum / draws.length ).toBeCloseTo( 0.5, 1 );

	} );

	it( 'decorrelates neighboring (pixel, frame) keys', () => {

		const seeds = [
			storedSeed( 128.5, 72.5, 0, 7 ),
			storedSeed( 129.5, 72.5, 0, 7 ), // +x neighbor
			storedSeed( 128.5, 73.5, 0, 7 ), // +y neighbor
			storedSeed( 128.5, 72.5, 0, 8 ), // next frame
		];
		expect( new Set( seeds ).size ).toBe( 4 );

	} );

	it( 'honors the sub-sample key contract (GenerateKernel.js:59,65)', () => {

		// subSample is the replay key, NOT the global rayID (which folds in subSample*w*h).
		const s0 = storedSeed( PX, PY, 0, FRAME );
		const s1 = storedSeed( PX, PY, 1, FRAME );
		expect( s0 ).not.toBe( s1 );
		expect( s0 ).toBe( 2999624230 );
		expect( s1 ).toBe( 1685935400 );

	} );

} );
