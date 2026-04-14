import { DataArrayTexture, RGBAFormat, LinearFilter, UnsignedByteType, SRGBColorSpace } from "three";
import { TEXTURE_CONSTANTS, MEMORY_CONSTANTS, DEFAULT_TEXTURE_MATRIX, MATERIAL_DATA_LAYOUT } from '../EngineDefaults.js';

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

			try {

				buffer = new Type( optimalSize );
				this.memoryUsage += buffer.byteLength;
				this.allocatedBuffers.set( buffer, true );

			} catch {

				// Memory allocation failed - cleanup and try again with smaller strategy
				this.cleanup();

				try {

					buffer = new Type( optimalSize );
					this.memoryUsage += buffer.byteLength;
					this.allocatedBuffers.set( buffer, true );

				} catch ( retryError ) {

					// Still failed - throw with helpful context
					const requestedMB = ( optimalSize * Type.BYTES_PER_ELEMENT ) / ( 1024 * 1024 );
					const currentUsageMB = this.memoryUsage / ( 1024 * 1024 );
					throw new Error( `Buffer allocation failed: requested ${ requestedMB.toFixed( 1 ) }MB, current usage: ${ currentUsageMB.toFixed( 1 ) }MB, max: ${ ( this.maxMemoryUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB. Original error: ${ retryError.message }` );

				}

			}

		}

		// Auto cleanup if memory usage is high
		if ( this.memoryUsage > this.maxMemoryUsage * MEMORY_CONSTANTS.CLEANUP_THRESHOLD ) {

			this.cleanup();

		}

		// Check memory health and warn if needed
		this.checkMemoryHealth();

		// Safety check: verify the underlying ArrayBuffer is large enough for the requested view.
		// A recycled buffer may have an undersized ArrayBuffer if it was released with a wrong Type.
		const requiredBytes = buffer.byteOffset + size * Type.BYTES_PER_ELEMENT;
		if ( requiredBytes > buffer.buffer.byteLength ) {

			// Discard the undersized buffer and allocate a fresh one
			buffer = new Type( size );
			this.memoryUsage += buffer.byteLength;

		}

		// Create a fresh view over the full underlying ArrayBuffer to avoid
		// subarray length clamping when the pool recycles a smaller view.
		return new Type( buffer.buffer, buffer.byteOffset, size );

	}

	releaseBuffer( buffer, Type = Float32Array ) {

		// Recover the full allocated size from the underlying ArrayBuffer
		const fullLength = ( buffer.buffer.byteLength - buffer.byteOffset ) / Type.BYTES_PER_ELEMENT;
		const optimalSize = this.getOptimalSize( fullLength );
		const key = `${Type.name}-${optimalSize}`;
		const pool = this.pools.get( key ) || [];

		if ( pool.length < TEXTURE_CONSTANTS.BUFFER_POOL_SIZE ) {

			// Store the full-extent view so future getBuffer calls can serve any size <= optimalSize
			pool.push( new Type( buffer.buffer, buffer.byteOffset, fullLength ) );
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

	// Memory monitoring helper
	getMemoryStats() {

		const stats = {
			currentUsage: this.memoryUsage,
			maxUsage: this.maxMemoryUsage,
			utilizationPercentage: ( this.memoryUsage / this.maxMemoryUsage ) * 100,
			poolCount: this.pools.size,
			allocatedBufferCount: this.allocatedBuffers ? this.allocatedBuffers.size || 0 : 0
		};

		return stats;

	}

	// Warning system for memory usage
	checkMemoryHealth() {

		const stats = this.getMemoryStats();

		if ( stats.utilizationPercentage > 90 ) {

			console.warn( `Memory pool critical: ${ stats.utilizationPercentage.toFixed( 1 ) }% used (${ ( stats.currentUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB / ${ ( stats.maxUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB)` );
			return 'critical';

		} else if ( stats.utilizationPercentage > 70 ) {

			console.warn( `Memory pool high: ${ stats.utilizationPercentage.toFixed( 1 ) }% used (${ ( stats.currentUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB / ${ ( stats.maxUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB)` );
			return 'high';

		}

		return 'normal';

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

			// Return cached texture directly — clone() fails on large DataArrayTextures
			// because Three.js's copy() calls JSON.stringify on the data array.
			// Each map type stores its own reference so shared instances are safe.
			return this.cache.get( key );

		}

		return null;

	}

	set( key, texture ) {

		if ( this.cache.has( key ) ) {

			// Remove stale access order entry to prevent duplicates
			const index = this.accessOrder.indexOf( key );
			if ( index > - 1 ) this.accessOrder.splice( index, 1 );

		} else if ( this.cache.size >= this.maxSize ) {

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

export class TextureCreator {

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

	/**
	 * Build raw material Float32Array without DataTexture wrapping.
	 * Used by WebGPU backend which feeds data into storage buffers.
	 */
	createMaterialRawData( materials ) {

		// Layout is defined by MATERIAL_DATA_LAYOUT in EngineDefaults.js.
		// The inline array below must match that layout exactly (positional order = canonical layout).
		const dataLengthPerMaterial = MATERIAL_DATA_LAYOUT.FLOATS_PER_MATERIAL;
		const totalMaterials = materials.length;

		const size = totalMaterials * dataLengthPerMaterial;
		const data = new Float32Array( size );

		for ( let i = 0; i < totalMaterials; i ++ ) {

			const mat = materials[ i ];
			const stride = i * dataLengthPerMaterial;

			const mapMatrix = mat.mapMatrix ?? DEFAULT_TEXTURE_MATRIX;
			const normalMapMatrices = mat.normalMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const roughnessMapMatrices = mat.roughnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const metalnessMapMatrices = mat.metalnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const emissiveMapMatrices = mat.emissiveMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const bumpMapMatrices = mat.bumpMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const displacementMapMatrices = mat.displacementMapMatrices ?? DEFAULT_TEXTURE_MATRIX;

			// Slot order: shadow/culling → BxDF core → maps → extended → displacement → transforms
			// Must match MATERIAL_DATA_LAYOUT in EngineDefaults.js exactly.
			const materialData = [
				// Slot 0: shadow core (ior, transmission, thickness, emissiveIntensity)
				mat.ior, 					mat.transmission, 			mat.thickness, 				mat.emissiveIntensity,
				// Slot 1: shadow (attenuationColor, attenuationDistance)
				mat.attenuationColor.r, 	mat.attenuationColor.g, 	mat.attenuationColor.b, 	mat.attenuationDistance,
				// Slot 2: shadow + culling (opacity, side, transparent, alphaTest)
				mat.opacity, 				mat.side, 					mat.transparent, 			mat.alphaTest,
				// Slot 3: shadow (alphaMode, depthWrite, normalScale)
				mat.alphaMode, 				mat.depthWrite, 			mat.normalScale?.x ?? 1, 	mat.normalScale?.y ?? 1,
				// Slot 4: BxDF core (color, metalness)
				mat.color.r, 				mat.color.g, 				mat.color.b, 				mat.metalness,
				// Slot 5: BxDF core (emissive, roughness)
				mat.emissive.r, 			mat.emissive.g, 			mat.emissive.b, 			mat.roughness,
				// Slot 6: map indices A (albedo, normal, roughness, metalness)
				mat.map, 					mat.normalMap, 				mat.roughnessMap, 			mat.metalnessMap,
				// Slot 7: map indices B (emissive, bump, clearcoat, clearcoatRoughness)
				mat.emissiveMap, 			mat.bumpMap, 				mat.clearcoat, 				mat.clearcoatRoughness,
				// Slot 8: extended BxDF (dispersion, visible, sheen, sheenRoughness)
				mat.dispersion, 			mat.visible, 				mat.sheen, 					mat.sheenRoughness,
				// Slot 9: extended BxDF (sheenColor, reserved)
				mat.sheenColor.r, 			mat.sheenColor.g, 			mat.sheenColor.b, 			1,
				// Slot 10: extended BxDF (specularIntensity, specularColor)
				mat.specularIntensity, 		mat.specularColor.r, 		mat.specularColor.g, 		mat.specularColor.b,
				// Slot 11: extended BxDF (iridescence)
				mat.iridescence, 			mat.iridescenceIOR, 		mat.iridescenceThicknessRange[ 0 ], mat.iridescenceThicknessRange[ 1 ],
				// Slot 12: displacement
				mat.bumpScale,				mat.displacementScale,		mat.displacementMap,		0,
				mapMatrix[ 0 ], 			mapMatrix[ 1 ], 			mapMatrix[ 2 ], 			mapMatrix[ 3 ],
				mapMatrix[ 4 ], 			mapMatrix[ 5 ], 			mapMatrix[ 6 ], 			1,
				normalMapMatrices[ 0 ], 	normalMapMatrices[ 1 ], 	normalMapMatrices[ 2 ], 	normalMapMatrices[ 3 ],
				normalMapMatrices[ 4 ], 	normalMapMatrices[ 5 ], 	normalMapMatrices[ 6 ], 	1,
				roughnessMapMatrices[ 0 ], 	roughnessMapMatrices[ 1 ], 	roughnessMapMatrices[ 2 ], 	roughnessMapMatrices[ 3 ],
				roughnessMapMatrices[ 4 ], 	roughnessMapMatrices[ 5 ], 	roughnessMapMatrices[ 6 ], 	1,
				metalnessMapMatrices[ 0 ], 	metalnessMapMatrices[ 1 ], 	metalnessMapMatrices[ 2 ], 	metalnessMapMatrices[ 3 ],
				metalnessMapMatrices[ 4 ], 	metalnessMapMatrices[ 5 ], 	metalnessMapMatrices[ 6 ], 	1,
				emissiveMapMatrices[ 0 ], 	emissiveMapMatrices[ 1 ], 	emissiveMapMatrices[ 2 ], 	emissiveMapMatrices[ 3 ],
				emissiveMapMatrices[ 4 ], 	emissiveMapMatrices[ 5 ], 	emissiveMapMatrices[ 6 ], 	1,
				bumpMapMatrices[ 0 ], 		bumpMapMatrices[ 1 ], 		bumpMapMatrices[ 2 ], 		bumpMapMatrices[ 3 ],
				bumpMapMatrices[ 4 ], 		bumpMapMatrices[ 5 ],	 	bumpMapMatrices[ 6 ], 		1,
				displacementMapMatrices[ 0 ], displacementMapMatrices[ 1 ], displacementMapMatrices[ 2 ], displacementMapMatrices[ 3 ],
				displacementMapMatrices[ 4 ], displacementMapMatrices[ 5 ], displacementMapMatrices[ 6 ], 1,
			];

			data.set( materialData, stride );

		}

		return data;

	}

	/**
	 * Build raw BVH Float32Array without DataTexture wrapping.
	 * Used by WebGPU backend which feeds data into storage buffers.
	 */
	createBVHRawData( bvhRoot ) {

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

		// Layout: 4 vec4 per node (16 floats)
		// Inner: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		// Leaf:  [triOffset, triCount, 0, -1] [0,0,0,0] [0,0,0,0] [0,0,0,0]
		const floatsPerNode = TEXTURE_CONSTANTS.VEC4_PER_BVH_NODE * TEXTURE_CONSTANTS.FLOATS_PER_VEC4;
		const size = nodes.length * floatsPerNode;
		const data = new Float32Array( size );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * floatsPerNode;
			const node = nodes[ i ];

			if ( node.leftChild !== null ) {

				// Inner node: leftChild/rightChild are now flat indices after recursive pass
				const leftIdx = node.leftChild;
				const rightIdx = node.rightChild;
				const left = nodes[ leftIdx ];
				const right = nodes[ rightIdx ];

				data[ stride ] = left.boundsMin.x;
				data[ stride + 1 ] = left.boundsMin.y;
				data[ stride + 2 ] = left.boundsMin.z;
				data[ stride + 3 ] = leftIdx;

				data[ stride + 4 ] = left.boundsMax.x;
				data[ stride + 5 ] = left.boundsMax.y;
				data[ stride + 6 ] = left.boundsMax.z;
				data[ stride + 7 ] = rightIdx;

				data[ stride + 8 ] = right.boundsMin.x;
				data[ stride + 9 ] = right.boundsMin.y;
				data[ stride + 10 ] = right.boundsMin.z;

				data[ stride + 12 ] = right.boundsMax.x;
				data[ stride + 13 ] = right.boundsMax.y;
				data[ stride + 14 ] = right.boundsMax.z;

			} else {

				// Leaf node
				data[ stride ] = node.triangleOffset;
				data[ stride + 1 ] = node.triangleCount;
				data[ stride + 3 ] = - 1; // Leaf marker

			}

		}

		return data;

	}

	/**
	 * Create only material and texture-related textures (excludes triangle and BVH textures)
	 * @param {Object} params - Parameters object
	 * @returns {Promise<Object>} - Object containing created textures
	 */
	async createMaterialTextures( params ) {

		const { materials, maps, normalMaps, bumpMaps, roughnessMaps, metalnessMaps, emissiveMaps, displacementMaps } = params;

		console.log( '[TextureCreator] Creating material textures only' );
		const startTime = performance.now();

		try {

			// Validate inputs
			if ( ! materials || materials.length === 0 ) {

				throw new Error( 'No materials provided for texture creation' );

			}

			// Clear any cached textures that might interfere
			this.textureCache.dispose();
			this.textureCache = new TextureCache();

			// Create texture arrays
			const texturePromises = [];

			if ( maps && maps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( maps )
						.then( tex => ( { type: 'albedo', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create albedo textures:', error );
							return { type: 'albedo', texture: null };

						} )
				);

			}

			if ( normalMaps && normalMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( normalMaps )
						.then( tex => ( { type: 'normal', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create normal textures:', error );
							return { type: 'normal', texture: null };

						} )
				);

			}

			if ( bumpMaps && bumpMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( bumpMaps )
						.then( tex => ( { type: 'bump', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create bump textures:', error );
							return { type: 'bump', texture: null };

						} )
				);

			}

			if ( roughnessMaps && roughnessMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( roughnessMaps )
						.then( tex => ( { type: 'roughness', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create roughness textures:', error );
							return { type: 'roughness', texture: null };

						} )
				);

			}

			if ( metalnessMaps && metalnessMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( metalnessMaps )
						.then( tex => ( { type: 'metalness', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create metalness textures:', error );
							return { type: 'metalness', texture: null };

						} )
				);

			}

			if ( emissiveMaps && emissiveMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( emissiveMaps )
						.then( tex => ( { type: 'emissive', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create emissive textures:', error );
							return { type: 'emissive', texture: null };

						} )
				);

			}

			if ( displacementMaps && displacementMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( displacementMaps )
						.then( tex => ( { type: 'displacement', texture: tex } ) )
						.catch( error => {

							console.warn( 'Failed to create displacement textures:', error );
							return { type: 'displacement', texture: null };

						} )
				);

			}

			// Wait for all texture arrays to complete
			const textureResults = await Promise.allSettled( texturePromises );

			// Organize results
			const textures = {};

			// Process texture results (successful or failed)
			textureResults.forEach( ( result ) => {

				if ( result.status === 'fulfilled' && result.value ) {

					const { type, texture } = result.value;

					if ( texture ) {

						switch ( type ) {

							case 'albedo': texture.colorSpace = SRGBColorSpace; textures.albedoTexture = texture; break;
							case 'normal': textures.normalTexture = texture; break;
							case 'bump': textures.bumpTexture = texture; break;
							case 'roughness': textures.roughnessTexture = texture; break;
							case 'metalness': textures.metalnessTexture = texture; break;
							case 'emissive': texture.colorSpace = SRGBColorSpace; textures.emissiveTexture = texture; break;
							case 'displacement': textures.displacementTexture = texture; break;

						}

					}

				}

			} );

			const duration = performance.now() - startTime;
			console.log( `[TextureCreator] Material texture creation complete (${duration.toFixed( 2 )}ms)` );

			return textures;

		} catch ( error ) {

			console.error( '[TextureCreator] Material texture creation error:', error );
			throw new Error( `Material texture creation failed: ${error.message}` );

		}

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

		const data = new Uint8Array( [ 255, 255, 255, 255 ] );
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
