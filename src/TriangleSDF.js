import { Vector3, Vector2, DataTexture, DataArrayTexture, UnsignedByteType, RGBAFormat, FloatType, Color } from "three";

Vector3.prototype.toFixed = function ( num ) {

	this.x = parseFloat( this.x.toFixed( num ) );
	this.y = parseFloat( this.y.toFixed( num ) );
	this.z = parseFloat( this.z.toFixed( num ) );
	return this;

};

class BVHNode {

	constructor() {

		this.boundsMin = new Vector3();
		this.boundsMax = new Vector3();
		this.leftChild = null;
		this.rightChild = null;
		this.triangleOffset = 0;
		this.triangleCount = 0;

	}

}

export default class TriangleSDF {

	constructor( object ) {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.directionalLights = [];

		this.extractTrianglesFromMeshes( object );
		this.buildBVH();
		this.materialTexture = this.createMaterialDataTexture( this.materials );
		this.triangleTexture = this.createTriangleDataTexture( this.triangles );
		this.diffuseTextures = this.createAlbedoDataTexture( this.maps );
		this.bvhTexture = this.createBVHDataTexture();
		this.spheres = this.createSpheres();
		this.triangles = []; // Clear the original triangle array as we've rebuilt it in the BVH

	}

	createSpheres() {

		let white = new Color( 0xffffff );
		let black = new Color( 0x000000 );
		return [
			// { position: new Vector3( - 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( - 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

			// { position: new Vector3( 0, 2, 0 ), radius: 1, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

		];

	}

	extractTrianglesFromMeshes( object ) {

		const posA = new Vector3();
		const posB = new Vector3();
		const posC = new Vector3();
		const uvA = new Vector2();
		const uvB = new Vector2();
		const uvC = new Vector2();

		const normal = new Vector3();
		const tempNormal = new Vector3();

		object.traverse( obj => {

		  	if ( obj.isMesh ) {

				let materialIndex = this.materials.findIndex( x => x.uuid === obj.material.uuid );
				if ( materialIndex === - 1 ) {

					let albedoTextureIndex = - 1;
					if ( obj.material.map ) {

						albedoTextureIndex = this.maps.findIndex( x => x.source.uuid === obj.material.map.source.uuid );
						if ( albedoTextureIndex === - 1 ) {

							this.maps.push( obj.material.map );
							albedoTextureIndex = this.maps.length - 1;

						}

					}

					const emissive = obj.material.emissive ?? new Color( 0, 0, 0 );
					const isEmissive = emissive.r > 0 || emissive.g > 0 || emissive.b > 0 ? true : false;

					const material = {
						color: obj.material.color,
						emissive: emissive,
						emissiveIntensity: isEmissive ? obj.material.emissiveIntensity ?? 0 : 0,
						roughness: obj.material.roughness ?? 1.0,
						metalness: obj.material.metalness ?? 0.0,
						ior: obj.material.ior ?? 0.15,
						transmission: obj.material.transmission ?? 0.0,

						map: albedoTextureIndex === null ? - 1 : albedoTextureIndex
					};

					this.materials.push( material );
					materialIndex = this.materials.length - 1;

				}

				obj.updateMatrix();
				obj.updateMatrixWorld();

				const geometry = obj.geometry;
				const positions = geometry.attributes.position;
				const uvs = geometry.attributes.uv;
				const indices = geometry.index ? geometry.index.array : null;

				const triangleCount = indices ? indices.length / 3 : positions.count / 3;

				for ( let i = 0; i < triangleCount; i ++ ) {

					const i3 = i * 3;

					if ( indices ) {

						posA.fromBufferAttribute( positions, indices[ i3 + 0 ] );
						posB.fromBufferAttribute( positions, indices[ i3 + 1 ] );
						posC.fromBufferAttribute( positions, indices[ i3 + 2 ] );

						if ( uvs ) {

							uvA.fromBufferAttribute( uvs, indices[ i3 + 0 ] );
							uvB.fromBufferAttribute( uvs, indices[ i3 + 1 ] );
							uvC.fromBufferAttribute( uvs, indices[ i3 + 2 ] );

						}

					} else {

						posA.fromBufferAttribute( positions, i3 + 0 );
						posB.fromBufferAttribute( positions, i3 + 1 );
						posC.fromBufferAttribute( positions, i3 + 2 );

						if ( uvs ) {

							uvA.fromBufferAttribute( uvs, i3 + 0 );
							uvB.fromBufferAttribute( uvs, i3 + 1 );
							uvC.fromBufferAttribute( uvs, i3 + 2 );

						}

					}

					posA.applyMatrix4( obj.matrixWorld );
					posB.applyMatrix4( obj.matrixWorld );
					posC.applyMatrix4( obj.matrixWorld );

					tempNormal.crossVectors( posB.clone().sub( posA ), posC.clone().sub( posA ) ).normalize();
					normal.copy( tempNormal ).transformDirection( obj.matrixWorld );

					this.triangles.push( {
						posA: posA.clone(),
						posB: posB.clone(),
						posC: posC.clone(),
						normal: normal.clone(),
						uvA: uvA.clone(),
						uvB: uvB.clone(),
						uvC: uvC.clone(),
						materialIndex: materialIndex // Add this line
					} );

				}

			} else if ( obj.isDirectionalLight === true ) {

				this.directionalLights.push( obj );

			}

		} );

		console.log( "materials:", this.materials.length );
		console.log( "triangles:", this.triangles.length );
		console.log( "maps:", this.maps.length );

	}

	buildBVH( depth = 16 ) {

		const maxTrianglesPerLeaf = 6;
		const axis = [ 'x', 'y', 'z' ];

		// Stats variables
		let leafDepths = [];
		let leafTriangles = [];
		let nodeCount = 0;
		let leafCount = 0;

		const buildNode = ( triangles, depth = 0 ) => {

			nodeCount ++;
			const node = new BVHNode();

			// Compute bounds
			node.boundsMin.set( Infinity, Infinity, Infinity );
			node.boundsMax.set( - Infinity, - Infinity, - Infinity );
			triangles.forEach( tri => {

				node.boundsMin.min( tri.posA ).min( tri.posB ).min( tri.posC );
				node.boundsMax.max( tri.posA ).max( tri.posB ).max( tri.posC );

			} );

			if ( triangles.length <= maxTrianglesPerLeaf ) {

				node.triangleOffset = this.triangles.length;
				node.triangleCount = triangles.length;
				this.triangles.push( ...triangles );

				// Collect leaf statistics
				leafCount ++;
				leafDepths.push( depth );
				leafTriangles.push( triangles.length );

				return node;

			}

			// Split along the longest axis
			const splitAxis = axis[ depth % 3 ];
			triangles.sort( ( a, b ) => {

				const centroidA = ( a.posA[ splitAxis ] + a.posB[ splitAxis ] + a.posC[ splitAxis ] ) / 3;
				const centroidB = ( b.posA[ splitAxis ] + b.posB[ splitAxis ] + b.posC[ splitAxis ] ) / 3;
				return centroidA - centroidB;

			} );

			const mid = Math.floor( triangles.length / 2 );
			node.leftChild = buildNode( triangles.slice( 0, mid ), depth + 1 );
			node.rightChild = buildNode( triangles.slice( mid ), depth + 1 );

			return node;

		};

		// Start timing
		const startTime = performance.now();

		this.bvhRoot = buildNode( this.triangles, depth );

		// End timing
		const endTime = performance.now();

		// Calculate statistics
		// const minLeafDepth = Math.min( ...leafDepths );
		// const maxLeafDepth = Math.max( ...leafDepths );
		// const meanLeafDepth = leafDepths.reduce( ( a, b ) => a + b, 0 ) / leafDepths.length;

		// const minLeafTris = Math.min( ...leafTriangles );
		// const maxLeafTris = Math.max( ...leafTriangles );
		// const meanLeafTris = leafTriangles.reduce( ( a, b ) => a + b, 0 ) / leafTriangles.length;

		// // Log the stats
		console.log( 'Time (ms):', endTime - startTime );
		console.log( 'Triangles:', this.triangles.length );
		console.log( 'Node Count:', nodeCount );
		console.log( 'Leaf Count:', leafCount );
		// console.log( 'Leaf Depth - Min:', minLeafDepth );
		// console.log( 'Leaf Depth - Max:', maxLeafDepth );
		// console.log( 'Leaf Depth - Mean:', meanLeafDepth );
		// console.log( 'Leaf Tris - Min:', minLeafTris );
		// console.log( 'Leaf Tris - Max:', maxLeafTris );
		// console.log( 'Leaf Tris - Mean:', meanLeafTris );

	}

	createBVHDataTexture() {

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

		flattenBVH( this.bvhRoot );

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

			// Specular color
			data[ stride + 12 ] = 0;
			data[ stride + 13 ] = 0;
			data[ stride + 14 ] = 0;
			data[ stride + 15 ] = 0;

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
		const ctx = canvas.getContext( '2d' );

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

}
