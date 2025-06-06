let canvas, ctx;
let imageBitmapCache = new Map();

// Memory limits and chunking configuration
const MEMORY_LIMITS = {
	MAX_BYTES_PER_TEXTURE: 256 * 1024 * 1024, // 256MB per texture array
	MAX_TEXTURE_DIMENSION: 4096, // Maximum dimension for a single texture
	CHUNK_SIZE: 16, // Process textures in chunks of 16
	MEMORY_SAFETY_FACTOR: 0.8 // Use only 80% of estimated available memory
};

self.onmessage = async function ( e ) {

	const { textures, maxTextureSize, method = 'direct-transfer' } = e.data;

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
	const size = Math.min( maxTextureSize, MEMORY_LIMITS.MAX_TEXTURE_DIMENSION );
	canvas = new OffscreenCanvas( size, size );
	ctx = canvas.getContext( '2d', {
		willReadFrequently: true,
		alpha: true,
		desynchronized: true
	} );

}

async function processTextures( textures, maxTextureSize, method ) {

	// Check if we need to use chunked processing
	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const estimatedBytes = dimensions.maxWidth * dimensions.maxHeight * textures.length * 4;

	if ( estimatedBytes > MEMORY_LIMITS.MAX_BYTES_PER_TEXTURE ) {

		console.log( `Large texture array detected (${( estimatedBytes / 1024 / 1024 ).toFixed( 2 )}MB), using chunked processing` );
		return await processTexturesInChunks( textures, maxTextureSize, method );

	}

	switch ( method ) {

		case 'direct-transfer':
			return await processWithDirectTransfer( textures, maxTextureSize );
		case 'offscreen-optimized':
			return await processWithOffscreenOptimized( textures, maxTextureSize );
		case 'imageBitmap-batch':
			return await processWithImageBitmapBatch( textures, maxTextureSize );
		default:
			return await processWithDirectTransfer( textures, maxTextureSize );

	}

}

async function processTexturesInChunks( textures, maxTextureSize, method ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;
	const depth = textures.length;

	// Process in smaller chunks to avoid memory issues
	const chunkSize = Math.min( MEMORY_LIMITS.CHUNK_SIZE, depth );
	const numChunks = Math.ceil( depth / chunkSize );

	console.log( `Processing ${depth} textures in ${numChunks} chunks of up to ${chunkSize} textures each` );

	// Allocate the full output array
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		// If full allocation fails, fall back to reduced dimensions
		console.warn( 'Failed to allocate full texture array, reducing dimensions' );
		const reducedDimensions = calculateReducedDimensions( textures, maxTextureSize );
		return await processWithReducedDimensions( textures, reducedDimensions, method );

	}

	// Process each chunk
	for ( let chunkIndex = 0; chunkIndex < numChunks; chunkIndex ++ ) {

		const startIdx = chunkIndex * chunkSize;
		const endIdx = Math.min( startIdx + chunkSize, depth );
		const chunkTextures = textures.slice( startIdx, endIdx );

		const chunkResult = await processTextureChunk( chunkTextures, maxWidth, maxHeight, method );

		// Copy chunk data to main array
		const offset = startIdx * maxWidth * maxHeight * 4;
		data.set( new Uint8Array( chunkResult.data ), offset );

		// Allow garbage collection between chunks
		await new Promise( resolve => setTimeout( resolve, 0 ) );

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

async function processTextureChunk( textures, maxWidth, maxHeight, method ) {

	// Resize canvas for this chunk if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	const data = new Uint8Array( maxWidth * maxHeight * textures.length * 4 );

	// Optimize context settings
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			await processSingleTexture( textureData, i, data, maxWidth, maxHeight );

		} catch ( error ) {

			console.warn( `Failed to process texture ${i}:`, error );
			const offset = maxWidth * maxHeight * 4 * i;
			data.fill( 0, offset, offset + maxWidth * maxHeight * 4 );

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth: textures.length
	};

}

async function processSingleTexture( textureData, index, outputData, maxWidth, maxHeight ) {

	let imageBitmap;

	if ( textureData.isDirect && textureData.bitmap ) {

		// Direct ImageBitmap transfer - no conversion needed!
		imageBitmap = textureData.bitmap;

	} else if ( textureData.isImageData && textureData.data ) {

		// Direct ImageData transfer - minimal conversion
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

	} else if ( textureData.isBlob ) {

		// Legacy blob processing (fallback)
		const blob = new Blob( [ textureData.data ] );
		imageBitmap = await createImageBitmap( blob, {
			resizeWidth: maxWidth,
			resizeHeight: maxHeight,
			resizeQuality: 'high'
		} );

	} else {

		throw new Error( 'Unknown texture data format' );

	}

	// Clear and draw to canvas
	ctx.clearRect( 0, 0, maxWidth, maxHeight );
	ctx.drawImage( imageBitmap, 0, 0, maxWidth, maxHeight );

	// Get image data efficiently
	const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );

	// Copy to output array
	const offset = maxWidth * maxHeight * 4 * index;
	outputData.set( imageData.data, offset );

	// Clean up ImageBitmap if we created it
	if ( textureData.isImageData || textureData.isBlob ) {

		imageBitmap.close();

	}

}

async function processWithDirectTransfer( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	// Resize canvas if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	const depth = textures.length;

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'direct-transfer' );

	}

	// Optimize context settings for batch processing
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			await processSingleTexture( textureData, i, data, maxWidth, maxHeight );

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

async function processWithReducedDimensions( textures, dimensions, method ) {

	const { maxWidth, maxHeight } = dimensions;
	console.log( `Using reduced dimensions: ${maxWidth}x${maxHeight}` );

	// Process with reduced dimensions
	return await processTextureChunk( textures, maxWidth, maxHeight, method );

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

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'offscreen-optimized' );

	}

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

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'imageBitmap-batch' );

	}

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
	maxWidth = Math.min( maxWidth, maxTextureSize, MEMORY_LIMITS.MAX_TEXTURE_DIMENSION );
	maxHeight = Math.min( maxHeight, maxTextureSize, MEMORY_LIMITS.MAX_TEXTURE_DIMENSION );

	// Additional safety check
	while ( maxWidth >= maxTextureSize / 2 || maxHeight >= maxTextureSize / 2 ) {

		maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
		maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

	}

	return { maxWidth, maxHeight };

}

function calculateReducedDimensions( textures, maxTextureSize ) {

	// Calculate dimensions but reduce by factor of 2 for memory safety
	const original = calculateOptimalDimensions( textures, maxTextureSize );

	return {
		maxWidth: Math.max( 1, Math.floor( original.maxWidth / 2 ) ),
		maxHeight: Math.max( 1, Math.floor( original.maxHeight / 2 ) )
	};

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
