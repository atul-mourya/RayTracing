import { DataTexture, DataArrayTexture, RGBAFormat, FloatType, UnsignedByteType } from "three";

export default class TextureCreator {

	createMaterialDataTexture( materials ) {

		const dataLength = materials.length * 4 * 4; // 4 vec4s per material
		const width = Math.ceil( Math.sqrt( dataLength / 4 ) );
		const height = Math.ceil( dataLength / ( 4 * width ) );
		const size = width * height * 4;
		const data = new Float32Array( size );

		for ( let i = 0; i < materials.length; i ++ ) {

			const stride = i * 16;
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
			data[ stride + 10 ] = mat.ior;
			data[ stride + 11 ] = mat.transmission;


			data[ stride + 12 ] = mat.thickness;
			data[ stride + 13 ] = 0;
			data[ stride + 14 ] = 0;
			data[ stride + 15 ] = 0;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createTriangleDataTexture( triangles ) {

		// Each triangle has 3 vertices, each vertex has 4 components (x, y, z, w)
		const dataLength = triangles.length * 6 * 4; // 3 vertices * 4 components each

		// Calculate dimensions
		const width = Math.ceil( Math.sqrt( dataLength ) ); // Divide by 4 because RGBA (4 components)
		const height = Math.ceil( dataLength / width );

		const size = width * height * 4; // Total size in terms of RGBA components
		const data = new Float32Array( size );

		for ( let i = 0; i < triangles.length; i ++ ) {

			const stride = i * 6 * 4;
			data[ stride + 0 ] = triangles[ i ].posA.x;
			data[ stride + 1 ] = triangles[ i ].posA.y;
			data[ stride + 2 ] = triangles[ i ].posA.z;
			data[ stride + 3 ] = triangles[ i ].normal.x;

			data[ stride + 4 ] = triangles[ i ].posB.x;
			data[ stride + 5 ] = triangles[ i ].posB.y;
			data[ stride + 6 ] = triangles[ i ].posB.z;
			data[ stride + 7 ] = triangles[ i ].normal.y;

			data[ stride + 8 ] = triangles[ i ].posC.x;
			data[ stride + 9 ] = triangles[ i ].posC.y;
			data[ stride + 10 ] = triangles[ i ].posC.z;
			data[ stride + 11 ] = triangles[ i ].normal.z;

			data[ stride + 12 ] = triangles[ i ].uvA.x;
			data[ stride + 13 ] = triangles[ i ].uvA.y;
			data[ stride + 14 ] = 0;
			data[ stride + 15 ] = 0;

			data[ stride + 16 ] = triangles[ i ].uvB.x;
			data[ stride + 17 ] = triangles[ i ].uvB.y;
			data[ stride + 18 ] = 0;
			data[ stride + 19 ] = 0;

			data[ stride + 20 ] = triangles[ i ].uvC.x;
			data[ stride + 21 ] = triangles[ i ].uvC.y;
			data[ stride + 22 ] = triangles[ i ].materialIndex;
			data[ stride + 23 ] = 0;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createAlbedoDataTexture( diffuseMaps ) {

		// Determine the maximum dimensions among all textures
		let maxWidth = 0;
		let maxHeight = 0;
		for ( let map of diffuseMaps ) {

			maxWidth = Math.max( maxWidth, map.image.width );
			maxHeight = Math.max( maxHeight, map.image.height );

		}

		// Round up to the nearest power of 2
		maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
		maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

		// Create a 3D data array
		const depth = diffuseMaps.length;
		const data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

		// Canvas for resizing textures
		const canvas = document.createElement( 'canvas' );
		canvas.width = maxWidth;
		canvas.height = maxHeight;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		// Fill the 3D texture data
		for ( let i = 0; i < diffuseMaps.length; i ++ ) {

			const map = diffuseMaps[ i ];

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
