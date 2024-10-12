import { Vector3 } from "three";

class BVHNode {

	constructor() {

		this.boundsMin = new Vector3();
		this.boundsMax = new Vector3();
		this.leftChild = null;
		this.rightChild = null;
		this.triangleOffset = 0;
		this.triangleCount = 0;

	}

}

export default class BVHBuilder {

	build( triangles, depth ) {

		const maxTrianglesPerLeaf = 6;
		const axis = [ 'x', 'y', 'z' ];

		// Stats variables
		let leafDepths = [];
		let leafTriangles = [];
		let nodeCount = 0;
		let leafCount = 0;

		const buildNode = ( _triangles, depth = 0 ) => {

			nodeCount ++;
			const node = new BVHNode();

			if ( _triangles.length <= maxTrianglesPerLeaf ) {

				// Leaf node: Compute bounds directly
				node.boundsMin.set( Infinity, Infinity, Infinity );
				node.boundsMax.set( - Infinity, - Infinity, - Infinity );
				_triangles.forEach( tri => {

					node.boundsMin.min( tri.posA ).min( tri.posB ).min( tri.posC );
					node.boundsMax.max( tri.posA ).max( tri.posB ).max( tri.posC );

				} );

				node.triangleOffset = triangles.length;
				node.triangleCount = _triangles.length;
				triangles.push( ..._triangles );

				// Collect leaf statistics
				leafCount ++;
				leafDepths.push( depth );
				leafTriangles.push( triangles.length );

				return node;

			}

			// Internal node: Split and compute bounds from children
			const splitAxis = axis[ depth % 3 ];
			_triangles.sort( ( a, b ) => {

				const centroidA = ( a.posA[ splitAxis ] + a.posB[ splitAxis ] + a.posC[ splitAxis ] ) / 3;
				const centroidB = ( b.posA[ splitAxis ] + b.posB[ splitAxis ] + b.posC[ splitAxis ] ) / 3;
				return centroidA - centroidB;

			} );

			const mid = Math.floor( _triangles.length / 2 );
			node.leftChild = buildNode( _triangles.slice( 0, mid ), depth + 1 );
			node.rightChild = buildNode( _triangles.slice( mid ), depth + 1 );

			// Compute bounds from children
			node.boundsMin.copy( node.leftChild.boundsMin ).min( node.rightChild.boundsMin );
			node.boundsMax.copy( node.leftChild.boundsMax ).max( node.rightChild.boundsMax );

			return node;

		};


		// Start timing
		const startTime = performance.now();

		const bvhRoot = buildNode( triangles, depth );

		// End timing
		const endTime = performance.now();

		// Calculate statistics
		// const minLeafDepth = Math.min( ...leafDepths );
		// const maxLeafDepth = Math.max( ...leafDepths );
		// const meanLeafDepth = leafDepths.reduce( ( a, b ) => a + b, 0 ) / leafDepths.length;

		// const minLeafTris = Math.min( ...leafTriangles );
		// const maxLeafTris = Math.max( ...leafTriangles );
		// const meanLeafTris = leafTriangles.reduce( ( a, b ) => a + b, 0 ) / leafTriangles.length;

		// // Log the stats
		console.log( 'Time (ms):', endTime - startTime );
		console.log( 'Triangles:', triangles.length );
		console.log( 'Node Count:', nodeCount );
		console.log( 'Leaf Count:', leafCount );
		// console.log( 'Leaf Depth - Min:', minLeafDepth );
		// console.log( 'Leaf Depth - Max:', maxLeafDepth );
		// console.log( 'Leaf Depth - Mean:', meanLeafDepth );
		// console.log( 'Leaf Tris - Min:', minLeafTris );
		// console.log( 'Leaf Tris - Max:', maxLeafTris );
		// console.log( 'Leaf Tris - Mean:', meanLeafTris );

		return bvhRoot;

	}

	// Helper methods for BVH building...

}
