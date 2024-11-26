import { WebGLRenderer, DataTexture, DataArrayTexture, RGBAFormat, LinearFilter, FloatType, UnsignedByteType } from "three";

const maxTextureSize = new WebGLRenderer().capabilities.maxTextureSize;
const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

export default class TextureCreator {

	createMaterialDataTexture( materials ) {

		const pixelsRequired = 19; // Pixels needed per material
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
				mat.map, 					mat.normalMap, 				mat.roughnessMap, 			mat.metalnessMap,			// pixel 4 - Map indices and properties
				mat.emissiveMap, 			mat.bumpMap, 				mat.clearcoat, 				mat.clearcoatRoughness,		// pixel 5 - More map indices and properties
				mat.opacity, 				mat.side, 					mat.transparent, 			mat.alphaTest,				// pixel 6 - Opacity, side, transparency, and alpha test
				mat.alphaMode, 				mat.alphaCutoff, 			mat.normalScale?.x ?? 1, 	mat.normalScale?.y ?? 1,	// pixel 8 - Opacity, side, and normal scale
				mapMatrix[ 0 ], 			mapMatrix[ 1 ], 			mapMatrix[ 2 ], 			mapMatrix[ 3 ],				// pixel 8 - Map matrices - 1
				mapMatrix[ 4 ], 			mapMatrix[ 5 ], 			mapMatrix[ 6 ], 			1,							// pixel 9 - Map matrices - 2
				normalMapMatrices[ 0 ], 	normalMapMatrices[ 1 ], 	normalMapMatrices[ 2 ], 	normalMapMatrices[ 3 ],		// pixel 10 - Normal matrices - 1
				normalMapMatrices[ 4 ], 	normalMapMatrices[ 5 ], 	normalMapMatrices[ 6 ], 	1,							// pixel 11 - Normal matrices - 2
				roughnessMapMatrices[ 0 ], 	roughnessMapMatrices[ 1 ], 	roughnessMapMatrices[ 2 ], 	roughnessMapMatrices[ 3 ],	// pixel 12 - Roughness matrices - 1
				roughnessMapMatrices[ 4 ], 	roughnessMapMatrices[ 5 ], 	roughnessMapMatrices[ 6 ], 	1,							// pixel 13 - Roughness matrices - 2
				metalnessMapMatrices[ 0 ], 	metalnessMapMatrices[ 1 ], 	metalnessMapMatrices[ 2 ], 	metalnessMapMatrices[ 3 ], 	// pixel 14 - Metalness matrices - 1
				metalnessMapMatrices[ 4 ], 	metalnessMapMatrices[ 5 ], 	metalnessMapMatrices[ 6 ], 	1,							// pixel 15 - Metalness matrices - 2
				emissiveMapMatrices[ 0 ], 	emissiveMapMatrices[ 1 ], 	emissiveMapMatrices[ 2 ], 	emissiveMapMatrices[ 3 ],	// pixel 16 - Emissive matrices - 1
				emissiveMapMatrices[ 4 ], 	emissiveMapMatrices[ 5 ], 	emissiveMapMatrices[ 6 ], 	1,							// pixel 17 - Emissive matrices - 2
				bumpMapMatrices[ 0 ], 		bumpMapMatrices[ 1 ], 		bumpMapMatrices[ 2 ], 		bumpMapMatrices[ 3 ],		// pixel 18 - Bump map matrices - 1
				bumpMapMatrices[ 4 ], 		bumpMapMatrices[ 5 ],	 	bumpMapMatrices[ 6 ], 		1,							// pixel 19 - Bump map matrices - 2
			];

			data.set( materialData, stride );

		}

		const texture = new DataTexture( data, bestWidth, bestHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createTriangleDataTexture( triangles ) {

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

	createTexturesToDataTexture( textures ) {

		if ( textures.length == 0 ) return null;

		// Determine the maximum dimensions among all textures
		let maxWidth = 0;
		let maxHeight = 0;
		for ( let map of textures ) {

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
		const depth = textures.length;
		const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

		// Canvas for resizing textures
		const canvas = document.createElement( 'canvas' );
		canvas.width = maxWidth;
		canvas.height = maxHeight;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		// Fill the 3D texture data
		for ( let i = 0; i < textures.length; i ++ ) {

			const map = textures[ i ];

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

		return texture;

	}

	createBVHDataTexture( bvhRoot ) {

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
