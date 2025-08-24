import BVHBuilder from '../BVHBuilder.js';

// Unified triangle data layout constants (32 floats)
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

self.onmessage = function ( e ) {

	const { triangleData, triangleCount, depth, reportProgress, treeletOptimization } = e.data;
	const builder = new BVHBuilder();

	try {

		// Configure treelet optimization if provided
		if ( treeletOptimization ) {

			builder.setTreeletConfig( treeletOptimization );

		}

		// Create progress callback if progress reporting is enabled
		const progressCallback = reportProgress ? ( progress ) => {

			self.postMessage( { progress } );

		} : null;

		// Determine input format and prepare data
		let inputTriangles = new Float32Array( triangleData );

		// Build BVH - builder can handle both formats
		const reorderedTriangles = [];
		const bvhRoot = builder.buildSync( inputTriangles, depth, reorderedTriangles, progressCallback );

		// Prepare response based on input format
		// Convert reordered triangle objects back to Float32Array format
		const reorderedFloat32Array = convertObjectsToFloat32Array( reorderedTriangles );

		self.postMessage( {
			bvhRoot,
			triangles: reorderedFloat32Array,
			triangleCount: reorderedTriangles.length,
			treeletStats: builder.splitStats
		}, [ reorderedFloat32Array.buffer ] );


	} catch ( error ) {

		console.error( '[BVHWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};

/**
 * Convert array of triangle objects to Float32Array format (32 floats per triangle)
 * @param {Array} triangleObjects - Array of triangle objects
 * @returns {Float32Array} - Packed triangle data
 */
function convertObjectsToFloat32Array( triangleObjects ) {

	const triangleCount = triangleObjects.length;
	const data = new Float32Array( triangleCount * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );

	for ( let i = 0; i < triangleCount; i ++ ) {

		const tri = triangleObjects[ i ];
		const offset = i * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

		// Positions as vec4s (3 vec4s = 12 floats)
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ] = tri.posA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = tri.posA.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = tri.posA.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 3 ] = 0; // vec4 padding

		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ] = tri.posB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = tri.posB.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = tri.posB.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 3 ] = 0; // vec4 padding

		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ] = tri.posC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = tri.posC.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = tri.posC.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 3 ] = 0; // vec4 padding

		// Normals as vec4s (3 vec4s = 12 floats)
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ] = tri.normalA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ] = tri.normalA.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ] = tri.normalA.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 3 ] = 0; // vec4 padding

		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ] = tri.normalB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ] = tri.normalB.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ] = tri.normalB.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 3 ] = 0; // vec4 padding

		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ] = tri.normalC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ] = tri.normalC.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ] = tri.normalC.z;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 3 ] = 0; // vec4 padding

		// UVs and material index (2 vec4s = 8 floats)
		// First vec4: uvA.x, uvA.y, uvB.x, uvB.y
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 0 ] = tri.uvA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 1 ] = tri.uvA.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 2 ] = tri.uvB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 3 ] = tri.uvB.y;

		// Second vec4: uvC.x, uvC.y, materialIndex, padding
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 0 ] = tri.uvC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 1 ] = tri.uvC.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 2 ] = tri.materialIndex;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 3 ] = 0; // vec4 padding

	}

	return data;

}
