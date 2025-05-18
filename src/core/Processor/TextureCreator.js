// TextureCreator.js
import { WebGLRenderer, DataTexture, DataArrayTexture, RGBAFormat, LinearFilter, FloatType, UnsignedByteType } from "three";

const maxTextureSize = new WebGLRenderer().capabilities.maxTextureSize;
const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

export default class TextureCreator {

	constructor() {

		this.useWorkers = typeof Worker !== 'undefined';
		// Limit concurrent workers (adjust based on your needs)
		this.maxConcurrentWorkers = 4;
		this.maxConcurrentWorkers = Math.min( navigator.hardwareConcurrency || 4, 4 );
		this.activeWorkers = 0;

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
			if ( triangles?.length ) {

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

				const texture = new DataTexture(
					new Float32Array( result.data ),
					result.width,
					result.height,
					RGBAFormat,
					FloatType
				);
				texture.needsUpdate = true;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed, falling back to synchronous operation:', error );
				return this.createMaterialDataTextureSync( materials );

			}

		}

		return this.createMaterialDataTextureSync( materials );

	}

	async createTriangleDataTexture( triangles ) {

		if ( this.useWorkers ) {

			try {

				const worker = new Worker(
					new URL( './Workers/TriangleTextureWorker.js', import.meta.url ),
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
					worker.postMessage( { triangles } );

				} );

				worker.terminate();

				const texture = new DataTexture(
					new Float32Array( result.data ),
					result.width,
					result.height,
					RGBAFormat,
					FloatType
				);
				texture.needsUpdate = true;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed, falling back to synchronous operation:', error );
				return this.createTriangleDataTextureSync( triangles );

			}

		}

		return this.createTriangleDataTextureSync( triangles );

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

				const texture = new DataArrayTexture(
					new Uint8Array( result.data ),
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

				console.warn( 'Worker creation failed, falling back to synchronous operation:', error );
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

				const texture = new DataTexture(
					new Float32Array( result.data ),
					result.width,
					result.height,
					RGBAFormat,
					FloatType
				);
				texture.needsUpdate = true;
				return texture;

			} catch ( error ) {

				console.warn( 'Worker creation failed, falling back to synchronous operation:', error );
				return this.createBVHDataTextureSync( bvhRoot );

			}

		}

		return this.createBVHDataTextureSync( bvhRoot );

	}

	// Helper method to get image data
	getImageData( image ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = image.width;
		canvas.height = image.height;
		const ctx = canvas.getContext( '2d' );
		ctx.drawImage( image, 0, 0 );
		return ctx.getImageData( 0, 0, image.width, image.height ).data;

	}

	createMaterialDataTextureSync( materials ) {

		const pixelsRequired = 24; // 24 pixels per material
		const dataInEachPixel = 4; // RGBA components
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const totalMaterials = materials.length;

		// Calculate the optimal dimensions
		// Strategy: Find the smallest power of 2 width that minimizes unused space
		const totalPixels = pixelsRequired * totalMaterials;
		let bestWidth = 4; // Start with minimum reasonable width
		let bestHeight = Math.ceil( totalPixels / 4 );
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
		return texture;

	}

	createTriangleDataTextureSync( triangles ) {

		const vec4PerTriangle = 3 + 3 + 2; // 3 vec4s for positions, 3 for normals, 2 for UVs and material index
		const floatsPerTriangle = vec4PerTriangle * 4; // Each vec4 contains 4 floats
		const dataLength = triangles.length * floatsPerTriangle;

		// Calculate dimensions for a square-like texture
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( width * 4 ) );

		// Create the data array
		const size = width * height * 4; // Total size in floats
		const data = new Float32Array( size );

		for ( let i = 0; i < triangles.length; i ++ ) {

			const stride = i * floatsPerTriangle;
			const tri = triangles[ i ];

			// Store positions (3 vec4s)
			data[ stride + 0 ] = tri.posA.x; data[ stride + 1 ] = tri.posA.y; data[ stride + 2 ] = tri.posA.z; data[ stride + 3 ] = 0;
			data[ stride + 4 ] = tri.posB.x; data[ stride + 5 ] = tri.posB.y; data[ stride + 6 ] = tri.posB.z; data[ stride + 7 ] = 0;
			data[ stride + 8 ] = tri.posC.x; data[ stride + 9 ] = tri.posC.y; data[ stride + 10 ] = tri.posC.z; data[ stride + 11 ] = 0;

			// Store normals (3 vec4s)
			data[ stride + 12 ] = tri.normalA.x; data[ stride + 13 ] = tri.normalA.y; data[ stride + 14 ] = tri.normalA.z; data[ stride + 15 ] = 0;
			data[ stride + 16 ] = tri.normalB.x; data[ stride + 17 ] = tri.normalB.y; data[ stride + 18 ] = tri.normalB.z; data[ stride + 19 ] = 0;
			data[ stride + 20 ] = tri.normalC.x; data[ stride + 21 ] = tri.normalC.y; data[ stride + 22 ] = tri.normalC.z; data[ stride + 23 ] = 0;

			// Store UVs (2 vec4s)
			// First vec4: UV coordinates for vertices A and B
			data[ stride + 24 ] = tri.uvA.x; data[ stride + 25 ] = tri.uvA.y; data[ stride + 26 ] = tri.uvB.x; data[ stride + 27 ] = tri.uvB.y;
			// Second vec4: UV coordinates for vertex C, material index, and a padding value
			data[ stride + 28 ] = tri.uvC.x; data[ stride + 29 ] = tri.uvC.y; data[ stride + 30 ] = tri.materialIndex; data[ stride + 31 ] = 0;

		}

		// Create and return the DataTexture
		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
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
		const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

		// Canvas for resizing textures
		const canvas = document.createElement( 'canvas' );
		canvas.width = maxWidth;
		canvas.height = maxHeight;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

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

		// Create and return the 3D texture
		const texture = new DataArrayTexture( data, maxWidth, maxHeight, depth );
		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

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

		const dataLength = nodes.length * 4 * 4; // 4 vec4s per node
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( 4 * width ) );
		const size = width * height * 4;
		const data = new Float32Array( size );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * 16;
			const node = nodes[ i ];
			data[ stride + 0 ] = node.boundsMin.x;
			data[ stride + 1 ] = node.boundsMin.y;
			data[ stride + 2 ] = node.boundsMin.z;
			data[ stride + 3 ] = node.leftChild !== null ? node.leftChild : - 1;

			data[ stride + 4 ] = node.boundsMax.x;
			data[ stride + 5 ] = node.boundsMax.y;
			data[ stride + 6 ] = node.boundsMax.z;
			data[ stride + 7 ] = node.rightChild !== null ? node.rightChild : - 1;

			data[ stride + 8 ] = node.triangleOffset;
			data[ stride + 9 ] = node.triangleCount;
			data[ stride + 10 ] = 0;
			data[ stride + 11 ] = 0;

			// You can use the remaining 4 floats for additional data if needed
			data[ stride + 12 ] = 0;
			data[ stride + 13 ] = 0;
			data[ stride + 14 ] = 0;
			data[ stride + 15 ] = 0;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

}
