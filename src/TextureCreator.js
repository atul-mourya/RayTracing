import { DataTexture, DataArrayTexture, RGBAFormat, FloatType, UnsignedByteType } from "three";

export default class TextureCreator {

	createMaterialDataTexture( materials ) {

		const dataLength = materials.length * 5 * 4; // 5 vec4s per material
		const width = Math.ceil( Math.sqrt( dataLength ) );
		const height = Math.ceil( dataLength / width );
		const size = width * height * 4;
		const data = new Float32Array( size );

		for ( let i = 0; i < materials.length; i ++ ) {

			const stride = i * 5 * 4;
			const mat = materials[ i ];

			// Color and map
			data[ stride + 0 ] = mat.color.r;
			data[ stride + 1 ] = mat.color.g;
			data[ stride + 2 ] = mat.color.b;
			data[ stride + 3 ] = mat.map; // Texture index or -1

			// Emissive and emissive intensity
			data[ stride + 4 ] = mat.emissive.r;
			data[ stride + 5 ] = mat.emissive.g;
			data[ stride + 6 ] = mat.emissive.b;
			data[ stride + 7 ] = mat.emissiveIntensity;

			// Roughness, metalness, specular probability
			data[ stride + 8 ] = mat.roughness;
			data[ stride + 9 ] = mat.metalness;
			data[ stride + 10 ] = mat.roughnessMap;
			data[ stride + 11 ] = mat.metalnessMap;

			data[ stride + 12 ] = mat.ior;
			data[ stride + 13 ] = mat.thickness;
			data[ stride + 14 ] = mat.transmission;
			data[ stride + 15 ] = mat.emissiveMap;

			data[ stride + 16 ] = mat.normalMap;
			data[ stride + 17 ] = mat.bumpMap;
			data[ stride + 18 ] = mat.clearCoat;
			data[ stride + 19 ] = mat.clearCoatRoughness;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
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

		// Get the maximum texture size supported by the GPU
		const maxTextureSize = renderer.capabilities.maxTextureSize;

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
		while ( maxWidth > maxTextureSize || maxHeight > maxTextureSize ) {

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
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;

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
