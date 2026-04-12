import { describe, it, expect, beforeEach } from 'vitest';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';

function makeEntry( meshIndex, aabb, blasOffset = 0 ) {

	return {
		meshIndex,
		blasOffset,
		blasNodeCount: 3,
		triOffset: meshIndex * 10,
		triCount: 10,
		worldAABB: aabb,
		originalToBvhMap: null,
		bvhData: null,
	};

}

function makeAABB( minX, minY, minZ, maxX, maxY, maxZ ) {

	return { minX, minY, minZ, maxX, maxY, maxZ };

}

describe( 'TLASBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new TLASBuilder();

	} );

	describe( 'build', () => {

		it( 'returns null root for empty entries', () => {

			const { root, nodeCount } = builder.build( [] );
			expect( root ).toBeNull();
			expect( nodeCount ).toBe( 0 );

		} );

		it( 'creates single leaf for one entry', () => {

			const entries = [ makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ) ) ];
			const { root, nodeCount } = builder.build( entries );

			expect( nodeCount ).toBe( 1 );
			expect( root.entryIndex ).toBe( 0 );
			expect( root.leftChild ).toBeNull();
			expect( root.rightChild ).toBeNull();

		} );

		it( 'creates balanced tree for two entries', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ) ),
				makeEntry( 1, makeAABB( 5, 5, 5, 6, 6, 6 ) ),
			];
			const { root, nodeCount } = builder.build( entries );

			expect( nodeCount ).toBe( 3 ); // root + 2 leaves
			expect( root.leftChild ).not.toBeNull();
			expect( root.rightChild ).not.toBeNull();
			expect( root.leftChild.entryIndex ).toBeGreaterThanOrEqual( 0 );
			expect( root.rightChild.entryIndex ).toBeGreaterThanOrEqual( 0 );

		} );

		it( 'builds SAH tree for multiple entries', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ) ),
				makeEntry( 1, makeAABB( 2, 0, 0, 3, 1, 1 ) ),
				makeEntry( 2, makeAABB( 4, 0, 0, 5, 1, 1 ) ),
				makeEntry( 3, makeAABB( 6, 0, 0, 7, 1, 1 ) ),
			];
			const { root, nodeCount } = builder.build( entries );

			// 4 leaves + 3 inner nodes = 7
			expect( nodeCount ).toBe( 7 );
			// Root should encompass all entries
			expect( root.minX ).toBe( 0 );
			expect( root.maxX ).toBe( 7 );

		} );

		it( 'handles overlapping AABBs', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 5, 5, 5 ) ),
				makeEntry( 1, makeAABB( 3, 3, 3, 8, 8, 8 ) ),
				makeEntry( 2, makeAABB( 1, 1, 1, 4, 4, 4 ) ),
			];
			const { root, nodeCount } = builder.build( entries );

			expect( nodeCount ).toBe( 5 ); // 3 leaves + 2 inner
			expect( root.minX ).toBe( 0 );
			expect( root.maxX ).toBe( 8 );

		} );

	} );

	describe( 'flatten', () => {

		it( 'returns empty array for null root', () => {

			const data = builder.flatten( null, [] );
			expect( data ).toHaveLength( 0 );

		} );

		it( 'flattens single-leaf TLAS with BLAS-pointer marker', () => {

			const entries = [ makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ), 10 ) ];
			const { root } = builder.build( entries );
			const data = builder.flatten( root, entries );

			expect( data ).toHaveLength( 16 ); // 1 node * 16 floats
			expect( data[ 0 ] ).toBe( 10 ); // blasOffset
			expect( data[ 3 ] ).toBe( - 2 ); // BLAS-pointer marker

		} );

		it( 'flattens multi-entry TLAS with correct markers', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ), 5 ),
				makeEntry( 1, makeAABB( 2, 2, 2, 3, 3, 3 ), 15 ),
			];
			const { root } = builder.build( entries );
			const data = builder.flatten( root, entries );

			expect( data ).toHaveLength( 48 ); // 3 nodes * 16 floats

			// Count BLAS-pointer leaves (marker -2)
			let blasPointers = 0;
			let innerNodes = 0;
			for ( let i = 0; i < 3; i ++ ) {

				const marker = data[ i * 16 + 3 ];
				if ( marker === - 2 ) blasPointers ++;
				else if ( marker >= 0 ) innerNodes ++;

			}

			expect( blasPointers ).toBe( 2 );
			expect( innerNodes ).toBe( 1 );

		} );

		it( 'inner nodes have valid child indices in pre-order', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ), 100 ),
				makeEntry( 1, makeAABB( 5, 5, 5, 6, 6, 6 ), 200 ),
			];
			const { root } = builder.build( entries );
			const data = builder.flatten( root, entries );

			// Root is node 0 (inner), children are nodes 1 and 2
			const leftChild = data[ 3 ]; // leftChild index
			const rightChild = data[ 7 ]; // rightChild index
			expect( leftChild ).toBeGreaterThanOrEqual( 1 );
			expect( leftChild ).toBeLessThan( 3 );
			expect( rightChild ).toBeGreaterThanOrEqual( 1 );
			expect( rightChild ).toBeLessThan( 3 );
			expect( leftChild ).not.toBe( rightChild );

		} );

		it( 'reuses cached flatten buffer across calls', () => {

			const entries = [
				makeEntry( 0, makeAABB( 0, 0, 0, 1, 1, 1 ), 5 ),
				makeEntry( 1, makeAABB( 2, 2, 2, 3, 3, 3 ), 15 ),
			];
			const { root } = builder.build( entries );

			builder.flatten( root, entries );
			const firstBuffer = builder._flatBuffer;

			builder.flatten( root, entries );
			expect( builder._flatBuffer ).toBe( firstBuffer ); // same buffer reused

		} );

	} );

} );
