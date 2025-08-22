self.onmessage = function ( e ) {

	try {

		const { nodes, width, height } = e.data;

		// Calculate texture data
		const dataInEachPixel = 4; // RGBA components
		const vec4PerNode = 3; // Each BVH node uses 3 vec4s
		const totalPixels = width * height;
		const data = new Float32Array( totalPixels * dataInEachPixel );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const node = nodes[ i ];
			const stride = i * vec4PerNode * dataInEachPixel;

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
