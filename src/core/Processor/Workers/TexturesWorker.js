let canvas, ctx;
let imageBitmapCache = new Map();

self.onmessage = async function ( e ) {

	const { textures, maxTextureSize, method = 'offscreen-optimized' } = e.data;

	try {

		// Initialize on first use
		if ( ! canvas ) {

			initializeWorker( maxTextureSize );

		}

		const result = await processTextures( textures, maxTextureSize, method );

		// Transfer ownership for zero-copy
		self.postMessage( result, [ result.data ] );

	} catch ( error ) {

		console.error( 'Worker processing failed:', error );
		self.postMessage( { error: error.message } );

	}

};

function initializeWorker( maxTextureSize ) {

	// Initialize OffscreenCanvas with optimal settings
	canvas = new OffscreenCanvas( maxTextureSize, maxTextureSize );
	ctx = canvas.getContext( '2d', {
		willReadFrequently: true,
		alpha: false,
		desynchronized: true // Allow for better performance
	} );

}

async function processTextures( textures, maxTextureSize, method ) {

	switch ( method ) {

		case 'offscreen-optimized':
			return await processWithOffscreenOptimized( textures, maxTextureSize );
		case 'imageBitmap-batch':
			return await processWithImageBitmapBatch( textures, maxTextureSize );
		default:
			return await processWithOffscreenOptimized( textures, maxTextureSize );

	}

}

async function processWithOffscreenOptimized( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	// Resize canvas if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	const depth = textures.length;
	const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	// Optimize context settings for batch processing
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			let imageBitmap;

			if ( textureData.isBlob ) {

				// Create ImageBitmap from blob data
				const blob = new Blob( [ textureData.data ] );
				imageBitmap = await createImageBitmap( blob, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			} else {

				// Handle direct image data
				const imageData = new ImageData(
					new Uint8ClampedArray( textureData.data ),
					textureData.width,
					textureData.height
				);
				imageBitmap = await createImageBitmap( imageData, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			}

			// Clear and draw to canvas
			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( imageBitmap, 0, 0 );

			// Get image data efficiently
			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );

			// Copy to output array
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

			// Clean up ImageBitmap
			imageBitmap.close();

		} catch ( error ) {

			console.warn( `Failed to process texture ${i}:`, error );
			// Fill with transparent pixels as fallback
			const offset = maxWidth * maxHeight * 4 * i;
			data.fill( 0, offset, offset + maxWidth * maxHeight * 4 );

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

async function processWithImageBitmapBatch( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	const depth = textures.length;
	const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	// Process in batches for memory efficiency
	const batchSize = Math.min( 4, textures.length );

	for ( let batchStart = 0; batchStart < textures.length; batchStart += batchSize ) {

		const batchEnd = Math.min( batchStart + batchSize, textures.length );
		const batchPromises = [];

		// Create all ImageBitmaps for this batch in parallel
		for ( let i = batchStart; i < batchEnd; i ++ ) {

			const textureData = textures[ i ];

			let bitmapPromise;
			if ( textureData.isBlob ) {

				const blob = new Blob( [ textureData.data ] );
				bitmapPromise = createImageBitmap( blob, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			} else {

				const imageData = new ImageData(
					new Uint8ClampedArray( textureData.data ),
					textureData.width,
					textureData.height
				);
				bitmapPromise = createImageBitmap( imageData, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			}

			batchPromises.push(
				bitmapPromise.then( bitmap => ( { bitmap, index: i } ) )
			);

		}

		// Wait for all bitmaps in this batch
		const bitmaps = await Promise.all( batchPromises );

		// Process each bitmap
		canvas.width = maxWidth;
		canvas.height = maxHeight;
		ctx.imageSmoothingEnabled = false; // Fast processing for batches

		for ( const { bitmap, index } of bitmaps ) {

			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( bitmap, 0, 0 );

			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * index;
			data.set( imageData.data, offset );

			bitmap.close();

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

function calculateOptimalDimensions( textures, maxTextureSize ) {

	let maxWidth = 0;
	let maxHeight = 0;

	for ( let texture of textures ) {

		maxWidth = Math.max( maxWidth, texture.width || 0 );
		maxHeight = Math.max( maxHeight, texture.height || 0 );

	}

	// Round to power of 2 for optimal GPU performance
	maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
	maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

	// Respect texture size limits
	maxWidth = Math.min( maxWidth, maxTextureSize );
	maxHeight = Math.min( maxHeight, maxTextureSize );

	// Additional safety check
	while ( maxWidth >= maxTextureSize / 2 || maxHeight >= maxTextureSize / 2 ) {

		maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
		maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

	}

	return { maxWidth, maxHeight };

}

// Cleanup function
self.addEventListener( 'beforeunload', () => {

	if ( imageBitmapCache ) {

		imageBitmapCache.forEach( bitmap => {

			if ( bitmap && bitmap.close ) {

				bitmap.close();

			}

		} );
		imageBitmapCache.clear();

	}

} );
