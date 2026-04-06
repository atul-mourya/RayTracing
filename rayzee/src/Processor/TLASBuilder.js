/**
 * TLASBuilder — Builds a Top-Level Acceleration Structure (TLAS) from mesh AABBs.
 *
 * Produces a small SAH BVH where leaves are BLAS-pointer nodes (marker -2)
 * that reference per-mesh BLAS root indices in the combined BVH buffer.
 */

import { BVH_LEAF_MARKERS } from '../EngineDefaults.js';

const FLOATS_PER_NODE = 16;

class TLASNode {

	constructor() {

		this.minX = 0; this.minY = 0; this.minZ = 0;
		this.maxX = 0; this.maxY = 0; this.maxZ = 0;
		this.leftChild = null;
		this.rightChild = null;
		this.entryIndex = - 1; // Index into InstanceTable.entries (leaf only)

	}

}

export class TLASBuilder {

	constructor() {

		// Cached flatten buffer — reused across rebuilds to avoid per-refit allocation.
		this._flatBuffer = null;
		this._flatBufferCapacity = 0;

	}

	/**
	 * Build TLAS from instance table entries.
	 *
	 * @param {Array<{worldAABB: {minX,minY,minZ,maxX,maxY,maxZ}, blasOffset: number}>} entries
	 * @returns {{ root: TLASNode, nodeCount: number }}
	 */
	build( entries ) {

		if ( entries.length === 0 ) {

			return { root: null, nodeCount: 0 };

		}

		// Build array of indices for partitioning
		const indices = [];
		for ( let i = 0; i < entries.length; i ++ ) {

			indices.push( i );

		}

		const root = this._buildRecursive( entries, indices );
		const nodeCount = this._countNodes( root );

		return { root, nodeCount };

	}

	/**
	 * Recursive SAH-based TLAS build.
	 * @private
	 */
	_buildRecursive( entries, indices ) {

		const node = new TLASNode();

		if ( indices.length === 1 ) {

			// Leaf — single mesh
			const entry = entries[ indices[ 0 ] ];
			const aabb = entry.worldAABB;
			node.minX = aabb.minX; node.minY = aabb.minY; node.minZ = aabb.minZ;
			node.maxX = aabb.maxX; node.maxY = aabb.maxY; node.maxZ = aabb.maxZ;
			node.entryIndex = indices[ 0 ];
			return node;

		}

		// Compute overall AABB
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( const idx of indices ) {

			const aabb = entries[ idx ].worldAABB;
			if ( aabb.minX < minX ) minX = aabb.minX;
			if ( aabb.minY < minY ) minY = aabb.minY;
			if ( aabb.minZ < minZ ) minZ = aabb.minZ;
			if ( aabb.maxX > maxX ) maxX = aabb.maxX;
			if ( aabb.maxY > maxY ) maxY = aabb.maxY;
			if ( aabb.maxZ > maxZ ) maxZ = aabb.maxZ;

		}

		node.minX = minX; node.minY = minY; node.minZ = minZ;
		node.maxX = maxX; node.maxY = maxY; node.maxZ = maxZ;

		// If only 2 entries, split trivially
		if ( indices.length === 2 ) {

			node.leftChild = this._buildRecursive( entries, [ indices[ 0 ] ] );
			node.rightChild = this._buildRecursive( entries, [ indices[ 1 ] ] );
			return node;

		}

		// SAH split: try all 3 axes, pick best
		const parentSA = this._surfaceArea( minX, minY, minZ, maxX, maxY, maxZ );
		let bestCost = Infinity;
		let bestAxis = 0;
		let bestSplit = 0;

		for ( let axis = 0; axis < 3; axis ++ ) {

			// Sort indices by centroid along axis
			const sorted = indices.slice().sort( ( a, b ) => {

				const aabbA = entries[ a ].worldAABB;
				const aabbB = entries[ b ].worldAABB;
				const cA = this._centroid( aabbA, axis );
				const cB = this._centroid( aabbB, axis );
				return cA - cB;

			} );

			// Evaluate SAH for each split position
			for ( let i = 1; i < sorted.length; i ++ ) {

				const leftAABB = this._computeGroupAABB( entries, sorted, 0, i );
				const rightAABB = this._computeGroupAABB( entries, sorted, i, sorted.length );

				const leftSA = this._surfaceArea(
					leftAABB.minX, leftAABB.minY, leftAABB.minZ,
					leftAABB.maxX, leftAABB.maxY, leftAABB.maxZ
				);
				const rightSA = this._surfaceArea(
					rightAABB.minX, rightAABB.minY, rightAABB.minZ,
					rightAABB.maxX, rightAABB.maxY, rightAABB.maxZ
				);

				// SAH cost: traversal + (leftSA/parentSA * leftCount + rightSA/parentSA * rightCount)
				const cost = 1.0 + ( leftSA * i + rightSA * ( sorted.length - i ) ) / parentSA;

				if ( cost < bestCost ) {

					bestCost = cost;
					bestAxis = axis;
					bestSplit = i;

				}

			}

		}

		// Sort along best axis and split
		const sorted = indices.slice().sort( ( a, b ) => {

			return this._centroid( entries[ a ].worldAABB, bestAxis ) -
				this._centroid( entries[ b ].worldAABB, bestAxis );

		} );

		const leftIndices = sorted.slice( 0, bestSplit );
		const rightIndices = sorted.slice( bestSplit );

		node.leftChild = this._buildRecursive( entries, leftIndices );
		node.rightChild = this._buildRecursive( entries, rightIndices );

		return node;

	}

	/**
	 * Flatten TLAS tree into Float32Array.
	 * Inner nodes: same format as BVH.
	 * Leaf nodes: [blasRootNodeIndex, 0, 0, -2] (BLAS-pointer marker).
	 *
	 * @param {TLASNode} root
	 * @param {Array<{blasOffset: number}>} entries - Instance table entries with assigned blasOffsets
	 * @returns {Float32Array}
	 */
	flatten( root, entries ) {

		if ( ! root ) return new Float32Array( 0 );

		// Pre-order traversal to assign flat indices
		const nodes = [];
		const stack = [ root ];
		while ( stack.length > 0 ) {

			const n = stack.pop();
			n._flatIndex = nodes.length;
			nodes.push( n );
			if ( n.rightChild ) stack.push( n.rightChild );
			if ( n.leftChild ) stack.push( n.leftChild );

		}

		// Reuse cached buffer (grow-only to avoid per-refit allocation)
		const requiredSize = nodes.length * FLOATS_PER_NODE;
		if ( requiredSize > this._flatBufferCapacity ) {

			this._flatBuffer = new Float32Array( requiredSize );
			this._flatBufferCapacity = requiredSize;

		}

		const data = this._flatBuffer;
		data.fill( 0, 0, requiredSize ); // Clear stale data

		for ( let i = 0; i < nodes.length; i ++ ) {

			const n = nodes[ i ];
			const o = i * FLOATS_PER_NODE;

			if ( n.leftChild ) {

				// Inner node — same format as BVH inner nodes
				const left = n.leftChild;
				const right = n.rightChild;

				data[ o ] = left.minX;
				data[ o + 1 ] = left.minY;
				data[ o + 2 ] = left.minZ;
				data[ o + 3 ] = left._flatIndex;

				data[ o + 4 ] = left.maxX;
				data[ o + 5 ] = left.maxY;
				data[ o + 6 ] = left.maxZ;
				data[ o + 7 ] = right._flatIndex;

				data[ o + 8 ] = right.minX;
				data[ o + 9 ] = right.minY;
				data[ o + 10 ] = right.minZ;

				data[ o + 12 ] = right.maxX;
				data[ o + 13 ] = right.maxY;
				data[ o + 14 ] = right.maxZ;

			} else {

				// Leaf node — BLAS pointer
				const entry = entries[ n.entryIndex ];
				data[ o ] = entry.blasOffset; // Absolute node index of BLAS root in combined buffer
				// data[o+1] = 0
				// data[o+2] = 0
				data[ o + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF; // -2 marker

			}

		}

		return data.subarray( 0, requiredSize );

	}

	// ── Helpers ──

	_centroid( aabb, axis ) {

		if ( axis === 0 ) return ( aabb.minX + aabb.maxX ) * 0.5;
		if ( axis === 1 ) return ( aabb.minY + aabb.maxY ) * 0.5;
		return ( aabb.minZ + aabb.maxZ ) * 0.5;

	}

	_surfaceArea( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2.0 * ( dx * dy + dy * dz + dz * dx );

	}

	_computeGroupAABB( entries, sorted, from, to ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( let i = from; i < to; i ++ ) {

			const aabb = entries[ sorted[ i ] ].worldAABB;
			if ( aabb.minX < minX ) minX = aabb.minX;
			if ( aabb.minY < minY ) minY = aabb.minY;
			if ( aabb.minZ < minZ ) minZ = aabb.minZ;
			if ( aabb.maxX > maxX ) maxX = aabb.maxX;
			if ( aabb.maxY > maxY ) maxY = aabb.maxY;
			if ( aabb.maxZ > maxZ ) maxZ = aabb.maxZ;

		}

		return { minX, minY, minZ, maxX, maxY, maxZ };

	}

	_countNodes( node ) {

		if ( ! node ) return 0;
		return 1 + this._countNodes( node.leftChild ) + this._countNodes( node.rightChild );

	}

}
