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

	const { triangles, triangleData, triangleCount, format } = e.data;

	try {

		let actualTriangleCount;
		let isFloat32ArrayInput = false;

		// Determine input format
		if ( format === 'float32array' && triangleData ) {

			actualTriangleCount = triangleCount;
			isFloat32ArrayInput = true;
			console.log( `[TriangleTextureWorker] Processing ${actualTriangleCount} triangles from Float32Array` );

		} else if ( triangles && Array.isArray( triangles ) ) {

			actualTriangleCount = triangles.length;
			isFloat32ArrayInput = false;
			console.log( `[TriangleTextureWorker] Processing ${actualTriangleCount} triangles from object array` );

		} else {

			throw new Error( 'Invalid triangle data format' );

		}

		// Calculate texture dimensions
		const vec4PerTriangle = TEXTURE_CONSTANTS.VEC4_PER_TRIANGLE;
		const floatsPerTriangle = vec4PerTriangle * TEXTURE_CONSTANTS.FLOATS_PER_VEC4;
		const dataLength = actualTriangleCount * floatsPerTriangle;

		// Calculate dimensions for a square-like texture
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( width * 4 ) );

		// Create the data array
		const size = width * height * 4; // Total size in floats
		const data = new Float32Array( size );

		// Process triangles
		for ( let i = 0; i < actualTriangleCount; i ++ ) {

			const stride = i * floatsPerTriangle;
			let tri;

			if ( isFloat32ArrayInput ) {

				// Extract triangle data from Float32Array
				const offset = i * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
				tri = {
					posA: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ]
					},
					posB: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ]
					},
					posC: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ]
					},
					normalA: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ]
					},
					normalB: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ]
					},
					normalC: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ],
						z: triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ]
					},
					uvA: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 1 ]
					},
					uvB: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 1 ]
					},
					uvC: {
						x: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 0 ],
						y: triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 1 ]
					},
					materialIndex: triangleData[ offset + TRIANGLE_DATA_LAYOUT.MATERIAL_INDEX_OFFSET ]
				};

			} else {

				// Use traditional object format
				tri = triangles[ i ];

			}

			// Store positions (3 vec4s)
			data[ stride + 0 ] = tri.posA.x; data[ stride + 1 ] = tri.posA.y; data[ stride + 2 ] = tri.posA.z; data[ stride + 3 ] = 0;
			data[ stride + 4 ] = tri.posB.x; data[ stride + 5 ] = tri.posB.y; data[ stride + 6 ] = tri.posB.z; data[ stride + 7 ] = 0;
			data[ stride + 8 ] = tri.posC.x; data[ stride + 9 ] = tri.posC.y; data[ stride + 10 ] = tri.posC.z; data[ stride + 11 ] = 0;

			// Store normals (3 vec4s)
			data[ stride + 12 ] = tri.normalA.x; data[ stride + 13 ] = tri.normalA.y; data[ stride + 14 ] = tri.normalA.z; data[ stride + 15 ] = 0;
			data[ stride + 16 ] = tri.normalB.x; data[ stride + 17 ] = tri.normalB.y; data[ stride + 18 ] = tri.normalB.z; data[ stride + 19 ] = 0;
			data[ stride + 20 ] = tri.normalC.x; data[ stride + 21 ] = tri.normalC.y; data[ stride + 22 ] = tri.normalC.z; data[ stride + 23 ] = 0;

			// Store UVs (2 vec4s)
			// First vec4: UV coordinates for vertices A and B
			data[ stride + 24 ] = tri.uvA.x; data[ stride + 25 ] = tri.uvA.y; data[ stride + 26 ] = tri.uvB.x; data[ stride + 27 ] = tri.uvB.y;
			// Second vec4: UV coordinates for vertex C, material index, and a padding value
			data[ stride + 28 ] = tri.uvC.x; data[ stride + 29 ] = tri.uvC.y; data[ stride + 30 ] = tri.materialIndex; data[ stride + 31 ] = 0;

		}

		// Send result back with transferable array buffer
		self.postMessage( {
			data: data.buffer,
			width,
			height,
			triangleCount: actualTriangleCount
		}, [ data.buffer ] );

	} catch ( error ) {

		console.error( '[TriangleTextureWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};
