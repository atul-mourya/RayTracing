import { Vector3, Vector2, Color, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide } from "three";
import { TRIANGLE_DATA_LAYOUT } from '../../Constants.js';

const MAX_TEXTURES_LIMIT = 128;

export default class GeometryExtractor {

	constructor() {

		// Object pools for reusing objects
		this._vectorPool = {
			vec3: Array( 9 ).fill().map( () => new Vector3() ),
			vec2: Array( 6 ).fill().map( () => new Vector2() )
		};

		this._matrixPool = {
			mat3: new Matrix3(),
			mat4: new Matrix4()
		};

		// Arrays to store extracted data
		this.resetArrays();

		// Triangle tracking
		this.triangleCount = 0;
		this.currentTriangleIndex = 0;

	}

	// Get a Vector3 from the pool
	_getVec3( index = 0 ) {

		return this._vectorPool.vec3[ index % this._vectorPool.vec3.length ];

	}

	// Get a Vector2 from the pool
	_getVec2( index = 0 ) {

		return this._vectorPool.vec2[ index % this._vectorPool.vec2.length ];

	}

	extract( object ) {

		this.resetArrays();

		// First pass: count triangles to pre-allocate Float32Array
		this.triangleCount = this.countTriangles( object );
		console.log( `Pre-allocating for ${this.triangleCount} triangles (texture-aligned format)` );

		// Allocate Float32Array for all triangle data (texture-ready format)
		this.triangleData = new Float32Array( this.triangleCount * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );
		this.currentTriangleIndex = 0;

		// Second pass: extract geometry
		this.traverseObject( object );

		this.logStats();
		return this.getExtractedData();

	}

	countTriangles( object ) {

		let count = 0;

		const countInObject = ( obj ) => {

			if ( obj.isMesh && obj.geometry ) {

				const geometry = obj.geometry;
				const positions = geometry.attributes.position;

				if ( positions ) {

					const indices = geometry.index ? geometry.index.array : null;
					count += indices ? indices.length / 3 : positions.count / 3;

				}

			}

			if ( obj.children ) {

				for ( const child of obj.children ) {

					countInObject( child );

				}

			}

		};

		countInObject( object );
		return Math.floor( count );

	}

	traverseObject( object ) {

		// Process the current object
		if ( object.isMesh ) {

			this.processMesh( object );

		} else if ( object.isDirectionalLight ) {

			this.directionalLights.push( object );

		} else if ( object.isCamera ) {

			this.cameras.push( object );

		}

		// Process children recursively
		if ( object.children ) {

			for ( const child of object.children ) {

				this.traverseObject( child );

			}

		}

	}

	processMesh( mesh ) {

		if ( ! mesh.geometry || ! mesh.material ) {

			console.warn( 'Skipping mesh with missing geometry or material:', mesh );
			return;

		}

		// Process material and get its index
		const materialIndex = this.processMaterial( mesh.material );
		mesh.userData.materialIndex = materialIndex;

		// Extract geometry
		this.extractGeometry( mesh, materialIndex );

	}

	processMaterial( material ) {

		// Check if material already exists in our array
		let materialIndex = this.materials.findIndex( x => x.uuid === material.uuid );
		if ( materialIndex === - 1 ) {

			// Force enable depth write if it's disabled
			if ( material.depthWrite === false ) {

				material.depthWrite = true;
				console.warn( "Depth write is disabled in material, enabling it for rastered rendering" );

			}

			// Create a new material object and add it to the array
			const newMaterial = this.createMaterialObject( material );
			this.materials.push( newMaterial );
			materialIndex = this.materials.length - 1;

		}

		return materialIndex;

	}

	getMaterialAlphaMode( material ) {

		if ( material.transparent ) return 2; // 'BLEND'
		if ( material.alphaTest > 0.0 ) return 1; // 'MASK'
		return 0; // 'OPAQUE'

	}

	createMaterialObject( material ) {

		// Create default values for missing properties
		const defaultValues = {
			emissive: new Color( 0, 0, 0 ),
			attenuationColor: new Color( 0xffffff ),
			attenuationDistance: 1e20,
			dispersion: 0.0,
			sheen: 0.0,
			sheenRoughness: 1,
			sheenColor: new Color( 0x000000 ),
			specularIntensity: 1.0,
			specularColor: new Color( 0xffffff ),
			iridescence: 0.0,
			iridescenceIOR: 1.0,
			iridescenceThicknessRange: [ 100, 400 ],
			roughness: 1.0,
			metalness: 0.0,
			ior: 0,
			opacity: 1.0,
			transmission: 0.0,
			thickness: 0.1,
			clearcoat: 0.0,
			clearcoatRoughness: 0.0,
			normalScale: { x: 1, y: 1 },
			bumpScale: 1,
			alphaTest: 0.0
		};

		// Create material object, using defaults for missing properties
		return {
			uuid: material.uuid,
			color: material.color,
			emissive: material.emissive || defaultValues.emissive,
			emissiveIntensity: material.emissiveIntensity || 1.0,
			roughness: material.roughness ?? defaultValues.roughness,
			metalness: material.metalness ?? defaultValues.metalness,
			ior: material.ior ?? defaultValues.ior,
			opacity: material.opacity ?? defaultValues.opacity,
			transmission: material.transmission ?? defaultValues.transmission,
			attenuationColor: material.attenuationColor ?? defaultValues.attenuationColor,
			attenuationDistance: material.attenuationDistance ?? defaultValues.attenuationDistance,
			dispersion: material.dispersion ?? defaultValues.dispersion,
			sheen: material.sheen ?? defaultValues.sheen,
			sheenRoughness: material.sheenRoughness ?? defaultValues.sheenRoughness,
			sheenColor: material.sheenColor ?? defaultValues.sheenColor,
			specularIntensity: material.specularIntensity ?? defaultValues.specularIntensity,
			specularColor: material.specularColor ?? defaultValues.specularColor,
			thickness: material.thickness ?? defaultValues.thickness,
			clearcoat: material.clearcoat ?? defaultValues.clearcoat,
			clearcoatRoughness: material.clearcoatRoughness ?? defaultValues.clearcoatRoughness,
			iridescence: material.iridescence ?? defaultValues.iridescence,
			iridescenceIOR: material.iridescenceIOR ?? defaultValues.iridescenceIOR,
			iridescenceThicknessRange: material.iridescenceThicknessRange ?? defaultValues.iridescenceThicknessRange,
			side: this.getMaterialSide( material ),
			normalScale: material.normalScale ?? defaultValues.normalScale,
			bumpScale: material.bumpScale ?? defaultValues.bumpScale,
			transparent: material.transparent ? 1 : 0,
			alphaTest: material.alphaTest ?? defaultValues.alphaTest,
			alphaMode: this.getMaterialAlphaMode( material ),
			depthWrite: material.depthWrite ? 1 : 0,
			visible: material.visible ? 1 : 0,

			// Process textures
			map: this.processTexture( material.map, this.maps ),
			normalMap: this.processTexture( material.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( material.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( material.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( material.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( material.emissiveMap, this.emissiveMaps ),
			clearcoatMap: this.processTexture( material.clearcoatMap, [] ),
			clearcoatRoughnessMap: this.processTexture( material.clearcoatRoughnessMap, [] ),

			// Process texture matrices
			mapMatrix: this.getTextureMatrix( material.map ),
			normalMapMatrices: this.getTextureMatrix( material.normalMap ),
			bumpMapMatrices: this.getTextureMatrix( material.bumpMap ),
			roughnessMapMatrices: this.getTextureMatrix( material.roughnessMap ),
			metalnessMapMatrices: this.getTextureMatrix( material.metalnessMap ),
			emissiveMapMatrices: this.getTextureMatrix( material.emissiveMap ),
		};

	}

	getTextureMatrix( texture ) {

		if ( ! texture ) return new Matrix3().elements;
		texture.updateMatrix();
		return texture.matrix.elements;

	}

	getMaterialSide( material ) {

		if ( material.transmission > 0.0 ) return 2;
		switch ( material.side ) {

			case FrontSide: return 0;
			case BackSide: return 1;
			case DoubleSide: return 2;
			default: return 0;

		}

	}

	processTexture( texture, textureArray ) {

		if ( ! texture ) return - 1;
		let textureIndex = textureArray.length === 0 ? - 1 : textureArray.findIndex( x => x.source.uuid === texture.source.uuid );
		if ( textureIndex === - 1 && textureArray.length < MAX_TEXTURES_LIMIT ) {

			textureArray.push( texture );
			return textureArray.length - 1;

		}

		return textureIndex;

	}

	extractGeometry( mesh, materialIndex ) {

		mesh.updateMatrix();
		mesh.updateMatrixWorld();

		const geometry = mesh.geometry;
		if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
		const positions = geometry.attributes.position;
		const normals = geometry.attributes.normal;
		const uvs = geometry.attributes.uv;
		const indices = geometry.index ? geometry.index.array : null;

		// Compute matrices
		this._matrixPool.mat4.copy( mesh.matrixWorld );
		this._matrixPool.mat3.getNormalMatrix( this._matrixPool.mat4 );

		const triangleCount = indices ? indices.length / 3 : positions.count / 3;

		// Extract triangles
		this.extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex );

	}

	// triangle extraction that stores directly in texture format
	extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex ) {

		// Pre-allocate objects for positions, normals, and UVs
		const posA = this._getVec3( 0 );
		const posB = this._getVec3( 1 );
		const posC = this._getVec3( 2 );

		const normalA = this._getVec3( 3 );
		const normalB = this._getVec3( 4 );
		const normalC = this._getVec3( 5 );

		const uvA = this._getVec2( 0 );
		const uvB = this._getVec2( 1 );
		const uvC = this._getVec2( 2 );

		// Batch process triangles to avoid excessive function calls
		for ( let i = 0; i < triangleCount; i ++ ) {

			if ( this.currentTriangleIndex >= this.triangleCount ) {

				console.warn( 'Triangle count exceeded pre-allocated size' );
				break;

			}

			const i3 = i * 3;

			// Get vertices
			if ( indices ) {

				this.getVertexFromIndices( positions, indices[ i3 + 0 ], posA );
				this.getVertexFromIndices( positions, indices[ i3 + 1 ], posB );
				this.getVertexFromIndices( positions, indices[ i3 + 2 ], posC );

				this.getVertexFromIndices( normals, indices[ i3 + 0 ], normalA );
				this.getVertexFromIndices( normals, indices[ i3 + 1 ], normalB );
				this.getVertexFromIndices( normals, indices[ i3 + 2 ], normalC );

				if ( uvs ) {

					this.getVertexFromIndices( uvs, indices[ i3 + 0 ], uvA );
					this.getVertexFromIndices( uvs, indices[ i3 + 1 ], uvB );
					this.getVertexFromIndices( uvs, indices[ i3 + 2 ], uvC );

				} else {

					uvA.set( 0, 0 );
					uvB.set( 0, 0 );
					uvC.set( 0, 0 );

				}

			} else {

				this.getVertex( positions, i3 + 0, posA );
				this.getVertex( positions, i3 + 1, posB );
				this.getVertex( positions, i3 + 2, posC );

				this.getVertex( normals, i3 + 0, normalA );
				this.getVertex( normals, i3 + 1, normalB );
				this.getVertex( normals, i3 + 2, normalC );

				if ( uvs ) {

					this.getVertex( uvs, i3 + 0, uvA );
					this.getVertex( uvs, i3 + 1, uvB );
					this.getVertex( uvs, i3 + 2, uvC );

				} else {

					uvA.set( 0, 0 );
					uvB.set( 0, 0 );
					uvC.set( 0, 0 );

				}

			}

			// Apply world transformation
			posA.applyMatrix4( this._matrixPool.mat4 );
			posB.applyMatrix4( this._matrixPool.mat4 );
			posC.applyMatrix4( this._matrixPool.mat4 );

			normalA.applyMatrix3( this._matrixPool.mat3 ).normalize();
			normalB.applyMatrix3( this._matrixPool.mat3 ).normalize();
			normalC.applyMatrix3( this._matrixPool.mat3 ).normalize();

			// Pack triangle datas
			this.packTriangleDataTextureFormat(
				this.currentTriangleIndex,
				posA, posB, posC,
				normalA, normalB, normalC,
				uvA, uvB, uvC,
				materialIndex
			);

			this.currentTriangleIndex ++;

		}

	}

	// Pack triangle data directly in texture format (32 floats with vec4 alignment)
	packTriangleDataTextureFormat( triangleIndex, posA, posB, posC, normalA, normalB, normalC, uvA, uvB, uvC, materialIndex ) {

		const offset = triangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

		// Positions as vec4s (3 vec4s = 12 floats)
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ] = posA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = posA.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = posA.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 3 ] = 0; // vec4 padding

		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ] = posB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = posB.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = posB.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 3 ] = 0; // vec4 padding

		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ] = posC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = posC.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = posC.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 3 ] = 0; // vec4 padding

		// Normals as vec4s (3 vec4s = 12 floats)
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ] = normalA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ] = normalA.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ] = normalA.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 3 ] = 0; // vec4 padding

		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ] = normalB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ] = normalB.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ] = normalB.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 3 ] = 0; // vec4 padding

		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ] = normalC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ] = normalC.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ] = normalC.z;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 3 ] = 0; // vec4 padding

		// UVs and material index (2 vec4s = 8 floats)
		// First vec4: uvA.x, uvA.y, uvB.x, uvB.y
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 0 ] = uvA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 1 ] = uvA.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 2 ] = uvB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET + 3 ] = uvB.y;

		// Second vec4: uvC.x, uvC.y, materialIndex, padding
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 0 ] = uvC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 1 ] = uvC.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 2 ] = materialIndex;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 3 ] = 0; // vec4 padding

	}

	// Get the raw Float32Array (optimal for worker transfer and zero-copy textures)
	getTriangleData() {

		// Return only the used portion of the array
		return this.triangleData.subarray( 0, this.currentTriangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );

	}

	// Get triangle count
	getTriangleCount() {

		return this.currentTriangleIndex;

	}

	// Optimized attribute access methods
	getVertexFromIndices( attribute, index, target ) {

		if ( attribute.itemSize === 2 ) {

			target.x = attribute.array[ index * 2 ];
			target.y = attribute.array[ index * 2 + 1 ];

		} else if ( attribute.itemSize === 3 ) {

			target.x = attribute.array[ index * 3 ];
			target.y = attribute.array[ index * 3 + 1 ];
			target.z = attribute.array[ index * 3 + 2 ];

		}

		return target;

	}

	getVertex( attribute, index, target ) {

		if ( attribute.itemSize === 2 ) {

			target.x = attribute.array[ index * 2 ];
			target.y = attribute.array[ index * 2 + 1 ];

		} else if ( attribute.itemSize === 3 ) {

			target.x = attribute.array[ index * 3 ];
			target.y = attribute.array[ index * 3 + 1 ];
			target.z = attribute.array[ index * 3 + 2 ];

		}

		return target;

	}

	logStats() {

		console.log( "materials:", this.materials.length );
		console.log( "triangles:", this.currentTriangleIndex );
		console.log( "triangle data size (MB):", ( this.triangleData.byteLength / ( 1024 * 1024 ) ).toFixed( 2 ) );
		console.log( "maps:", this.maps.length );

	}

	resetArrays() {

		// Reset triangle data
		this.triangleData = null;
		this.triangleCount = 0;
		this.currentTriangleIndex = 0;

		// Reset other arrays
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.roughnessMaps = [];
		this.directionalLights = [];
		this.cameras = [];

	}

	getExtractedData() {

		return {
			triangleData: this.getTriangleData(), // Texture-ready Float32Array format
			triangleCount: this.getTriangleCount(),
			materials: this.materials,
			maps: this.maps,
			normalMaps: this.normalMaps,
			bumpMaps: this.bumpMaps,
			metalnessMaps: this.metalnessMaps,
			emissiveMaps: this.emissiveMaps,
			roughnessMaps: this.roughnessMaps,
			directionalLights: this.directionalLights,
			cameras: this.cameras
		};

	}

}

// Export the data layout constants
export { TRIANGLE_DATA_LAYOUT };
