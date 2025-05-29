// Triangle data layout constants (must match GeometryExtractor)
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

// Texture constants
const TEXTURE_CONSTANTS = {
	VEC4_PER_TRIANGLE: 8, // 3 for positions, 3 for normals, 2 for UVs
	FLOATS_PER_VEC4: 4
};

self.onmessage = function ( e ) {

	const { triangleData, triangleCount } = e.data;

	try {

		console.log( `[TriangleTextureWorker] Processing ${triangleCount} triangles from Float32Array` );

		// Calculate texture dimensions
		const vec4PerTriangle = TEXTURE_CONSTANTS.VEC4_PER_TRIANGLE;
		const floatsPerTriangle = vec4PerTriangle * TEXTURE_CONSTANTS.FLOATS_PER_VEC4;
		const dataLength = triangleCount * floatsPerTriangle;

		// Calculate dimensions for a square-like texture
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( width * 4 ) );

		// Create the data array
		const size = width * height * 4;
		const data = new Float32Array( size );

		// Pre-calculate constants to avoid repeated lookups
		const LAYOUT = TRIANGLE_DATA_LAYOUT;
		const inputStride = LAYOUT.FLOATS_PER_TRIANGLE;

		// Process triangles in batches for better cache performance
		const BATCH_SIZE = 64; // Process 64 triangles at a time
		const batches = Math.ceil( triangleCount / BATCH_SIZE );

		for ( let batch = 0; batch < batches; batch ++ ) {

			const batchStart = batch * BATCH_SIZE;
			const batchEnd = Math.min( batchStart + BATCH_SIZE, triangleCount );

			for ( let i = batchStart; i < batchEnd; i ++ ) {

				const inputBase = i * inputStride;
				const outputBase = i * floatsPerTriangle;

				// Use direct indexing with pre-calculated base offsets
				// Positions - copy 3 vec3s as vec4s with zero padding
				const pABase = inputBase + LAYOUT.POSITION_A_OFFSET;
				const pBBase = inputBase + LAYOUT.POSITION_B_OFFSET;
				const pCBase = inputBase + LAYOUT.POSITION_C_OFFSET;

				data[ outputBase + 0 ] = triangleData[ pABase ]; data[ outputBase + 1 ] = triangleData[ pABase + 1 ]; data[ outputBase + 2 ] = triangleData[ pABase + 2 ]; data[ outputBase + 3 ] = 0;
				data[ outputBase + 4 ] = triangleData[ pBBase ]; data[ outputBase + 5 ] = triangleData[ pBBase + 1 ]; data[ outputBase + 6 ] = triangleData[ pBBase + 2 ]; data[ outputBase + 7 ] = 0;
				data[ outputBase + 8 ] = triangleData[ pCBase ]; data[ outputBase + 9 ] = triangleData[ pCBase + 1 ]; data[ outputBase + 10 ] = triangleData[ pCBase + 2 ]; data[ outputBase + 11 ] = 0;

				// Normals - copy 3 vec3s as vec4s with zero padding
				const nABase = inputBase + LAYOUT.NORMAL_A_OFFSET;
				const nBBase = inputBase + LAYOUT.NORMAL_B_OFFSET;
				const nCBase = inputBase + LAYOUT.NORMAL_C_OFFSET;

				data[ outputBase + 12 ] = triangleData[ nABase ]; data[ outputBase + 13 ] = triangleData[ nABase + 1 ]; data[ outputBase + 14 ] = triangleData[ nABase + 2 ]; data[ outputBase + 15 ] = 0;
				data[ outputBase + 16 ] = triangleData[ nBBase ]; data[ outputBase + 17 ] = triangleData[ nBBase + 1 ]; data[ outputBase + 18 ] = triangleData[ nBBase + 2 ]; data[ outputBase + 19 ] = 0;
				data[ outputBase + 20 ] = triangleData[ nCBase ]; data[ outputBase + 21 ] = triangleData[ nCBase + 1 ]; data[ outputBase + 22 ] = triangleData[ nCBase + 2 ]; data[ outputBase + 23 ] = 0;

				// UVs and material - pack efficiently
				const uvABase = inputBase + LAYOUT.UV_A_OFFSET;
				const uvBBase = inputBase + LAYOUT.UV_B_OFFSET;
				const uvCBase = inputBase + LAYOUT.UV_C_OFFSET;

				data[ outputBase + 24 ] = triangleData[ uvABase ]; data[ outputBase + 25 ] = triangleData[ uvABase + 1 ]; data[ outputBase + 26 ] = triangleData[ uvBBase ]; data[ outputBase + 27 ] = triangleData[ uvBBase + 1 ];
				data[ outputBase + 28 ] = triangleData[ uvCBase ]; data[ outputBase + 29 ] = triangleData[ uvCBase + 1 ]; data[ outputBase + 30 ] = triangleData[ inputBase + LAYOUT.MATERIAL_INDEX_OFFSET ]; data[ outputBase + 31 ] = 0;

			}

		}

		// Send result back with Float32Array and transferable array buffer
		self.postMessage( {
			data: data,
			width,
			height,
			triangleCount: triangleCount
		}, [ data.buffer ] );

	} catch ( error ) {

		console.error( '[TriangleTextureWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};
