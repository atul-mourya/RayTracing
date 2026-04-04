import { describe, it, expect } from 'vitest';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';

// BVH flat layout: 16 floats per node
// Inner: [leftMin.xyz, leftChildIdx, leftMax.xyz, rightChildIdx, rightMin.xyz, 0, rightMax.xyz, 0]
// Leaf:  [triOffset, triCount, 0, -1, 0,0,0,0, 0,0,0,0, 0,0,0,0]

function makeLeaf( triOffset, triCount ) {

	return [ triOffset, triCount, 0, - 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ];

}

function makeInner( lMin, lMax, leftIdx, rMin, rMax, rightIdx ) {

	return [
		lMin[ 0 ], lMin[ 1 ], lMin[ 2 ], leftIdx,
		lMax[ 0 ], lMax[ 1 ], lMax[ 2 ], rightIdx,
		rMin[ 0 ], rMin[ 1 ], rMin[ 2 ], 0,
		rMax[ 0 ], rMax[ 1 ], rMax[ 2 ], 0,
	];

}

// Triangle data: 32 floats per triangle
// Positions at offsets 0,1,2 (A), 4,5,6 (B), 8,9,10 (C)
function makeTriangle( ax, ay, az, bx, by, bz, cx, cy, cz ) {

	const data = new Float32Array( 32 );
	data[ 0 ] = ax; data[ 1 ] = ay; data[ 2 ] = az; // posA
	data[ 4 ] = bx; data[ 5 ] = by; data[ 6 ] = bz; // posB
	data[ 8 ] = cx; data[ 9 ] = cy; data[ 10 ] = cz; // posC
	return data;

}

describe( 'BVHRefitter', () => {

	let refitter;

	beforeEach( () => {

		refitter = new BVHRefitter();

	} );

	describe( 'updateTrianglePositions', () => {

		it( 'patches positions using bvhToOriginal map', () => {

			// 2 triangles, BVH order: bvh[0]=orig[1], bvh[1]=orig[0]
			const triangleData = new Float32Array( 64 ); // 2 * 32
			const newPositions = new Float32Array( [
				1, 2, 3, 4, 5, 6, 7, 8, 9,   // original tri 0
				10, 20, 30, 40, 50, 60, 70, 80, 90 // original tri 1
			] );
			// bvhToOriginal: bvh[0]→orig[1], bvh[1]→orig[0]
			const bvhToOriginal = new Uint32Array( [ 1, 0 ] );

			refitter.updateTrianglePositions( triangleData, newPositions, bvhToOriginal );

			// bvh index 0 should have original tri 1 positions
			expect( triangleData[ 0 ] ).toBe( 10 ); // posA.x
			expect( triangleData[ 1 ] ).toBe( 20 ); // posA.y
			expect( triangleData[ 2 ] ).toBe( 30 ); // posA.z
			expect( triangleData[ 4 ] ).toBe( 40 ); // posB.x
			expect( triangleData[ 8 ] ).toBe( 70 ); // posC.x

			// bvh index 1 should have original tri 0 positions
			expect( triangleData[ 32 ] ).toBe( 1 );  // posA.x
			expect( triangleData[ 36 ] ).toBe( 4 );  // posB.x
			expect( triangleData[ 40 ] ).toBe( 7 );  // posC.x

		} );

		it( 'computes face normals', () => {

			const triangleData = new Float32Array( 32 );
			// Triangle in XY plane: A=(0,0,0), B=(1,0,0), C=(0,1,0)
			// Cross product AB x AC = (0,0,1) (unnormalized)
			const newPositions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
			const bvhToOriginal = new Uint32Array( [ 0 ] );

			refitter.updateTrianglePositions( triangleData, newPositions, bvhToOriginal );

			// Normal offsets: A=12, B=16, C=20 — unnormalized cross product
			expect( triangleData[ 12 ] ).toBeCloseTo( 0 ); // nA.x
			expect( triangleData[ 13 ] ).toBeCloseTo( 0 ); // nA.y
			expect( triangleData[ 14 ] ).toBeCloseTo( 1 ); // nA.z (AB x AC = (0,0,1))

			// All vertices get the same face normal
			expect( triangleData[ 16 ] ).toBeCloseTo( 0 ); // nB.x
			expect( triangleData[ 17 ] ).toBeCloseTo( 0 ); // nB.y
			expect( triangleData[ 18 ] ).toBeCloseTo( 1 ); // nB.z

		} );

	} );

	describe( 'refit', () => {

		it( 'updates inner node AABBs from leaf triangle data', () => {

			// Simple 3-node tree: root (inner) → left leaf (tri 0) + right leaf (tri 1)
			// Pre-order: [root=0, leftLeaf=1, rightLeaf=2]
			const bvhData = new Float32Array( [
				// Node 0 (inner): children at 1 and 2 — AABBs will be overwritten
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ),
				// Node 1 (leaf): triOffset=0, triCount=1
				...makeLeaf( 0, 1 ),
				// Node 2 (leaf): triOffset=1, triCount=1
				...makeLeaf( 1, 1 ),
			] );

			// Two triangles
			const tri0 = makeTriangle( 0, 0, 0, 1, 0, 0, 0, 1, 0 );
			const tri1 = makeTriangle( 5, 5, 5, 6, 5, 5, 5, 6, 5 );
			const triangleData = new Float32Array( 64 );
			triangleData.set( tri0, 0 );
			triangleData.set( tri1, 32 );

			refitter.refit( bvhData, triangleData, 3 );

			// After refit, root's left child AABB = tri0 bounds = (0,0,0)→(1,1,0)
			expect( bvhData[ 0 ] ).toBe( 0 );  // leftMin.x
			expect( bvhData[ 1 ] ).toBe( 0 );  // leftMin.y
			expect( bvhData[ 2 ] ).toBe( 0 );  // leftMin.z
			expect( bvhData[ 4 ] ).toBe( 1 );  // leftMax.x
			expect( bvhData[ 5 ] ).toBe( 1 );  // leftMax.y
			expect( bvhData[ 6 ] ).toBe( 0 );  // leftMax.z

			// Root's right child AABB = tri1 bounds = (5,5,5)→(6,6,5)
			expect( bvhData[ 8 ] ).toBe( 5 );  // rightMin.x
			expect( bvhData[ 12 ] ).toBe( 6 ); // rightMax.x
			expect( bvhData[ 13 ] ).toBe( 6 ); // rightMax.y
			expect( bvhData[ 14 ] ).toBe( 5 ); // rightMax.z

		} );

		it( 'reuses bounds buffer across calls', () => {

			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 2, 2, 2 ], [ 3, 3, 3 ], 2 ),
				...makeLeaf( 0, 1 ),
				...makeLeaf( 1, 1 ),
			] );

			const triangleData = new Float32Array( 64 );
			triangleData.set( makeTriangle( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 0 );
			triangleData.set( makeTriangle( 2, 2, 2, 3, 2, 2, 2, 3, 2 ), 32 );

			refitter.refit( bvhData, triangleData, 3 );
			const firstBounds = refitter._bounds;

			refitter.refit( bvhData, triangleData, 3 );
			expect( refitter._bounds ).toBe( firstBounds ); // same buffer reused

		} );

		it( 'handles deeper trees correctly', () => {

			// 5-node tree:
			// root(0) → left(1), right(2)
			// left(1) → leaf(3, tri 0), leaf(4, tri 1)
			// right(2) = leaf(tri 2)
			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ), // 0: root
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 3, [ 0, 0, 0 ], [ 1, 1, 1 ], 4 ), // 1: inner
				...makeLeaf( 2, 1 ),  // 2: right leaf (tri 2)
				...makeLeaf( 0, 1 ),  // 3: left-left leaf (tri 0)
				...makeLeaf( 1, 1 ),  // 4: left-right leaf (tri 1)
			] );

			const triangleData = new Float32Array( 96 ); // 3 triangles
			triangleData.set( makeTriangle( - 1, - 1, - 1, 0, - 1, - 1, - 1, 0, - 1 ), 0 );
			triangleData.set( makeTriangle( 1, 1, 1, 2, 1, 1, 1, 2, 1 ), 32 );
			triangleData.set( makeTriangle( 10, 10, 10, 11, 10, 10, 10, 11, 10 ), 64 );

			refitter.refit( bvhData, triangleData, 5 );

			// Node 1's left child (node 3) = tri 0 bounds = (-1,-1,-1)→(0,0,-1)
			expect( bvhData[ 16 + 0 ] ).toBe( - 1 ); // leftMin.x
			expect( bvhData[ 16 + 4 ] ).toBe( 0 );   // leftMax.x

			// Root's right child (node 2) = tri 2 bounds = (10,10,10)→(11,11,10)
			expect( bvhData[ 8 ] ).toBe( 10 );   // rightMin.x
			expect( bvhData[ 12 ] ).toBe( 11 );  // rightMax.x

		} );

	} );

} );
