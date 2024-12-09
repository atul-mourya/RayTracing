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

	constructor() {

		this.useWorker = true;

	}

	build( triangles, depth ) {

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

			console.log( "Using Worker" );
			return new Promise( ( resolve, reject ) => {

				try {

					const worker = new Worker(
						new URL( './Workers/BVHWorker.js', import.meta.url ),
						{ type: 'module' }
					);

					worker.onmessage = ( e ) => {

						const { bvhRoot, triangles: newTriangles, error } = e.data;

						if ( error ) {

							worker.terminate();
							reject( new Error( error ) );
							return;

						}

						// Update triangles array
						triangles.length = newTriangles.length;
						for ( let i = 0; i < newTriangles.length; i ++ ) {

							triangles[ i ] = newTriangles[ i ];

						}

						// bvhRoot can be used directly
						worker.terminate();
						resolve( bvhRoot );

					};

					worker.onerror = ( error ) => {

						worker.terminate();
						reject( error );

					};

					worker.postMessage( { triangles, depth } );

				} catch ( error ) {

					console.warn( 'Worker creation failed, falling back to synchronous build:', error );
					resolve( this.buildSync( triangles, depth ) );

				}

			} );

		} else {

			return Promise.resolve( this.buildSync( triangles, depth ) );

		}

	}

	// Add this to your BVHBuilder class, replacing the existing buildSync method

	buildSync( triangles, depth, reorderedTriangles = [] ) {

		if ( reorderedTriangles === triangles ) {

			reorderedTriangles = [];

		}

		const maxTrianglesPerLeaf = 6;
		const binCount = 8; // Number of bins per axis for spatial binning
		let nodeCount = 0;
		let leafCount = 0;

		class BuildItem {

			constructor( triangles, depth, parent = null, isLeftChild = true ) {

				this.triangles = triangles;
				this.depth = depth;
				this.parent = parent;
				this.isLeftChild = isLeftChild;

			}

		}

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

		// Start with root
		const stack = [];
		const rootNode = new BVHNode();
		nodeCount ++;

		stack.push( new BuildItem( triangles, depth ) );
		let currentNode = rootNode;

		while ( stack.length > 0 ) {

			const item = stack.pop();
			const triangles = item.triangles;
			const depth = item.depth;

			const node = new BVHNode();
			nodeCount ++;

			// Link node to parent if not root
			if ( item.parent ) {

				if ( item.isLeftChild ) {

					item.parent.leftChild = node;

				} else {

					item.parent.rightChild = node;

				}

			} else {

				currentNode = node; // This is the root node

			}

			// Leaf node case
			if ( triangles.length <= maxTrianglesPerLeaf ) {

				node.boundsMin.set( Infinity, Infinity, Infinity );
				node.boundsMax.set( - Infinity, - Infinity, - Infinity );
				triangles.forEach( tri => {

					node.boundsMin.min( tri.posA ).min( tri.posB ).min( tri.posC );
					node.boundsMax.max( tri.posA ).max( tri.posB ).max( tri.posC );

				} );

				node.triangleOffset = reorderedTriangles.length;
				node.triangleCount = triangles.length;
				for ( let i = 0; i < triangles.length; i ++ ) {

					reorderedTriangles[ node.triangleOffset + i ] = triangles[ i ];

				}

				leafCount ++;
				continue;

			}

			// Find best split
			let bestCost = Infinity;
			let bestAxis = - 1;
			let bestSplitIndex = - 1;
			let bestLeftTriangles = [];
			let bestRightTriangles = [];

			// Try each axis
			for ( let axisIdx = 0; axisIdx < 3; axisIdx ++ ) {

				const axis = [ 'x', 'y', 'z' ][ axisIdx ];

				// Sort triangles by centroids
				const centroids = triangles.map( tri => {

					const centroid = new Vector3();
					centroid.add( tri.posA ).add( tri.posB ).add( tri.posC ).divideScalar( 3 );
					return centroid[ axis ]; // Correctly get the centroid's coordinate along the chosen axis

				} );
				const sortedTriangles = triangles
					.map( ( tri, i ) => ( { tri, centroid: centroids[ i ] } ) )
					.sort( ( a, b ) => a.centroid - b.centroid )
					.map( item => item.tri );

				// Divide triangles into bins and compute bounds for each bin
				const bins = Array.from( { length: binCount }, () => [] );
				sortedTriangles.forEach( ( tri, i ) => {

					const binIndex = Math.floor( i / ( triangles.length / binCount ) );
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
			if ( bestAxis === - 1 || bestSplitIndex === - 1 ) {

				triangles.sort( ( a, b ) => {

					const centroidA = ( a.posA.x + a.posB.x + a.posC.x ) / 3; // Use x for centroid
					const centroidB = ( b.posA.x + b.posB.x + b.posC.x ) / 3; // Use x for centroid
					return centroidA - centroidB;

				} );
				const mid = Math.floor( triangles.length / 2 );
				bestLeftTriangles = triangles.slice( 0, mid );
				bestRightTriangles = triangles.slice( mid );

			}

			// Set node bounds
			const [ nodeMin, nodeMax ] = calculateBoundingBox( triangles );
			// Set node bounds based on child bounds
			node.boundsMin.copy( nodeMin );
			node.boundsMax.copy( nodeMax );

			// Push children to stack
			stack.push( new BuildItem( bestRightTriangles, depth + 1, node, false ) );
			stack.push( new BuildItem( bestLeftTriangles, depth + 1, node, true ) );

		}

		console.log( 'Node Count:', nodeCount );
		console.log( 'Leaf Count:', leafCount );
		console.log( 'Triangles:', reorderedTriangles.length );

		return currentNode;

	}

}
