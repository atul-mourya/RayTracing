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

	// ── offsetTopology ────────────────────────────────────────

	describe( 'offsetTopology', () => {

		it( 'offsets a single leaf', () => {

			expect( optimizer.offsetTopology( 0, 3 ) ).toBe( 3 );

		} );

		it( 'offsets a nested topology', () => {

			const result = optimizer.offsetTopology( [ 0, [ 1, 2 ] ], 5 );
			expect( result ).toEqual( [ 5, [ 6, 7 ] ] );

		} );

	} );

	// ── surfaceAreaFlat ───────────────────────────────────────

	describe( 'surfaceAreaFlat', () => {

		it( 'unit cube has surface area 6', () => {

			expect( optimizer.surfaceAreaFlat( 0, 0, 0, 1, 1, 1 ) ).toBeCloseTo( 6.0 );

		} );

		it( 'degenerate (flat) box has area > 0', () => {

			// 2x3 flat → 2*(2*3 + 3*0 + 0*2) = 12
			expect( optimizer.surfaceAreaFlat( 0, 0, 0, 2, 3, 0 ) ).toBeCloseTo( 12.0 );

		} );

		it( 'point has area 0', () => {

			expect( optimizer.surfaceAreaFlat( 1, 1, 1, 1, 1, 1 ) ).toBe( 0 );

		} );

	} );

	// ── generatePermutations ──────────────────────────────────

	describe( 'generatePermutations', () => {

		it( 'n=3 produces 6 permutations (3!)', () => {

			const perms = optimizer.generatePermutations( 3 );
			expect( perms ).toHaveLength( 6 );

		} );

		it( 'n=4 produces 24 permutations (4!)', () => {

			const perms = optimizer.generatePermutations( 4 );
			expect( perms ).toHaveLength( 24 );

		} );

		it( 'all permutations contain all indices', () => {

			const perms = optimizer.generatePermutations( 3 );
			for ( const perm of perms ) {

				expect( [ ...perm ].sort() ).toEqual( [ 0, 1, 2 ] );

			}

		} );

		it( 'all permutations are unique', () => {

			const perms = optimizer.generatePermutations( 3 );
			const strs = perms.map( p => p.join( ',' ) );
			expect( new Set( strs ).size ).toBe( 6 );

		} );

	} );

	// ── countLeaves ───────────────────────────────────────────

	describe( 'countLeaves', () => {

		it( 'returns 0 for null', () => {

			expect( optimizer.countLeaves( null ) ).toBe( 0 );

		} );

		it( 'returns 1 for leaf node', () => {

			const leaf = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 2 );
			expect( optimizer.countLeaves( leaf ) ).toBe( 1 );

		} );

		it( 'counts all leaves in a tree', () => {

			const left = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 2 );
			const right = makeLeafNode( 2, 0, 0, 3, 1, 1, 2, 2 );
			const root = makeInnerNode( left, right );
			expect( optimizer.countLeaves( root ) ).toBe( 2 );

		} );

	} );

	// ── evaluateSubtreeSAH ────────────────────────────────────

	describe( 'evaluateSubtreeSAH', () => {

		it( 'returns 0 for null', () => {

			expect( optimizer.evaluateSubtreeSAH( null ) ).toBe( 0 );

		} );

		it( 'leaf cost = SA * triCount * intersectionCost', () => {

			const leaf = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 4 );
			const cost = optimizer.evaluateSubtreeSAH( leaf );
			// SA = 6, triCount = 4, intersectionCost = 1.0
			expect( cost ).toBeCloseTo( 6 * 4 * 1.0 );

		} );

		it( 'inner cost = SA * traversalCost + leftCost + rightCost', () => {

			const left = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 1 );
			const right = makeLeafNode( 2, 0, 0, 3, 1, 1, 1, 1 );
			const root = makeInnerNode( left, right );

			const cost = optimizer.evaluateSubtreeSAH( root );
			const rootSA = optimizer.surfaceAreaFlat( 0, 0, 0, 3, 1, 1 );
			const leftCost = 6 * 1; // SA(1x1x1)=6, triCount=1
			const rightCost = 6 * 1;
			expect( cost ).toBeCloseTo( rootSA * 1.0 + leftCost + rightCost );

		} );

	} );

	// ── evaluateTopology ──────────────────────────────────────

	describe( 'evaluateTopology', () => {

		it( 'evaluates a simple 2-leaf topology', () => {

			const leaves = [
				{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1, triangleOffset: 0, triangleCount: 1 },
				{ minX: 5, minY: 0, minZ: 0, maxX: 6, maxY: 1, maxZ: 1, triangleOffset: 1, triangleCount: 1 },
			];
			const topo = [ 0, 1 ];
			const perm = [ 0, 1 ];
			const cost = optimizer.evaluateTopology( topo, leaves, perm );
			expect( cost ).toBeGreaterThan( 0 );

		} );

	} );

	// ── configuration ─────────────────────────────────────────

	describe( 'configuration', () => {

		it( 'setTreeletSize clamps to [3, 7]', () => {

			optimizer.setTreeletSize( 1 );
			expect( optimizer.maxTreeletLeaves ).toBe( 3 );

			optimizer.setTreeletSize( 100 );
			expect( optimizer.maxTreeletLeaves ).toBe( 7 );

			optimizer.setTreeletSize( 5 );
			expect( optimizer.maxTreeletLeaves ).toBe( 5 );

		} );

		it( 'setMinImprovement clamps to >= 0.001', () => {

			optimizer.setMinImprovement( 0.0001 );
			expect( optimizer.minImprovement ).toBe( 0.001 );

			optimizer.setMinImprovement( 0.5 );
			expect( optimizer.minImprovement ).toBe( 0.5 );

		} );

		it( 'getStatistics returns copy of stats', () => {

			const stats = optimizer.getStatistics();
			stats.treeletsProcessed = 999;
			expect( optimizer.stats.treeletsProcessed ).toBe( 0 );

		} );

	} );

	// ── optimizeBVH (integration) ─────────────────────────────

	describe( 'optimizeBVH', () => {

		it( 'handles leaf-only root without error', () => {

			const leaf = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 5 );
			const result = optimizer.optimizeBVH( leaf );
			expect( result ).toBe( leaf );

		} );

		it( 'processes a valid 3-leaf tree', () => {

			const l1 = makeLeafNode( 0, 0, 0, 1, 1, 1, 0, 2 );
			const l2 = makeLeafNode( 5, 0, 0, 6, 1, 1, 2, 2 );
			const l3 = makeLeafNode( 10, 0, 0, 11, 1, 1, 4, 2 );
			const inner = makeInnerNode( l2, l3 );
			const root = makeInnerNode( l1, inner );

			optimizer.optimizeBVH( root );
			expect( optimizer.stats.treeletsProcessed ).toBeGreaterThanOrEqual( 0 );

		} );

	} );

} );

// ── Helpers ───────────────────────────────────────────────────

function flattenLeaves( node ) {

	if ( typeof node === 'number' ) return [ node ];
	return [ ...flattenLeaves( node[ 0 ] ), ...flattenLeaves( node[ 1 ] ) ];

}

function makeLeafNode( minX, minY, minZ, maxX, maxY, maxZ, triOffset, triCount ) {

	return {
		minX, minY, minZ, maxX, maxY, maxZ,
		leftChild: null, rightChild: null,
		triangleOffset: triOffset, triangleCount: triCount
	};

}

function makeInnerNode( left, right ) {

	return {
		minX: Math.min( left.minX, right.minX ),
		minY: Math.min( left.minY, right.minY ),
		minZ: Math.min( left.minZ, right.minZ ),
		maxX: Math.max( left.maxX, right.maxX ),
		maxY: Math.max( left.maxY, right.maxY ),
		maxZ: Math.max( left.maxZ, right.maxZ ),
		leftChild: left, rightChild: right,
		triangleOffset: 0, triangleCount: 0,
	};

}
