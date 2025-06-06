import { DataTexture, DataArrayTexture, RGBAFormat, LinearFilter, FloatType, UnsignedByteType } from "three";
import { TEXTURE_CONSTANTS, MEMORY_CONSTANTS, TRIANGLE_DATA_LAYOUT, DEFAULT_TEXTURE_MATRIX } from '../../Constants.js';
import { updateLoading } from '../Processor/utils.js';

// Canvas pooling for efficient reuse of canvas elements
class CanvasPool {

	constructor() {

		this.canvasContextPairs = []; // Pool canvas+context pairs together
		this.maxPoolSize = TEXTURE_CONSTANTS.CANVAS_POOL_SIZE;

	}

	getCanvasWithContext( width, height, useOffscreen = false, options = {} ) {

		const defaultOptions = {
			willReadFrequently: true,
			alpha: true,
			desynchronized: true
		};
		const contextOptions = { ...defaultOptions, ...options };

		// Try to get from pool first
		let pair = this.canvasContextPairs.pop();

		if ( ! pair ) {

			// Create new pair
			let canvas;
			if ( useOffscreen && typeof OffscreenCanvas !== 'undefined' ) {

				canvas = new OffscreenCanvas( width, height );

			} else {

				canvas = document.createElement( 'canvas' );

			}

			const context = canvas.getContext( '2d', contextOptions );
			pair = { canvas, context };

		}

		// Set dimensions (this is fast even if unchanged)
		pair.canvas.width = width;
		pair.canvas.height = height;

		return pair;

	}

	releaseCanvasWithContext( pair ) {

		if ( this.canvasContextPairs.length < this.maxPoolSize ) {

			// Reset context state
			pair.context.globalAlpha = 1;
			pair.context.globalCompositeOperation = 'source-over';
			pair.context.imageSmoothingEnabled = true;

			// Clear the canvas
			pair.context.clearRect( 0, 0, pair.canvas.width, pair.canvas.height );

			// Reset to minimal size to save memory
			pair.canvas.width = 1;
			pair.canvas.height = 1;

			this.canvasContextPairs.push( pair );

		}

		// If pool is full, let it be garbage collected

	}

	// Legacy method for backward compatibility
	getCanvas( width, height, useOffscreen = false ) {

		return this.getCanvasWithContext( width, height, useOffscreen ).canvas;

	}

	getContext( canvas, options = {} ) {

		// Find existing context or create new one
		const pair = this.canvasContextPairs.find( p => p.canvas === canvas );
		if ( pair ) return pair.context;

		const defaultOptions = {
			willReadFrequently: true,
			alpha: true,
			desynchronized: true
		};
		return canvas.getContext( '2d', { ...defaultOptions, ...options } );

	}

	dispose() {

		this.canvasContextPairs = [];

	}

}

// Fixed smart buffer pool with proper memory accounting
class SmartBufferPool {

	constructor( options = {} ) {

		this.pools = new Map();
		this.memoryUsage = 0;
		this.maxMemoryUsage = options.maxMemory || MEMORY_CONSTANTS.MAX_BUFFER_MEMORY;
		this.allocatedBuffers = new WeakMap(); // Track which buffers we allocated
		this.sizeStrategy = options.sizeStrategy || 'adaptive'; // 'power2', 'exact', 'adaptive'

	}

	getOptimalSize( requestedSize ) {

		switch ( this.sizeStrategy ) {

			case 'exact':
				return requestedSize;

			case 'power2':
				return Math.pow( 2, Math.ceil( Math.log2( requestedSize ) ) );

			case 'adaptive':
			default:
				// Use exact size for small buffers, power of 2 for large ones
				if ( requestedSize < 1024 ) {

					return requestedSize;

				} else if ( requestedSize < 1024 * 1024 ) {

					// Round to nearest 1KB boundary
					return Math.ceil( requestedSize / 1024 ) * 1024;

				} else {

					// Use power of 2 for very large buffers
					return Math.pow( 2, Math.ceil( Math.log2( requestedSize ) ) );

				}

		}

	}

	getBuffer( size, Type = Float32Array ) {

		const optimalSize = this.getOptimalSize( size );
		const key = `${Type.name}-${optimalSize}`;
		const pool = this.pools.get( key ) || [];

		let buffer = pool.pop();
		if ( ! buffer ) {

			buffer = new Type( optimalSize );
			this.memoryUsage += buffer.byteLength;
			this.allocatedBuffers.set( buffer, true );

		}

		// Auto cleanup if memory usage is high
		if ( this.memoryUsage > this.maxMemoryUsage * MEMORY_CONSTANTS.CLEANUP_THRESHOLD ) {

			this.cleanup();

		}

		return buffer.subarray( 0, size );

	}

	releaseBuffer( buffer, Type = Float32Array ) {

		const key = `${Type.name}-${buffer.length}`;
		const pool = this.pools.get( key ) || [];

		if ( pool.length < TEXTURE_CONSTANTS.BUFFER_POOL_SIZE ) {

			pool.push( buffer );
			this.pools.set( key, pool );

		} else {

			// Only subtract if this was our allocation
			if ( this.allocatedBuffers.has( buffer ) ) {

				this.memoryUsage -= buffer.byteLength;
				this.allocatedBuffers.delete( buffer );

			}

		}

	}

	cleanup() {

		// Clear half the pools, properly accounting for memory
		const entries = Array.from( this.pools.entries() );
		const toRemove = entries.slice( 0, Math.floor( entries.length / 2 ) );

		toRemove.forEach( ( [ key, pool ] ) => {

			pool.forEach( buffer => {

				if ( this.allocatedBuffers.has( buffer ) ) {

					this.memoryUsage -= buffer.byteLength;
					this.allocatedBuffers.delete( buffer );

				}

			} );
			this.pools.delete( key );

		} );

	}

	dispose() {

		// Clean up all pools and reset memory tracking
		this.pools.forEach( pool => {

			pool.forEach( buffer => {

				if ( this.allocatedBuffers.has( buffer ) ) {

					this.allocatedBuffers.delete( buffer );

				}

			} );

		} );

		this.pools.clear();
		this.memoryUsage = 0;

	}

}

// LRU Cache for textures
class TextureCache {

	constructor( maxSize = TEXTURE_CONSTANTS.CACHE_SIZE_LIMIT ) {

		this.cache = new Map();
		this.accessOrder = [];
		this.maxSize = maxSize;

	}

	generateHash( textures ) {

		let hash = '';
		for ( const texture of textures ) {

			if ( texture?.image ) {

				const width = texture.image.width || 0;
				const height = texture.image.height || 0;
				const src = texture.image.src || texture.uuid || '';
				hash += `${width}x${height}_${src.slice( - 8 )}_`;

			}

		}

		return hash + textures.length;

	}

	get( key ) {

		if ( this.cache.has( key ) ) {

			// Move to end (most recently used)
			const index = this.accessOrder.indexOf( key );
			if ( index > - 1 ) {

				this.accessOrder.splice( index, 1 );

			}

			this.accessOrder.push( key );
			return this.cache.get( key ).clone();

		}

		return null;

	}

	set( key, texture ) {

		if ( this.cache.size >= this.maxSize && ! this.cache.has( key ) ) {

			this.evictLRU();

		}

		this.cache.set( key, texture );
		this.accessOrder.push( key );

	}

	evictLRU() {

		if ( this.accessOrder.length > 0 ) {

			const lruKey = this.accessOrder.shift();
			const texture = this.cache.get( lruKey );
			if ( texture && texture.dispose ) {

				texture.dispose();

			}

			this.cache.delete( lruKey );

		}

	}

	dispose() {

		this.cache.forEach( texture => {

			if ( texture && texture.dispose ) texture.dispose();

		} );
		this.cache.clear();
		this.accessOrder = [];

	}

}

export default class TextureCreator {

	constructor( options = {} ) {

		this.useWorkers = typeof Worker !== 'undefined';
		this.maxConcurrentWorkers = TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS;
		this.activeWorkers = 0;

		// Initialize high-performance components
		this.canvasPool = new CanvasPool();
		this.bufferPool = new SmartBufferPool( {
			maxMemory: options.maxBufferMemory || MEMORY_CONSTANTS.MAX_BUFFER_MEMORY,
			sizeStrategy: options.bufferSizeStrategy || 'adaptive'
		} );
		this.textureCache = new TextureCache();

		// Method selection based on capabilities
		this.capabilities = this.detectCapabilities();
		this.optimalMethod = this.selectOptimalMethod();

	}

	detectCapabilities() {

		return {
			offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
			imageBitmap: typeof createImageBitmap !== 'undefined',
			workers: typeof Worker !== 'undefined',
			hardwareConcurrency: navigator.hardwareConcurrency || 4
		};

	}

	selectOptimalMethod() {

		if ( this.capabilities.workers && this.capabilities.offscreenCanvas ) {

			return 'worker-offscreen';

		} else if ( this.capabilities.imageBitmap ) {

			return 'imageBitmap';

		} else {

			return 'canvas';

		}

	}

	updateTextureProgress( progress, status ) {

		// Simple progress mapping from 80% to 100%
		const scaledProgress = 80 + ( progress * 0.2 );
		updateLoading( {
			status: status || `Processing textures... ${Math.round( progress )}%`,
			progress: Math.round( scaledProgress )
		} );

	}

	async createAllTextures( params ) {

		const promises = [];
		let completedTasks = 0;

		// Count total tasks
		let totalTasks = 0;
		if ( params.materials?.length ) totalTasks ++;
		if ( params.triangles && params.triangles.byteLength > 0 ) totalTasks ++;
		if ( params.bvhRoot ) totalTasks ++;

		const mapTypes = [ 'maps', 'normalMaps', 'bumpMaps', 'roughnessMaps', 'metalnessMaps', 'emissiveMaps' ];
		for ( const mapType of mapTypes ) {

			if ( params[ mapType ]?.length > 0 ) totalTasks ++;

		}

		const updateProgress = ( taskName ) => {

			completedTasks ++;
			const progress = ( completedTasks / totalTasks ) * 100;
			this.updateTextureProgress( progress, `Completed ${taskName}` );

		};

		this.updateTextureProgress( 0, "Starting texture creation..." );

		// Material texture
		if ( params.materials?.length ) {

			promises.push(
				this.createMaterialDataTexture( params.materials )
					.then( texture => {

						updateProgress( "material texture" );
						return { type: 'material', texture };

					} )
			);

		}

		// Triangle texture
		if ( params.triangles && params.triangles.byteLength > 0 ) {

			promises.push(
				this.createTriangleDataTexture( params.triangles )
					.then( texture => {

						updateProgress( "triangle texture" );
						return { type: 'triangle', texture };

					} )
			);

		}

		// Map textures
		const mapTypesList = [
			{ data: params.maps, type: 'albedo' },
			{ data: params.normalMaps, type: 'normal' },
			{ data: params.bumpMaps, type: 'bump' },
			{ data: params.roughnessMaps, type: 'roughness' },
			{ data: params.metalnessMaps, type: 'metalness' },
			{ data: params.emissiveMaps, type: 'emissive' }
		];

		for ( const { data, type } of mapTypesList ) {

			if ( data?.length > 0 ) {

				promises.push(
					this.createTexturesToDataTexture( data )
						.then( texture => {

							updateProgress( `${type} textures` );
							return { type, texture };

						} )
				);

			}

		}

		// BVH texture
		if ( params.bvhRoot ) {

			promises.push(
				this.createBVHDataTexture( params.bvhRoot )
					.then( texture => {

						updateProgress( "BVH texture" );
						return { type: 'bvh', texture };

					} )
			);

		}

		const results = await Promise.all( promises );

		this.updateTextureProgress( 100, "Texture creation complete!" );

		return results.reduce( ( acc, { type, texture } ) => {

			acc[ `${type}Texture` ] = texture;
			return acc;

		}, {} );

	}

	async createMaterialDataTexture( materials ) {

		return this.createMaterialDataTextureSync( materials );

	}

	async createTriangleDataTexture( triangles ) {

		const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		console.log( `Creating triangle texture: ${triangleCount} triangles` );

		// Calculate texture dimensions
		const floatsPerTriangle = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const dataLength = triangleCount * floatsPerTriangle;

		// Calculate dimensions for a square-like texture
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( width * 4 ) );

		// Check if we can use the triangle data directly
		const expectedSize = width * height * 4;

		let textureData;
		if ( dataLength === expectedSize ) {

			// Perfect fit - use the triangle data directly
			textureData = triangles;

		} else {

			// Need to pad the data slightly
			textureData = this.bufferPool.getBuffer( expectedSize, Float32Array );
			textureData.set( new Float32Array( triangles ), 0 ); // Copy existing data, rest remains zeros

		}

		const texture = new DataTexture( textureData, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store metadata for disposal
		if ( textureData !== triangles ) {

			texture.userData = { buffer: textureData, bufferType: Float32Array };
			const originalDispose = texture.dispose.bind( texture );
			texture.dispose = () => {

				if ( texture.userData.buffer ) {

					this.bufferPool.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
					texture.userData.buffer = null;

				}

				originalDispose();

			};

		}

		return texture;

	}

	// Unified texture processing with strategy selection
	async createTexturesToDataTexture( textures ) {

		if ( ! textures || textures.length === 0 ) return null;

		// Check cache first
		const cacheKey = this.textureCache.generateHash( textures );
		const cached = this.textureCache.get( cacheKey );
		if ( cached ) return cached;

		// Select optimal processing strategy
		const strategy = this.selectProcessingStrategy( textures );
		let result;

		try {

			switch ( strategy.method ) {

				case 'worker-direct':
					result = await this.processWithWorkerDirect( textures );
					break;
				case 'worker-chunked':
					result = await this.processWithWorkerChunked( textures, strategy.chunkSize );
					break;
				case 'main-batch':
					result = await this.processOnMainThreadBatch( textures, strategy.batchSize );
					break;
				case 'main-streaming':
					result = await this.processOnMainThreadStreaming( textures );
					break;
				default:
					result = await this.processOnMainThreadSync( textures );

			}

			// Cache successful result
			if ( result ) {

				this.textureCache.set( cacheKey, result );

			}

			return result;

		} catch ( error ) {

			console.warn( 'Texture processing failed, trying fallback:', error );
			return await this.processOnMainThreadSync( textures );

		}

	}

	selectProcessingStrategy( textures ) {

		const totalPixels = textures.reduce( ( sum, tex ) => {

			const width = tex.image?.width || 0;
			const height = tex.image?.height || 0;
			return sum + width * height;

		}, 0 );

		const estimatedMemory = totalPixels * 4; // RGBA

		if ( this.capabilities.workers && estimatedMemory > MEMORY_CONSTANTS.MAX_TEXTURE_MEMORY ) {

			return {
				method: 'worker-chunked',
				chunkSize: Math.max( 1, Math.floor( textures.length / 4 ) )
			};

		} else if ( this.capabilities.workers && totalPixels > 2097152 ) {

			return { method: 'worker-direct' };

		} else if ( totalPixels > 524288 ) {

			return {
				method: 'main-batch',
				batchSize: Math.min( 4, textures.length )
			};

		} else if ( textures.length > 8 ) {

			return { method: 'main-streaming' };

		} else {

			return { method: 'main-sync' };

		}

	}

	// Optimized worker processing with direct transfer
	async processWithWorkerDirect( textures ) {

		// Wait for available worker
		while ( this.activeWorkers >= this.maxConcurrentWorkers ) {

			await new Promise( resolve => setTimeout( resolve, 10 ) );

		}

		this.activeWorkers ++;

		try {

			const worker = new Worker(
				new URL( './Workers/TexturesWorker.js', import.meta.url ),
				{ type: 'module' }
			);

			// Prepare textures for worker with direct transfer
			const texturesData = await this.prepareTexturesForWorkerDirect( textures );

			const result = await new Promise( ( resolve, reject ) => {

				worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				worker.onerror = reject;

				// Collect transferable objects for zero-copy transfer
				const transferables = [];
				texturesData.forEach( tex => {

					if ( tex.data instanceof ArrayBuffer ) {

						transferables.push( tex.data );

					} else if ( tex.bitmap ) {

						transferables.push( tex.bitmap );

					}

				} );

				worker.postMessage( {
					textures: texturesData,
					maxTextureSize: TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE,
					method: 'direct-transfer'
				}, transferables );

			} );

			worker.terminate();
			return this.createDataArrayTextureFromResult( result );

		} finally {

			this.activeWorkers --;

		}

	}

	// Optimized worker preparation - eliminates data copying
	async prepareTexturesForWorkerDirect( textures ) {

		const texturesData = [];

		for ( const texture of textures ) {

			if ( ! texture?.image ) continue;

			try {

				// Option 1: Direct ImageBitmap transfer (when supported)
				if ( typeof createImageBitmap !== 'undefined' && texture.image instanceof HTMLImageElement ) {

					const bitmap = await createImageBitmap( texture.image );
					texturesData.push( {
						bitmap: bitmap,
						width: texture.image.width,
						height: texture.image.height,
						isDirect: true
					} );

				} else { // Option 2: Efficient canvas-based transfer

					const pair = this.canvasPool.getCanvasWithContext( texture.image.width, texture.image.height );

					pair.context.drawImage( texture.image, 0, 0 );
					const imageData = pair.context.getImageData( 0, 0, texture.image.width, texture.image.height );

					// Transfer the underlying ArrayBuffer directly
					texturesData.push( {
						data: imageData.data.buffer, // Direct buffer transfer
						width: texture.image.width,
						height: texture.image.height,
						isImageData: true
					} );

					this.canvasPool.releaseCanvasWithContext( pair );

				}

			} catch ( error ) {

				console.warn( 'Failed to prepare texture for worker:', error );

			}

		}

		return texturesData;

	}

	async processWithWorkerChunked( textures, chunkSize ) {

		const results = [];
		for ( let i = 0; i < textures.length; i += chunkSize ) {

			const chunk = textures.slice( i, i + chunkSize );
			const chunkResult = await this.processWithWorkerDirect( chunk );
			results.push( chunkResult );

		}

		return this.combineTextureResults( results );

	}

	async processOnMainThreadBatch( textures, batchSize ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		// Process in batches for memory efficiency
		for ( let batchStart = 0; batchStart < validTextures.length; batchStart += batchSize ) {

			const batchEnd = Math.min( batchStart + batchSize, validTextures.length );
			const batchPromises = [];

			// Create all ImageBitmaps for this batch in parallel
			for ( let i = batchStart; i < batchEnd; i ++ ) {

				const texture = validTextures[ i ];

				const bitmapPromise = createImageBitmap( texture.image, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

				batchPromises.push(
					bitmapPromise.then( bitmap => ( { bitmap, index: i } ) )
				);

			}

			const bitmaps = await Promise.all( batchPromises );

			// Process each bitmap
			const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
			pair.context.imageSmoothingEnabled = false; // Fast processing for batches

			for ( const { bitmap, index } of bitmaps ) {

				pair.context.clearRect( 0, 0, maxWidth, maxHeight );
				pair.context.drawImage( bitmap, 0, 0 );

				const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
				const offset = maxWidth * maxHeight * 4 * index;
				data.set( imageData.data, offset );

				bitmap.close();

			}

			this.canvasPool.releaseCanvasWithContext( pair );

		}

		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	async processOnMainThreadStreaming( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
		pair.context.imageSmoothingEnabled = true;
		pair.context.imageSmoothingQuality = 'high';

		for ( let i = 0; i < validTextures.length; i ++ ) {

			const texture = validTextures[ i ];

			pair.context.clearRect( 0, 0, maxWidth, maxHeight );
			pair.context.drawImage( texture.image, 0, 0, maxWidth, maxHeight );

			const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

			// Allow GC between frames
			if ( i % MEMORY_CONSTANTS.STREAM_BATCH_SIZE === 0 ) {

				await new Promise( resolve => setTimeout( resolve, 0 ) );

			}

		}

		this.canvasPool.releaseCanvasWithContext( pair );
		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	async processOnMainThreadSync( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
		pair.context.imageSmoothingEnabled = true;
		pair.context.imageSmoothingQuality = 'high';

		for ( let i = 0; i < validTextures.length; i ++ ) {

			const texture = validTextures[ i ];

			pair.context.clearRect( 0, 0, maxWidth, maxHeight );
			pair.context.drawImage( texture.image, 0, 0, maxWidth, maxHeight );

			const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

		}

		this.canvasPool.releaseCanvasWithContext( pair );
		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	async createBVHDataTexture( bvhRoot ) {

		return this.createBVHDataTextureSync( bvhRoot );

	}

	createMaterialDataTextureSync( materials ) {

		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const totalMaterials = materials.length;

		const totalPixels = pixelsRequired * totalMaterials;
		const width = Math.pow( 2, Math.ceil( Math.log2( Math.sqrt( totalPixels ) ) ) );
		const height = Math.ceil( totalPixels / width );

		const size = width * height * dataInEachPixel;
		const data = this.bufferPool.getBuffer( size, Float32Array );

		for ( let i = 0; i < totalMaterials; i ++ ) {

			const mat = materials[ i ];
			const stride = i * dataLengthPerMaterial;

			const mapMatrix = mat.mapMatrix ?? DEFAULT_TEXTURE_MATRIX;
			const normalMapMatrices = mat.normalMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const roughnessMapMatrices = mat.roughnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const metalnessMapMatrices = mat.metalnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const emissiveMapMatrices = mat.emissiveMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const bumpMapMatrices = mat.bumpMapMatrices ?? DEFAULT_TEXTURE_MATRIX;

			const materialData = [
				mat.color.r, 				mat.color.g, 				mat.color.b, 				mat.metalness,				// pixel 1 - Base color and metalness
				mat.emissive.r, 			mat.emissive.g, 			mat.emissive.b, 			mat.roughness,				// pixel 2 - Emissive and roughness
				mat.ior, 					mat.transmission, 			mat.thickness, 				mat.emissiveIntensity,		// pixel 3 - IOR, transmission, thickness, and emissive intensity
				mat.attenuationColor.r, 	mat.attenuationColor.g, 	mat.attenuationColor.b, 	mat.attenuationDistance,	// pixel 4 - Attenuation color and distance
				mat.dispersion, 			mat.visible, 				mat.sheen, 					mat.sheenRoughness, 		// pixel 5 - Dispersion, sheen, sheen roughness
				mat.sheenColor.r, 			mat.sheenColor.g, 			mat.sheenColor.b, 			1,							// pixel 6 - Sheen color and tint
				mat.specularIntensity, 		mat.specularColor.r, 		mat.specularColor.g, 		mat.specularColor.b,		// pixel 7 - Specular intensity and color
				mat.iridescence, 			mat.iridescenceIOR, 		mat.iridescenceThicknessRange[ 0 ], mat.iridescenceThicknessRange[ 1 ], // pixel 8 - Iridescence properties
				mat.map, 					mat.normalMap, 				mat.roughnessMap, 			mat.metalnessMap,			// pixel 9 - Map indices and properties
				mat.emissiveMap, 			mat.bumpMap, 				mat.clearcoat, 				mat.clearcoatRoughness,		// pixel 10 - More map indices and properties
				mat.opacity, 				mat.side, 					mat.transparent, 			mat.alphaTest,				// pixel 11 - Opacity, side, transparency, and alpha test
				mat.alphaMode, 				mat.depthWrite, 			mat.normalScale?.x ?? 1, 	mat.normalScale?.y ?? 1,	// pixel 12 - Opacity, side, and normal scale
				mapMatrix[ 0 ], 			mapMatrix[ 1 ], 			mapMatrix[ 2 ], 			mapMatrix[ 3 ],				// pixel 13 - Map matrices - 1
				mapMatrix[ 4 ], 			mapMatrix[ 5 ], 			mapMatrix[ 6 ], 			1,							// pixel 14 - Map matrices - 2
				normalMapMatrices[ 0 ], 	normalMapMatrices[ 1 ], 	normalMapMatrices[ 2 ], 	normalMapMatrices[ 3 ],		// pixel 15 - Normal matrices - 1
				normalMapMatrices[ 4 ], 	normalMapMatrices[ 5 ], 	normalMapMatrices[ 6 ], 	1,							// pixel 16 - Normal matrices - 2
				roughnessMapMatrices[ 0 ], 	roughnessMapMatrices[ 1 ], 	roughnessMapMatrices[ 2 ], 	roughnessMapMatrices[ 3 ],	// pixel 17 - Roughness matrices - 1
				roughnessMapMatrices[ 4 ], 	roughnessMapMatrices[ 5 ], 	roughnessMapMatrices[ 6 ], 	1,							// pixel 18 - Roughness matrices - 2
				metalnessMapMatrices[ 0 ], 	metalnessMapMatrices[ 1 ], 	metalnessMapMatrices[ 2 ], 	metalnessMapMatrices[ 3 ], 	// pixel 19 - Metalness matrices - 1
				metalnessMapMatrices[ 4 ], 	metalnessMapMatrices[ 5 ], 	metalnessMapMatrices[ 6 ], 	1,							// pixel 20 - Metalness matrices - 2
				emissiveMapMatrices[ 0 ], 	emissiveMapMatrices[ 1 ], 	emissiveMapMatrices[ 2 ], 	emissiveMapMatrices[ 3 ],	// pixel 21 - Emissive matrices - 1
				emissiveMapMatrices[ 4 ], 	emissiveMapMatrices[ 5 ], 	emissiveMapMatrices[ 6 ], 	1,							// pixel 22 - Emissive matrices - 2
				bumpMapMatrices[ 0 ], 		bumpMapMatrices[ 1 ], 		bumpMapMatrices[ 2 ], 		bumpMapMatrices[ 3 ],		// pixel 23 - Bump map matrices - 1
				bumpMapMatrices[ 4 ], 		bumpMapMatrices[ 5 ],	 	bumpMapMatrices[ 6 ], 		1,							// pixel 24 - Bump map matrices - 2
			];

			data.set( materialData, stride );

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store the buffer for release when texture is disposed
		texture.userData = { buffer: data, bufferType: Float32Array };
		const originalDispose = texture.dispose.bind( texture );
		texture.dispose = () => {

			if ( texture.userData.buffer ) {

				this.bufferPool.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

			originalDispose();

		};

		return texture;

	}

	createBVHDataTextureSync( bvhRoot ) {

		const nodes = [];
		const flattenBVH = ( node ) => {

			const nodeIndex = nodes.length;
			nodes.push( node );
			if ( node.leftChild ) {

				const leftIndex = flattenBVH( node.leftChild );
				const rightIndex = flattenBVH( node.rightChild );
				node.leftChild = leftIndex;
				node.rightChild = rightIndex;

			}

			return nodeIndex;

		};

		flattenBVH( bvhRoot );

		const dataLength = nodes.length * TEXTURE_CONSTANTS.VEC4_PER_BVH_NODE * TEXTURE_CONSTANTS.FLOATS_PER_VEC4;
		const width = Math.ceil( Math.sqrt( dataLength / TEXTURE_CONSTANTS.RGBA_COMPONENTS ) );
		const height = Math.ceil( dataLength / ( TEXTURE_CONSTANTS.RGBA_COMPONENTS * width ) );
		const size = width * height * TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const data = this.bufferPool.getBuffer( size, Float32Array );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * 12;
			const node = nodes[ i ];

			const nodeData = [
				node.boundsMin.x, node.boundsMin.y, node.boundsMin.z,
				node.leftChild !== null ? node.leftChild : - 1,
				node.boundsMax.x, node.boundsMax.y, node.boundsMax.z,
				node.rightChild !== null ? node.rightChild : - 1,
				node.triangleOffset, node.triangleCount, 0, 0
			];

			data.set( nodeData, stride );

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store the buffer for release when texture is disposed
		texture.userData = { buffer: data, bufferType: Float32Array };
		const originalDispose = texture.dispose.bind( texture );
		texture.dispose = () => {

			if ( texture.userData.buffer ) {

				this.bufferPool.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

			originalDispose();

		};

		return texture;

	}

	// Helper methods
	calculateOptimalDimensions( textures ) {

		let maxWidth = 0;
		let maxHeight = 0;

		for ( const texture of textures ) {

			maxWidth = Math.max( maxWidth, texture.image.width );
			maxHeight = Math.max( maxHeight, texture.image.height );

		}

		maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
		maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

		while ( maxWidth >= TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE / 2 || maxHeight >= TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE / 2 ) {

			maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
			maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

		}

		return { maxWidth, maxHeight };

	}

	createDataArrayTextureFromResult( result ) {

		const textureData = result.data instanceof ArrayBuffer ?
			new Uint8Array( result.data ) : new Uint8Array( result.data );

		return this.createDataArrayTextureFromBuffer( textureData, result.width, result.height, result.depth );

	}

	createDataArrayTextureFromBuffer( data, width, height, depth ) {

		const texture = new DataArrayTexture( data, width, height, depth );

		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

		// Enhanced disposal
		texture.userData = { buffer: data, bufferType: Uint8Array };
		const originalDispose = texture.dispose.bind( texture );
		texture.dispose = () => {

			if ( texture.userData.buffer ) {

				this.bufferPool.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

			originalDispose();

		};

		return texture;

	}

	createFallbackTexture() {

		const data = new Uint8Array( 4 );
		const texture = new DataArrayTexture( data, 1, 1, 1 );

		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

		return texture;

	}

	combineTextureResults( results ) {

		// Combine multiple texture array results into one
		// This is a simplified implementation - you may need more sophisticated merging
		return results[ 0 ]; // For now, return first result

	}

	dispose() {

		this.canvasPool.dispose();
		this.bufferPool.dispose();
		this.textureCache.dispose();

	}

}
