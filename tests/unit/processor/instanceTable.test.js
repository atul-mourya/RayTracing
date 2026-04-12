import { describe, it, expect } from 'vitest';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';

// Triangle data: 32 floats per triangle
// Positions at offsets 0,1,2 (A), 4,5,6 (B), 8,9,10 (C)
function makeTriangle( ax, ay, az, bx, by, bz, cx, cy, cz ) {

	const data = new Float32Array( 32 );
	data[ 0 ] = ax; data[ 1 ] = ay; data[ 2 ] = az;
	data[ 4 ] = bx; data[ 5 ] = by; data[ 6 ] = bz;
	data[ 8 ] = cx; data[ 9 ] = cy; data[ 10 ] = cz;
	return data;

}

// BVH inner node: [leftMin.xyz, leftChild, leftMax.xyz, rightChild, rightMin.xyz, 0, rightMax.xyz, 0]
function makeInner( lMin, lMax, leftIdx, rMin, rMax, rightIdx ) {

	return new Float32Array( [
		lMin[ 0 ], lMin[ 1 ], lMin[ 2 ], leftIdx,
		lMax[ 0 ], lMax[ 1 ], lMax[ 2 ], rightIdx,
		rMin[ 0 ], rMin[ 1 ], rMin[ 2 ], 0,
		rMax[ 0 ], rMax[ 1 ], rMax[ 2 ], 0,
	] );

}

// BVH leaf node: [triOffset, triCount, 0, -1, ...]
function makeLeaf( triOffset, triCount ) {

	return new Float32Array( [ triOffset, triCount, 0, - 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] );

}

describe( 'InstanceTable', () => {

	describe( 'allocate and setEntry', () => {

		it( 'pre-allocates entries array with null slots', () => {

			const table = new InstanceTable();
			table.allocate( 3 );
			expect( table.entries ).toHaveLength( 3 );
			expect( table.entries[ 0 ] ).toBeNull();
			expect( table.entries[ 1 ] ).toBeNull();
			expect( table.entries[ 2 ] ).toBeNull();

		} );

		it( 'sets entries at correct meshIndex positions regardless of insertion order', () => {

			const table = new InstanceTable();
			table.allocate( 3 );

			// Insert out of order (simulating async-first build)
			table.setEntry( { meshIndex: 2, blasNodeCount: 5, triOffset: 20, triCount: 10, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 48 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 7, triOffset: 5, triCount: 15, originalToBvhMap: null, bvhData: new Float32Array( 112 ) } );

			expect( table.entries[ 0 ].meshIndex ).toBe( 0 );
			expect( table.entries[ 0 ].triOffset ).toBe( 0 );
			expect( table.entries[ 1 ].meshIndex ).toBe( 1 );
			expect( table.entries[ 1 ].triOffset ).toBe( 5 );
			expect( table.entries[ 2 ].meshIndex ).toBe( 2 );
			expect( table.entries[ 2 ].triOffset ).toBe( 20 );

		} );

	} );

	describe( 'assignOffsets', () => {

		it( 'assigns sequential BLAS offsets after TLAS nodes', () => {

			const table = new InstanceTable();
			table.allocate( 3 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 10, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 160 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 20, triOffset: 5, triCount: 8, originalToBvhMap: null, bvhData: new Float32Array( 320 ) } );
			table.setEntry( { meshIndex: 2, blasNodeCount: 5, triOffset: 13, triCount: 3, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );

			table.assignOffsets( 7 ); // 7 TLAS nodes

			expect( table.tlasNodeCount ).toBe( 7 );
			expect( table.entries[ 0 ].blasOffset ).toBe( 7 ); // 7
			expect( table.entries[ 1 ].blasOffset ).toBe( 17 ); // 7 + 10
			expect( table.entries[ 2 ].blasOffset ).toBe( 37 ); // 7 + 10 + 20
			expect( table.totalBLASNodes ).toBe( 35 ); // 10 + 20 + 5
			expect( table.totalNodeCount ).toBe( 42 ); // 7 + 35

		} );

	} );

	describe( 'computeAABBs', () => {

		it( 'reads AABB from inner root node (O(1) path)', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			// Inner root with left child AABB (1,2,3)→(4,5,6) and right child AABB (0,0,0)→(10,10,10)
			const bvhData = makeInner( [ 1, 2, 3 ], [ 4, 5, 6 ], 1, [ 0, 0, 0 ], [ 10, 10, 10 ], 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );

			table.computeAABBs( new Float32Array( 64 ) );

			const aabb = table.entries[ 0 ].worldAABB;
			expect( aabb.minX ).toBe( 0 );
			expect( aabb.minY ).toBe( 0 );
			expect( aabb.minZ ).toBe( 0 );
			expect( aabb.maxX ).toBe( 10 );
			expect( aabb.maxY ).toBe( 10 );
			expect( aabb.maxZ ).toBe( 10 );

		} );

		it( 'falls back to triangle scan for leaf root (very small mesh)', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			// Leaf root — mesh has ≤ maxLeafSize triangles
			const bvhData = makeLeaf( 0, 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );

			const triangleData = new Float32Array( 64 );
			triangleData.set( makeTriangle( 1, 2, 3, 4, 5, 6, 7, 8, 9 ), 0 );
			triangleData.set( makeTriangle( - 1, - 2, - 3, 10, 11, 12, 0, 0, 0 ), 32 );

			table.computeAABBs( triangleData );

			const aabb = table.entries[ 0 ].worldAABB;
			expect( aabb.minX ).toBe( - 1 );
			expect( aabb.minY ).toBe( - 2 );
			expect( aabb.minZ ).toBe( - 3 );
			expect( aabb.maxX ).toBe( 10 );
			expect( aabb.maxY ).toBe( 11 );
			expect( aabb.maxZ ).toBe( 12 );

		} );

	} );

	describe( 'recomputeAABB', () => {

		it( 'reads updated AABB from combined buffer at BLAS offset', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			const bvhData = makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );
			table.assignOffsets( 5 ); // BLAS starts at node 5

			// Build a combined buffer with BLAS root at offset 5
			const combinedBvh = new Float32Array( 128 ); // 8 nodes worth
			const updatedRoot = makeInner( [ - 5, - 5, - 5 ], [ 15, 15, 15 ], 6, [ 2, 2, 2 ], [ 8, 8, 8 ], 7 );
			combinedBvh.set( updatedRoot, 5 * 16 );

			table.recomputeAABB( 0, combinedBvh, new Float32Array( 64 ) );

			const aabb = table.entries[ 0 ].worldAABB;
			expect( aabb.minX ).toBe( - 5 );
			expect( aabb.maxX ).toBe( 15 );

		} );

	} );

	describe( 'clear', () => {

		it( 'resets all state', () => {

			const table = new InstanceTable();
			table.allocate( 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 48 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 5, triOffset: 5, triCount: 8, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );
			table.assignOffsets( 5 );

			table.clear();

			expect( table.entries ).toEqual( [] );
			expect( table.totalBLASNodes ).toBe( 0 );
			expect( table.tlasNodeCount ).toBe( 0 );

		} );

	} );

} );
