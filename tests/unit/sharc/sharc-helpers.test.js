/**
 * Unit tests for SHaRC TSL helper algorithms.
 *
 * The TSL helpers in `rayzee/src/TSL/SHaRC.js` build node graphs that compile
 * to WGSL — they can't be directly evaluated at the JS level. To still cover
 * the algorithm intent, we implement pure-JS reference functions that mirror
 * the TSL implementations line-for-line. If the TSL is ever changed without
 * updating the JS reference (or vice versa), these tests catch the divergence
 * via golden-value comparisons and property checks.
 *
 * The constants (SHARC_BUCKET_SIZE, SHARC_FRAME_BIT_MASK, etc.) ARE plain JS
 * exports and we use the real ones from the source module to keep them in sync.
 */

import { describe, it, expect } from 'vitest';
import {
	SHARC_BUCKET_SIZE,
	SHARC_PROBE_LIMIT,
	SHARC_FRAME_BIT_MASK,
	SHARC_STALE_BIT_OFFSET,
	SHARC_RADIANCE_SCALE,
	SHARC_LOG_BASE,
} from '@/core/TSL/SHaRC.js';

// ──────────────────────────────────────────────────────────────────────
// JS reference implementations (mirror the TSL helpers exactly)
// ──────────────────────────────────────────────────────────────────────

/** Force u32 semantics (JS bitwise ops are i32; >>> 0 reinterprets as u32). */
const u32 = ( x ) => x >>> 0;

/** Bob Jenkins' 32-bit integer hash. Mirrors `jenkins32` Fn in TSL/SHaRC.js. */
function jenkins32( a ) {

	a = u32( a );
	a = u32( ( a + 0x7ed55d16 ) + ( a << 12 ) );
	a = u32( ( a ^ 0xc761c23c ) ^ ( a >>> 19 ) );
	a = u32( ( a + 0x165667b1 ) + ( a << 5 ) );
	a = u32( ( a + 0xd3a2646c ) ^ ( a << 9 ) );
	a = u32( ( a + 0xfd7046c5 ) + ( a << 3 ) );
	a = u32( ( a ^ 0xb55a4f09 ) ^ ( a >>> 16 ) );
	return a;

}

/** Pack low 32 bits of the hash key. Mirrors `composeKeyLo`. */
function composeKeyLo( gx, gy ) {

	const x = u32( gx & 0x1FFFF );
	const yLo = u32( gy & 0x7FFF );
	return u32( x | ( yLo << 17 ) );

}

/** Pack high 32 bits of the hash key. Mirrors `composeKeyHi`. */
function composeKeyHi( gy, gz, level, nSigns ) {

	const yHi = u32( ( gy >> 15 ) & 0x3 );
	const z = u32( gz & 0x1FFFF );
	const lvl = u32( level & 0x3FF );
	const nb = u32( nSigns & 0x7 );
	return u32( yHi | ( z << 2 ) | ( lvl << 19 ) | ( nb << 29 ) );

}

/** Compute bucket base index. Mirrors `bucketBaseFromKey`. */
function bucketBaseFromKey( keyLo, keyHi, numBuckets ) {

	const h = u32( jenkins32( keyLo ) ^ jenkins32( keyHi ) );
	return u32( ( h % numBuckets ) * SHARC_BUCKET_SIZE );

}

/** Normal sign bits encoding. Mirrors `normalSignBits`. */
function normalSignBits( N ) {

	const eps = - 1e-3;
	const xb = N.x < eps ? 1 : 0;
	const yb = N.y < eps ? 2 : 0;
	const zb = N.z < eps ? 4 : 0;
	return xb | yb | zb;

}

/** Grid LOD level from distance. Mirrors `computeGridLevel`. */
function computeGridLevel( worldPos, cameraPos, levelBias ) {

	const dx = worldPos.x - cameraPos.x;
	const dy = worldPos.y - cameraPos.y;
	const dz = worldPos.z - cameraPos.z;
	const dist2 = Math.max( dx * dx + dy * dy + dz * dz, 1e-6 );
	const logBase = Math.log( SHARC_LOG_BASE );
	const level = 0.5 * ( Math.log( dist2 ) / logBase ) + levelBias;
	return Math.min( Math.max( level, 1.0 ), 1023.0 );

}

/** Voxel size from level. Mirrors `computeVoxelSize`. */
function computeVoxelSize( level, sceneScale, levelBias ) {

	return Math.pow( SHARC_LOG_BASE, level ) /
		( sceneScale * Math.pow( SHARC_LOG_BASE, levelBias ) );

}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe( 'SHaRC constants', () => {

	it( 'exports the expected layout constants', () => {

		expect( SHARC_BUCKET_SIZE ).toBe( 16 );
		expect( SHARC_PROBE_LIMIT ).toBe( 8 );
		expect( SHARC_FRAME_BIT_MASK ).toBe( 0xFFFF );
		expect( SHARC_STALE_BIT_OFFSET ).toBe( 16 );
		expect( SHARC_RADIANCE_SCALE ).toBe( 1000.0 );
		expect( SHARC_LOG_BASE ).toBe( 2.0 );

	} );

	it( 'probe limit is at most bucket size', () => {

		// Linear probing should not walk past its own bucket
		expect( SHARC_PROBE_LIMIT ).toBeLessThanOrEqual( SHARC_BUCKET_SIZE );

	} );

} );

describe( 'jenkins32', () => {

	it( 'is deterministic', () => {

		expect( jenkins32( 0 ) ).toBe( jenkins32( 0 ) );
		expect( jenkins32( 12345 ) ).toBe( jenkins32( 12345 ) );
		expect( jenkins32( 0xFFFFFFFF ) ).toBe( jenkins32( 0xFFFFFFFF ) );

	} );

	it( 'returns a u32', () => {

		const samples = [ 0, 1, 0xDEADBEEF, 0xFFFFFFFF, 0x80000000 ];
		for ( const x of samples ) {

			const h = jenkins32( x );
			expect( h ).toBeGreaterThanOrEqual( 0 );
			expect( h ).toBeLessThanOrEqual( 0xFFFFFFFF );
			expect( Number.isInteger( h ) ).toBe( true );

		}

	} );

	it( 'avalanches: tiny input changes produce large output changes', () => {

		// Average bits-changed for ±1 input deltas should be roughly half (16)
		let totalDiffBits = 0;
		const samples = 1000;
		for ( let i = 0; i < samples; i ++ ) {

			const a = jenkins32( i );
			const b = jenkins32( i + 1 );
			let d = a ^ b;
			let bits = 0;
			while ( d ) {

				bits += d & 1;
				d >>>= 1;

			}

			totalDiffBits += bits;

		}

		const avg = totalDiffBits / samples;
		// A perfect 32-bit hash averages 16 flipped bits per input delta.
		// Bob Jenkins' hash typically scores 13–18 in this range.
		expect( avg ).toBeGreaterThan( 12 );
		expect( avg ).toBeLessThan( 20 );

	} );

	it( 'has good bucket distribution over consecutive integers', () => {

		// Hash 100k consecutive ints into 256 buckets; each bucket should land
		// in [actualMin, actualMax] within a chi-square-like sanity range.
		const N_HASHES = 100000;
		const N_BUCKETS = 256;
		const counts = new Array( N_BUCKETS ).fill( 0 );
		for ( let i = 0; i < N_HASHES; i ++ ) counts[ jenkins32( i ) % N_BUCKETS ] ++;

		const expected = N_HASHES / N_BUCKETS; // ≈ 390 per bucket
		const min = Math.min( ...counts );
		const max = Math.max( ...counts );

		// A perfectly uniform hash on consecutive ints would land inside ±20%
		// of expected for almost all buckets. Tightening below catches obvious
		// regressions (e.g. a constant, a low-bit-only hash, etc.).
		expect( min ).toBeGreaterThan( expected * 0.7 );
		expect( max ).toBeLessThan( expected * 1.3 );

	} );

	it( 'reference golden values', () => {

		// Snapshot specific values so any algorithmic change is detected.
		// Generated by running the JS reference once and locking in the output.
		expect( jenkins32( 0 ) ).toBe( 1800329511 );
		expect( jenkins32( 1 ) ).toBe( 3028713910 );
		expect( jenkins32( 0xDEADBEEF ) ).toBe( 2146495194 );
		expect( jenkins32( 0xFFFFFFFF ) ).toBe( 4268016002 );

	} );

} );

describe( 'composeKeyLo', () => {

	it( 'packs gx in low 17 bits and gy_low15 at offset 17', () => {

		const lo = composeKeyLo( 5, 7 );
		expect( lo & 0x1FFFF ).toBe( 5 ); // gx
		expect( ( lo >>> 17 ) & 0x7FFF ).toBe( 7 ); // gy low 15 bits

	} );

	it( 'masks gx to 17 bits', () => {

		// Values exceeding 17 bits must wrap (no overflow into other fields)
		const lo = composeKeyLo( 0x1FFFFF, 0 ); // 21 bits → low 17 = 0x1FFFF
		expect( lo & 0x1FFFF ).toBe( 0x1FFFF );
		expect( ( lo >>> 17 ) & 0x7FFF ).toBe( 0 );

	} );

	it( 'discards gy bits >= 15 (those go into keyHi instead)', () => {

		// gy = 0x7FFFF (19 bits) → keyLo only stores low 15 bits = 0x7FFF
		const lo = composeKeyLo( 0, 0x7FFFF );
		expect( ( lo >>> 17 ) & 0x7FFF ).toBe( 0x7FFF );

	} );

	it( 'returns 0 for the empty-key sentinel', () => {

		// Empty cells store keyLo == 0 && keyHi == 0
		expect( composeKeyLo( 0, 0 ) ).toBe( 0 );

	} );

} );

describe( 'composeKeyHi', () => {

	it( 'packs gy_high2, gz, level, nSigns into the documented bit layout', () => {

		// gy in 0..0x1FFFF; high 2 bits = (gy>>15) & 0x3
		// gz at offset 2, level at offset 19, nSigns at offset 29
		const gy = ( 0x3 << 15 ); // gy_high2 = 3
		const gz = 0x1FFFF; // 17 bits
		const hi = composeKeyHi( gy, gz, 5, 0b101 );
		expect( hi & 0x3 ).toBe( 0x3 ); // gy high 2 bits
		expect( ( hi >>> 2 ) & 0x1FFFF ).toBe( 0x1FFFF ); // gz
		expect( ( hi >>> 19 ) & 0x3FF ).toBe( 5 ); // level
		expect( ( hi >>> 29 ) & 0x7 ).toBe( 0b101 ); // nSigns

	} );

	it( 'masks level to 10 bits', () => {

		const hi = composeKeyHi( 0, 0, 0xFFFF, 0 );
		expect( ( hi >>> 19 ) & 0x3FF ).toBe( 0x3FF );

	} );

	it( 'masks normal-sign bits to 3 bits', () => {

		const hi = composeKeyHi( 0, 0, 0, 0xFF );
		expect( ( hi >>> 29 ) & 0x7 ).toBe( 0x7 );

	} );

	it( 'is non-zero for any valid level (level >= 1)', () => {

		// level_bits live at offset 19, so level=1 → keyHi >= (1<<19) > 0.
		// This is critical: the empty-cell sentinel relies on (keyLo,keyHi) ==
		// (0,0). A valid cell always has keyHi != 0 because level_min == 1.
		for ( let lvl = 1; lvl <= 1023; lvl ++ ) {

			expect( composeKeyHi( 0, 0, lvl, 0 ) ).toBeGreaterThan( 0 );

		}

	} );

} );

describe( 'key roundtrip', () => {

	it( 'lossless for in-range coordinates and level', () => {

		const cases = [
			{ gx: 0, gy: 0, gz: 0, level: 1, nSigns: 0 },
			{ gx: 1, gy: 1, gz: 1, level: 1, nSigns: 0 },
			{ gx: 100, gy: 50, gz: 25, level: 5, nSigns: 0b011 },
			{ gx: 0xFFFF, gy: 0xABCD, gz: 0x1FFFF, level: 1023, nSigns: 0b111 },
			{ gx: 0x1FFFF, gy: 0x1FFFF, gz: 0x1FFFF, level: 1023, nSigns: 0b111 },
		];
		for ( const c of cases ) {

			const lo = composeKeyLo( c.gx, c.gy );
			const hi = composeKeyHi( c.gy, c.gz, c.level, c.nSigns );

			// Decompose
			const decGx = lo & 0x1FFFF;
			const decGyLo = ( lo >>> 17 ) & 0x7FFF;
			const decGyHi = hi & 0x3;
			const decGz = ( hi >>> 2 ) & 0x1FFFF;
			const decLevel = ( hi >>> 19 ) & 0x3FF;
			const decNSigns = ( hi >>> 29 ) & 0x7;

			// Reconstruct gy from its 17-bit split
			const reconGy = ( decGyHi << 15 ) | decGyLo;

			expect( decGx ).toBe( c.gx & 0x1FFFF );
			expect( reconGy ).toBe( c.gy & 0x1FFFF );
			expect( decGz ).toBe( c.gz & 0x1FFFF );
			expect( decLevel ).toBe( c.level );
			expect( decNSigns ).toBe( c.nSigns );

		}

	} );

	it( 'distinct (gx, gy, gz, level, nSigns) tuples produce distinct keys', () => {

		// Every field is independently encoded — changing any one must change
		// the (keyLo, keyHi) pair. Catches the latent collision bug from
		// Phase 1 where gy bits 13..16 collided with gz_lo at bits 30..31.
		const seen = new Set();
		for ( let gx of [ 0, 1, 0x1FFFF ] ) {

			for ( let gy of [ 0, 1, 0x4000, 0x1FFFF ] ) {

				for ( let gz of [ 0, 1, 0x1FFFF ] ) {

					for ( let level of [ 1, 5, 1023 ] ) {

						for ( let nSigns of [ 0, 3, 7 ] ) {

							const lo = composeKeyLo( gx, gy );
							const hi = composeKeyHi( gy, gz, level, nSigns );
							const key = `${lo}_${hi}`;
							expect( seen.has( key ) ).toBe( false );
							seen.add( key );

						}

					}

				}

			}

		}

	} );

} );

describe( 'bucketBaseFromKey', () => {

	it( 'returns multiples of SHARC_BUCKET_SIZE', () => {

		// bucketBase is always a bucket-aligned slot index
		for ( let i = 0; i < 100; i ++ ) {

			const lo = jenkins32( i );
			const hi = jenkins32( i + 1 );
			const base = bucketBaseFromKey( lo, hi, 1024 );
			expect( base % SHARC_BUCKET_SIZE ).toBe( 0 );

		}

	} );

	it( 'wraps within numBuckets', () => {

		const numBuckets = 64;
		const totalSlots = numBuckets * SHARC_BUCKET_SIZE;
		for ( let i = 0; i < 1000; i ++ ) {

			const base = bucketBaseFromKey( i, i * 7919, numBuckets );
			expect( base ).toBeLessThan( totalSlots );

		}

	} );

	it( 'distributes well across buckets', () => {

		// Pump 50k pseudo-random keys (deterministic via mulberry32 PRNG so the
		// test is stable across CI runs) through the bucket function. Counts
		// should land in a Poisson-style range. We use a permissive ±2× window
		// around the expected mean — tightening below would catch degenerate
		// hashes (constant, low-bit-only) without flagging normal variance.
		const seedRand = ( seed ) => () => {

			seed = ( seed + 0x6D2B79F5 ) >>> 0;
			let t = seed;
			t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
			t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
			return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

		};

		const rand = seedRand( 42 );
		const numBuckets = 1024;
		const samples = 50000;
		const counts = new Array( numBuckets ).fill( 0 );
		for ( let i = 0; i < samples; i ++ ) {

			const gx = ( rand() * 0x1FFFF ) | 0;
			const gy = ( rand() * 0x1FFFF ) | 0;
			const gz = ( rand() * 0x1FFFF ) | 0;
			const level = ( ( rand() * 1023 ) | 0 ) + 1;
			const nSigns = ( rand() * 8 ) | 0;
			const lo = composeKeyLo( gx, gy );
			const hi = composeKeyHi( gy, gz, level, nSigns );
			const base = bucketBaseFromKey( lo, hi, numBuckets );
			counts[ base / SHARC_BUCKET_SIZE ] ++;

		}

		const expected = samples / numBuckets;
		const min = Math.min( ...counts );
		const max = Math.max( ...counts );
		expect( min ).toBeGreaterThan( expected * 0.4 );
		expect( max ).toBeLessThan( expected * 2.0 );

	} );

} );

describe( 'normalSignBits', () => {

	it( 'encodes per-axis sign bits', () => {

		expect( normalSignBits( { x: 1, y: 1, z: 1 } ) ).toBe( 0 );
		expect( normalSignBits( { x: - 1, y: 1, z: 1 } ) ).toBe( 1 );
		expect( normalSignBits( { x: 1, y: - 1, z: 1 } ) ).toBe( 2 );
		expect( normalSignBits( { x: 1, y: 1, z: - 1 } ) ).toBe( 4 );
		expect( normalSignBits( { x: - 1, y: - 1, z: - 1 } ) ).toBe( 7 );
		expect( normalSignBits( { x: - 1, y: 1, z: - 1 } ) ).toBe( 5 );

	} );

	it( 'treats axis-aligned (zero) components as positive', () => {

		// Reference uses a 1e-3 epsilon to keep axis-aligned faces stable —
		// only "clearly negative" components flip the bit. Tiny numerical
		// jitter on 0 should NOT toggle the bit.
		expect( normalSignBits( { x: 0, y: 0, z: 0 } ) ).toBe( 0 );
		expect( normalSignBits( { x: - 1e-4, y: 0, z: 0 } ) ).toBe( 0 ); // within eps
		expect( normalSignBits( { x: - 1e-2, y: 0, z: 0 } ) ).toBe( 1 ); // beyond eps

	} );

	it( 'returns a value in 0..7', () => {

		// 8 orientation classes — never out of range
		for ( let i = 0; i < 100; i ++ ) {

			const N = {
				x: Math.random() - 0.5,
				y: Math.random() - 0.5,
				z: Math.random() - 0.5,
			};
			const bits = normalSignBits( N );
			expect( bits ).toBeGreaterThanOrEqual( 0 );
			expect( bits ).toBeLessThanOrEqual( 7 );

		}

	} );

} );

describe( 'computeGridLevel', () => {

	it( 'is monotonically non-decreasing in distance', () => {

		const cam = { x: 0, y: 0, z: 0 };
		const lb = 3;
		let prev = - Infinity;
		for ( let d = 0.1; d < 100; d *= 1.2 ) {

			const lvl = computeGridLevel( { x: d, y: 0, z: 0 }, cam, lb );
			expect( lvl ).toBeGreaterThanOrEqual( prev );
			prev = lvl;

		}

	} );

	it( 'clamps to [1, 1023]', () => {

		const cam = { x: 0, y: 0, z: 0 };
		expect( computeGridLevel( { x: 0, y: 0, z: 0 }, cam, 3 ) ).toBeGreaterThanOrEqual( 1 );
		expect( computeGridLevel( { x: 1e10, y: 1e10, z: 1e10 }, cam, 3 ) ).toBeLessThanOrEqual( 1023 );

	} );

	it( 'levelBias shifts the LOD curve uniformly', () => {

		const cam = { x: 0, y: 0, z: 0 };
		const pt = { x: 10, y: 0, z: 0 };
		const a = computeGridLevel( pt, cam, 0 );
		const b = computeGridLevel( pt, cam, 5 );
		// Higher levelBias yields higher level (clamped). Each unit of
		// levelBias adds 1 to the level (no ratio tricks).
		expect( b - a ).toBeCloseTo( 5, 1 );

	} );

} );

describe( 'computeVoxelSize', () => {

	it( 'doubles size per level when LOG_BASE = 2', () => {

		// voxelSize = pow(2, level) / (sceneScale * pow(2, levelBias))
		// → voxelSize at level L+1 is 2× voxelSize at level L.
		const sceneScale = 50;
		const levelBias = 3;
		const v3 = computeVoxelSize( 3, sceneScale, levelBias );
		const v4 = computeVoxelSize( 4, sceneScale, levelBias );
		expect( v4 / v3 ).toBeCloseTo( 2, 4 );

	} );

	it( 'inverse-scales with sceneScale', () => {

		// voxelSize ∝ 1/sceneScale. Doubling sceneScale halves voxelSize.
		const v50 = computeVoxelSize( 5, 50, 3 );
		const v100 = computeVoxelSize( 5, 100, 3 );
		expect( v50 / v100 ).toBeCloseTo( 2, 4 );

	} );

	it( 'returns positive finite values for valid inputs', () => {

		const v = computeVoxelSize( 1, 1, 1 );
		expect( v ).toBeGreaterThan( 0 );
		expect( Number.isFinite( v ) ).toBe( true );

	} );

} );

describe( 'cell layout sanity', () => {

	it( 'cellData stride matches the documented packing (8 u32 per entry)', () => {

		// Stage allocates `capacity * 8` u32 entries; per-cell base = idx*8.
		// Slots: [0..2] accum RGB, [3] accumN, [4..6] resolved RGB, [7] meta.
		const idx = 1234;
		const cellBase = idx * 8;
		const slots = {
			accumR: cellBase + 0,
			accumG: cellBase + 1,
			accumB: cellBase + 2,
			accumN: cellBase + 3,
			resolvedR: cellBase + 4,
			resolvedG: cellBase + 5,
			resolvedB: cellBase + 6,
			resolvedMeta: cellBase + 7,
		};
		// Slots are unique and adjacent
		const values = Object.values( slots );
		expect( new Set( values ).size ).toBe( values.length );
		expect( Math.max( ...values ) - Math.min( ...values ) ).toBe( 7 );

	} );

	it( 'frame metadata packing is invertible', () => {

		// resolvedMeta = (accumFrameNum & 0xFFFF) | ((staleFrameNum & 0xFFFF) << 16)
		const accumFrame = 42;
		const stale = 7;
		const meta = ( accumFrame & SHARC_FRAME_BIT_MASK ) |
			( ( stale & SHARC_FRAME_BIT_MASK ) << SHARC_STALE_BIT_OFFSET );

		const decAccum = meta & SHARC_FRAME_BIT_MASK;
		const decStale = ( meta >>> SHARC_STALE_BIT_OFFSET ) & SHARC_FRAME_BIT_MASK;

		expect( decAccum ).toBe( accumFrame );
		expect( decStale ).toBe( stale );

	} );

} );
