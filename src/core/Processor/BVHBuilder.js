import { Vector3 } from "three";

// Import the unified data layout constants
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32, // 8 vec4s: 3 positions + 3 normals + 2 UV/material

	// Positions (3 vec4s = 12 floats)
	POSITION_A_OFFSET: 0, // vec4: x, y, z, 0
	POSITION_B_OFFSET: 4, // vec4: x, y, z, 0
	POSITION_C_OFFSET: 8, // vec4: x, y, z, 0

	// Normals (3 vec4s = 12 floats)
	NORMAL_A_OFFSET: 12, // vec4: x, y, z, 0
	NORMAL_B_OFFSET: 16, // vec4: x, y, z, 0
	NORMAL_C_OFFSET: 20, // vec4: x, y, z, 0

	// UVs and Material (2 vec4s = 8 floats)
	UV_AB_OFFSET: 24, // vec4: uvA.x, uvA.y, uvB.x, uvB.y
	UV_C_MAT_OFFSET: 28 // vec4: uvC.x, uvC.y, materialIndex, 0
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
// Updated to work with triangle format (32 floats)
class TriangleInfo {

	constructor( index, triangleData = null ) {

		this.index = index;
		this.triangleData = triangleData;
		this.triangle = new TriangleWrapper( triangleData, index );

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

// Wrapper class to provide object-like access to Float32Array triangle data (32-float format)
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
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 1 ]
		};

	}

	get uvB() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 2 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 3 ]
		};

	}

	get uvC() {

		return {
			x: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 0 ],
			y: this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 1 ]
		};

	}

	get materialIndex() {

		return this.data[ this.offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 2 ];

	}

}

class TreeletOptimizer {

	constructor( traversalCost, intersectionCost ) {

		this.traversalCost = traversalCost;
		this.intersectionCost = intersectionCost;
		this.treeletSize = 7; // Safe: Reduced back to 7 to prevent memory explosion
		this.minImprovement = 0.01; // Safe: Higher threshold to reduce computation
		this.maxTreeletDepth = 3; // Safe: Reduced depth to prevent deep recursion

		// Memory-controlled topology cache
		this.topologyCache = new Map();
		this.maxTopologyEntries = 1000; // Limit cache size to prevent memory issues
		this.precomputeTopologies();

		// Statistics
		this.stats = {
			treeletsProcessed: 0,
			treeletsImproved: 0,
			totalSAHImprovement: 0,
			averageSAHImprovement: 0,
			optimizationTime: 0
		};

	}

	// Pre-compute all possible binary tree topologies for given leaf counts
	// With safety limits to prevent memory explosion
	precomputeTopologies() {

		for ( let leafCount = 3; leafCount <= this.treeletSize; leafCount ++ ) {

			try {

				// Check cache size before adding more entries
				if ( this.topologyCache.size > this.maxTopologyEntries ) {

					console.warn( `TreeletOptimizer: Topology cache limit reached (${this.maxTopologyEntries}). Skipping larger treelets.` );
					break;

				}

				const topologies = this.generateAllTopologies( leafCount );
				
				// Safety check: don't cache if too many topologies
				if ( topologies.length > 10000 ) {

					console.warn( `TreeletOptimizer: Too many topologies for leafCount ${leafCount} (${topologies.length}). Skipping.` );
					continue;

				}
				
				this.topologyCache.set( leafCount, topologies );

			} catch ( error ) {

				console.error( `TreeletOptimizer: Failed to precompute topologies for leafCount ${leafCount}:`, error );
				break;

			}

		}

	}

	// Generate all possible binary tree topologies using iterative approach
	// to prevent stack overflow for large treelet sizes
	generateAllTopologies( leafCount ) {

		if ( leafCount <= 2 ) return [ leafCount === 1 ? [ 0 ] : [ 0, 1 ] ];

		// Use iterative dynamic programming approach instead of recursion
		const dp = new Map();
		dp.set( 1, [[ 0 ]] );
		dp.set( 2, [[ 0, 1 ]] );

		// Build up solutions iteratively
		for ( let n = 3; n <= leafCount; n ++ ) {

			const topologies = [];
			const maxIterations = Math.min( n - 1, 50 ); // Safety limit on iterations

			for ( let leftCount = 1; leftCount < n && leftCount <= maxIterations; leftCount ++ ) {

				const rightCount = n - leftCount;
				
				// Safety check to prevent excessive memory usage
				if ( rightCount > 50 ) continue;
				
				const leftTopologies = dp.get( leftCount ) || [];
				const rightTopologies = dp.get( rightCount ) || [];

				// Limit the number of combinations to prevent memory explosion
				const maxCombinations = 1000;
				let combinationCount = 0;

				for ( const leftTopo of leftTopologies ) {

					for ( const rightTopo of rightTopologies ) {

						if ( combinationCount >= maxCombinations ) {

							console.warn( `TreeletOptimizer: Reached max combinations limit for leafCount ${n}` );
							break;

						}

						// Offset right topology indices
						const offsetRightTopo = rightTopo.map( idx => idx + leftCount );
						topologies.push( [ ...leftTopo, ...offsetRightTopo ] );
						combinationCount ++;

					}

					if ( combinationCount >= maxCombinations ) break;

				}

			}

			dp.set( n, topologies );

		}

		return dp.get( leafCount ) || [];

	}

	// Main optimization entry point with safety limits
	optimizeBVH( bvhRoot, progressCallback = null ) {

		const startTime = performance.now();
		const maxOptimizationTime = 30000; // 30 second timeout to prevent browser freeze
		
		this.stats = {
			treeletsProcessed: 0,
			treeletsImproved: 0,
			totalSAHImprovement: 0,
			averageSAHImprovement: 0,
			optimizationTime: 0
		};

		// Identify and optimize treelets with safety limits
		const treeletRoots = this.identifyTreeletRoots( bvhRoot );
		const totalTreelets = Math.min( treeletRoots.length, 5000 ); // Limit max treelets to prevent excessive computation

		console.log( `Found ${treeletRoots.length} treelets, processing first ${totalTreelets} for optimization` );

		for ( let i = 0; i < totalTreelets; i ++ ) {

			// Check timeout to prevent browser freeze
			if ( performance.now() - startTime > maxOptimizationTime ) {

				console.warn( `TreeletOptimizer: Timeout reached after ${Math.round( performance.now() - startTime )}ms. Processed ${i}/${totalTreelets} treelets.` );
				break;

			}

			const treelet = treeletRoots[ i ];
			
			try {

				this.optimizeTreelet( treelet );

			} catch ( error ) {

				console.error( `TreeletOptimizer: Error optimizing treelet ${i}:`, error );
				continue; // Skip problematic treelets instead of crashing

			}

			// Update progress every 50 treelets to avoid excessive callback overhead
			if ( progressCallback && i % 50 === 0 ) {

				const progress = Math.floor( ( i / totalTreelets ) * 100 );
				progressCallback( `Optimizing treelets: ${progress}%` );

			}

		}

		this.stats.optimizationTime = performance.now() - startTime;
		this.stats.averageSAHImprovement = this.stats.treeletsProcessed > 0 ?
			this.stats.totalSAHImprovement / this.stats.treeletsProcessed : 0;

		console.log( 'Treelet optimization complete:', this.stats );
		return bvhRoot;

	}

	// Identify treelet root nodes throughout the BVH
	identifyTreeletRoots( bvhRoot ) {

		const treeletRoots = [];
		const visited = new Set();

		this.traverseForTreelets( bvhRoot, treeletRoots, visited, 0 );
		return treeletRoots;

	}

	// Recursive traversal to find optimal treelet boundaries with safety limits
	traverseForTreelets( node, treeletRoots, visited, depth ) {

		// Safety checks to prevent infinite recursion and memory issues
		if ( ! node || visited.has( node ) || node.triangleCount > 0 || depth > 10 ) {

			return 0; // Skip leaves, already processed nodes, and deep recursion

		}

		// Add current node to visited set immediately to prevent cycles
		visited.add( node );

		const leftLeafCount = this.countLeafNodes( node.leftChild );
		const rightLeafCount = this.countLeafNodes( node.rightChild );
		const totalLeafCount = leftLeafCount + rightLeafCount;

		// Safety check: skip nodes with excessive leaf counts
		if ( totalLeafCount > this.treeletSize * 2 ) {

			return totalLeafCount;

		}

		// More conservative treelet selection criteria to prevent problematic cases
		const isGoodTreeletRoot = totalLeafCount >= 3 &&
			totalLeafCount <= this.treeletSize &&
			depth <= this.maxTreeletDepth &&
			leftLeafCount > 0 && rightLeafCount > 0 && // Ensure balanced
			this.evaluateTreeletQuality( node, totalLeafCount );

		if ( isGoodTreeletRoot ) {

			treeletRoots.push( node );
			this.markSubtreeVisited( node, visited );
			return totalLeafCount;

		}

		// Continue traversing children
		let leafCount = 0;
		if ( node.leftChild && ! visited.has( node.leftChild ) ) {

			leafCount += this.traverseForTreelets( node.leftChild, treeletRoots, visited, depth + 1 );

		}

		if ( node.rightChild && ! visited.has( node.rightChild ) ) {

			leafCount += this.traverseForTreelets( node.rightChild, treeletRoots, visited, depth + 1 );

		}

		return leafCount;

	}

	// Optimized: Evaluate treelet quality for better ray traversal performance
	evaluateTreeletQuality( node, leafCount ) {

		// Prefer treelets with balanced leaf distribution
		const leftLeafCount = this.countLeafNodes( node.leftChild );
		const rightLeafCount = this.countLeafNodes( node.rightChild );
		const balanceRatio = Math.min( leftLeafCount, rightLeafCount ) / Math.max( leftLeafCount, rightLeafCount );

		// Prefer treelets with good balance (ratio > 0.3) and optimal size (5-9 leaves)
		const isWellBalanced = balanceRatio > 0.3;
		const isOptimalSize = leafCount >= 5 && leafCount <= 9;

		// Calculate surface area heuristic to prefer spatially compact treelets
		const surfaceArea = this.computeSurfaceAreaFromBounds( node.boundsMin, node.boundsMax );
		const avgLeafSA = surfaceArea / leafCount;

		// Prefer treelets with reasonable surface area per leaf (not too sparse)
		const isCompact = avgLeafSA < surfaceArea * 2.0; // Heuristic threshold

		return isWellBalanced || isOptimalSize || isCompact;

	}

	// Count leaf nodes in a subtree with safety limits
	countLeafNodes( node, depth = 0 ) {

		if ( ! node || depth > 20 ) return 0; // Prevent deep recursion
		if ( node.triangleCount > 0 ) return 1; // Leaf node
		
		return this.countLeafNodes( node.leftChild, depth + 1 ) +
		       this.countLeafNodes( node.rightChild, depth + 1 );

	}

	// Mark all nodes in a subtree as visited with safety limits
	markSubtreeVisited( node, visited, depth = 0 ) {

		if ( ! node || visited.has( node ) || depth > 20 ) return; // Prevent cycles and deep recursion
		
		visited.add( node );
		this.markSubtreeVisited( node.leftChild, visited, depth + 1 );
		this.markSubtreeVisited( node.rightChild, visited, depth + 1 );

	}

	// Optimize a single treelet
	optimizeTreelet( treeletRoot ) {

		// Extract leaf nodes and their triangle data
		const leafNodes = [];
		this.extractLeafNodes( treeletRoot, leafNodes );

		if ( leafNodes.length < 3 || leafNodes.length > this.treeletSize ) {

			return; // Skip invalid treelets

		}

		this.stats.treeletsProcessed ++;

		// Calculate original SAH cost
		const originalCost = this.evaluateSubtreeSAH( treeletRoot );

		// Get all possible topologies for this leaf count
		const topologies = this.topologyCache.get( leafNodes.length ) || [];
		let bestCost = originalCost;
		let bestTopology = null;

		// Evaluate each topology
		for ( const topology of topologies ) {

			const cost = this.evaluateTopologySAH( topology, leafNodes );
			if ( cost < bestCost ) {

				bestCost = cost;
				bestTopology = topology;

			}

		}

		// Apply optimization if improvement is significant
		const improvement = originalCost - bestCost;
		if ( improvement > this.minImprovement ) {

			this.reconstructTreelet( treeletRoot, bestTopology, leafNodes );
			this.stats.treeletsImproved ++;
			this.stats.totalSAHImprovement += improvement;

		}

	}

	// Extract all leaf nodes from a treelet
	extractLeafNodes( node, leafNodes ) {

		if ( ! node ) return;

		if ( node.triangleCount > 0 ) {

			leafNodes.push( {
				triangleOffset: node.triangleOffset,
				triangleCount: node.triangleCount,
				boundsMin: node.boundsMin.clone(),
				boundsMax: node.boundsMax.clone()
			} );
			return;

		}

		this.extractLeafNodes( node.leftChild, leafNodes );
		this.extractLeafNodes( node.rightChild, leafNodes );

	}

	// Evaluate SAH cost for a complete subtree
	evaluateSubtreeSAH( node ) {

		if ( ! node ) return 0;

		if ( node.triangleCount > 0 ) {

			// Leaf cost
			const surfaceArea = this.computeSurfaceAreaFromBounds( node.boundsMin, node.boundsMax );
			return surfaceArea * node.triangleCount * this.intersectionCost;

		}

		// Internal node cost
		const leftCost = this.evaluateSubtreeSAH( node.leftChild );
		const rightCost = this.evaluateSubtreeSAH( node.rightChild );
		const nodeSurfaceArea = this.computeSurfaceAreaFromBounds( node.boundsMin, node.boundsMax );

		return nodeSurfaceArea * this.traversalCost + leftCost + rightCost;

	}

	// Evaluate SAH cost for a specific topology arrangement
	evaluateTopologySAH( topology, leafNodes ) {

		// Reconstruct tree structure based on topology
		const tree = this.buildTopologyTree( topology, leafNodes );
		return this.evaluateTopologyTreeSAH( tree );

	}

	// Build tree structure from topology description
	buildTopologyTree( topology, leafNodes ) {

		if ( topology.length === 1 ) {

			return leafNodes[ topology[ 0 ] ];

		}

		// Find split point (this is simplified - full implementation would need proper topology parsing)
		const midPoint = Math.floor( topology.length / 2 );
		const leftTopology = topology.slice( 0, midPoint );
		const rightTopology = topology.slice( midPoint );

		const leftTree = this.buildTopologyTree( leftTopology, leafNodes );
		const rightTree = this.buildTopologyTree( rightTopology, leafNodes );

		// Compute combined bounds
		const boundsMin = new Vector3(
			Math.min( leftTree.boundsMin.x, rightTree.boundsMin.x ),
			Math.min( leftTree.boundsMin.y, rightTree.boundsMin.y ),
			Math.min( leftTree.boundsMin.z, rightTree.boundsMin.z )
		);

		const boundsMax = new Vector3(
			Math.max( leftTree.boundsMax.x, rightTree.boundsMax.x ),
			Math.max( leftTree.boundsMax.y, rightTree.boundsMax.y ),
			Math.max( leftTree.boundsMax.z, rightTree.boundsMax.z )
		);

		return {
			leftChild: leftTree,
			rightChild: rightTree,
			boundsMin,
			boundsMax,
			triangleCount: 0
		};

	}

	// Evaluate SAH cost for a topology tree structure
	evaluateTopologyTreeSAH( tree ) {

		if ( tree.triangleCount > 0 ) {

			// Leaf node
			const surfaceArea = this.computeSurfaceAreaFromBounds( tree.boundsMin, tree.boundsMax );
			return surfaceArea * tree.triangleCount * this.intersectionCost;

		}

		// Internal node
		const leftCost = this.evaluateTopologyTreeSAH( tree.leftChild );
		const rightCost = this.evaluateTopologyTreeSAH( tree.rightChild );
		const nodeSurfaceArea = this.computeSurfaceAreaFromBounds( tree.boundsMin, tree.boundsMax );

		return nodeSurfaceArea * this.traversalCost + leftCost + rightCost;

	}

	// Reconstruct treelet with optimal topology
	reconstructTreelet( treeletRoot, bestTopology, leafNodes ) {

		// Build the optimized tree structure
		const optimizedTree = this.buildTopologyTree( bestTopology, leafNodes );

		// Replace the original treelet with the optimized version
		treeletRoot.leftChild = optimizedTree.leftChild;
		treeletRoot.rightChild = optimizedTree.rightChild;
		treeletRoot.boundsMin.copy( optimizedTree.boundsMin );
		treeletRoot.boundsMax.copy( optimizedTree.boundsMax );
		treeletRoot.triangleCount = optimizedTree.triangleCount;
		treeletRoot.triangleOffset = optimizedTree.triangleOffset;

	}

	// Surface area computation (reuse from main builder)
	computeSurfaceAreaFromBounds( boundsMin, boundsMax ) {

		const dx = boundsMax.x - boundsMin.x;
		const dy = boundsMax.y - boundsMin.y;
		const dz = boundsMax.z - boundsMin.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

	// Configuration methods
	setTreeletSize( size ) {

		this.treeletSize = Math.max( 3, Math.min( 15, size ) );
		this.precomputeTopologies();

	}

	setMinImprovement( threshold ) {

		this.minImprovement = Math.max( 0.001, threshold );

	}

	getStatistics() {

		return { ...this.stats };

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
			totalBuildTime: 0,
			// Treelet optimization stats
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0
		};

		// Treelet optimization configuration - conservative settings to prevent crashes
		this.enableTreeletOptimization = true; // Enable by default for better ray performance
		this.treeletSize = 7; // Conservative: Reduced from 9 to 7 to prevent memory issues
		this.treeletOptimizationPasses = 1; // Conservative: Single pass to prevent excessive computation
		this.treeletMinImprovement = 0.01; // Conservative: Higher threshold to reduce computation load
		this.maxTreeletDepth = 3; // Conservative: Reduced depth to prevent deep recursion

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

	// Configuration for treelet optimization with enhanced safety
	setTreeletConfig( config ) {

		if ( config.enabled !== undefined ) this.enableTreeletOptimization = config.enabled;
		if ( config.size !== undefined ) this.treeletSize = Math.max( 3, Math.min( 12, config.size ) ); // Cap at 12 for safety
		if ( config.passes !== undefined ) this.treeletOptimizationPasses = Math.max( 1, Math.min( 3, config.passes ) ); // Cap at 3 passes
		if ( config.minImprovement !== undefined ) this.treeletMinImprovement = Math.max( 0.001, config.minImprovement );

		console.log( 'Treelet optimization config updated:', {
			enabled: this.enableTreeletOptimization,
			size: this.treeletSize,
			passes: this.treeletOptimizationPasses,
			minImprovement: this.treeletMinImprovement
		} );

	}

	// Method to safely disable treelet optimization
	disableTreeletOptimization() {

		this.enableTreeletOptimization = false;
		console.log( 'Treelet optimization disabled for safety' );

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

		for ( const [ , cluster ] of sortedClusters ) {

			// Clusters are already sorted by Morton code for spatial ordering
			const sortedCluster = this.sortTrianglesByMortonCode( cluster );
			result.push( ...sortedCluster );

		}

		this.splitStats.mortonSortTime += performance.now() - startTime;
		return result;

	}

	build( triangles, depth = 30, progressCallback = null ) {

		this.totalTriangles = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		this.processedTriangles = 0;
		this.lastProgressUpdate = performance.now();

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

			console.log( "Using Worker for BVH construction" );
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

					// Prepare data based on input format
					let workerData;
					let transferable = [];

					// Send Float32Array with transferable buffer
					const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
					// Clone the buffer to avoid detachment issues
					const bufferCopy = triangles.buffer.slice();
					workerData = {
						triangleData: bufferCopy,
						triangleCount,
						depth,
						reportProgress: !! progressCallback,
						// Include treelet optimization configuration
						treeletOptimization: {
							enabled: this.enableTreeletOptimization,
							size: this.treeletSize,
							passes: this.treeletOptimizationPasses,
							minImprovement: this.treeletMinImprovement
						}
					};
					transferable = [ bufferCopy ];

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
		this.totalTriangles = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
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
			totalBuildTime: 0,
			// Treelet optimization stats
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0
		};

		// Float32Array-based triangles
		const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		let triangleInfos = [];
		for ( let i = 0; i < triangleCount; i ++ ) {

			triangleInfos.push( new TriangleInfo( i, triangles ) );

		}


		// Apply Morton code spatial clustering for better cache locality
		// Use recursive clustering for very large datasets - the implemetion is currently missing
		triangleInfos = this.sortTrianglesByMortonCode( triangleInfos );

		// Create root node
		const root = this.buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback );

		// Apply treelet optimization if enabled - with enhanced safety checks
		if ( this.enableTreeletOptimization && this.totalTriangles > 1000 ) { // Increased threshold from 500 to 1000

			const optimizer = new TreeletOptimizer( this.traversalCost, this.intersectionCost );
			optimizer.setTreeletSize( this.treeletSize );
			optimizer.setMinImprovement( this.treeletMinImprovement );

			console.log( 'Starting treelet optimization...' );
			const optimizationStartTime = performance.now();

			// Run optimization passes with adaptive convergence and timeout protection
			for ( let pass = 0; pass < this.treeletOptimizationPasses; pass ++ ) {

				const passCallback = progressCallback ? ( status ) => {

					progressCallback( `Treelet optimization pass ${pass + 1}/${this.treeletOptimizationPasses}: ${status}` );

				} : null;

				const beforeStats = optimizer.getStatistics();
				
				try {

					optimizer.optimizeBVH( root, passCallback );

				} catch ( error ) {

					console.error( `TreeletOptimizer: Error in pass ${pass + 1}:`, error );
					break; // Stop optimization on error instead of crashing

				}
				
				const afterStats = optimizer.getStatistics();

				const currentPassImprovements = afterStats.treeletsImproved - beforeStats.treeletsImproved;

				// Early termination if no improvements in current pass or if taking too long
				const passTime = performance.now() - optimizationStartTime;
				if ( ( currentPassImprovements === 0 && pass > 0 ) || passTime > 15000 ) {

					console.log( `Treelet optimization stopped after ${pass + 1} passes (improvements: ${currentPassImprovements}, time: ${Math.round( passTime )}ms)` );
					break;

				}

			}

			// Update statistics
			const optimizationStats = optimizer.getStatistics();
			this.splitStats.treeletOptimizationTime = performance.now() - optimizationStartTime;
			this.splitStats.treeletsProcessed = optimizationStats.treeletsProcessed;
			this.splitStats.treeletsImproved = optimizationStats.treeletsImproved;
			this.splitStats.averageSAHImprovement = optimizationStats.averageSAHImprovement;

		} else if ( this.enableTreeletOptimization && this.totalTriangles <= 1000 ) {

			console.log( `Skipping treelet optimization for model with ${this.totalTriangles} triangles (below 1000 triangle threshold for safety)` );

		}

		// Record total build time
		this.splitStats.totalBuildTime = performance.now() - buildStartTime;

		const stats = {
			totalNodes: this.totalNodes,
			triangleCount: reorderedTriangles.length,
			maxDepth: depth,
			'Split Method: SAH': this.splitStats.sahSplits,
			'Split Method: Object Median': this.splitStats.objectMedianSplits,
			'Split Method: Spatial Median': this.splitStats.spatialMedianSplits,
			'Split Method: Failed': this.splitStats.failedSplits,
			'Adaptive Bins: Avg Used': Math.round( this.splitStats.avgBinsUsed * 10 ) / 10,
			'Adaptive Bins: Min': this.minBins,
			'Adaptive Bins: Max': this.maxBins,
			'Adaptive Bins: Base': this.numBins,
			'Treelet Opt: Enabled': this.enableTreeletOptimization,
			'Treelet Opt: Time (ms)': Math.round( this.splitStats.treeletOptimizationTime ),
			'Treelet Opt: Processed': this.splitStats.treeletsProcessed,
			'Treelet Opt: Improved': this.splitStats.treeletsImproved,
			'Treelet Opt: Avg SAH Improvement': Math.round( this.splitStats.averageSAHImprovement * 1000 ) / 1000,
			'Perf: Total Build Time (ms)': Math.round( this.splitStats.totalBuildTime ),
			'Perf: Morton Sort Time (ms)': Math.round( this.splitStats.mortonSortTime ),
			'Perf: Treelet Opt Time (ms)': Math.round( this.splitStats.treeletOptimizationTime ),
			'Perf: Morton %': Math.round( ( this.splitStats.mortonSortTime / this.splitStats.totalBuildTime ) * 100 ),
			'Perf: Treelet Opt %': Math.round( ( this.splitStats.treeletOptimizationTime / this.splitStats.totalBuildTime ) * 100 ),
			'Perf: Triangles/sec': Math.round( this.totalTriangles / ( this.splitStats.totalBuildTime / 1000 ) ),
			'Morton Clustering: Enabled': this.useMortonCodes,
			'Morton Clustering: Threshold': this.mortonClusterThreshold,
			'Morton Clustering: Bits': this.mortonBits,
		};

		console.log( 'BVH Statistics:' );
		console.table( stats );

		progressCallback && progressCallback( 100 );

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
		this.updateNodeBounds( node, triangleInfos );

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

	updateNodeBounds( node, triangleInfos ) {

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
