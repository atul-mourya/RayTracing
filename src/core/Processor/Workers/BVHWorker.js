import BVHBuilder from '../BVHBuilder.js';

self.onmessage = function ( e ) {

	const { triangles, depth, reportProgress } = e.data;
	const builder = new BVHBuilder();

	try {

		// Create progress callback if progress reporting is enabled
		const progressCallback = reportProgress ? ( progress ) => {

			self.postMessage( { progress } );

		} : null;

		const reorderedTriangles = [];
		const bvhRoot = builder.buildSync( triangles, depth, reorderedTriangles, progressCallback );

		self.postMessage( {
			bvhRoot,
			triangles: reorderedTriangles
		} );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
