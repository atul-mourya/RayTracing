import { Vector3, Vector2, Color, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide, RGBAFormat } from "three";
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

		// Follow glTF 2.0 specification for alphaMode
		// Check if material explicitly sets alphaMode (from glTF loader)
		if ( material.userData?.gltfExtensions?.KHR_materials_unlit?.alphaMode ) {

			const mode = material.userData.gltfExtensions.KHR_materials_unlit.alphaMode;
			if ( mode === 'BLEND' ) return 2;
			if ( mode === 'MASK' ) return 1;
			return 0; // OPAQUE

		}

		// Fallback logic based on material properties
		if ( material.alphaTest > 0.0 ) {

			return 1; // MASK - alphaTest takes priority

		}

		if ( material.transparent && material.opacity < 1.0 ) {

			return 2; // BLEND - transparent with opacity < 1

		}

		// Check for alpha in diffuse texture
		if ( material.map && material.map.format === RGBAFormat && material.transparent ) {

			return 2; // BLEND - has alpha texture and transparent flag

		}

		return 0; // OPAQUE

	}

	getMaterialType( material ) {

		// Detect material type for appropriate property mapping
		if ( material.isMeshPhysicalMaterial ) return 'physical';
		if ( material.isMeshStandardMaterial ) return 'standard';
		if ( material.isMeshPhongMaterial ) return 'phong';
		if ( material.isMeshLambertMaterial ) return 'lambert';
		if ( material.isMeshBasicMaterial ) return 'basic';
		if ( material.isMeshToonMaterial ) return 'toon';
		return 'unknown';

	}

	getPhysicalDefaults() {

		// Defaults optimized for physically-based path tracing
		return {
			emissive: new Color( 0, 0, 0 ),
			emissiveIntensity: 1.0,
			roughness: 1.0,
			metalness: 0.0,
			ior: 1.5, // Common dielectric IOR (glass, plastic)
			opacity: 1.0,
			transmission: 0.0,
			thickness: 0.1,
			attenuationColor: new Color( 0xffffff ),
			attenuationDistance: Infinity, // No attenuation by default
			dispersion: 0.0,
			sheen: 0.0,
			sheenRoughness: 1.0,
			sheenColor: new Color( 0x000000 ),
			specularIntensity: 1.0,
			specularColor: new Color( 0xffffff ),
			clearcoat: 0.0,
			clearcoatRoughness: 0.0,
			iridescence: 0.0,
			iridescenceIOR: 1.3,
			iridescenceThicknessRange: [ 100, 400 ],
			normalScale: { x: 1, y: 1 },
			bumpScale: 1.0,
			displacementScale: 1.0,
			alphaTest: 0.0
		};

	}

	mapLegacyMaterialToPhysical( material, materialType ) {

		// Map legacy material properties to physically-based equivalents
		const mapped = {};

		switch ( materialType ) {

			case 'basic':
				// MeshBasicMaterial -> Unlit/Emissive material
				mapped.emissive = material.color.clone();
				mapped.emissiveIntensity = 1.0;
				mapped.color = new Color( 0x000000 ); // No diffuse reflection
				mapped.roughness = 1.0;
				mapped.metalness = 0.0;
				break;

			case 'lambert':
				// MeshLambertMaterial -> Pure diffuse
				mapped.roughness = 1.0;
				mapped.metalness = 0.0;
				mapped.specularIntensity = 0.0; // No specular
				break;

			case 'phong':
				// MeshPhongMaterial -> Convert shininess to roughness
				{

					const shininess = material.shininess || 30;
					mapped.roughness = Math.sqrt( 2.0 / ( shininess + 2 ) );
					mapped.metalness = 0.0;

				}

				// Convert specular color to specular intensity
				if ( material.specular ) {

					const specularLuminance = material.specular.r * 0.299 +
                                        material.specular.g * 0.587 +
                                        material.specular.b * 0.114;
					mapped.specularIntensity = Math.min( specularLuminance * 2.0, 1.0 );
					mapped.specularColor = material.specular.clone();

				}

				break;

			case 'toon':
				// MeshToonMaterial -> Stylized but physically plausible
				mapped.roughness = 0.9;
				mapped.metalness = 0.0;
				break;

			case 'standard':
			case 'physical':
				// Already physically-based, no conversion needed
				break;

		}

		return mapped;

	}

	createMaterialObject( material ) {

		const defaults = this.getPhysicalDefaults();
		const materialType = this.getMaterialType( material );
		const legacyMapping = this.mapLegacyMaterialToPhysical( material, materialType );

		// Determine if material should be treated as dielectric or metallic
		const isMetallic = ( material.metalness ?? legacyMapping.metalness ?? 0.0 ) > 0.1;

		// Set appropriate IOR based on material type
		let defaultIOR = defaults.ior;
		if ( isMetallic ) {

			defaultIOR = 2.5; // Typical metallic IOR

		} else if ( material.transmission > 0.0 ) {

			defaultIOR = 1.5; // Glass-like for transmissive materials

		}

		// Handle color conversion for different material types
		let baseColor = material.color || new Color( 0xffffff );
		if ( materialType === 'basic' && ! material.map ) {

			// For basic materials without textures, treat color as emissive
			baseColor = new Color( 0x000000 );

		}

		return {
			uuid: material.uuid,

			// Base material properties
			color: baseColor,
			emissive: legacyMapping.emissive || material.emissive || defaults.emissive,
			emissiveIntensity: legacyMapping.emissiveIntensity || material.emissiveIntensity || defaults.emissiveIntensity,

			// Surface properties
			roughness: Math.max( 0.05, legacyMapping.roughness ?? material.roughness ?? defaults.roughness ),
			metalness: legacyMapping.metalness ?? material.metalness ?? defaults.metalness,

			// Optical properties
			ior: material.ior ?? defaultIOR,
			opacity: material.opacity ?? defaults.opacity,

			// Transmission properties (MeshPhysicalMaterial only)
			transmission: material.transmission ?? defaults.transmission,
			thickness: material.thickness ?? defaults.thickness,
			attenuationColor: material.attenuationColor ?? defaults.attenuationColor,
			attenuationDistance: material.attenuationDistance ?? defaults.attenuationDistance,

			// Advanced properties (MeshPhysicalMaterial only)
			dispersion: material.dispersion ?? defaults.dispersion,
			sheen: material.sheen ?? defaults.sheen,
			sheenRoughness: material.sheenRoughness ?? defaults.sheenRoughness,
			sheenColor: material.sheenColor ?? defaults.sheenColor,
			clearcoat: material.clearcoat ?? defaults.clearcoat,
			clearcoatRoughness: material.clearcoatRoughness ?? defaults.clearcoatRoughness,
			iridescence: material.iridescence ?? defaults.iridescence,
			iridescenceIOR: material.iridescenceIOR ?? defaults.iridescenceIOR,
			iridescenceThicknessRange: material.iridescenceThicknessRange ?? defaults.iridescenceThicknessRange,

			// Specular properties (for compatibility)
			specularIntensity: legacyMapping.specularIntensity ?? material.specularIntensity ?? defaults.specularIntensity,
			specularColor: legacyMapping.specularColor ?? material.specularColor ?? defaults.specularColor,

			// Surface detail properties
			normalScale: material.normalScale ?? defaults.normalScale,
			bumpScale: material.bumpScale ?? defaults.bumpScale,
			displacementScale: material.displacementScale ?? defaults.displacementScale,

			// Transparency and alpha
			transparent: material.transparent ? 1 : 0,
			alphaTest: material.alphaTest ?? defaults.alphaTest,
			alphaMode: this.getMaterialAlphaMode( material ),

			// Rendering properties
			side: this.getMaterialSide( material ),
			depthWrite: material.depthWrite ?? true ? 1 : 0,
			visible: material.visible ?? true ? 1 : 0,

			// Texture processing
			map: this.processTexture( material.map, this.maps ),
			normalMap: this.processTexture( material.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( material.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( material.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( material.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( material.emissiveMap, this.emissiveMaps ),
			displacementMap: this.processTexture( material.displacementMap, this.displacementMaps ),

			// Advanced texture maps (MeshPhysicalMaterial only)
			clearcoatMap: this.processTexture( material.clearcoatMap, [] ),
			clearcoatRoughnessMap: this.processTexture( material.clearcoatRoughnessMap, [] ),
			transmissionMap: this.processTexture( material.transmissionMap, [] ),
			thicknessMap: this.processTexture( material.thicknessMap, [] ),
			sheenColorMap: this.processTexture( material.sheenColorMap, [] ),
			sheenRoughnessMap: this.processTexture( material.sheenRoughnessMap, [] ),
			specularIntensityMap: this.processTexture( material.specularIntensityMap, [] ),
			specularColorMap: this.processTexture( material.specularColorMap, [] ),
			iridescenceMap: this.processTexture( material.iridescenceMap, [] ),
			iridescenceThicknessMap: this.processTexture( material.iridescenceThicknessMap, [] ),

			// Texture transformation matrices
			mapMatrix: this.getTextureMatrix( material.map ),
			normalMapMatrices: this.getTextureMatrix( material.normalMap ),
			bumpMapMatrices: this.getTextureMatrix( material.bumpMap ),
			roughnessMapMatrices: this.getTextureMatrix( material.roughnessMap ),
			metalnessMapMatrices: this.getTextureMatrix( material.metalnessMap ),
			emissiveMapMatrices: this.getTextureMatrix( material.emissiveMap ),
			displacementMapMatrices: this.getTextureMatrix( material.displacementMap ),

			// Material type for debugging/optimization
			originalType: materialType
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
		this.displacementMaps = [];
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
			displacementMaps: this.displacementMaps,
			directionalLights: this.directionalLights,
			cameras: this.cameras
		};

	}

}

// Export the data layout constants
export { TRIANGLE_DATA_LAYOUT };
