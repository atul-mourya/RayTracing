import BVHBuilder from '../BVHBuilder.js';

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

self.onmessage = function ( e ) {

	const { triangles, triangleData, triangleCount, format, depth, reportProgress } = e.data;
	const builder = new BVHBuilder();

	try {

		// Create progress callback if progress reporting is enabled
		const progressCallback = reportProgress ? ( progress ) => {

			self.postMessage( { progress } );

		} : null;

		let inputTriangles;
		let isFloat32ArrayInput = false;

		// Determine input format and prepare data
		if ( format === 'float32array' && triangleData ) {

			// Input is Float32Array format
			inputTriangles = new Float32Array( triangleData );
			isFloat32ArrayInput = true;
			console.log( `[BVHWorker] Processing ${triangleCount} triangles from Float32Array (${inputTriangles.byteLength} bytes)` );

		} else if ( triangles && Array.isArray( triangles ) ) {

			// Input is traditional object array format
			inputTriangles = triangles;
			isFloat32ArrayInput = false;
			console.log( `[BVHWorker] Processing ${triangles.length} triangles from object array` );

		} else {

			throw new Error( 'Invalid triangle data format' );

		}

		// Build BVH - builder can handle both formats
		const reorderedTriangles = [];
		const bvhRoot = builder.buildSync( inputTriangles, depth, reorderedTriangles, progressCallback );

		// Prepare response based on input format
		if ( isFloat32ArrayInput ) {

			// Convert reordered triangle objects back to Float32Array format
			const reorderedFloat32Array = convertObjectsToFloat32Array( reorderedTriangles );

			self.postMessage( {
				bvhRoot,
				triangles: reorderedFloat32Array.buffer,
				triangleCount: reorderedTriangles.length,
				format: 'float32array'
			}, [ reorderedFloat32Array.buffer ] );

		} else {

			// Return traditional object format
			self.postMessage( {
				bvhRoot,
				triangles: reorderedTriangles,
				format: 'objects'
			} );

		}

	} catch ( error ) {

		console.error( '[BVHWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};

/**
 * Convert array of triangle objects to Float32Array format
 * @param {Array} triangleObjects - Array of triangle objects
 * @returns {Float32Array} - Packed triangle data
 */
function convertObjectsToFloat32Array( triangleObjects ) {

	const triangleCount = triangleObjects.length;
	const data = new Float32Array( triangleCount * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );

	for ( let i = 0; i < triangleCount; i ++ ) {

		const tri = triangleObjects[ i ];
		const offset = i * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

		// Position A
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ] = tri.posA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = tri.posA.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = tri.posA.z;

		// Position B
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ] = tri.posB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = tri.posB.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = tri.posB.z;

		// Position C
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ] = tri.posC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = tri.posC.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = tri.posC.z;

		// Normal A
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ] = tri.normalA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ] = tri.normalA.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ] = tri.normalA.z;

		// Normal B
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ] = tri.normalB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ] = tri.normalB.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ] = tri.normalB.z;

		// Normal C
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ] = tri.normalC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ] = tri.normalC.y;
		data[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ] = tri.normalC.z;

		// UV A
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 0 ] = tri.uvA.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 1 ] = tri.uvA.y;

		// UV B
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 0 ] = tri.uvB.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 1 ] = tri.uvB.y;

		// UV C
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 0 ] = tri.uvC.x;
		data[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 1 ] = tri.uvC.y;

		// Material Index
		data[ offset + TRIANGLE_DATA_LAYOUT.MATERIAL_INDEX_OFFSET ] = tri.materialIndex;

	}

	return data;

}
