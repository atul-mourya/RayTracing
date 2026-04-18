/**
 * InstanceTable — Per-mesh BLAS metadata for the two-level BVH (TLAS/BLAS).
 *
 * Tracks each mesh's BLAS location within the combined BVH buffer,
 * its triangle range in the global triangle buffer, world-space AABB,
 * and per-BLAS triangle reorder map for refit.
 */

import { TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';

export class InstanceTable {

	constructor() {

		/** @type {InstanceEntry[]} */
		this.entries = [];

		/** Total BVH node count across all BLASes (excludes TLAS nodes) */
		this.totalBLASNodes = 0;

		/** Number of TLAS nodes */
		this.tlasNodeCount = 0;

	}

	/**
	 * Pre-allocate entries array for a known mesh count.
	 * Must be called before setEntry().
	 * @param {number} count
	 */
	allocate( count ) {

		this.entries = new Array( count ).fill( null );

	}

	/**
	 * Set a mesh entry at a specific index (meshIndex) after its BLAS has been built.
	 * Guarantees entries[meshIndex] maps to the correct mesh regardless of build order.
	 *
	 * @param {Object} params
	 * @param {number} params.meshIndex - Index into the meshes array (also the slot index)
	 * @param {number} params.blasNodeCount - Number of BVH nodes in this BLAS
	 * @param {number} params.triOffset - Triangle index offset in global triangleData
	 * @param {number} params.triCount - Number of triangles for this mesh
	 * @param {Uint32Array} params.originalToBvhMap - Per-BLAS triangle reorder map
	 * @param {Float32Array} params.bvhData - Raw BLAS BVH data (local indices, before assembly)
	 */
	setEntry( { meshIndex, blasNodeCount, triOffset, triCount, originalToBvhMap, bvhData } ) {

		this.entries[ meshIndex ] = {
			meshIndex,
			blasOffset: 0, // Set during assembly
			blasNodeCount,
			triOffset,
			triCount,
			worldAABB: null, // Computed from triangle data
			originalToBvhMap,
			bvhData,
		};

	}

	/**
	 * Compute world-space AABBs for all entries from their BLAS root node data.
	 * O(1) per mesh for inner roots; falls back to triangle scan for leaf roots (rare).
	 *
	 * @param {Float32Array} triangleData - Global triangle data (needed for leaf-root fallback)
	 */
	computeAABBs( triangleData ) {

		for ( const entry of this.entries ) {

			if ( ! entry ) continue;
			entry.worldAABB = this._readRootAABB( entry.bvhData, entry, triangleData );

		}

	}

	/**
	 * Recompute AABB for a single entry after BLAS refit.
	 * Reads from the combined bvhData buffer at the BLAS root offset.
	 *
	 * @param {number} entryIndex
	 * @param {Float32Array} combinedBvhData - The assembled BVH buffer (TLAS + BLASes)
	 * @param {Float32Array} triangleData - Global triangle data (for leaf-root fallback)
	 */
	recomputeAABB( entryIndex, combinedBvhData, triangleData ) {

		const entry = this.entries[ entryIndex ];
		const rootData = combinedBvhData.subarray( entry.blasOffset * 16, entry.blasOffset * 16 + 16 );
		entry.worldAABB = this._readRootAABB( rootData, entry, triangleData );

	}

	/**
	 * Read the root node's AABB from a flat BVH data array.
	 * Inner root: union of left+right child AABBs (O(1)).
	 * Leaf root: scan triangles (rare — only meshes with ≤maxLeafSize tris).
	 * @private
	 */
	_readRootAABB( bvhData, entry, triangleData ) {

		const marker = bvhData[ 3 ];

		if ( marker === - 1 ) {

			// Root is a leaf — very small mesh. Scan its triangles.
			return this._computeAABBFromTriangles( entry, triangleData );

		}

		// Inner node: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		const lMinX = bvhData[ 0 ], lMinY = bvhData[ 1 ], lMinZ = bvhData[ 2 ];
		const lMaxX = bvhData[ 4 ], lMaxY = bvhData[ 5 ], lMaxZ = bvhData[ 6 ];
		const rMinX = bvhData[ 8 ], rMinY = bvhData[ 9 ], rMinZ = bvhData[ 10 ];
		const rMaxX = bvhData[ 12 ], rMaxY = bvhData[ 13 ], rMaxZ = bvhData[ 14 ];

		return {
			minX: Math.min( lMinX, rMinX ),
			minY: Math.min( lMinY, rMinY ),
			minZ: Math.min( lMinZ, rMinZ ),
			maxX: Math.max( lMaxX, rMaxX ),
			maxY: Math.max( lMaxY, rMaxY ),
			maxZ: Math.max( lMaxZ, rMaxZ ),
		};

	}

	/**
	 * Compute AABB by scanning triangle positions (fallback for leaf-root BLASes).
	 * @private
	 */
	_computeAABBFromTriangles( entry, triangleData ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( let t = 0; t < entry.triCount; t ++ ) {

			const base = ( entry.triOffset + t ) * FPT;

			// Check positions A (offset 0), B (offset 4), C (offset 8)
			for ( let off = 0; off <= 8; off += 4 ) {

				const x = triangleData[ base + off ];
				const y = triangleData[ base + off + 1 ];
				const z = triangleData[ base + off + 2 ];
				if ( x < minX ) minX = x;
				if ( y < minY ) minY = y;
				if ( z < minZ ) minZ = z;
				if ( x > maxX ) maxX = x;
				if ( y > maxY ) maxY = y;
				if ( z > maxZ ) maxZ = z;

			}

		}

		return { minX, minY, minZ, maxX, maxY, maxZ };

	}

	/**
	 * Assign BLAS offsets in the combined BVH buffer.
	 * Called after TLAS node count is known.
	 *
	 * @param {number} tlasNodeCount - Number of nodes in the TLAS
	 */
	assignOffsets( tlasNodeCount ) {

		this.tlasNodeCount = tlasNodeCount;
		let offset = tlasNodeCount;

		for ( const entry of this.entries ) {

			if ( ! entry ) continue;
			entry.blasOffset = offset;
			offset += entry.blasNodeCount;

		}

		this.totalBLASNodes = offset - tlasNodeCount;

	}

	/**
	 * Total node count (TLAS + all BLASes).
	 */
	get totalNodeCount() {

		return this.tlasNodeCount + this.totalBLASNodes;

	}

	/**
	 * Number of mesh instances.
	 */
	get count() {

		return this.entries.length;

	}

	/**
	 * Reset all entries.
	 */
	clear() {

		this.entries = [];
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;

	}

}
