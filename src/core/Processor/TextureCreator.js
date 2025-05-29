import { WebGLRenderer, DataTexture, DataArrayTexture, RGBAFormat, LinearFilter, FloatType, UnsignedByteType } from "three";

const maxTextureSize = new WebGLRenderer().capabilities.maxTextureSize;
const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

// Constants to avoid magic numbers
const TEXTURE_CONSTANTS = {
	PIXELS_PER_MATERIAL: 24,
	RGBA_COMPONENTS: 4,
	VEC4_PER_TRIANGLE: 8, // 3 for positions, 3 for normals, 2 for UVs
	VEC4_PER_BVH_NODE: 3,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: 4,
	WORKER_POOL_SIZE: 10,
	BUFFER_POOL_SIZE: 20
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
		this.contexts = [];
		this.maxPoolSize = 10; // Prevent excessive pooling

	}

	getCanvas( width, height ) {

		let canvas = this.canvases.pop();
		if ( ! canvas ) {

			canvas = document.createElement( 'canvas' );

		}

		canvas.width = width;
		canvas.height = height;
		return canvas;

	}

	getContext( canvas ) {

		let ctx = this.contexts.pop();
		if ( ! ctx ) {

			ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		} else {

			ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		}

		return ctx;

	}

	releaseCanvas( canvas, ctx ) {

		if ( this.canvases.length < this.maxPoolSize ) {

			// Reset canvas to save memory
			canvas.width = 1;
			canvas.height = 1;
			this.canvases.push( canvas );

		}

		if ( ctx && this.contexts.length < this.maxPoolSize ) {

			this.contexts.push( ctx );

		}

	}

}

export default class TextureCreator {

	constructor() {

		this.useWorkers = typeof Worker !== 'undefined';
		// Limit concurrent workers (adjust based on your needs)
		this.maxConcurrentWorkers = TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS;
		this.maxConcurrentWorkers = Math.min( navigator.hardwareConcurrency || TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS, TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS );
		this.activeWorkers = 0;

		// Initialize canvas pool
		this.canvasPool = new CanvasPool();

		// Initialize buffer pool
		this.bufferPool = new Map(); // size -> array pool
		this.maxBufferPoolSize = TEXTURE_CONSTANTS.BUFFER_POOL_SIZE;

	}

	// Get a buffer from the pool or create a new one
	getBuffer( size, type = Float32Array ) {

		const key = `${type.name}-${size}`;
		const pool = this.bufferPool.get( key ) || [];
		return pool.pop() || new type( size );

	}

	// Return a buffer to the pool
	releaseBuffer( buffer, type = Float32Array ) {

		const key = `${type.name}-${buffer.length}`;
		const pool = this.bufferPool.get( key ) || [];
		if ( pool.length < this.maxBufferPoolSize ) {

			pool.push( buffer );
			this.bufferPool.set( key, pool );

		}

	}

	// Add a worker queue handler
	async executeWorker( workerPath, data ) {

		// Wait if too many workers are active
		while ( this.activeWorkers >= this.maxConcurrentWorkers ) {

			await new Promise( resolve => setTimeout( resolve, 10 ) );

		}

		this.activeWorkers ++;
		try {

			const worker = new Worker( workerPath, { type: 'module' } );
			const result = await new Promise( ( resolve, reject ) => {

				worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				worker.onerror = reject;
				worker.postMessage( data );

			} );
			worker.terminate();
			return result;

		} finally {

			this.activeWorkers --;

		}

	}

	async createAllTextures( params ) {

		const {
			materials,
			triangles,
			maps,
			normalMaps,
			bumpMaps,
			roughnessMaps,
			metalnessMaps,
			emissiveMaps,
			bvhRoot
		} = params;

		try {

			const texturePromises = [];

			// Material texture
			if ( materials?.length ) {

				texturePromises.push(
					this.createMaterialDataTexture( materials )
						.then( texture => ( { type: 'material', texture } ) )
				);

			}

			// Triangle texture
			if ( triangles && triangles.byteLength > 0 ) {

				texturePromises.push(
					this.createTriangleDataTexture( triangles )
						.then( texture => ( { type: 'triangle', texture } ) )
				);

			}

			// Maps textures
			const mapPromises = [
				{ data: maps, type: 'albedo' },
				{ data: normalMaps, type: 'normal' },
				{ data: bumpMaps, type: 'bump' },
				{ data: roughnessMaps, type: 'roughness' },
				{ data: metalnessMaps, type: 'metalness' },
				{ data: emissiveMaps, type: 'emissive' }
			].filter( ( { data } ) => data?.length > 0 )
				.map( ( { data, type } ) =>
					this.createTexturesToDataTexture( data )
						.then( texture => ( { type, texture } ) )
				);

			texturePromises.push( ...mapPromises );

			// BVH texture
			if ( bvhRoot ) {

				texturePromises.push(
					this.createBVHDataTexture( bvhRoot )
						.then( texture => ( { type: 'bvh', texture } ) )
				);

			}

			// Wait for all textures to be created
			const results = await Promise.all( texturePromises );

			// Organize results into an object
			return results.reduce( ( acc, { type, texture } ) => {

				acc[ `${type}Texture` ] = texture;
				return acc;

			}, {} );

		} catch ( error ) {

			console.error( 'Error creating textures:', error );
			throw error;

		}

	}

	async createMaterialDataTexture( materials ) {

		if ( this.useWorkers ) {

			try {

				const worker = new Worker(
					new URL( './Workers/MaterialTextureWorker.js', import.meta.url ),
					{ type: 'module' }
				);

				const result = await new Promise( ( resolve, reject ) => {

					worker.onmessage = ( e ) => {

						const { data, width, height, error } = e.data;
						if ( error ) {

							reject( new Error( error ) );
							return;

						}

						resolve( { data, width, height } );

					};

					worker.onerror = ( error ) => reject( error );
					worker.postMessage( { materials, DEFAULT_TEXTURE_MATRIX } );

				} );

				worker.terminate();

				// Properly handle ArrayBuffer from worker
				let textureData;
				if ( result.data instanceof ArrayBuffer ) {

					textureData = new Float32Array( result.data );

				} else if ( result.data instanceof Float32Array ) {

					textureData = result.data;

				} else {

					throw new Error( 'Invalid data format from worker' );

				}

				const texture = new DataTexture(
					textureData,
					result.width,
					result.height,
					RGBAFormat,
					FloatType
				);
				texture.needsUpdate = true;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed for material texture, falling back to synchronous operation:', error );
				return this.createMaterialDataTextureSync( materials );

			}

		}

		return this.createMaterialDataTextureSync( materials );

	}

	async createTriangleDataTexture( triangles ) {

		const triangleCount = triangles.byteLength / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 );
		console.log( `Creating triangle: ${triangleCount} triangles` );

		// Calculate texture dimensions - data is already perfectly aligned
		const floatsPerTriangle = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE; // 32 floats
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
			textureData = new Float32Array( expectedSize );
			textureData.set( triangles, 0 ); // Copy existing data, rest remains zeros

		}

		const texture = new DataTexture( textureData, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store metadata for disposal
		if ( textureData !== triangles ) {

			texture.userData = { buffer: textureData, bufferType: Float32Array };
			texture.addEventListener( 'dispose', () => {

				if ( texture.userData.buffer ) {

					this.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
					texture.userData.buffer = null;

				}

			} );

		}

		console.log( `Triangle texture created: ${width}x${height}, ${triangleCount} triangles` );
		return texture;

	}

	async createTexturesToDataTexture( textures ) {

		if ( textures.length === 0 ) return null;

		if ( this.useWorkers ) {

			try {

				const worker = new Worker(
					new URL( './Workers/TexturesWorker.js', import.meta.url ),
					{ type: 'module' }
				);

				const texturesData = textures.map( texture => ( {
					width: texture.image.width,
					height: texture.image.height,
					data: this.getImageData( texture.image )
				} ) );

				const result = await new Promise( ( resolve, reject ) => {

					worker.onmessage = ( e ) => {

						const { data, width, height, depth, error } = e.data;
						if ( error ) {

							reject( new Error( error ) );
							return;

						}

						resolve( { data, width, height, depth } );

					};

					worker.onerror = ( error ) => reject( error );
					worker.postMessage( { textures: texturesData, maxTextureSize } );

				} );

				worker.terminate();

				// Properly handle ArrayBuffer from worker
				let textureData;
				if ( result.data instanceof ArrayBuffer ) {

					textureData = new Uint8Array( result.data );

				} else if ( result.data instanceof Uint8Array ) {

					textureData = result.data;

				} else {

					throw new Error( 'Invalid texture array data format from worker' );

				}

				const texture = new DataArrayTexture(
					textureData,
					result.width,
					result.height,
					result.depth
				);
				texture.minFilter = LinearFilter;
				texture.magFilter = LinearFilter;
				texture.format = RGBAFormat;
				texture.type = UnsignedByteType;
				texture.needsUpdate = true;
				texture.generateMipmaps = false;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed for texture array, falling back to synchronous operation:', error );
				return this.createTexturesToDataTextureSync( textures );

			}

		}

		return this.createTexturesToDataTextureSync( textures );

	}

	async createBVHDataTexture( bvhRoot ) {

		if ( this.useWorkers ) {

			try {

				const worker = new Worker(
					new URL( './Workers/BVHTextureWorker.js', import.meta.url ),
					{ type: 'module' }
				);

				const result = await new Promise( ( resolve, reject ) => {

					worker.onmessage = ( e ) => {

						const { data, width, height, error } = e.data;
						if ( error ) {

							reject( new Error( error ) );
							return;

						}

						resolve( { data, width, height } );

					};

					worker.onerror = ( error ) => reject( error );
					worker.postMessage( { bvhRoot } );

				} );

				worker.terminate();

				// Properly handle ArrayBuffer from worker
				let textureData;
				if ( result.data instanceof ArrayBuffer ) {

					textureData = new Float32Array( result.data );

				} else if ( result.data instanceof Float32Array ) {

					textureData = result.data;

				} else {

					throw new Error( 'Invalid BVH data format from worker' );

				}

				const texture = new DataTexture(
					textureData,
					result.width,
					result.height,
					RGBAFormat,
					FloatType
				);
				texture.needsUpdate = true;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed for BVH texture, falling back to synchronous operation:', error );
				return this.createBVHDataTextureSync( bvhRoot );

			}

		}

		return this.createBVHDataTextureSync( bvhRoot );

	}

	// Helper method to get image data using canvas pool
	getImageData( image ) {

		const canvas = this.canvasPool.getCanvas( image.width, image.height );
		const ctx = this.canvasPool.getContext( canvas );

		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		ctx.drawImage( image, 0, 0 );
		const imageData = ctx.getImageData( 0, 0, image.width, image.height ).data;

		this.canvasPool.releaseCanvas( canvas, ctx );
		return imageData;

	}

	createMaterialDataTextureSync( materials ) {

		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL; // 24 pixels per material
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS; // RGBA components
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const totalMaterials = materials.length;

		// Calculate the optimal dimensions
		// Strategy: Find the smallest power of 2 width that minimizes unused space
		const totalPixels = pixelsRequired * totalMaterials;
		let bestWidth = TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH; // Start with minimum reasonable width
		let bestHeight = Math.ceil( totalPixels / TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH );
		let minWaste = bestWidth * bestHeight - totalPixels;

		// Try different widths up to the square root of total pixels
		const maxWidth = Math.ceil( Math.sqrt( totalPixels ) );
		for ( let w = 8; w <= maxWidth; w *= 2 ) {

			const h = Math.ceil( totalPixels / w );
			const waste = w * h - totalPixels;

			if ( waste < minWaste ) {

				bestWidth = w;
				bestHeight = h;
				minWaste = waste;

			}

		}

		// Ensure height is a power of 2 as well (often required by GPUs)
		bestHeight = Math.pow( 2, Math.ceil( Math.log2( bestHeight ) ) );

		const size = bestWidth * bestHeight * dataInEachPixel;
		const data = this.getBuffer( size );

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

		const texture = new DataTexture( data, bestWidth, bestHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store the buffer for release when texture is disposed
		texture.userData = { buffer: data, bufferType: Float32Array };
		texture.addEventListener( 'dispose', () => {

			if ( texture.userData.buffer ) {

				this.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

		} );

		return texture;

	}

	createTexturesToDataTextureSync( textures ) {

		if ( textures.length == 0 ) return null;

		// Filter out textures with null images and log warnings
		const validTextures = textures.filter( ( map, index ) => {

			if ( ! map || ! map.image ) {

				console.warn( `Texture at index ${index} has null or invalid image. Creating fallback texture.` );
				return false;

			}

			return true;

		} );

		// If no valid textures, create a single 1x1 black texture as fallback
		if ( validTextures.length === 0 ) {

			const data = new Uint8Array( 4 ); // RGBA, all zeros (black, fully transparent)
			const texture = new DataArrayTexture( data, 1, 1, 1 );
			texture.minFilter = LinearFilter;
			texture.magFilter = LinearFilter;
			texture.format = RGBAFormat;
			texture.type = UnsignedByteType;
			texture.needsUpdate = true;
			texture.generateMipmaps = false;
			return texture;

		}

		// Determine the maximum dimensions among all valid textures
		let maxWidth = 0;
		let maxHeight = 0;
		for ( let map of validTextures ) {

			maxWidth = Math.max( maxWidth, map.image.width );
			maxHeight = Math.max( maxHeight, map.image.height );

		}

		// Round up to the nearest power of 2
		maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
		maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

		// Reduce dimensions if they exceed the maximum texture size
		while ( maxWidth >= maxTextureSize / 2 || maxHeight >= maxTextureSize / 2 ) {

			maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
			maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

		}

		// Create a 3D data array
		const depth = validTextures.length;
		const data = this.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		// Get canvas from pool
		const canvas = this.canvasPool.getCanvas( maxWidth, maxHeight );
		const ctx = this.canvasPool.getContext( canvas );

		// Fill the 3D texture data
		for ( let i = 0; i < validTextures.length; i ++ ) {

			const map = validTextures[ i ];

			// Clear canvas and draw the texture
			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( map.image, 0, 0, maxWidth, maxHeight );

			// Get image data
			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );

			// Copy to the 3D array
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

		}

		// Return canvas to pool
		this.canvasPool.releaseCanvas( canvas, ctx );

		// Create and return the 3D texture
		const texture = new DataArrayTexture( data, maxWidth, maxHeight, depth );
		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

		// Store the buffer for release when texture is disposed
		texture.userData = { buffer: data, bufferType: Uint8Array };
		texture.addEventListener( 'dispose', () => {

			if ( texture.userData.buffer ) {

				this.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

		} );

		// Store the mapping between original texture indices and valid texture indices
		texture.textureMapping = textures.map( ( tex, index ) => {

			const validIndex = validTextures.indexOf( tex );
			return validIndex >= 0 ? validIndex : - 1;

		} );

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

		// Optimized: Use only 3 vec4s per node instead of 4
		const dataLength = nodes.length * TEXTURE_CONSTANTS.VEC4_PER_BVH_NODE * TEXTURE_CONSTANTS.FLOATS_PER_VEC4; // 3 vec4s per node
		const width = Math.ceil( Math.sqrt( dataLength / TEXTURE_CONSTANTS.RGBA_COMPONENTS ) );
		const height = Math.ceil( dataLength / ( TEXTURE_CONSTANTS.RGBA_COMPONENTS * width ) );
		const size = width * height * TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const data = this.getBuffer( size );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * 12;
			const node = nodes[ i ];

			// Vec4 1: boundsMin + leftChild
			data[ stride + 0 ] = node.boundsMin.x;
			data[ stride + 1 ] = node.boundsMin.y;
			data[ stride + 2 ] = node.boundsMin.z;
			data[ stride + 3 ] = node.leftChild !== null ? node.leftChild : - 1;

			// Vec4 2: boundsMax + rightChild
			data[ stride + 4 ] = node.boundsMax.x;
			data[ stride + 5 ] = node.boundsMax.y;
			data[ stride + 6 ] = node.boundsMax.z;
			data[ stride + 7 ] = node.rightChild !== null ? node.rightChild : - 1;

			// Vec4 3: triangleOffset, triangleCount, and padding
			data[ stride + 8 ] = node.triangleOffset;
			data[ stride + 9 ] = node.triangleCount;
			data[ stride + 10 ] = 0;
			data[ stride + 11 ] = 0;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;

		// Store the buffer for release when texture is disposed
		texture.userData = { buffer: data, bufferType: Float32Array };
		texture.addEventListener( 'dispose', () => {

			if ( texture.userData.buffer ) {

				this.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

		} );

		return texture;

	}

	// Clean up method to release all pooled resources
	dispose() {

		// Clear buffer pools
		this.bufferPool.clear();

		// Clear canvas pools
		this.canvasPool.canvases = [];
		this.canvasPool.contexts = [];

	}

}
