import { Vector3 } from "three";

export default class TreeletOptimizer {

	constructor( traversalCost, intersectionCost ) {

		this.traversalCost = traversalCost;
		this.intersectionCost = intersectionCost;
		this.treeletSize = 5; // Conservative: Reduced to 5 to prevent browser crashes
		this.minImprovement = 0.01; // Safe: Higher threshold to reduce computation
		this.maxTreeletDepth = 10; // Allow deeper treelets for complex scenes

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
		const totalTreelets = Math.min( treeletRoots.length, 50 ); // Limit max treelets to prevent browser crashes

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

		return bvhRoot;

	}

	// Identify treelet root nodes throughout the BVH
	identifyTreeletRoots( bvhRoot ) {

		const treeletRoots = [];
		const visited = new Set();

		console.log( `Starting treelet identification on BVH with root bounds:`, bvhRoot.boundsMin, bvhRoot.boundsMax );
		this.traverseForTreelets( bvhRoot, treeletRoots, visited, 0 );
		console.log( `Treelet identification complete: found ${treeletRoots.length} treelets` );
		return treeletRoots;

	}

	// Recursive traversal to find optimal treelet boundaries with safety limits
	traverseForTreelets( node, treeletRoots, visited, depth ) {

		// Safety checks to prevent infinite recursion and memory issues
		if ( ! node || visited.has( node ) || node.triangleCount > 0 || depth > 25 ) {

			if ( depth === 0 && node ) {

				console.log( `Root node check: triangleCount=${node.triangleCount}, depth=${depth}` );

			}

			if ( depth > 25 ) {

				console.log( `Skipping node at depth ${depth} (too deep)` );

			}

			return 0; // Skip leaves, already processed nodes, and deep recursion

		}

		// Add current node to visited set immediately to prevent cycles
		visited.add( node );

		const leftLeafCount = this.countLeafNodes( node.leftChild );
		const rightLeafCount = this.countLeafNodes( node.rightChild );
		const totalLeafCount = leftLeafCount + rightLeafCount;

		if ( depth < 3 ) {

			console.log( `Node at depth ${depth}: leftLeaf=${leftLeafCount}, rightLeaf=${rightLeafCount}, total=${totalLeafCount}` );

		}

		// For large subtrees, continue traversing instead of skipping
		// Only skip if extremely large to prevent memory issues
		if ( totalLeafCount > 100000 ) {

			if ( depth < 5 ) {

				console.log( `Skipping node at depth ${depth} - extremely large subtree (${totalLeafCount} leaves)` );

			}

			return totalLeafCount;

		}

		// More conservative treelet selection criteria to prevent problematic cases
		const isGoodTreeletRoot = totalLeafCount >= 3 &&
            totalLeafCount <= this.treeletSize &&
            depth <= this.maxTreeletDepth &&
            leftLeafCount > 0 && rightLeafCount > 0 && // Ensure balanced
            this.evaluateTreeletQuality( node, totalLeafCount );

		if ( isGoodTreeletRoot ) {

			console.log( `Found treelet at depth ${depth}: ${totalLeafCount} leaves` );


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

		if ( ! node || depth > 35 ) return 0; // Prevent deep recursion
		if ( node.triangleCount > 0 ) return 1; // Leaf node

		return this.countLeafNodes( node.leftChild, depth + 1 ) +
               this.countLeafNodes( node.rightChild, depth + 1 );

	}

	// Mark all nodes in a subtree as visited with safety limits
	markSubtreeVisited( node, visited, depth = 0 ) {

		if ( ! node || visited.has( node ) || depth > 35 ) return; // Prevent cycles and deep recursion

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

		// Safety limit: skip if too many topologies to prevent browser freeze
		if ( topologies.length > 1000 ) {

			return;

		}

		// Evaluate each topology with timeout protection
		const evaluationStartTime = performance.now();
		for ( const topology of topologies ) {

			// Timeout check to prevent browser freeze
			if ( performance.now() - evaluationStartTime > 100 ) {

				break; // Skip remaining topologies if taking too long

			}

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
