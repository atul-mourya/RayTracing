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
		const binCount = 8; // Number of bins per axis for spatial binning

		let nodeCount = 0;
		let leafCount = 0;
		const leafDepths = [];
		const leafTriangles = [];

		const computeSurfaceArea = ( min, max ) => {

			const dx = max.x - min.x;
			const dy = max.y - min.y;
			const dz = max.z - min.z;
			return 2 * ( dx * dy + dy * dz + dz * dx );

		};

		const calculateBoundingBox = ( triangles ) => {

			const boundsMin = new Vector3( Infinity, Infinity, Infinity );
			const boundsMax = new Vector3( - Infinity, - Infinity, - Infinity );
			triangles.forEach( tri => {

				boundsMin.min( tri.posA ).min( tri.posB ).min( tri.posC );
				boundsMax.max( tri.posA ).max( tri.posB ).max( tri.posC );

			} );
			return [ boundsMin, boundsMax ];

		};

		const buildNode = ( _triangles, depth = 0 ) => {

			nodeCount ++;
			const node = new BVHNode();

			if ( _triangles.length <= maxTrianglesPerLeaf ) {

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
				leafTriangles.push( _triangles.length );

				return node;

			}

			let bestCost = Infinity;
			let bestAxis = - 1;
			let bestSplitIndex = - 1;
			let bestLeftTriangles = [];
			let bestRightTriangles = [];

			for ( let axisIdx = 0; axisIdx < 3; axisIdx ++ ) {

				const axis = [ 'x', 'y', 'z' ][ axisIdx ];

				// Sort triangles by centroids along current axis
				const centroids = _triangles.map( tri => {

					const centroid = new Vector3();
					centroid.add( tri.posA ).add( tri.posB ).add( tri.posC ).divideScalar( 3 );
					return centroid[ axis ]; // Correctly get the centroid's coordinate along the chosen axis

				} );
				const sortedTriangles = _triangles
					.map( ( tri, i ) => ( { tri, centroid: centroids[ i ] } ) )
					.sort( ( a, b ) => a.centroid - b.centroid )
					.map( item => item.tri );

				// Divide triangles into bins and compute bounds for each bin
				const bins = Array.from( { length: binCount }, () => [] );
				sortedTriangles.forEach( ( tri, i ) => {

					const binIndex = Math.floor( i / ( _triangles.length / binCount ) );
					if ( binIndex >= 0 && binIndex < binCount ) {

						bins[ binIndex ].push( tri );

					}

				} );

				// Evaluate SAH cost across bin edges
				for ( let i = 1; i < binCount; i ++ ) {

					const leftTriangles = bins.slice( 0, i ).flat();
					const rightTriangles = bins.slice( i ).flat();

					const [ leftMin, leftMax ] = calculateBoundingBox( leftTriangles );
					const [ rightMin, rightMax ] = calculateBoundingBox( rightTriangles );

					const leftArea = computeSurfaceArea( leftMin, leftMax );
					const rightArea = computeSurfaceArea( rightMin, rightMax );
					const cost = leftArea * leftTriangles.length + rightArea * rightTriangles.length;

					if ( cost < bestCost ) {

						bestCost = cost;
						bestAxis = axisIdx;
						bestSplitIndex = i;
						bestLeftTriangles = leftTriangles;
						bestRightTriangles = rightTriangles;

					}

				}

			}

			// If no optimal split found, fallback to median split
			if ( bestAxis === - 1 || bestSplitIndex === - 1 || bestCost === Infinity ) {

				_triangles.sort( ( a, b ) => {

					const centroidA = ( a.posA.x + a.posB.x + a.posC.x ) / 3; // Use x for centroid
					const centroidB = ( b.posA.x + b.posB.x + b.posC.x ) / 3; // Use x for centroid
					return centroidA - centroidB;

				} );
				const mid = Math.floor( _triangles.length / 2 );
				bestLeftTriangles = _triangles.slice( 0, mid );
				bestRightTriangles = _triangles.slice( mid );

			}

			// Recursively build children
			node.leftChild = buildNode( bestLeftTriangles, depth + 1 );
			node.rightChild = buildNode( bestRightTriangles, depth + 1 );

			// Set node bounds based on child bounds
			node.boundsMin.copy( node.leftChild.boundsMin ).min( node.rightChild.boundsMin );
			node.boundsMax.copy( node.leftChild.boundsMax ).max( node.rightChild.boundsMax );

			return node;

		};

		const startTime = performance.now();
		const bvhRoot = buildNode( triangles, depth );
		const endTime = performance.now();

		// Calculate leaf statistics
		// const minLeafDepth = Math.min( ...leafDepths );
		// const maxLeafDepth = Math.max( ...leafDepths );
		// const meanLeafDepth = leafDepths.reduce( ( a, b ) => a + b, 0 ) / leafDepths.length;

		// const minLeafTris = Math.min( ...leafTriangles );
		// const maxLeafTris = Math.max( ...leafTriangles );
		// const meanLeafTris = leafTriangles.reduce( ( a, b ) => a + b, 0 ) / leafTriangles.length;

		// Log the statistics
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

}
