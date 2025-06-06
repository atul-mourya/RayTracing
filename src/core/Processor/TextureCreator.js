import { WebGLRenderer, DataTexture, DataArrayTexture, RGBAFormat, LinearFilter, FloatType, UnsignedByteType } from "three";
import { updateLoading } from '../Processor/utils.js';

const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

// Constants to avoid magic numbers
const TEXTURE_CONSTANTS = {
	PIXELS_PER_MATERIAL: 24,
	RGBA_COMPONENTS: 4,
	VEC4_PER_TRIANGLE: 8, // 3 for positions, 3 for normals, 2 for UVs
	VEC4_PER_BVH_NODE: 3,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: Math.min( navigator.hardwareConcurrency || 4, 6 ),
	BUFFER_POOL_SIZE: 20,
	CANVAS_POOL_SIZE: 12,
	CACHE_SIZE_LIMIT: 50,
	MAX_TEXTURE_SIZE: ( () => {

		try {

			const renderer = new WebGLRenderer();
			const size = renderer.capabilities.maxTextureSize;
			renderer.dispose();
			return size;

		} catch {

			return 4096;

		}

	} )()
};

// Triangle data layout constants (matching GeometryExtractor)
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32, // 8 vec4s: 3 positions + 3 normals + 2 UV/material

	// Positions (3 vec4s = 12 floats)
	POSITION_A_OFFSET: 0, // vec4: x, y, z, 0
	POSITION_B_OFFSET: 4, // vec4: x, y, z, 0
	POSITION_C_OFFSET: 8, // vec4: x, y, z, 0

	// Normals (3 vec4s = 12 floats)
	NORMAL_A_OFFSET: 12, // vec4: x, y, z, 0
	NORMAL_B_OFFSET: 16, // vec4: x, y, z, 0
	NORMAL_C_OFFSET: 20, // vec4: x, y, z, 0

	// UVs and Material (2 vec4s = 8 floats)
	UV_AB_OFFSET: 24, // vec4: uvA.x, uvA.y, uvB.x, uvB.y
	UV_C_MAT_OFFSET: 28 // vec4: uvC.x, uvC.y, materialIndex, 0
};

// Canvas pooling for efficient reuse of canvas elements
class CanvasPool {

	constructor() {

		this.canvases = [];
		this.offscreenCanvases = [];
		this.contexts = [];
		this.maxPoolSize = TEXTURE_CONSTANTS.CANVAS_POOL_SIZE;

	}

	getCanvas( width, height, useOffscreen = false ) {

		if ( useOffscreen && typeof OffscreenCanvas !== 'undefined' ) {

			let canvas = this.offscreenCanvases.pop();
			if ( ! canvas ) {

				canvas = new OffscreenCanvas( width, height );

			} else {

				canvas.width = width;
				canvas.height = height;

			}

			return canvas;

		}

		let canvas = this.canvases.pop();
		if ( ! canvas ) {

			canvas = document.createElement( 'canvas' );

		}

		canvas.width = width;
		canvas.height = height;
		return canvas;

	}

	getContext( canvas, options = {} ) {

		const defaultOptions = {
			willReadFrequently: true,
			alpha: true,
			desynchronized: true
		};
		return canvas.getContext( '2d', { ...defaultOptions, ...options } );

	}

	releaseCanvas( canvas, ctx ) {

		if ( this.canvases.length < this.maxPoolSize ) {

			canvas.width = 1;
			canvas.height = 1;

			if ( canvas instanceof OffscreenCanvas ) {

				this.offscreenCanvases.push( canvas );

			} else {

				this.canvases.push( canvas );

			}

		}

	}

	dispose() {

		this.canvases = [];
		this.offscreenCanvases = [];
		this.contexts = [];

	}

}

// Smart buffer pool with automatic memory management
class SmartBufferPool {

	constructor() {

		this.pools = new Map();
		this.memoryUsage = 0;
		this.maxMemoryUsage = 256 * 1024 * 1024; // 256MB limit

	}

	getBuffer( size, Type = Float32Array ) {

		const key = `${Type.name}-${this.getNearestPowerOf2( size )}`;
		const pool = this.pools.get( key ) || [];

		let buffer = pool.pop();
		if ( ! buffer || buffer.length < size ) {

			buffer = new Type( this.getNearestPowerOf2( size ) );
			this.memoryUsage += buffer.byteLength;

		}

		// Auto cleanup if memory usage is high
		if ( this.memoryUsage > this.maxMemoryUsage ) {

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

			this.memoryUsage -= buffer.byteLength;

		}

	}

	getNearestPowerOf2( size ) {

		return Math.pow( 2, Math.ceil( Math.log2( size ) ) );

	}

	cleanup() {

		// Remove oldest pools
		const entries = Array.from( this.pools.entries() );
		entries.slice( 0, Math.floor( entries.length / 2 ) ).forEach( ( [ key, pool ] ) => {

			pool.forEach( buffer => {

				this.memoryUsage -= buffer.byteLength;

			} );
			this.pools.delete( key );

		} );

	}

	dispose() {

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

	constructor() {

		this.useWorkers = typeof Worker !== 'undefined';
		this.maxConcurrentWorkers = TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS;
		this.activeWorkers = 0;

		// Initialize high-performance components
		this.canvasPool = new CanvasPool();
		this.bufferPool = new SmartBufferPool();
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

	// Replace the existing createAllTextures method with this version:
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

		// Use optimized sync method for materials (typically small datasets)
		return this.createMaterialDataTextureSync( materials );

	}

	async createTriangleDataTexture( triangles ) {

		const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		console.log( `Creating triangle: ${triangleCount} triangles` );

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

	async createTexturesToDataTexture( textures ) {

		if ( ! textures || textures.length === 0 ) return null;

		// Check cache first
		const cacheKey = this.textureCache.generateHash( textures );
		const cached = this.textureCache.get( cacheKey );
		if ( cached ) {

			return cached;

		}

		let result;
		const method = this.selectMethodForTextures( textures );

		switch ( method ) {

			case 'worker-offscreen':
				result = await this.processWithWorker( textures );
				break;
			case 'imageBitmap':
				result = await this.processWithImageBitmap( textures );
				break;
			default:
				result = await this.createTexturesToDataTextureSync( textures );

		}

		// Cache the result
		if ( result ) {

			this.textureCache.set( cacheKey, result );

		}

		return result;

	}

	selectMethodForTextures( textures ) {

		const totalPixels = textures.reduce( ( sum, tex ) => {

			const width = tex.image?.width || 0;
			const height = tex.image?.height || 0;
			return sum + width * height;

		}, 0 );

		const hasLargeTextures = textures.some( tex => {

			const width = tex.image?.width || 0;
			const height = tex.image?.height || 0;
			return width > 1024 || height > 1024;

		} );

		// Use workers for large datasets
		if ( this.optimalMethod === 'worker-offscreen' &&
			( totalPixels > 2097152 || ( hasLargeTextures && textures.length > 4 ) ) ) {

			return 'worker-offscreen';

		}

		// Use ImageBitmap for medium complexity
		if ( this.capabilities.imageBitmap && totalPixels > 524288 ) {

			return 'imageBitmap';

		}

		return 'canvas';

	}

	async processWithWorker( textures ) {

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

			// Prepare textures for worker
			const texturesData = await this.prepareTexturesForWorker( textures );

			const result = await new Promise( ( resolve, reject ) => {

				worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				worker.onerror = reject;

				// Transfer ownership for zero-copy
				const transferables = texturesData
					.map( tex => tex.data )
					.filter( data => data instanceof ArrayBuffer );

				worker.postMessage( {
					textures: texturesData,
					maxTextureSize: TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE,
					method: 'offscreen-optimized'
				}, transferables );

			} );

			worker.terminate();
			return this.createDataArrayTextureFromResult( result );

		} finally {

			this.activeWorkers --;

		}

	}

	async prepareTexturesForWorker( textures ) {

		const texturesData = [];

		for ( const texture of textures ) {

			if ( ! texture?.image ) continue;

			try {

				// Convert to blob for efficient worker transfer
				const canvas = this.canvasPool.getCanvas( texture.image.width, texture.image.height );
				const ctx = this.canvasPool.getContext( canvas );

				ctx.clearRect( 0, 0, canvas.width, canvas.height );
				ctx.drawImage( texture.image, 0, 0 );

				const blob = await new Promise( resolve => {

					canvas.toBlob( resolve, 'image/png', 1.0 );

				} );

				const arrayBuffer = await blob.arrayBuffer();

				texturesData.push( {
					data: arrayBuffer,
					width: texture.image.width,
					height: texture.image.height,
					isBlob: true
				} );

				this.canvasPool.releaseCanvas( canvas, ctx );

			} catch ( error ) {

				console.warn( 'Failed to prepare texture for worker:', error );

			}

		}

		return texturesData;

	}

	async processWithImageBitmap( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		// Process in parallel batches
		const batchSize = Math.min( 4, validTextures.length );

		for ( let batchStart = 0; batchStart < validTextures.length; batchStart += batchSize ) {

			const batchEnd = Math.min( batchStart + batchSize, validTextures.length );
			const batchPromises = [];

			for ( let i = batchStart; i < batchEnd; i ++ ) {

				const texture = validTextures[ i ];
				batchPromises.push(
					createImageBitmap( texture.image, {
						resizeWidth: maxWidth,
						resizeHeight: maxHeight,
						resizeQuality: 'high'
					} ).then( bitmap => ( { bitmap, index: i } ) )
				);

			}

			const bitmaps = await Promise.all( batchPromises );

			// Process each bitmap
			const canvas = this.canvasPool.getCanvas( maxWidth, maxHeight );
			const ctx = this.canvasPool.getContext( canvas );
			ctx.imageSmoothingEnabled = false; // Fast processing

			for ( const { bitmap, index } of bitmaps ) {

				ctx.clearRect( 0, 0, maxWidth, maxHeight );
				ctx.drawImage( bitmap, 0, 0 );

				const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );
				const offset = maxWidth * maxHeight * 4 * index;
				data.set( imageData.data, offset );

				bitmap.close();

			}

			this.canvasPool.releaseCanvas( canvas, ctx );

		}

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

	createTexturesToDataTextureSync( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		const canvas = this.canvasPool.getCanvas( maxWidth, maxHeight );
		const ctx = this.canvasPool.getContext( canvas );
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';

		for ( let i = 0; i < validTextures.length; i ++ ) {

			const texture = validTextures[ i ];

			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( texture.image, 0, 0, maxWidth, maxHeight );

			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

		}

		this.canvasPool.releaseCanvas( canvas, ctx );
		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

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

	dispose() {

		this.canvasPool.dispose();
		this.bufferPool.dispose();
		this.textureCache.dispose();

	}

}
