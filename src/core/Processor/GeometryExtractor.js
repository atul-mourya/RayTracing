import {
	Vector3, Vector2, Color, Matrix3, Matrix4, MeshPhysicalMaterial,
	FrontSide, BackSide, DoubleSide, BufferAttribute
} from "three";

const MAX_TEXTURES_LIMIT = 128;

// Constants for triangle data layout in Float32Array
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 25, // 3*3 positions + 3*3 normals + 3*2 uvs + 1 materialIndex
	POSITION_A_OFFSET: 0, // 3 floats: x, y, z
	POSITION_B_OFFSET: 3, // 3 floats: x, y, z
	POSITION_C_OFFSET: 6, // 3 floats: x, y, z
	NORMAL_A_OFFSET: 9, // 3 floats: x, y, z
	NORMAL_B_OFFSET: 12, // 3 floats: x, y, z
	NORMAL_C_OFFSET: 15, // 3 floats: x, y, z
	UV_A_OFFSET: 18, // 2 floats: x, y
	UV_B_OFFSET: 20, // 2 floats: x, y
	UV_C_OFFSET: 22, // 2 floats: x, y
	MATERIAL_INDEX_OFFSET: 24 // 1 float: materialIndex
};

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
		console.log( `Pre-allocating for ${this.triangleCount} triangles` );

		// Allocate Float32Array for all triangle data
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

	// More efficient triangle extraction that processes triangles in batches
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

			// Pack triangle data into Float32Array
			this.packTriangleData(
				this.currentTriangleIndex,
				posA, posB, posC,
				normalA, normalB, normalC,
				uvA, uvB, uvC,
				materialIndex
			);

			this.currentTriangleIndex ++;

		}

	}

	// Pack triangle data into Float32Array at specified index
	packTriangleData( triangleIndex, posA, posB, posC, normalA, normalB, normalC, uvA, uvB, uvC, materialIndex ) {

		const offset = triangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

		// Position A
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ] = posA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = posA.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = posA.z;

		// Position B
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ] = posB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = posB.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = posB.z;

		// Position C
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ] = posC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = posC.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = posC.z;

		// Normal A
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ] = normalA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ] = normalA.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ] = normalA.z;

		// Normal B
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ] = normalB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ] = normalB.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ] = normalB.z;

		// Normal C
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ] = normalC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ] = normalC.y;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ] = normalC.z;

		// UV A
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 0 ] = uvA.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 1 ] = uvA.y;

		// UV B
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 0 ] = uvB.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 1 ] = uvB.y;

		// UV C
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 0 ] = uvC.x;
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 1 ] = uvC.y;

		// Material Index
		this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.MATERIAL_INDEX_OFFSET ] = materialIndex;

	}

	// Unpack triangle data from Float32Array at specified index
	getTriangle( triangleIndex ) {

		if ( triangleIndex < 0 || triangleIndex >= this.currentTriangleIndex ) {

			throw new Error( `Triangle index ${triangleIndex} out of bounds` );

		}

		const offset = triangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

		return {
			posA: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ]
			},
			posB: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ]
			},
			posC: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ]
			},
			normalA: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ]
			},
			normalB: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ]
			},
			normalC: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ],
				z: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ]
			},
			uvA: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_A_OFFSET + 1 ]
			},
			uvB: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_B_OFFSET + 1 ]
			},
			uvC: {
				x: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 0 ],
				y: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.UV_C_OFFSET + 1 ]
			},
			materialIndex: this.triangleData[ offset + TRIANGLE_DATA_LAYOUT.MATERIAL_INDEX_OFFSET ]
		};

	}

	// Get all triangles as an array of objects (for compatibility)
	getTrianglesAsObjects() {

		const triangles = [];
		for ( let i = 0; i < this.currentTriangleIndex; i ++ ) {

			triangles.push( this.getTriangle( i ) );

		}

		return triangles;

	}

	// Get the raw Float32Array (optimal for worker transfer)
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
			// Return both formats for compatibility
			triangles: this.getTrianglesAsObjects(), // Compatibility format
			triangleData: this.getTriangleData(), // Efficient Float32Array format
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

// Export the data layout constants for use in other modules
export { TRIANGLE_DATA_LAYOUT };
