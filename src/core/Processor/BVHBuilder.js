import { Vector3 } from "three";
import TreeletOptimizer from "./TreeletOptimizer";

// Inline copy of TRIANGLE_DATA_LAYOUT (mirrors Constants.js).
// Cannot import Constants.js because BVHBuilder runs inside BVHWorker
// where `window` (used elsewhere in Constants.js) is not defined.
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32,
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,
	NORMAL_A_OFFSET: 12,
	NORMAL_B_OFFSET: 16,
	NORMAL_C_OFFSET: 20,
	UV_AB_OFFSET: 24,
	UV_C_MAT_OFFSET: 28 // vec4: uvC.x, uvC.y, materialIndex, meshIndex
};

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

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
		this.maxLeafSize = 8;
		this.numBins = 32;
		this.minBins = 8;
		this.maxBins = 64;
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100;

		// SAH constants
		this.traversalCost = 1.0;
		this.intersectionCost = 1.0;

		// Morton code clustering settings
		this.useMortonCodes = true;
		this.mortonBits = 10;
		this.mortonClusterThreshold = 128;

		// Fallback method configuration
		this.enableObjectMedianFallback = true;
		this.enableSpatialMedianFallback = true;

		// Split statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0,
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0
		};

		// Treelet optimization configuration
		this.enableTreeletOptimization = false;
		this.treeletSize = 5;
		this.treeletOptimizationPasses = 1;
		this.treeletMinImprovement = 0.02;
		this.maxTreeletDepth = 3;
		this.maxTreeletsPerScene = 20;
		this.treeletComplexityThreshold = 50000;

		// Pre-allocate bin arrays
		this.initializeBinArrays();

		// Flat per-triangle arrays (allocated in buildSync)
		this.centroids = null;
		this.bMin = null;
		this.bMax = null;
		this.indices = null;
		this.mortonCodes = null;
		this.triangles = null;

		// Reordered output (produced by buildSync)
		this.reorderedTriangleData = null;

	}

	initializeBinArrays() {

		const mb = this.maxBins;
		// Flat bin bounds: 3 floats per bin (x, y, z)
		this.binBoundsMin = new Float32Array( mb * 3 );
		this.binBoundsMax = new Float32Array( mb * 3 );
		this.binCounts = new Uint32Array( mb );

		// Prefix-sum arrays for SAH evaluation
		this.leftPrefixMin = new Float32Array( mb * 3 );
		this.leftPrefixMax = new Float32Array( mb * 3 );
		this.leftPrefixCount = new Uint32Array( mb );
		this.rightPrefixMin = new Float32Array( mb * 3 );
		this.rightPrefixMax = new Float32Array( mb * 3 );
		this.rightPrefixCount = new Uint32Array( mb );

	}

	getOptimalBinCount( triangleCount ) {

		if ( triangleCount <= 16 ) return this.minBins;
		if ( triangleCount <= 64 ) return 16;
		if ( triangleCount <= 256 ) return 32;
		if ( triangleCount <= 1024 ) return 48;
		return this.maxBins;

	}

	setAdaptiveBinConfig( config ) {

		if ( config.minBins !== undefined ) this.minBins = Math.max( 4, config.minBins );
		if ( config.maxBins !== undefined ) this.maxBins = Math.min( 128, config.maxBins );
		if ( config.baseBins !== undefined ) this.numBins = config.baseBins;
		if ( config.maxBins !== undefined ) this.initializeBinArrays();

	}

	setMortonConfig( config ) {

		if ( config.enabled !== undefined ) this.useMortonCodes = config.enabled;
		if ( config.bits !== undefined ) this.mortonBits = Math.max( 6, Math.min( 16, config.bits ) );
		if ( config.threshold !== undefined ) this.mortonClusterThreshold = Math.max( 16, config.threshold );

	}

	setFallbackConfig( config ) {

		if ( config.objectMedian !== undefined ) this.enableObjectMedianFallback = config.objectMedian;
		if ( config.spatialMedian !== undefined ) this.enableSpatialMedianFallback = config.spatialMedian;

	}

	setTreeletConfig( config ) {

		if ( config.enabled !== undefined ) this.enableTreeletOptimization = config.enabled;
		if ( config.size !== undefined ) this.treeletSize = Math.max( 3, Math.min( 12, config.size ) );
		if ( config.passes !== undefined ) this.treeletOptimizationPasses = Math.max( 1, Math.min( 3, config.passes ) );
		if ( config.minImprovement !== undefined ) this.treeletMinImprovement = Math.max( 0.001, config.minImprovement );

	}

	disableTreeletOptimization() {

		this.enableTreeletOptimization = false;

	}

	// --- Morton code helpers ---

	expandBits( value ) {

		value = ( value * 0x00010001 ) & 0xFF0000FF;
		value = ( value * 0x00000101 ) & 0x0F00F00F;
		value = ( value * 0x00000011 ) & 0xC30C30C3;
		value = ( value * 0x00000005 ) & 0x49249249;
		return value;

	}

	morton3D( x, y, z ) {

		return ( this.expandBits( z ) << 2 ) + ( this.expandBits( y ) << 1 ) + this.expandBits( x );

	}

	computeMortonCodeForIndex( idx, sceneMinX, sceneMinY, sceneMinZ, rangeX, rangeY, rangeZ ) {

		const c = this.centroids;
		const o = idx * 3;
		const mortonScale = ( 1 << this.mortonBits ) - 1;

		let nx = rangeX > 0 ? ( c[ o ] - sceneMinX ) / rangeX : 0;
		let ny = rangeY > 0 ? ( c[ o + 1 ] - sceneMinY ) / rangeY : 0;
		let nz = rangeZ > 0 ? ( c[ o + 2 ] - sceneMinZ ) / rangeZ : 0;

		const x = Math.max( 0, Math.min( mortonScale, Math.floor( nx * mortonScale ) ) );
		const y = Math.max( 0, Math.min( mortonScale, Math.floor( ny * mortonScale ) ) );
		const z = Math.max( 0, Math.min( mortonScale, Math.floor( nz * mortonScale ) ) );

		return this.morton3D( x, y, z );

	}

	sortTrianglesByMortonCode() {

		const n = this.totalTriangles;
		if ( ! this.useMortonCodes || n < this.mortonClusterThreshold ) return;

		const startTime = performance.now();
		const c = this.centroids;
		const indices = this.indices;

		// Compute scene bounds from centroids
		let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
		let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity;
		for ( let i = 0; i < n; i ++ ) {

			const idx = indices[ i ];
			const o = idx * 3;
			const cx = c[ o ], cy = c[ o + 1 ], cz = c[ o + 2 ];
			if ( cx < sMinX ) sMinX = cx;
			if ( cy < sMinY ) sMinY = cy;
			if ( cz < sMinZ ) sMinZ = cz;
			if ( cx > sMaxX ) sMaxX = cx;
			if ( cy > sMaxY ) sMaxY = cy;
			if ( cz > sMaxZ ) sMaxZ = cz;

		}

		const rX = sMaxX - sMinX, rY = sMaxY - sMinY, rZ = sMaxZ - sMinZ;

		// Compute morton codes
		for ( let i = 0; i < n; i ++ ) {

			this.mortonCodes[ indices[ i ] ] = this.computeMortonCodeForIndex( indices[ i ], sMinX, sMinY, sMinZ, rX, rY, rZ );

		}

		// Sort indices by morton code
		const mc = this.mortonCodes;
		const tempArr = Array.from( indices );
		tempArr.sort( ( a, b ) => mc[ a ] - mc[ b ] );
		indices.set( tempArr );

		this.splitStats.mortonSortTime += performance.now() - startTime;

	}

	// --- Build entry points ---

	build( triangles, depth = 30, progressCallback = null ) {

		this.totalTriangles = triangles.byteLength / ( FPT * 4 );
		this.processedTriangles = 0;
		this.lastProgressUpdate = performance.now();

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

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

						// Copy reordered data back to original array
						triangles.set( newTriangles );

						worker.terminate();
						resolve( bvhRoot );

					};

					worker.onerror = ( error ) => {

						worker.terminate();
						reject( error );

					};

					const triangleCount = triangles.byteLength / ( FPT * 4 );
					const bufferCopy = triangles.buffer.slice( triangles.byteOffset, triangles.byteOffset + triangles.byteLength );
					const workerData = {
						triangleData: bufferCopy,
						triangleCount,
						depth,
						reportProgress: !! progressCallback,
						treeletOptimization: {
							enabled: this.enableTreeletOptimization,
							size: this.treeletSize,
							passes: this.treeletOptimizationPasses,
							minImprovement: this.treeletMinImprovement
						}
					};

					worker.postMessage( workerData, [ bufferCopy ] );

				} catch ( error ) {

					console.warn( 'Worker creation failed, falling back to synchronous build:', error );
					const bvhRoot = this.buildSync( triangles, depth, progressCallback );
					if ( this.reorderedTriangleData ) {

						triangles.set( this.reorderedTriangleData );

					}

					resolve( bvhRoot );

				}

			} );

		} else {

			return new Promise( ( resolve ) => {

				const bvhRoot = this.buildSync( triangles, depth, progressCallback );
				if ( this.reorderedTriangleData ) {

					triangles.set( this.reorderedTriangleData );

				}

				resolve( bvhRoot );

			} );

		}

	}

	buildSync( triangles, depth = 30, progressCallback = null ) {

		const buildStartTime = performance.now();

		// Reset state
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.triangles = triangles;
		this.totalTriangles = triangles.byteLength / ( FPT * 4 );
		this.lastProgressUpdate = performance.now();

		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0,
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0
		};

		const n = this.totalTriangles;

		// Allocate flat per-triangle arrays
		this.centroids = new Float32Array( n * 3 );
		this.bMin = new Float32Array( n * 3 );
		this.bMax = new Float32Array( n * 3 );
		this.indices = new Uint32Array( n );
		this.mortonCodes = new Uint32Array( n );

		// Initialize from source triangle data
		const src = triangles;
		const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
		const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
		const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;

		for ( let i = 0; i < n; i ++ ) {

			const base = i * FPT;
			const ax = src[ base + PA ], ay = src[ base + PA + 1 ], az = src[ base + PA + 2 ];
			const bx = src[ base + PB ], by = src[ base + PB + 1 ], bz = src[ base + PB + 2 ];
			const cx = src[ base + PC ], cy = src[ base + PC + 1 ], cz = src[ base + PC + 2 ];

			const o3 = i * 3;
			this.centroids[ o3 ] = ( ax + bx + cx ) / 3;
			this.centroids[ o3 + 1 ] = ( ay + by + cy ) / 3;
			this.centroids[ o3 + 2 ] = ( az + bz + cz ) / 3;

			this.bMin[ o3 ] = Math.min( ax, bx, cx );
			this.bMin[ o3 + 1 ] = Math.min( ay, by, cy );
			this.bMin[ o3 + 2 ] = Math.min( az, bz, cz );

			this.bMax[ o3 ] = Math.max( ax, bx, cx );
			this.bMax[ o3 + 1 ] = Math.max( ay, by, cy );
			this.bMax[ o3 + 2 ] = Math.max( az, bz, cz );

			this.indices[ i ] = i;

		}

		// Morton code spatial clustering
		this.sortTrianglesByMortonCode();

		// Build BVH recursively
		const root = this.buildNodeRecursive( 0, n, depth, progressCallback );

		// Treelet optimization
		if ( this.enableTreeletOptimization && this.totalTriangles > 1000 ) {

			const isLargeScene = this.totalTriangles > this.treeletComplexityThreshold;
			const adaptiveTreeletSize = isLargeScene ? 3 : this.treeletSize;
			const adaptiveMaxTreelets = isLargeScene ? 10 : this.maxTreeletsPerScene;

			const optimizer = new TreeletOptimizer( this.traversalCost, this.intersectionCost );
			optimizer.setTreeletSize( adaptiveTreeletSize );
			optimizer.setMinImprovement( this.treeletMinImprovement );
			optimizer.setMaxTreelets( adaptiveMaxTreelets );

			const optimizationStartTime = performance.now();

			for ( let pass = 0; pass < this.treeletOptimizationPasses; pass ++ ) {

				const passCallback = progressCallback ? ( status ) => {

					progressCallback( `Treelet optimization pass ${pass + 1}/${this.treeletOptimizationPasses}: ${status}` );

				} : null;

				const beforeStats = optimizer.getStatistics();

				try {

					optimizer.optimizeBVH( root, passCallback );

				} catch ( error ) {

					console.error( `TreeletOptimizer: Error in pass ${pass + 1}:`, error );
					break;

				}

				const afterStats = optimizer.getStatistics();
				const currentPassImprovements = afterStats.treeletsImproved - beforeStats.treeletsImproved;
				const passTime = performance.now() - optimizationStartTime;
				if ( ( currentPassImprovements === 0 && pass > 0 ) || passTime > 15000 ) {

					break;

				}

			}

			const treeletTime = performance.now() - optimizationStartTime;
			this.splitStats.treeletOptimizationTime = treeletTime;
			const treeletStats = optimizer.getStatistics();
			this.splitStats.treeletsProcessed = treeletStats.treeletsProcessed;
			this.splitStats.treeletsImproved = treeletStats.treeletsImproved;
			this.splitStats.averageSAHImprovement = treeletStats.averageSAHImprovement;

		}

		// Create reordered triangle data from final index order
		const reordered = new Float32Array( n * FPT );
		for ( let i = 0; i < n; i ++ ) {

			const srcOff = this.indices[ i ] * FPT;
			const dstOff = i * FPT;
			reordered.set( src.subarray( srcOff, srcOff + FPT ), dstOff );

		}

		this.reorderedTriangleData = reordered;

		this.splitStats.totalBuildTime = performance.now() - buildStartTime;

		const stats = {
			'Total Triangles': this.totalTriangles,
			'Total Nodes': this.totalNodes,
			'Max Leaf Size': this.maxLeafSize,
			'SAH Splits': this.splitStats.sahSplits,
			'Object Median Splits': this.splitStats.objectMedianSplits,
			'Spatial Median Splits': this.splitStats.spatialMedianSplits,
			'Failed Splits': this.splitStats.failedSplits,
			'Perf: Total Build (ms)': Math.round( this.splitStats.totalBuildTime ),
			'Perf: Morton Sort (ms)': Math.round( this.splitStats.mortonSortTime ),
			'Perf: Treelet Opt Time (ms)': Math.round( this.splitStats.treeletOptimizationTime ),
			'Morton Clustering: Enabled': this.useMortonCodes,
		};

		console.log( 'BVH Statistics:' );
		console.table( stats );

		progressCallback && progressCallback( 100 );

		// Free flat arrays (no longer needed)
		this.centroids = null;
		this.bMin = null;
		this.bMax = null;
		this.mortonCodes = null;

		return root;

	}

	updateProgress( trianglesProcessed, progressCallback ) {

		if ( ! progressCallback ) return;

		this.processedTriangles += trianglesProcessed;
		const now = performance.now();
		if ( now - this.lastProgressUpdate < this.progressUpdateInterval ) return;

		this.lastProgressUpdate = now;
		const progress = Math.min( Math.floor( ( this.processedTriangles / this.totalTriangles ) * 100 ), 99 );
		progressCallback( progress );

	}

	// --- Recursive BVH build (operates on index range) ---

	buildNodeRecursive( start, end, depth, progressCallback ) {

		const node = new CWBVHNode();
		this.nodes.push( node );
		this.totalNodes ++;

		const count = end - start;

		// Update bounds from pre-computed per-triangle bounds
		this.updateNodeBounds( node, start, end );

		// Leaf condition
		if ( count <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		// Find split
		const splitInfo = this.findBestSplitPositionSAH( start, end, node );

		if ( ! splitInfo.success ) {

			this.splitStats.failedSplits ++;
			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		// Track split method
		if ( splitInfo.method === 'SAH' ) this.splitStats.sahSplits ++;
		else if ( splitInfo.method === 'object_median' ) this.splitStats.objectMedianSplits ++;
		else if ( splitInfo.method === 'spatial_median' ) this.splitStats.spatialMedianSplits ++;

		// In-place partition
		const mid = this.partitionInPlace( start, end, splitInfo.axis, splitInfo.pos );

		// Degenerate partition fallback
		if ( mid === start || mid === end ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		node.leftChild = this.buildNodeRecursive( start, mid, depth - 1, progressCallback );
		node.rightChild = this.buildNodeRecursive( mid, end, depth - 1, progressCallback );

		return node;

	}

	// In-place partition: swap indices so [start..mid) have centroid <= splitPos, [mid..end) have centroid > splitPos
	partitionInPlace( start, end, axis, splitPos ) {

		const idx = this.indices;
		const c = this.centroids;
		let lo = start;
		let hi = end - 1;

		while ( lo <= hi ) {

			if ( c[ idx[ lo ] * 3 + axis ] <= splitPos ) {

				lo ++;

			} else {

				// Swap indices[lo] and indices[hi]
				const tmp = idx[ lo ];
				idx[ lo ] = idx[ hi ];
				idx[ hi ] = tmp;
				hi --;

			}

		}

		return lo; // lo is the first index of the right partition

	}

	updateNodeBounds( node, start, end ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		const idx = this.indices;
		const bMin = this.bMin;
		const bMax = this.bMax;

		for ( let i = start; i < end; i ++ ) {

			const o = idx[ i ] * 3;
			if ( bMin[ o ] < minX ) minX = bMin[ o ];
			if ( bMin[ o + 1 ] < minY ) minY = bMin[ o + 1 ];
			if ( bMin[ o + 2 ] < minZ ) minZ = bMin[ o + 2 ];
			if ( bMax[ o ] > maxX ) maxX = bMax[ o ];
			if ( bMax[ o + 1 ] > maxY ) maxY = bMax[ o + 1 ];
			if ( bMax[ o + 2 ] > maxZ ) maxZ = bMax[ o + 2 ];

		}

		node.boundsMin.set( minX, minY, minZ );
		node.boundsMax.set( maxX, maxY, maxZ );

	}

	// --- SAH with prefix-sum (O(bins) per axis instead of O(bins²)) ---

	findBestSplitPositionSAH( start, end, parentNode ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		const parentSA = this.computeSurfaceArea( parentNode.boundsMin, parentNode.boundsMax );
		const count = end - start;
		const leafCost = this.intersectionCost * count;
		const currentBinCount = this.getOptimalBinCount( count );

		this.splitStats.totalSplitAttempts ++;
		this.splitStats.avgBinsUsed = ( ( this.splitStats.avgBinsUsed * ( this.splitStats.totalSplitAttempts - 1 ) ) + currentBinCount ) / this.splitStats.totalSplitAttempts;

		const idx = this.indices;
		const c = this.centroids;
		const bMn = this.bMin;
		const bMx = this.bMax;
		const bbMin = this.binBoundsMin;
		const bbMax = this.binBoundsMax;
		const bc = this.binCounts;
		const lpMin = this.leftPrefixMin;
		const lpMax = this.leftPrefixMax;
		const lpc = this.leftPrefixCount;
		const rpMin = this.rightPrefixMin;
		const rpMax = this.rightPrefixMax;
		const rpc = this.rightPrefixCount;

		for ( let axis = 0; axis < 3; axis ++ ) {

			// Find centroid bounds for this axis
			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			for ( let i = start; i < end; i ++ ) {

				const cv = c[ idx[ i ] * 3 + axis ];
				if ( cv < minCentroid ) minCentroid = cv;
				if ( cv > maxCentroid ) maxCentroid = cv;

			}

			if ( maxCentroid - minCentroid < 1e-6 ) continue;

			// Reset bins
			for ( let b = 0; b < currentBinCount; b ++ ) {

				bc[ b ] = 0;
				const b3 = b * 3;
				bbMin[ b3 ] = Infinity; bbMin[ b3 + 1 ] = Infinity; bbMin[ b3 + 2 ] = Infinity;
				bbMax[ b3 ] = - Infinity; bbMax[ b3 + 1 ] = - Infinity; bbMax[ b3 + 2 ] = - Infinity;

			}

			// Place triangles into bins
			const binScale = currentBinCount / ( maxCentroid - minCentroid );
			for ( let i = start; i < end; i ++ ) {

				const triIdx = idx[ i ];
				const cv = c[ triIdx * 3 + axis ];
				let bi = Math.floor( ( cv - minCentroid ) * binScale );
				if ( bi >= currentBinCount ) bi = currentBinCount - 1;

				bc[ bi ] ++;
				const b3 = bi * 3;
				const t3 = triIdx * 3;

				if ( bMn[ t3 ] < bbMin[ b3 ] ) bbMin[ b3 ] = bMn[ t3 ];
				if ( bMn[ t3 + 1 ] < bbMin[ b3 + 1 ] ) bbMin[ b3 + 1 ] = bMn[ t3 + 1 ];
				if ( bMn[ t3 + 2 ] < bbMin[ b3 + 2 ] ) bbMin[ b3 + 2 ] = bMn[ t3 + 2 ];
				if ( bMx[ t3 ] > bbMax[ b3 ] ) bbMax[ b3 ] = bMx[ t3 ];
				if ( bMx[ t3 + 1 ] > bbMax[ b3 + 1 ] ) bbMax[ b3 + 1 ] = bMx[ t3 + 1 ];
				if ( bMx[ t3 + 2 ] > bbMax[ b3 + 2 ] ) bbMax[ b3 + 2 ] = bMx[ t3 + 2 ];

			}

			// Build left prefix sums
			lpc[ 0 ] = bc[ 0 ];
			lpMin[ 0 ] = bbMin[ 0 ]; lpMin[ 1 ] = bbMin[ 1 ]; lpMin[ 2 ] = bbMin[ 2 ];
			lpMax[ 0 ] = bbMax[ 0 ]; lpMax[ 1 ] = bbMax[ 1 ]; lpMax[ 2 ] = bbMax[ 2 ];

			for ( let b = 1; b < currentBinCount; b ++ ) {

				const b3 = b * 3;
				const p3 = ( b - 1 ) * 3;
				lpc[ b ] = lpc[ b - 1 ] + bc[ b ];
				lpMin[ b3 ] = Math.min( lpMin[ p3 ], bbMin[ b3 ] );
				lpMin[ b3 + 1 ] = Math.min( lpMin[ p3 + 1 ], bbMin[ b3 + 1 ] );
				lpMin[ b3 + 2 ] = Math.min( lpMin[ p3 + 2 ], bbMin[ b3 + 2 ] );
				lpMax[ b3 ] = Math.max( lpMax[ p3 ], bbMax[ b3 ] );
				lpMax[ b3 + 1 ] = Math.max( lpMax[ p3 + 1 ], bbMax[ b3 + 1 ] );
				lpMax[ b3 + 2 ] = Math.max( lpMax[ p3 + 2 ], bbMax[ b3 + 2 ] );

			}

			// Build right prefix sums
			const last = currentBinCount - 1;
			const l3 = last * 3;
			rpc[ last ] = bc[ last ];
			rpMin[ l3 ] = bbMin[ l3 ]; rpMin[ l3 + 1 ] = bbMin[ l3 + 1 ]; rpMin[ l3 + 2 ] = bbMin[ l3 + 2 ];
			rpMax[ l3 ] = bbMax[ l3 ]; rpMax[ l3 + 1 ] = bbMax[ l3 + 1 ]; rpMax[ l3 + 2 ] = bbMax[ l3 + 2 ];

			for ( let b = last - 1; b >= 0; b -- ) {

				const b3 = b * 3;
				const n3 = ( b + 1 ) * 3;
				rpc[ b ] = rpc[ b + 1 ] + bc[ b ];
				rpMin[ b3 ] = Math.min( rpMin[ n3 ], bbMin[ b3 ] );
				rpMin[ b3 + 1 ] = Math.min( rpMin[ n3 + 1 ], bbMin[ b3 + 1 ] );
				rpMin[ b3 + 2 ] = Math.min( rpMin[ n3 + 2 ], bbMin[ b3 + 2 ] );
				rpMax[ b3 ] = Math.max( rpMax[ n3 ], bbMax[ b3 ] );
				rpMax[ b3 + 1 ] = Math.max( rpMax[ n3 + 1 ], bbMax[ b3 + 1 ] );
				rpMax[ b3 + 2 ] = Math.max( rpMax[ n3 + 2 ], bbMax[ b3 + 2 ] );

			}

			// Evaluate splits using prefix sums (O(bins) instead of O(bins²))
			for ( let i = 1; i < currentBinCount; i ++ ) {

				const leftIdx = ( i - 1 ) * 3;
				const rightIdx = i * 3;
				const leftCount = lpc[ i - 1 ];
				const rightCount = rpc[ i ];

				if ( leftCount === 0 || rightCount === 0 ) continue;

				const leftSA = this.computeSurfaceAreaFlat(
					lpMin[ leftIdx ], lpMin[ leftIdx + 1 ], lpMin[ leftIdx + 2 ],
					lpMax[ leftIdx ], lpMax[ leftIdx + 1 ], lpMax[ leftIdx + 2 ]
				);
				const rightSA = this.computeSurfaceAreaFlat(
					rpMin[ rightIdx ], rpMin[ rightIdx + 1 ], rpMin[ rightIdx + 2 ],
					rpMax[ rightIdx ], rpMax[ rightIdx + 1 ], rpMax[ rightIdx + 2 ]
				);

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

		// Fallbacks
		if ( bestAxis === - 1 ) {

			if ( this.enableObjectMedianFallback ) return this.findObjectMedianSplit( start, end );
			if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
			return { success: false, method: 'fallbacks_disabled' };

		}

		return { success: true, axis: bestAxis, pos: bestPos, method: 'SAH', binsUsed: currentBinCount };

	}

	findObjectMedianSplit( start, end ) {

		const idx = this.indices;
		const c = this.centroids;
		let bestAxis = - 1;
		let bestSpread = - 1;

		for ( let axis = 0; axis < 3; axis ++ ) {

			let minC = Infinity, maxC = - Infinity;
			for ( let i = start; i < end; i ++ ) {

				const v = c[ idx[ i ] * 3 + axis ];
				if ( v < minC ) minC = v;
				if ( v > maxC ) maxC = v;

			}

			const spread = maxC - minC;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-10 ) {

			if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
			return { success: false, method: 'object_median_failed' };

		}

		// Build temp array of centroid values for this axis to find median
		const count = end - start;
		const vals = new Float32Array( count );
		for ( let i = 0; i < count; i ++ ) {

			vals[ i ] = c[ idx[ start + i ] * 3 + bestAxis ];

		}

		vals.sort();
		const medianIdx = Math.floor( count / 2 );
		let splitPos = vals[ medianIdx ];

		// Verify balanced split
		let leftCount = 0;
		for ( let i = start; i < end; i ++ ) {

			if ( c[ idx[ i ] * 3 + bestAxis ] <= splitPos ) leftCount ++;

		}

		if ( leftCount === 0 || leftCount === count ) {

			if ( medianIdx > 0 ) {

				splitPos = ( vals[ medianIdx - 1 ] + vals[ medianIdx ] ) * 0.5;

			} else {

				if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
				return { success: false, method: 'object_median_degenerate' };

			}

		}

		return { success: true, axis: bestAxis, pos: splitPos, method: 'object_median' };

	}

	findSpatialMedianSplit( start, end ) {

		const idx = this.indices;
		const c = this.centroids;
		const bMn = this.bMin;
		const bMx = this.bMax;
		let bestAxis = - 1;
		let bestSpread = - 1;
		let bestMin = 0, bestMax = 0;

		for ( let axis = 0; axis < 3; axis ++ ) {

			let minB = Infinity, maxB = - Infinity;
			for ( let i = start; i < end; i ++ ) {

				const o = idx[ i ] * 3 + axis;
				if ( bMn[ o ] < minB ) minB = bMn[ o ];
				if ( bMx[ o ] > maxB ) maxB = bMx[ o ];

			}

			const spread = maxB - minB;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;
				bestMin = minB;
				bestMax = maxB;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-12 ) {

			return { success: false, method: 'spatial_median_failed' };

		}

		let splitPos = ( bestMin + bestMax ) * 0.5;

		// Verify split quality
		const count = end - start;
		let leftCount = 0;
		for ( let i = start; i < end; i ++ ) {

			if ( c[ idx[ i ] * 3 + bestAxis ] <= splitPos ) leftCount ++;

		}

		if ( leftCount === 0 || leftCount === count ) {

			// Force balanced via sorted median
			const vals = new Float32Array( count );
			for ( let i = 0; i < count; i ++ ) {

				vals[ i ] = c[ idx[ start + i ] * 3 + bestAxis ];

			}

			vals.sort();

			if ( vals[ 0 ] === vals[ count - 1 ] ) {

				return { success: false, method: 'spatial_median_degenerate' };

			}

			const medianIdx = Math.floor( count / 2 );
			splitPos = vals[ medianIdx ];

			if ( medianIdx > 0 && vals[ medianIdx - 1 ] !== splitPos ) {

				splitPos = ( vals[ medianIdx - 1 ] + splitPos ) * 0.5;

			} else if ( medianIdx < count - 1 ) {

				splitPos = ( splitPos + vals[ medianIdx + 1 ] ) * 0.5;

			}

		}

		return { success: true, axis: bestAxis, pos: splitPos, method: 'spatial_median' };

	}

	// --- Surface area helpers ---

	computeSurfaceArea( boundsMin, boundsMax ) {

		const dx = boundsMax.x - boundsMin.x;
		const dy = boundsMax.y - boundsMin.y;
		const dz = boundsMax.z - boundsMin.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

	computeSurfaceAreaFlat( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

}
