/**
 * LightBVHBuilder
 *
 * CPU-side BVH builder over emissive triangles for spatially-aware light sampling.
 * Each node occupies 4 vec4s (16 floats, BVH_STRIDE=4):
 *
 *   vec4[0]: [aabb.minX, aabb.minY, aabb.minZ, totalPower]
 *   vec4[1]: [aabb.maxX, aabb.maxY, aabb.maxZ, isLeaf]   // isLeaf: 0.0=inner, 1.0=leaf
 *   vec4[2]: inner → [leftChildIdx, rightChildIdx, 0, 0]
 *            leaf  → [emissiveStart, emissiveCount, 0, 0]
 *   vec4[3]: [0, 0, 0, 0]
 *
 * Build algorithm: median split on longest centroid AABB axis, maxLeafSize=8.
 * Output: pre-order flattened array with right child pushed first (so left is processed first).
 */
export class LightBVHBuilder {

	constructor() {

		this.maxLeafSize = 8;

	}

	/**
	 * Build the Light BVH over emissive triangles.
	 *
	 * @param {Array} emissiveTriangles - Array of objects:
	 *   { triangleIndex, power, area, emissive, emissiveIntensity, cx, cy, cz,
	 *     bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ }
	 * @returns {{ nodeData: Float32Array, nodeCount: number, sortedPerm: Int32Array }}
	 *   sortedPerm[i] = original index in emissiveTriangles for position i in sorted leaf order
	 */
	build( emissiveTriangles ) {

		const n = emissiveTriangles.length;
		if ( n === 0 ) {

			// Dummy leaf node
			const nodeData = new Float32Array( 16 );
			nodeData[ 7 ] = 1.0; // isLeaf
			return { nodeData, nodeCount: 1, sortedPerm: new Int32Array( 0 ) };

		}

		// Working indices into emissiveTriangles (will be reordered in-place)
		const indices = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) indices[ i ] = i;

		// Pre-allocate node storage: upper bound is 2*n nodes
		const maxNodes = 2 * n + 4;
		// Each node is 16 floats
		const nodeData = new Float32Array( maxNodes * 16 );
		let nodeCount = 0;

		// Recursively build; returns node index
		const buildRecursive = ( start, end ) => {

			const nodeIndex = nodeCount ++;
			const nodeOffset = nodeIndex * 16;

			// Compute AABB and total power for this range
			let minX = Infinity, minY = Infinity, minZ = Infinity;
			let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
			let totalPower = 0;
			// Also track centroid AABB for split axis
			let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
			let cMaxX = - Infinity, cMaxY = - Infinity, cMaxZ = - Infinity;

			for ( let i = start; i < end; i ++ ) {

				const tri = emissiveTriangles[ indices[ i ] ];
				minX = Math.min( minX, tri.bMinX );
				minY = Math.min( minY, tri.bMinY );
				minZ = Math.min( minZ, tri.bMinZ );
				maxX = Math.max( maxX, tri.bMaxX );
				maxY = Math.max( maxY, tri.bMaxY );
				maxZ = Math.max( maxZ, tri.bMaxZ );
				totalPower += tri.power;
				cMinX = Math.min( cMinX, tri.cx );
				cMinY = Math.min( cMinY, tri.cy );
				cMinZ = Math.min( cMinZ, tri.cz );
				cMaxX = Math.max( cMaxX, tri.cx );
				cMaxY = Math.max( cMaxY, tri.cy );
				cMaxZ = Math.max( cMaxZ, tri.cz );

			}

			// vec4[0]: [minX, minY, minZ, totalPower]
			nodeData[ nodeOffset + 0 ] = minX;
			nodeData[ nodeOffset + 1 ] = minY;
			nodeData[ nodeOffset + 2 ] = minZ;
			nodeData[ nodeOffset + 3 ] = totalPower;

			// vec4[1]: [maxX, maxY, maxZ, isLeaf] — fill isLeaf below
			nodeData[ nodeOffset + 4 ] = maxX;
			nodeData[ nodeOffset + 5 ] = maxY;
			nodeData[ nodeOffset + 6 ] = maxZ;
			// nodeData[nodeOffset + 7] = isLeaf — set below

			// vec4[3]: zeros (reserved)
			nodeData[ nodeOffset + 12 ] = 0;
			nodeData[ nodeOffset + 13 ] = 0;
			nodeData[ nodeOffset + 14 ] = 0;
			nodeData[ nodeOffset + 15 ] = 0;

			const count = end - start;

			if ( count <= this.maxLeafSize ) {

				// LEAF NODE
				nodeData[ nodeOffset + 7 ] = 1.0; // isLeaf
				nodeData[ nodeOffset + 8 ] = start; // emissiveStart
				nodeData[ nodeOffset + 9 ] = count; // emissiveCount
				nodeData[ nodeOffset + 10 ] = 0;
				nodeData[ nodeOffset + 11 ] = 0;

			} else {

				// INNER NODE — find longest centroid axis and split at median
				const extX = cMaxX - cMinX;
				const extY = cMaxY - cMinY;
				const extZ = cMaxZ - cMinZ;

				let axis;
				if ( extX >= extY && extX >= extZ ) axis = 0;
				else if ( extY >= extZ ) axis = 1;
				else axis = 2;

				const axisKeys = [ 'cx', 'cy', 'cz' ];
				const axisKey = axisKeys[ axis ];

				// Partial sort: partition around median
				const mid = ( start + end ) >> 1;
				this._nthElement( indices, emissiveTriangles, start, end, mid, axisKey );

				nodeData[ nodeOffset + 7 ] = 0.0; // isLeaf = false (inner)

				// Build children (right first so left is processed first in pre-order)
				// We need left index first but must build in correct pre-order order
				// Build left child immediately after this node
				const leftChildIdx = buildRecursive( start, mid );
				const rightChildIdx = buildRecursive( mid, end );

				nodeData[ nodeOffset + 8 ] = leftChildIdx;
				nodeData[ nodeOffset + 9 ] = rightChildIdx;
				nodeData[ nodeOffset + 10 ] = 0;
				nodeData[ nodeOffset + 11 ] = 0;

			}

			return nodeIndex;

		};

		buildRecursive( 0, n );

		// sortedPerm: the rearranged indices array (leaf order)
		const sortedPerm = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) sortedPerm[ i ] = indices[ i ];

		// Trim nodeData to actual used size
		const trimmedData = new Float32Array( nodeCount * 16 );
		trimmedData.set( nodeData.subarray( 0, nodeCount * 16 ) );

		console.log( `[LightBVHBuilder] Built BVH: ${nodeCount} nodes for ${n} emissive triangles` );

		return { nodeData: trimmedData, nodeCount, sortedPerm };

	}

	/**
	 * Partial selection: rearranges indices[start..end) so that indices[k] is
	 * the element that would be at position k in a sorted array, with elements
	 * < median to the left and >= median to the right.
	 * Uses introselect (simple quickselect here).
	 * @private
	 */
	_nthElement( indices, tris, start, end, k, axisKey ) {

		while ( start < end - 1 ) {

			// Pick pivot as median of first/middle/last
			const mid = ( start + end ) >> 1;
			const pivotVal = tris[ indices[ mid ] ][ axisKey ];

			// Move pivot to end
			let tmp = indices[ mid ];
			indices[ mid ] = indices[ end - 1 ];
			indices[ end - 1 ] = tmp;

			// Partition
			let store = start;
			for ( let i = start; i < end - 1; i ++ ) {

				if ( tris[ indices[ i ] ][ axisKey ] < pivotVal ) {

					tmp = indices[ i ];
					indices[ i ] = indices[ store ];
					indices[ store ] = tmp;
					store ++;

				}

			}

			// Restore pivot
			tmp = indices[ store ];
			indices[ store ] = indices[ end - 1 ];
			indices[ end - 1 ] = tmp;

			if ( store === k ) return;
			else if ( store < k ) start = store + 1;
			else end = store;

		}

	}

}
