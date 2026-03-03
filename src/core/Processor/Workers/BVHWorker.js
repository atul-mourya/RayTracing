import BVHBuilder from '../BVHBuilder.js';

self.onmessage = function ( e ) {

	const { triangleData, depth, reportProgress, treeletOptimization } = e.data;
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

		const inputTriangles = new Float32Array( triangleData );

		// Build BVH — buildSync produces reorderedTriangleData internally
		const bvhRoot = builder.buildSync( inputTriangles, depth, progressCallback );

		// Get reordered data (direct Float32Array block copy, zero object allocations)
		const reorderedFloat32Array = builder.reorderedTriangleData;
		const triangleCount = reorderedFloat32Array.byteLength / ( 32 * 4 );

		self.postMessage( {
			bvhRoot,
			triangles: reorderedFloat32Array,
			triangleCount,
			treeletStats: builder.splitStats
		}, [ reorderedFloat32Array.buffer ] );

	} catch ( error ) {

		console.error( '[BVHWorker] Error:', error );
		self.postMessage( { error: error.message } );

	}

};
