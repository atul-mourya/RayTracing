self.onmessage = function ( e ) {

	const { bvhRoot } = e.data;

	try {

		const nodes = [];
		const flattenBVH = ( node ) => {

			const nodeIndex = nodes.length;
			nodes.push( node );
			if ( node.leftChild ) {

				const leftIndex = flattenBVH( node.leftChild );
				const rightIndex = flattenBVH( node.rightChild );
				node.leftChild = leftIndex;
				node.rightChild = rightIndex;

			}

			return nodeIndex;

		};

		flattenBVH( bvhRoot );

		// Use 3 vec4s per node (12 floats) to match TextureCreator
		const VEC4_PER_BVH_NODE = 3;
		const FLOATS_PER_VEC4 = 4;
		const dataLength = nodes.length * VEC4_PER_BVH_NODE * FLOATS_PER_VEC4; // 3 vec4s per node
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( 4 * width ) );
		const size = width * height * 4;
		const data = new Float32Array( size );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * 12; // 12 floats per node (3 vec4s)
			const node = nodes[ i ];

			// Vec4 1: boundsMin + leftChild
			data[ stride + 0 ] = node.boundsMin.x;
			data[ stride + 1 ] = node.boundsMin.y;
			data[ stride + 2 ] = node.boundsMin.z;
			data[ stride + 3 ] = node.leftChild !== null ? node.leftChild : - 1;

			// Vec4 2: boundsMax + rightChild
			data[ stride + 4 ] = node.boundsMax.x;
			data[ stride + 5 ] = node.boundsMax.y;
			data[ stride + 6 ] = node.boundsMax.z;
			data[ stride + 7 ] = node.rightChild !== null ? node.rightChild : - 1;

			// Vec4 3: triangleOffset, triangleCount, and padding
			data[ stride + 8 ] = node.triangleOffset;
			data[ stride + 9 ] = node.triangleCount;
			data[ stride + 10 ] = 0;
			data[ stride + 11 ] = 0;

		}

		// Clone buffer before transfer to avoid detachment issues
		const transferBuffer = data.buffer.slice();
		self.postMessage( { data: transferBuffer, width, height }, [ transferBuffer ] );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
