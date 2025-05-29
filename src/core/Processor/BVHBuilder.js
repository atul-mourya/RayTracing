import { Vector3 } from "three";

// Import the data layout constants
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 25,
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 3,
	POSITION_C_OFFSET: 6,
	NORMAL_A_OFFSET: 9,
	NORMAL_B_OFFSET: 12,
	NORMAL_C_OFFSET: 15,
	UV_A_OFFSET: 18,
	UV_B_OFFSET: 20,
	UV_C_OFFSET: 22,
	MATERIAL_INDEX_OFFSET: 24
};

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
// Updated to work with both object triangles and Float32Array triangles
class TriangleInfo {

	constructor( triangle, index, triangleData = null ) {

		this.index = index;
		this.triangleData = triangleData;

		// If we have Float32Array data, create a triangle wrapper
		if ( triangleData ) {

			this.triangle = new TriangleWrapper( triangleData, index );

		} else {

			this.triangle = triangle;

		}

		// Pre-compute centroid for better performance
		this.centroid = new Vector3(
			( this.triangle.posA.x + this.triangle.posB.x + this.triangle.posC.x ) / 3,
			( this.triangle.posA.y + this.triangle.posB.y + this.triangle.posC.y ) / 3,
			( this.triangle.posA.z + this.triangle.posB.z + this.triangle.posC.z ) / 3
		);

		// Pre-compute bounds
		this.bounds = {
			min: new Vector3(
				Math.min( this.triangle.posA.x, this.triangle.posB.x, this.triangle.posC.x ),
				Math.min( this.triangle.posA.y, this.triangle.posB.y, this.triangle.posC.y ),
				Math.min( this.triangle.posA.z, this.triangle.posB.z, this.triangle.posC.z )
			),
			max: new Vector3(
				Math.max( this.triangle.posA.x, this.triangle.posB.x, this.triangle.posC.x ),
				Math.max( this.triangle.posA.y, this.triangle.posB.y, this.triangle.posC.y ),
				Math.max( this.triangle.posA.z, this.triangle.posB.z, this.triangle.posC.z )
			)
		};

		// Morton code will be computed later during sorting
		this.mortonCode = 0;

	}

}

// Wrapper class to provide object-like access to Float32Array triangle data
class TriangleWrapper {

	constructor( triangleData, triangleIndex ) {

		this.data = triangleData;
		this.index = triangleIndex;
		this.offset = triangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

	}

	get posA() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ]
		};

	}

	get posB() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ]
		};

	}

	get posC() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ]
		};

	}

	get normalA() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ]
		};

	}

	get normalB() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ]
		};

	}

	get normalC() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ],
			z: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ]
		};

	}

	get uvA() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 1 ]
		};

	}

	get uvB() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 1 ]
		};

	}

	get uvC() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 1 ]
		};

	}

	get materialIndex() {

		return this.data[ this.offset + TRIANGLE_DATA_LAYOUT.MATERIAL_INDEX_OFFSET ];

	}

}

export default class BVHBuilder {

	constructor() {

		this.useWorker = true;
		this.maxLeafSize = 8; // Slightly larger for better performance
		this.numBins = 32; // Base number of bins (will be adapted)
		this.minBins = 8; // Minimum bins for sparse nodes
		this.maxBins = 64; // Maximum bins for dense nodes
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100;

		// SAH constants for better quality
		this.traversalCost = 1.0;
		this.intersectionCost = 1.0;

		// Morton code clustering settings
		this.useMortonCodes = true; // Enable spatial clustering
		this.mortonBits = 10; // Precision for Morton codes (10 bits per axis = 30 total)
		this.mortonClusterThreshold = 128; // Use Morton clustering for nodes with more triangles

		// Fallback method configuration
		this.enableObjectMedianFallback = true;
		this.enableSpatialMedianFallback = true;

		// Temporary arrays to avoid allocations
		this.tempLeftTris = [];
		this.tempRightTris = [];
		this.binBounds = [];
		this.binCounts = [];

		// Split method statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0
		};

		// Pre-allocate maximum bin arrays to avoid reallocations
		this.initializeBinArrays();

	}

	initializeBinArrays() {

		// Pre-allocate for maximum bins to avoid reallocations
		for ( let i = 0; i < this.maxBins; i ++ ) {

			this.binBounds[ i ] = {
				min: new Vector3(),
				max: new Vector3()
			};
			this.binCounts[ i ] = 0;

		}

	}

	getOptimalBinCount( triangleCount ) {

		// Adaptive bin count based on triangle density
		// More triangles = more bins for better quality
		// Fewer triangles = fewer bins for better performance

		if ( triangleCount <= 16 ) {

			return this.minBins; // 8 bins for very sparse nodes

		} else if ( triangleCount <= 64 ) {

			return 16; // Medium bin count for moderate density

		} else if ( triangleCount <= 256 ) {

			return 32; // Standard bin count

		} else if ( triangleCount <= 1024 ) {

			return 48; // Higher bin count for dense nodes

		} else {

			return this.maxBins; // Maximum bins for very dense nodes

		}

	}

	// Configuration method for fine-tuning adaptive behavior
	setAdaptiveBinConfig( config ) {

		if ( config.minBins !== undefined ) this.minBins = Math.max( 4, config.minBins );
		if ( config.maxBins !== undefined ) this.maxBins = Math.min( 128, config.maxBins );
		if ( config.baseBins !== undefined ) this.numBins = config.baseBins;

		// Re-initialize bin arrays if max bins changed
		if ( config.maxBins !== undefined ) {

			this.binBounds = [];
			this.binCounts = [];
			this.initializeBinArrays();

		}

		console.log( 'Adaptive bin config updated:', {
			minBins: this.minBins,
			maxBins: this.maxBins,
			baseBins: this.numBins
		} );

	}

	// Configuration for Morton code clustering
	setMortonConfig( config ) {

		if ( config.enabled !== undefined ) this.useMortonCodes = config.enabled;
		if ( config.bits !== undefined ) this.mortonBits = Math.max( 6, Math.min( 16, config.bits ) );
		if ( config.threshold !== undefined ) this.mortonClusterThreshold = Math.max( 16, config.threshold );

		console.log( 'Morton code config updated:', {
			enabled: this.useMortonCodes,
			bits: this.mortonBits,
			threshold: this.mortonClusterThreshold
		} );

	}

	// Configuration for fallback split methods
	setFallbackConfig( config ) {

		if ( config.objectMedian !== undefined ) this.enableObjectMedianFallback = config.objectMedian;
		if ( config.spatialMedian !== undefined ) this.enableSpatialMedianFallback = config.spatialMedian;

		console.log( 'Fallback config updated:', {
			objectMedianEnabled: this.enableObjectMedianFallback,
			spatialMedianEnabled: this.enableSpatialMedianFallback
		} );

	}

	// Morton code computation functions
	// Expands a 10-bit integer by inserting 2 zeros after each bit
	expandBits( value ) {

		value = ( value * 0x00010001 ) & 0xFF0000FF;
		value = ( value * 0x00000101 ) & 0x0F00F00F;
		value = ( value * 0x00000011 ) & 0xC30C30C3;
		value = ( value * 0x00000005 ) & 0x49249249;
		return value;

	}

	// Computes Morton code for normalized 3D coordinates (0-1023 range)
	morton3D( x, y, z ) {

		return ( this.expandBits( z ) << 2 ) + ( this.expandBits( y ) << 1 ) + this.expandBits( x );

	}

	// How Morton codes work:
	// Triangle centroids:
	// Morton codes preserve spatial proximity:
	//   (1,1,1) → 0b001001001  ┌─────┬─────┐  Nearby triangles get similar
	//   (1,1,2) → 0b001001010  │  A  │  B  │  codes and end up adjacent
	//   (1,2,1) → 0b001010001  ├─────┼─────┤  in the sorted array
	//   (2,1,1) → 0b010001001  │  C  │  D  │
	//                          └─────┴─────┘  Better cache locality!

	// Compute Morton code for a triangle centroid
	computeMortonCode( centroid, sceneMin, sceneMax ) {

		// Normalize coordinates to [0, 1] range
		const range = sceneMax.clone().sub( sceneMin );
		const normalized = centroid.clone().sub( sceneMin );

		// Avoid division by zero
		if ( range.x > 0 ) normalized.x /= range.x;
		if ( range.y > 0 ) normalized.y /= range.y;
		if ( range.z > 0 ) normalized.z /= range.z;

		// Clamp to [0, 1] and scale to Morton space
		const mortonScale = ( 1 << this.mortonBits ) - 1;
		const x = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.x * mortonScale ) ) );
		const y = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.y * mortonScale ) ) );
		const z = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.z * mortonScale ) ) );

		return this.morton3D( x, y, z );

	}

	// Sort triangles by Morton code for better spatial locality
	sortTrianglesByMortonCode( triangleInfos ) {

		if ( ! this.useMortonCodes || triangleInfos.length < this.mortonClusterThreshold ) {

			return triangleInfos; // Skip Morton sorting for small arrays

		}

		const startTime = performance.now();

		// Compute scene bounds
		const sceneMin = new Vector3( Infinity, Infinity, Infinity );
		const sceneMax = new Vector3( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			sceneMin.min( triInfo.centroid );
			sceneMax.max( triInfo.centroid );

		}

		// Compute Morton codes for all triangles
		for ( const triInfo of triangleInfos ) {

			triInfo.mortonCode = this.computeMortonCode( triInfo.centroid, sceneMin, sceneMax );

		}

		// Sort by Morton code
		triangleInfos.sort( ( a, b ) => a.mortonCode - b.mortonCode );

		// Track timing
		this.splitStats.mortonSortTime += performance.now() - startTime;

		return triangleInfos;

	}

	// Advanced recursive Morton clustering for extremely large datasets
	recursiveMortonCluster( triangleInfos, maxClusterSize = 10000 ) {

		if ( triangleInfos.length <= maxClusterSize ) {

			return this.sortTrianglesByMortonCode( triangleInfos );

		}

		// For very large datasets, cluster recursively
		const startTime = performance.now();

		// Compute scene bounds
		const sceneMin = new Vector3( Infinity, Infinity, Infinity );
		const sceneMax = new Vector3( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			sceneMin.min( triInfo.centroid );
			sceneMax.max( triInfo.centroid );

		}

		// Use coarser Morton codes for initial clustering
		const coarseBits = Math.max( 6, this.mortonBits - 2 );

		// Group triangles by coarse Morton codes
		const clusters = new Map();
		for ( const triInfo of triangleInfos ) {

			// Compute coarse Morton code
			const range = sceneMax.clone().sub( sceneMin );
			const normalized = triInfo.centroid.clone().sub( sceneMin );

			if ( range.x > 0 ) normalized.x /= range.x;
			if ( range.y > 0 ) normalized.y /= range.y;
			if ( range.z > 0 ) normalized.z /= range.z;

			const mortonScale = ( 1 << coarseBits ) - 1;
			const x = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.x * mortonScale ) ) );
			const y = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.y * mortonScale ) ) );
			const z = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.z * mortonScale ) ) );

			const coarseMorton = this.morton3D( x, y, z );

			if ( ! clusters.has( coarseMorton ) ) {

				clusters.set( coarseMorton, [] );

			}

			clusters.get( coarseMorton ).push( triInfo );

		}

		// Sort clusters by Morton code and refine each cluster
		const sortedClusters = Array.from( clusters.entries() ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		const result = [];

		for ( const [ mortonCode, cluster ] of sortedClusters ) {

			// Recursively sort each cluster
			const sortedCluster = this.sortTrianglesByMortonCode( cluster );
			result.push( ...sortedCluster );

		}

		this.splitStats.mortonSortTime += performance.now() - startTime;
		return result;

	}

	build( triangles, depth = 30, progressCallback = null ) {

		this.totalTriangles = Array.isArray( triangles ) ? triangles.length : triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
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

						const { bvhRoot, triangles: newTriangles, triangleCount, format, error, progress } = e.data;

						if ( error ) {

							worker.terminate();
							reject( new Error( error ) );
							return;

						}

						if ( progress !== undefined && progressCallback ) {

							progressCallback( progress );
							return;

						}

						// Handle different triangle formats in response
						if ( format === 'float32array' && newTriangles ) {

							// Update original Float32Array with reordered data
							if ( triangles instanceof Float32Array ) {

								// Properly handle transferred ArrayBuffer
								let reorderedData;
								if ( newTriangles instanceof ArrayBuffer ) {

									reorderedData = new Float32Array( newTriangles );

								} else {

									reorderedData = new Float32Array( newTriangles );

								}

								// Resize original array if needed
								if ( triangles.length !== reorderedData.length ) {

									// Create new Float32Array with correct size
									const newArray = new Float32Array( reorderedData.length );
									newArray.set( reorderedData );
									// Note: Original array reference cannot be changed,
									// so we need to handle this at a higher level
									console.warn( 'Triangle array size changed during BVH build' );

								} else {

									triangles.set( reorderedData );

								}

							}

						} else if ( Array.isArray( triangles ) && Array.isArray( newTriangles ) ) {

							// Update original object array
							triangles.length = newTriangles.length;
							for ( let i = 0; i < newTriangles.length; i ++ ) {

								triangles[ i ] = newTriangles[ i ];

							}

						}

						worker.terminate();
						resolve( bvhRoot );

					};

					worker.onerror = ( error ) => {

						worker.terminate();
						reject( error );

					};

					// Prepare data based on input format
					let workerData;
					let transferable = [];

					if ( triangles instanceof Float32Array ) {

						// Send Float32Array with transferable buffer
						const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
						// Clone the buffer to avoid detachment issues
						const bufferCopy = triangles.buffer.slice();
						workerData = {
							triangleData: bufferCopy,
							triangleCount,
							format: 'float32array',
							depth,
							reportProgress: !! progressCallback
						};
						transferable = [ bufferCopy ];

					} else {

						// Send traditional object array
						workerData = {
							triangles,
							format: 'objects',
							depth,
							reportProgress: !! progressCallback
						};

					}

					worker.postMessage( workerData, transferable );

				} catch ( error ) {

					console.warn( 'Worker creation failed, falling back to synchronous build:', error );

					const reorderedTriangles = [];
					const bvhRoot = this.buildSync( triangles, depth, reorderedTriangles, progressCallback );

					// Update the original triangles array with reordered triangles
					if ( Array.isArray( triangles ) ) {

						triangles.length = reorderedTriangles.length;
						for ( let i = 0; i < reorderedTriangles.length; i ++ ) {

							triangles[ i ] = reorderedTriangles[ i ];

						}

					}

					resolve( bvhRoot );

				}

			} );

		} else {

			// Fallback to synchronous build...
			return new Promise( ( resolve ) => {

				const reorderedTriangles = [];
				const bvhRoot = this.buildSync( triangles, depth, reorderedTriangles, progressCallback );

				if ( Array.isArray( triangles ) ) {

					triangles.length = reorderedTriangles.length;
					for ( let i = 0; i < reorderedTriangles.length; i ++ ) {

						triangles[ i ] = reorderedTriangles[ i ];

					}

				}

				resolve( bvhRoot );

			} );

		}

	}

	buildSync( triangles, depth = 30, reorderedTriangles = [], progressCallback = null ) {

		const buildStartTime = performance.now();

		// Reset state
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = Array.isArray( triangles ) ? triangles.length : triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		this.lastProgressUpdate = performance.now();

		// Reset split statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0
		};

		// Convert to TriangleInfo for better performance
		let triangleInfos;

		if ( Array.isArray( triangles ) ) {

			// Traditional object-based triangles
			triangleInfos = triangles.map( ( tri, index ) => new TriangleInfo( tri, index ) );

		} else if ( triangles instanceof Float32Array ) {

			// Float32Array-based triangles
			const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
			triangleInfos = [];
			for ( let i = 0; i < triangleCount; i ++ ) {

				triangleInfos.push( new TriangleInfo( null, i, triangles ) );

			}

		} else {

			throw new Error( 'Unsupported triangle format' );

		}

		// Apply Morton code spatial clustering for better cache locality
		// Use recursive clustering for very large datasets
		if ( triangleInfos.length > 50000 ) {

			triangleInfos = this.recursiveMortonCluster( triangleInfos );

		} else {

			triangleInfos = this.sortTrianglesByMortonCode( triangleInfos );

		}

		// Create root node
		const root = this.buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback );

		// Record total build time
		this.splitStats.totalBuildTime = performance.now() - buildStartTime;

		console.log( 'BVH Statistics:', {
			totalNodes: this.totalNodes,
			triangleCount: reorderedTriangles.length,
			maxDepth: depth,
			splitMethods: {
				SAH: this.splitStats.sahSplits,
				objectMedian: this.splitStats.objectMedianSplits,
				spatialMedian: this.splitStats.spatialMedianSplits,
				failed: this.splitStats.failedSplits
			},
			adaptiveBins: {
				averageBinsUsed: Math.round( this.splitStats.avgBinsUsed * 10 ) / 10,
				minBins: this.minBins,
				maxBins: this.maxBins,
				baseBins: this.numBins
			},
			performance: {
				totalBuildTime: Math.round( this.splitStats.totalBuildTime ),
				mortonSortTime: Math.round( this.splitStats.mortonSortTime ),
				mortonSortPercentage: Math.round( ( this.splitStats.mortonSortTime / this.splitStats.totalBuildTime ) * 100 ),
				trianglesPerSecond: Math.round( this.totalTriangles / ( this.splitStats.totalBuildTime / 1000 ) )
			},
			mortonClustering: {
				enabled: this.useMortonCodes,
				threshold: this.mortonClusterThreshold,
				bits: this.mortonBits
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

		} else if ( splitInfo.method === 'spatial_median' ) {

			this.splitStats.spatialMedianSplits ++;

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

	// ... (rest of the methods remain the same as they work with TriangleInfo objects)
	findBestSplitPositionSAH( triangleInfos, parentNode ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		const parentSA = this.computeSurfaceAreaFromBounds( parentNode.boundsMin, parentNode.boundsMax );
		const leafCost = this.intersectionCost * triangleInfos.length;

		// Use adaptive bin count based on triangle density
		const currentBinCount = this.getOptimalBinCount( triangleInfos.length );

		// Track statistics
		this.splitStats.totalSplitAttempts ++;
		this.splitStats.avgBinsUsed = ( ( this.splitStats.avgBinsUsed * ( this.splitStats.totalSplitAttempts - 1 ) ) + currentBinCount ) / this.splitStats.totalSplitAttempts;

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

			// Reset bins (only the ones we're using)
			for ( let i = 0; i < currentBinCount; i ++ ) {

				this.binCounts[ i ] = 0;
				this.binBounds[ i ].min.set( Infinity, Infinity, Infinity );
				this.binBounds[ i ].max.set( - Infinity, - Infinity, - Infinity );

			}

			// Place triangles into bins
			const binScale = currentBinCount / ( maxCentroid - minCentroid );
			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				let binIndex = Math.floor( ( centroid - minCentroid ) * binScale );
				binIndex = Math.min( binIndex, currentBinCount - 1 );

				this.binCounts[ binIndex ] ++;
				this.expandBounds( this.binBounds[ binIndex ], triInfo.bounds );

			}

			// Evaluate splits between bins
			for ( let i = 1; i < currentBinCount; i ++ ) {

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

				for ( let j = i; j < currentBinCount; j ++ ) {

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
					bestPos = minCentroid + ( maxCentroid - minCentroid ) * i / currentBinCount;

				}

			}

		}

		// If SAH failed to find a good split, try object median as fallback
		if ( bestAxis === - 1 ) {

			if ( this.enableObjectMedianFallback ) {

				return this.findObjectMedianSplit( triangleInfos );

			} else if ( this.enableSpatialMedianFallback ) {

				return this.findSpatialMedianSplit( triangleInfos );

			} else {

				return { success: false, method: 'fallbacks_disabled' };

			}

		}

		return {
			success: bestAxis !== - 1,
			axis: bestAxis,
			pos: bestPos,
			method: 'SAH',
			binsUsed: currentBinCount
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

			// If object median fails, try spatial median as final fallback
			if ( this.enableSpatialMedianFallback ) {

				return this.findSpatialMedianSplit( triangleInfos );

			} else {

				return { success: false, method: 'object_median_failed_no_spatial_fallback' };

			}

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

				// Object median failed, try spatial median
				if ( this.enableSpatialMedianFallback ) {

					return this.findSpatialMedianSplit( triangleInfos );

				} else {

					return { success: false, method: 'object_median_degenerate_no_spatial_fallback' };

				}

			}

		}

		return {
			success: true,
			axis: bestAxis,
			pos: splitPos,
			method: 'object_median'
		};

	}

	findSpatialMedianSplit( triangleInfos ) {

		let bestAxis = - 1;
		let bestSpread = - 1;
		let bestBounds = null;

		// Find the axis with the largest spatial spread (based on triangle bounds, not centroids)
		for ( let axis = 0; axis < 3; axis ++ ) {

			let minBound = Infinity;
			let maxBound = - Infinity;

			// Consider all triangle vertices, not just centroids
			for ( const triInfo of triangleInfos ) {

				minBound = Math.min( minBound, triInfo.bounds.min.getComponent( axis ) );
				maxBound = Math.max( maxBound, triInfo.bounds.max.getComponent( axis ) );

			}

			const spread = maxBound - minBound;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;
				bestBounds = { min: minBound, max: maxBound };

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-12 ) {

			return { success: false, method: 'spatial_median_failed' };

		}

		// Use spatial median - split at the middle of the bounding box
		const splitPos = ( bestBounds.min + bestBounds.max ) * 0.5;

		// Verify this creates a reasonable split
		let leftCount = 0;
		let rightCount = 0;

		for ( const triInfo of triangleInfos ) {

			const centroid = triInfo.centroid.getComponent( bestAxis );
			if ( centroid <= splitPos ) {

				leftCount ++;

			} else {

				rightCount ++;

			}

		}

		// If still creating degenerate partitions, force a more balanced split
		if ( leftCount === 0 || rightCount === 0 ) {

			// Create array of all centroid values for this axis
			const centroids = triangleInfos.map( tri => tri.centroid.getComponent( bestAxis ) );
			centroids.sort( ( a, b ) => a - b );

			// Use the actual median of centroids as split position
			const medianIndex = Math.floor( centroids.length / 2 );
			const medianCentroid = centroids[ medianIndex ];

			// Ensure we don't have all identical values
			if ( centroids[ 0 ] === centroids[ centroids.length - 1 ] ) {

				return { success: false, method: 'spatial_median_degenerate' };

			}

			// Use position between median values to ensure split
			let adjustedSplitPos = medianCentroid;
			if ( medianIndex > 0 && centroids[ medianIndex - 1 ] !== medianCentroid ) {

				adjustedSplitPos = ( centroids[ medianIndex - 1 ] + medianCentroid ) * 0.5;

			} else if ( medianIndex < centroids.length - 1 ) {

				adjustedSplitPos = ( medianCentroid + centroids[ medianIndex + 1 ] ) * 0.5;

			}

			return {
				success: true,
				axis: bestAxis,
				pos: adjustedSplitPos,
				method: 'spatial_median'
			};

		}

		return {
			success: true,
			axis: bestAxis,
			pos: splitPos,
			method: 'spatial_median'
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

}
