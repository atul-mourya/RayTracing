import { Vector3 } from "three";

class CWBVHNode {

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
		this.maxLeafSize = 4;
		this.numBins = 16;
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100; // ms

	}

	build( triangles, depth = 30, progressCallback = null ) { // Added progressCallback parameter

		// Store total triangles for progress calculation
		this.totalTriangles = triangles.length;
		this.processedTriangles = 0;
		this.lastProgressUpdate = performance.now();

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

			console.log( "Using Worker" );
			return new Promise( ( resolve, reject ) => {

				try {

					const worker = new Worker(
						new URL( './Workers/BVHWorker.js', import.meta.url ),
						{ type: 'module' }
					);

					worker.onmessage = ( e ) => {

						const { bvhRoot, triangles: newTriangles, error, progress } = e.data;

						if ( error ) {

							worker.terminate();
							reject( new Error( error ) );
							return;

						}

						// Handle progress updates from worker
						if ( progress !== undefined && progressCallback ) {

							progressCallback( progress );
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

					worker.postMessage( { triangles, depth, reportProgress: !! progressCallback } );

				} catch ( error ) {

					console.warn( 'Worker creation failed, falling back to synchronous build:', error );
					resolve( this.buildSync( triangles, depth, [], progressCallback ) );

				}

			} );

		} else {

			return Promise.resolve( this.buildSync( triangles, depth, [], progressCallback ) );

		}

	}

	buildSync( triangles, depth = 30, reorderedTriangles = [], progressCallback = null ) {

		// Reset state
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = triangles.length;
		this.lastProgressUpdate = performance.now();

		// Create root node
		const root = this.buildNodeRecursive( triangles, depth, reorderedTriangles, progressCallback );

		console.log( 'BVH Statistics:', {
			totalNodes: this.totalNodes,
			triangleCount: reorderedTriangles.length,
			maxDepth: depth
		} );

		// Ensure we send 100% progress at the end
		if ( progressCallback ) {

			progressCallback( 100 );

		}

		return root;

	}

	updateProgress( trianglesProcessed, progressCallback ) {

		if ( ! progressCallback ) return;

		this.processedTriangles += trianglesProcessed;

		// Limit progress updates to avoid overwhelming the UI
		const now = performance.now();
		if ( now - this.lastProgressUpdate < this.progressUpdateInterval ) {

			return;

		}

		this.lastProgressUpdate = now;

		// Calculate progress percentage (0-100)
		const progress = Math.min( Math.floor( ( this.processedTriangles / this.totalTriangles ) * 100 ), 99 );
		progressCallback( progress );

	}

	buildNodeRecursive( triangles, depth, reorderedTriangles, progressCallback ) {

		const node = new CWBVHNode();
		this.nodes.push( node );
		this.totalNodes ++;

		// Update bounds
		this.updateNodeBounds( node, triangles );

		// Check for leaf conditions
		if ( triangles.length <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangles.length;
			reorderedTriangles.push( ...triangles );

			// Update progress for leaf node creation
			this.updateProgress( triangles.length, progressCallback );

			return node;

		}

		// Find split position
		const splitInfo = this.findBestSplitPosition( triangles );

		if ( ! splitInfo.success ) {

			// Make a leaf node if split failed
			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangles.length;
			reorderedTriangles.push( ...triangles );

			// Update progress for leaf node creation after failed split
			this.updateProgress( triangles.length, progressCallback );

			return node;

		}

		// Partition triangles
		const { left: leftTris, right: rightTris } = this.partitionTriangles(
			triangles,
			splitInfo.axis,
			splitInfo.pos
		);

		// Fall back to leaf if partition failed
		if ( leftTris.length === 0 || rightTris.length === 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangles.length;
			reorderedTriangles.push( ...triangles );

			// Update progress for leaf node creation after failed partition
			this.updateProgress( triangles.length, progressCallback );

			return node;

		}

		// Recursively build children
		node.leftChild = this.buildNodeRecursive( leftTris, depth - 1, reorderedTriangles, progressCallback );
		node.rightChild = this.buildNodeRecursive( rightTris, depth - 1, reorderedTriangles, progressCallback );

		return node;

	}

	findBestSplitPosition( triangles ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		for ( let axis = 0; axis < 3; axis ++ ) {

			// Calculate bounds for centroids
			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			// Compute centroids bounds
			for ( const tri of triangles ) {

				const centroid = ( tri.posA[ axis === 0 ? 'x' : axis === 1 ? 'y' : 'z' ] +
                                tri.posB[ axis === 0 ? 'x' : axis === 1 ? 'y' : 'z' ] +
                                tri.posC[ axis === 0 ? 'x' : axis === 1 ? 'y' : 'z' ] ) / 3;
				minCentroid = Math.min( minCentroid, centroid );
				maxCentroid = Math.max( maxCentroid, centroid );

			}

			// Try potential split positions
			for ( let i = 1; i < this.numBins; i ++ ) {

				const splitPos = minCentroid + ( maxCentroid - minCentroid ) * i / this.numBins;
				const partition = this.partitionTriangles( triangles, axis === 0 ? 'x' : axis === 1 ? 'y' : 'z', splitPos );

				if ( partition.left.length === 0 || partition.right.length === 0 ) continue;

				const cost = this.evaluateSplitCost( partition.left, partition.right );
				if ( cost < bestCost ) {

					bestCost = cost;
					bestAxis = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
					bestPos = splitPos;

				}

			}

		}

		return {
			success: bestAxis !== - 1,
			axis: bestAxis,
			pos: bestPos
		};

	}

	partitionTriangles( triangles, axis, splitPos ) {

		const left = [];
		const right = [];

		for ( const tri of triangles ) {

			const centroid = ( tri.posA[ axis ] + tri.posB[ axis ] + tri.posC[ axis ] ) / 3;
			if ( centroid <= splitPos ) {

				left.push( tri );

			} else {

				right.push( tri );

			}

		}

		return { left, right };

	}

	evaluateSplitCost( leftTris, rightTris ) {

		const leftBounds = this.computeBounds( leftTris );
		const rightBounds = this.computeBounds( rightTris );
		const leftSA = this.computeSurfaceArea( leftBounds );
		const rightSA = this.computeSurfaceArea( rightBounds );

		return leftTris.length * leftSA + rightTris.length * rightSA;

	}

	updateNodeBounds( node, triangles ) {

		node.boundsMin.set( Infinity, Infinity, Infinity );
		node.boundsMax.set( - Infinity, - Infinity, - Infinity );

		for ( const tri of triangles ) {

			node.boundsMin.x = Math.min( node.boundsMin.x, tri.posA.x, tri.posB.x, tri.posC.x );
			node.boundsMin.y = Math.min( node.boundsMin.y, tri.posA.y, tri.posB.y, tri.posC.y );
			node.boundsMin.z = Math.min( node.boundsMin.z, tri.posA.z, tri.posB.z, tri.posC.z );

			node.boundsMax.x = Math.max( node.boundsMax.x, tri.posA.x, tri.posB.x, tri.posC.x );
			node.boundsMax.y = Math.max( node.boundsMax.y, tri.posA.y, tri.posB.y, tri.posC.y );
			node.boundsMax.z = Math.max( node.boundsMax.z, tri.posA.z, tri.posB.z, tri.posC.z );

		}

	}

	computeBounds( triangles ) {

		const bounds = {
			min: new Vector3( Infinity, Infinity, Infinity ),
			max: new Vector3( - Infinity, - Infinity, - Infinity )
		};

		for ( const tri of triangles ) {

			bounds.min.x = Math.min( bounds.min.x, tri.posA.x, tri.posB.x, tri.posC.x );
			bounds.min.y = Math.min( bounds.min.y, tri.posA.y, tri.posB.y, tri.posC.y );
			bounds.min.z = Math.min( bounds.min.z, tri.posA.z, tri.posB.z, tri.posC.z );

			bounds.max.x = Math.max( bounds.max.x, tri.posA.x, tri.posB.x, tri.posC.x );
			bounds.max.y = Math.max( bounds.max.y, tri.posA.y, tri.posB.y, tri.posC.y );
			bounds.max.z = Math.max( bounds.max.z, tri.posA.z, tri.posB.z, tri.posC.z );

		}

		return bounds;

	}

	computeSurfaceArea( bounds ) {

		const dx = bounds.max.x - bounds.min.x;
		const dy = bounds.max.y - bounds.min.y;
		const dz = bounds.max.z - bounds.min.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

}
