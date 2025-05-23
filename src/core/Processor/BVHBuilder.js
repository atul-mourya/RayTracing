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

// Helper class for better cache locality and performance
class TriangleInfo {

	constructor( triangle, index ) {

		this.triangle = triangle;
		this.index = index;
		// Pre-compute centroid for better performance
		this.centroid = new Vector3(
			( triangle.posA.x + triangle.posB.x + triangle.posC.x ) / 3,
			( triangle.posA.y + triangle.posB.y + triangle.posC.y ) / 3,
			( triangle.posA.z + triangle.posB.z + triangle.posC.z ) / 3
		);
		// Pre-compute bounds
		this.bounds = {
			min: new Vector3(
				Math.min( triangle.posA.x, triangle.posB.x, triangle.posC.x ),
				Math.min( triangle.posA.y, triangle.posB.y, triangle.posC.y ),
				Math.min( triangle.posA.z, triangle.posB.z, triangle.posC.z )
			),
			max: new Vector3(
				Math.max( triangle.posA.x, triangle.posB.x, triangle.posC.x ),
				Math.max( triangle.posA.y, triangle.posB.y, triangle.posC.y ),
				Math.max( triangle.posA.z, triangle.posB.z, triangle.posC.z )
			)
		};

	}

}

export default class OptimizedBVHBuilder {

	constructor() {

		this.useWorker = true;
		this.maxLeafSize = 8; // Slightly larger for better performance
		this.numBins = 32; // More bins for better quality
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100;

		// SAH constants for better quality
		this.traversalCost = 1.0;
		this.intersectionCost = 1.0;

		// Temporary arrays to avoid allocations
		this.tempLeftTris = [];
		this.tempRightTris = [];
		this.binBounds = [];
		this.binCounts = [];

		// Split method statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			failedSplits: 0
		};

		// Initialize bins
		for ( let i = 0; i < this.numBins; i ++ ) {

			this.binBounds[ i ] = {
				min: new Vector3(),
				max: new Vector3()
			};
			this.binCounts[ i ] = 0;

		}

	}

	build( triangles, depth = 30, progressCallback = null ) {

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

						if ( progress !== undefined && progressCallback ) {

							progressCallback( progress );
							return;

						}

						triangles.length = newTriangles.length;
						for ( let i = 0; i < newTriangles.length; i ++ ) {

							triangles[ i ] = newTriangles[ i ];

						}

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

		// Reset split statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			failedSplits: 0
		};

		// Convert to TriangleInfo for better performance
		const triangleInfos = triangles.map( ( tri, index ) => new TriangleInfo( tri, index ) );

		// Create root node
		const root = this.buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback );

		console.log( 'BVH Statistics:', {
			totalNodes: this.totalNodes,
			triangleCount: reorderedTriangles.length,
			maxDepth: depth,
			splitMethods: {
				SAH: this.splitStats.sahSplits,
				objectMedian: this.splitStats.objectMedianSplits,
				failed: this.splitStats.failedSplits
			}
		} );

		if ( progressCallback ) {

			progressCallback( 100 );

		}

		return root;

	}

	updateProgress( trianglesProcessed, progressCallback ) {

		if ( ! progressCallback ) return;

		this.processedTriangles += trianglesProcessed;

		const now = performance.now();
		if ( now - this.lastProgressUpdate < this.progressUpdateInterval ) {

			return;

		}

		this.lastProgressUpdate = now;
		const progress = Math.min( Math.floor( ( this.processedTriangles / this.totalTriangles ) * 100 ), 99 );
		progressCallback( progress );

	}

	buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback ) {

		const node = new CWBVHNode();
		this.nodes.push( node );
		this.totalNodes ++;

		// Update bounds using pre-computed triangle bounds
		this.updateNodeBoundsOptimized( node, triangleInfos );

		// Check for leaf conditions
		if ( triangleInfos.length <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			// Add original triangles to reordered array
			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Find split position using improved SAH
		const splitInfo = this.findBestSplitPositionSAH( triangleInfos, node );

		if ( ! splitInfo.success ) {

			// Track failed splits
			this.splitStats.failedSplits ++;

			// Make a leaf node if split failed
			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Track successful split method
		if ( splitInfo.method === 'SAH' ) {

			this.splitStats.sahSplits ++;

		} else if ( splitInfo.method === 'object_median' ) {

			this.splitStats.objectMedianSplits ++;

		}

		// Partition triangles efficiently
		const { left: leftTris, right: rightTris } = this.partitionTrianglesOptimized(
			triangleInfos,
			splitInfo.axis,
			splitInfo.pos
		);

		// Fall back to leaf if partition failed
		if ( leftTris.length === 0 || rightTris.length === 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Recursively build children
		node.leftChild = this.buildNodeRecursive( leftTris, depth - 1, reorderedTriangles, progressCallback );
		node.rightChild = this.buildNodeRecursive( rightTris, depth - 1, reorderedTriangles, progressCallback );

		return node;

	}

	findBestSplitPositionSAH( triangleInfos, parentNode ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		const parentSA = this.computeSurfaceAreaFromBounds( parentNode.boundsMin, parentNode.boundsMax );
		const leafCost = this.intersectionCost * triangleInfos.length;

		for ( let axis = 0; axis < 3; axis ++ ) {

			// Find centroid bounds for this axis
			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				minCentroid = Math.min( minCentroid, centroid );
				maxCentroid = Math.max( maxCentroid, centroid );

			}

			if ( maxCentroid - minCentroid < 1e-6 ) continue; // Skip degenerate axis

			// Reset bins
			for ( let i = 0; i < this.numBins; i ++ ) {

				this.binCounts[ i ] = 0;
				this.binBounds[ i ].min.set( Infinity, Infinity, Infinity );
				this.binBounds[ i ].max.set( - Infinity, - Infinity, - Infinity );

			}

			// Place triangles into bins
			const binScale = this.numBins / ( maxCentroid - minCentroid );
			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				let binIndex = Math.floor( ( centroid - minCentroid ) * binScale );
				binIndex = Math.min( binIndex, this.numBins - 1 );

				this.binCounts[ binIndex ] ++;
				this.expandBounds( this.binBounds[ binIndex ], triInfo.bounds );

			}

			// Evaluate splits between bins
			for ( let i = 1; i < this.numBins; i ++ ) {

				// Count triangles and compute bounds for left side
				let leftCount = 0;
				const leftBounds = {
					min: new Vector3( Infinity, Infinity, Infinity ),
					max: new Vector3( - Infinity, - Infinity, - Infinity )
				};

				for ( let j = 0; j < i; j ++ ) {

					if ( this.binCounts[ j ] > 0 ) {

						leftCount += this.binCounts[ j ];
						this.expandBounds( leftBounds, this.binBounds[ j ] );

					}

				}

				// Count triangles and compute bounds for right side
				let rightCount = 0;
				const rightBounds = {
					min: new Vector3( Infinity, Infinity, Infinity ),
					max: new Vector3( - Infinity, - Infinity, - Infinity )
				};

				for ( let j = i; j < this.numBins; j ++ ) {

					if ( this.binCounts[ j ] > 0 ) {

						rightCount += this.binCounts[ j ];
						this.expandBounds( rightBounds, this.binBounds[ j ] );

					}

				}

				if ( leftCount === 0 || rightCount === 0 ) continue;

				// Compute SAH cost
				const leftSA = this.computeSurfaceAreaFromBounds( leftBounds.min, leftBounds.max );
				const rightSA = this.computeSurfaceAreaFromBounds( rightBounds.min, rightBounds.max );

				const cost = this.traversalCost +
					( leftSA / parentSA ) * leftCount * this.intersectionCost +
					( rightSA / parentSA ) * rightCount * this.intersectionCost;

				if ( cost < bestCost && cost < leafCost ) {

					bestCost = cost;
					bestAxis = axis;
					bestPos = minCentroid + ( maxCentroid - minCentroid ) * i / this.numBins;

				}

			}

		}

		// If SAH failed to find a good split, try object median as fallback
		if ( bestAxis === - 1 ) {

			return this.findObjectMedianSplit( triangleInfos );

		}

		return {
			success: bestAxis !== - 1,
			axis: bestAxis,
			pos: bestPos,
			method: 'SAH'
		};

	}

	findObjectMedianSplit( triangleInfos ) {

		let bestAxis = - 1;
		let bestSpread = - 1;

		// Find the axis with the largest spread
		for ( let axis = 0; axis < 3; axis ++ ) {

			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				minCentroid = Math.min( minCentroid, centroid );
				maxCentroid = Math.max( maxCentroid, centroid );

			}

			const spread = maxCentroid - minCentroid;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-10 ) {

			return { success: false, method: 'object_median_failed' };

		}

		// Sort triangles by centroid on the best axis
		const sortedTriangles = [ ...triangleInfos ];
		sortedTriangles.sort( ( a, b ) => {

			return a.centroid.getComponent( bestAxis ) - b.centroid.getComponent( bestAxis );

		} );

		// Find median position
		const medianIndex = Math.floor( sortedTriangles.length / 2 );
		const medianCentroid = sortedTriangles[ medianIndex ].centroid.getComponent( bestAxis );

		// Ensure we don't get an empty partition by using the actual median triangle's centroid
		// and adjusting slightly if needed
		let splitPos = medianCentroid;

		// Check if this split would create balanced partitions
		let leftCount = 0;
		for ( const triInfo of triangleInfos ) {

			if ( triInfo.centroid.getComponent( bestAxis ) <= splitPos ) {

				leftCount ++;

			}

		}

		// If the split is too unbalanced, adjust it
		if ( leftCount === 0 || leftCount === triangleInfos.length ) {

			// Use the position slightly before the median triangle
			if ( medianIndex > 0 ) {

				const prevCentroid = sortedTriangles[ medianIndex - 1 ].centroid.getComponent( bestAxis );
				splitPos = ( prevCentroid + medianCentroid ) * 0.5;

			} else {

				return { success: false, method: 'object_median_degenerate' };

			}

		}

		return {
			success: true,
			axis: bestAxis,
			pos: splitPos,
			method: 'object_median'
		};

	}

	partitionTrianglesOptimized( triangleInfos, axis, splitPos ) {

		// Clear temp arrays
		this.tempLeftTris.length = 0;
		this.tempRightTris.length = 0;

		for ( const triInfo of triangleInfos ) {

			const centroid = triInfo.centroid.getComponent( axis );
			if ( centroid <= splitPos ) {

				this.tempLeftTris.push( triInfo );

			} else {

				this.tempRightTris.push( triInfo );

			}

		}

		return {
			left: this.tempLeftTris.slice(), // Copy to avoid reference issues
			right: this.tempRightTris.slice()
		};

	}

	updateNodeBoundsOptimized( node, triangleInfos ) {

		node.boundsMin.set( Infinity, Infinity, Infinity );
		node.boundsMax.set( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			node.boundsMin.min( triInfo.bounds.min );
			node.boundsMax.max( triInfo.bounds.max );

		}

	}

	expandBounds( targetBounds, sourceBounds ) {

		targetBounds.min.min( sourceBounds.min );
		targetBounds.max.max( sourceBounds.max );

	}

	computeSurfaceAreaFromBounds( boundsMin, boundsMax ) {

		const dx = boundsMax.x - boundsMin.x;
		const dy = boundsMax.y - boundsMin.y;
		const dz = boundsMax.z - boundsMin.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

	// Legacy methods for compatibility
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
