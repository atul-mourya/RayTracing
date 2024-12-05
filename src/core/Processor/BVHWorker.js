import BVHBuilder from './BVHBuilder.js';

self.onmessage = function ( e ) {

	const { triangles, depth } = e.data;
	const builder = new BVHBuilder();

	try {

		const reorderedTriangles = [];
		const bvhRoot = builder.buildSync( triangles, depth, reorderedTriangles );

		self.postMessage( {
			bvhRoot,
			triangles: reorderedTriangles
		} );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
