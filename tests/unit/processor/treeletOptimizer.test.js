import { describe, it, expect } from 'vitest';
import { TreeletOptimizer } from '@/core/Processor/TreeletOptimizer.js';

describe( 'TreeletOptimizer', () => {

	let optimizer;

	// Use small traversal/intersection costs for testing
	beforeEach( () => {

		optimizer = new TreeletOptimizer( 1.0, 1.0 );

	} );

	describe( 'generateTopologies', () => {

		it( 'n=1 returns single leaf [0]', () => {

			const topos = optimizer.generateTopologies( 1 );
			expect( topos ).toEqual( [ 0 ] );

		} );

		it( 'n=2 returns single pair [[0,1]]', () => {

			const topos = optimizer.generateTopologies( 2 );
			expect( topos ).toEqual( [ [ 0, 1 ] ] );

		} );

		it( 'n=3 produces Catalan(2)=2 topologies', () => {

			const topos = optimizer.generateTopologies( 3 );
			expect( topos ).toHaveLength( 2 );

		} );

		it( 'n=4 produces Catalan(3)=5 topologies', () => {

			const topos = optimizer.generateTopologies( 4 );
			expect( topos ).toHaveLength( 5 );

		} );

		it( 'n=5 produces Catalan(4)=14 topologies', () => {

			const topos = optimizer.generateTopologies( 5 );
			expect( topos ).toHaveLength( 14 );

		} );

		it( 'n=6 produces Catalan(5)=42 topologies', () => {

			const topos = optimizer.generateTopologies( 6 );
			expect( topos ).toHaveLength( 42 );

		} );

		it( 'all leaf indices appear in each topology for n=3', () => {

			const topos = optimizer.generateTopologies( 3 );
			for ( const topo of topos ) {

				const leaves = flattenLeaves( topo );
				expect( leaves.sort() ).toEqual( [ 0, 1, 2 ] );

			}

		} );

		it( 'all leaf indices appear in each topology for n=4', () => {

			const topos = optimizer.generateTopologies( 4 );
			for ( const topo of topos ) {

				const leaves = flattenLeaves( topo );
				expect( leaves.sort() ).toEqual( [ 0, 1, 2, 3 ] );

			}

		} );

	} );

	describe( 'constructor', () => {

		it( 'precomputes topology cache for 3..maxTreeletLeaves', () => {

			expect( optimizer.topologyCache.has( 3 ) ).toBe( true );
			expect( optimizer.topologyCache.has( 4 ) ).toBe( true );
			expect( optimizer.topologyCache.has( 7 ) ).toBe( true );

		} );

		it( 'stores traversal and intersection costs', () => {

			expect( optimizer.traversalCost ).toBe( 1.0 );
			expect( optimizer.intersectionCost ).toBe( 1.0 );

		} );

		it( 'initializes stats', () => {

			expect( optimizer.stats.treeletsProcessed ).toBe( 0 );
			expect( optimizer.stats.treeletsImproved ).toBe( 0 );

		} );

	} );

} );

/**
 * Helper: Extract all leaf indices from a nested topology
 */
function flattenLeaves( node ) {

	if ( typeof node === 'number' ) return [ node ];
	return [ ...flattenLeaves( node[ 0 ] ), ...flattenLeaves( node[ 1 ] ) ];

}
