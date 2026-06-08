/**
 * Phase-0 substrate (restir-di-phase01 §5.1 task 0.5): the partition-of-unity guard for the
 * UNBIASED GRIS combine. This is the cheapest possible check that the estimator does NOT
 * silently reduce to the biased Bitterli Algorithm 4 the three prior attempts used.
 *
 * The generalized balance heuristic (GRIS Eq. 16 / Bitterli 2020 Eq. 9), for reservoir i
 * at a FIXED sample y_j:
 *      m(i, j) = c_i · p̂_i(y_j) / Σ_k c_k · p̂_k(y_j)
 * Its defining property is Σ_i m(i, j) = 1 for every reachable y_j (partition of unity,
 * Veach 1995) — THAT is the unbiasing term. This test pins it, and pins the two specific
 * ways the verifiers showed it can be broken (restir-di-phase01 §7 R2 + §3.4.4).
 *
 * Pure JS — no TSL import (vitest runs in node; TSL needs the GPU). It mirrors the math the
 * TSL `reservoirCombineUnbiased` must realize.
 */

import { describe, it, expect } from 'vitest';

// P[i][j] = reservoir i's target evaluated at reservoir j's sample (the cross-eval matrix).
// C[i]    = confidence weight (capped M).
function balanceWeight( i, j, C, P ) {

	let denom = 0;
	for ( let k = 0; k < C.length; k ++ ) denom += C[ k ] * P[ k ][ j ];
	return ( C[ i ] * P[ i ][ j ] ) / denom;

}

function sumOverReservoirsAt( j, C, P ) {

	let s = 0;
	for ( let i = 0; i < C.length; i ++ ) s += balanceWeight( i, j, C, P );
	return s;

}

describe( 'ReSTIR Phase 0 — GRIS combine partition of unity (Σ mᵢ = 1)', () => {

	it( 'sums to 1 at every sample for a 2-reservoir case (canonical + temporal)', () => {

		const C = [ 4, 20 ]; // canonical M=4, temporal M-capped at 20
		const P = [
			[ 0.80, 0.30 ], // canonical's target at {y_c, y_t}
			[ 0.50, 0.90 ], // temporal's target at {y_c, y_t}
		];
		for ( let j = 0; j < C.length; j ++ ) {

			expect( sumOverReservoirsAt( j, C, P ) ).toBeCloseTo( 1, 12 );

		}

	} );

	it( 'sums to 1 for a 3-reservoir case (generalizes to spatial reuse later)', () => {

		const C = [ 4, 20, 1 ];
		const P = [
			[ 0.9, 0.2, 0.6 ],
			[ 0.3, 0.8, 0.4 ],
			[ 0.5, 0.5, 0.7 ],
		];
		for ( let j = 0; j < C.length; j ++ ) {

			expect( sumOverReservoirsAt( j, C, P ) ).toBeCloseTo( 1, 12 );

		}

	} );

	it( 'collapses to confidence weights cᵢ/Σc when targets are shared (the temporal-only form the TSL combine implements)', () => {

		// Post-disocclusion both reservoirs live at the current pixel → same target function.
		const C = [ 4, 20 ];
		const shared = [ 0.8, 0.35 ]; // identical target row for both reservoirs
		const P = [ shared, shared ];
		const denom = C[ 0 ] + C[ 1 ];
		for ( let j = 0; j < C.length; j ++ ) {

			expect( balanceWeight( 0, j, C, P ) ).toBeCloseTo( C[ 0 ] / denom, 12 );
			expect( balanceWeight( 1, j, C, P ) ).toBeCloseTo( C[ 1 ] / denom, 12 );

		}

	} );

	// ── Bias traps the verifiers caught — assert they BREAK partition of unity ──

	it( 'TRAP R2 (pHatOwn overload): using each reservoir\'s OWN-domain target in the denominator breaks Σ mᵢ = 1', () => {

		// The bug: denominator uses p̂_k(y_k) (stored own-target) instead of p̂_k(y_j).
		const C = [ 4, 20 ];
		const P = [
			[ 0.80, 0.30 ],
			[ 0.50, 0.90 ],
		];
		const buggy = ( i, j ) => {

			let denom = 0;
			for ( let k = 0; k < C.length; k ++ ) denom += C[ k ] * P[ k ][ k ]; // BUG: P[k][k] not P[k][j]
			return ( C[ i ] * P[ i ][ j ] ) / denom;

		};

		let sum = 0;
		for ( let i = 0; i < C.length; i ++ ) sum += buggy( i, 0 );
		expect( Math.abs( sum - 1 ) ).toBeGreaterThan( 0.05 ); // demonstrably biased

	} );

	it( 'TRAP §3.4.4 (bolted-on 1/K): adding a flat 1/K defensive term breaks Σ mᵢ = 1', () => {

		const C = [ 4, 20 ];
		const P = [
			[ 0.80, 0.30 ],
			[ 0.50, 0.90 ],
		];
		const K = C.length;
		let sum = 0;
		for ( let i = 0; i < K; i ++ ) sum += balanceWeight( i, 0, C, P ) + 1 / K; // BUG: +1/K on top
		expect( sum ).toBeCloseTo( 2, 6 ); // sums to 2, not 1 — over-weights the canonical

	} );

} );
