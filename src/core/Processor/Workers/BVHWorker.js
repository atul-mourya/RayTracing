import BVHBuilder from '../BVHBuilder.js';

self.onmessage = function ( e ) {

	const { triangleData, triangleByteOffset, triangleByteLength, depth, reportProgress, treeletOptimization, sharedReorderBuffer } = e.data;
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

		// Reconstruct the correct Float32Array view from the transferred buffer
		// (handles subarray case where byteOffset > 0)
		const inputTriangles = triangleByteOffset !== undefined
			? new Float32Array( triangleData, triangleByteOffset, triangleByteLength / 4 )
			: new Float32Array( triangleData );

		// If SharedArrayBuffer provided, worker writes reordered data directly to
		// shared memory — main thread reads it without any transfer overhead.
		const reorderTarget = sharedReorderBuffer
			? new Float32Array( sharedReorderBuffer )
			: null;

		// Build BVH — buildSync produces reorderedTriangleData internally
		const bvhRoot = builder.buildSync( inputTriangles, depth, progressCallback, reorderTarget );

		// Flatten BVH tree to GPU-ready Float32Array inside the worker
		const flattenStart = performance.now();
		const bvhData = builder.flattenBVH( bvhRoot );
		const flattenTime = performance.now() - flattenStart;
		console.log( `[BVHWorker] Flatten BVH: ${Math.round( flattenTime )}ms (${( bvhData.byteLength / 1024 / 1024 ).toFixed( 1 )}MB)` );

		if ( sharedReorderBuffer ) {

			// Reordered data already in shared memory — only send small metadata + BVH data
			self.postMessage( {
				bvhData,
				triangleCount: inputTriangles.length / 32,
				treeletStats: builder.splitStats
			}, [ bvhData.buffer ] );

		} else {

			// Fallback: transfer reordered data back
			const reorderedFloat32Array = builder.reorderedTriangleData;
			const triangleCount = reorderedFloat32Array.byteLength / ( 32 * 4 );

			self.postMessage( {
				bvhData,
				triangles: reorderedFloat32Array,
				triangleCount,
				treeletStats: builder.splitStats
			}, [ bvhData.buffer, reorderedFloat32Array.buffer ] );

		}

	} catch ( error ) {

		console.error( '[BVHWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};
