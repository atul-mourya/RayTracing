self.onmessage = function ( e ) {

	const { textures, maxTextureSize } = e.data;

	try {

		// Determine max dimensions
		let maxWidth = 0;
		let maxHeight = 0;
		for ( let texture of textures ) {

			maxWidth = Math.max( maxWidth, texture.width );
			maxHeight = Math.max( maxHeight, texture.height );

		}

		// Round to power of 2
		maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
		maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

		// Adjust for texture size limits
		while ( maxWidth >= maxTextureSize / 2 || maxHeight >= maxTextureSize / 2 ) {

			maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
			maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

		}

		const depth = textures.length;
		const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

		// Process textures
		for ( let i = 0; i < textures.length; i ++ ) {

			const textureData = textures[ i ].data;
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( new Uint8Array( textureData ), offset );

		}

		self.postMessage( {
			data: data.buffer,
			width: maxWidth,
			height: maxHeight,
			depth
		}, [ data.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
