import { Vector3, Vector2, Color, Matrix3, Matrix4, MeshPhysicalMaterial, FrontSide, BackSide, DoubleSide } from "three";

const MAX_TEXTURES_LIMIT = 48;

export default class GeometryExtractor {

	constructor() {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.metalnessMaps = [];
		this.roughnessMaps = [];
		this.emissiveMaps = [];
		this.directionalLights = [];
		this.cameras = [];

		this.posA = new Vector3();
		this.posB = new Vector3();
		this.posC = new Vector3();
		this.uvA = new Vector2();
		this.uvB = new Vector2();
		this.uvC = new Vector2();

		this.normal = new Vector3();
		this.normalA = this.normal.clone();
		this.normalB = this.normal.clone();
		this.normalC = this.normal.clone();

		this.normalMatrix = new Matrix3();
		this.worldMatrix = new Matrix4();

	}

	extract( object ) {

		this.resetArrays();
		this.traverseObject( object );
		this.logStats();
		return this.getExtractedData();

	}

	traverseObject( object ) {

		if ( object.isMesh ) {

			this.processMesh( object );

		} else if ( object.isDirectionalLight ) {

			this.directionalLights.push( object );

		} else if ( object.isCamera ) {

			this.cameras.push( object );

		}

		// Recursively process children
		if ( object.children ) {

			for ( let child of object.children ) {

				this.traverseObject( child );

			}

		}

	}

	processObject( obj ) {

		if ( obj.isDirectionalLight ) {

			this.directionalLights.push( obj );

		} else if ( obj.isMesh ) {

			this.processMesh( obj );

		}

	}

	processMesh( mesh ) {

		const materialIndex = this.processMaterial( mesh.material );
		mesh.userData.materialIndex = materialIndex;
		this.extractGeometry( mesh, materialIndex );

	}

	processMaterial( material ) {

		let materialIndex = this.materials.findIndex( x => x.uuid === material.uuid );
		if ( materialIndex === - 1 ) {

			if ( material.depthWrite === false ) {

				material.depthWrite = true; // Depth write is required for rastered rendering
				console.warn( "Depth write is disabled in material, enabling it for rastered rendering" );

			}

			const newMaterial = this.createMaterialObject( material );
			this.materials.push( newMaterial );
			materialIndex = this.materials.length - 1;

		}

		return materialIndex;

	}

	getMaterialAlphaMode( material ) {

		if ( material.transparent ) return 2; //'BLEND';
		if ( material.alphaTest > 0.0 ) return 1;// 'MASK';
		return 0; //'OPAQUE';

	}


	createMaterialObject( material ) {

		const emissive = material.emissive ?? new Color( 0, 0, 0 );
		const alphaMode = this.getMaterialAlphaMode( material );

		material.attenuationColor = material.attenuationColor ?? new Color( 0xffffff );
		material.attenuationDistance = material.attenuationDistance ?? 1e20;
		material.dispersion = material.dispersion ?? 0.0;
		material.sheen = material.sheen ?? 0.0;
		material.sheenRoughness = material.sheenRoughness ?? 1;
		material.sheenColor = material.sheenColor ?? new Color().setHex( 0x00000 );
		material.specularIntensity = material.specularIntensity ?? 1.0;
		material.specularColor = material.specularColor ?? new Color( 0xffffff );
		material.iridescence = material.iridescence ?? 0.0;
		material.iridescenceIOR = material.iridescenceIOR ?? 1.0;
		material.iridescenceThicknessRange = material.iridescenceThicknessRange ?? [ 100, 400 ];

		return {
			uuid: material.uuid,
			color: material.color,
			emissive: emissive,
			emissiveIntensity: material.emissiveIntensity,
			roughness: material.roughness ?? 1.0,
			metalness: material.metalness ?? 0.0,
			ior: material.ior ?? 0,
			opacity: material.opacity ?? 0,
			transmission: material.transmission ?? 0.0,
			attenuationColor: material.attenuationColor,
			attenuationDistance: material.attenuationDistance,
			dispersion: material.dispersion,
			sheen: material.sheen,
			sheenRoughness: material.sheenRoughness,
			sheenColor: material.sheenColor,
			specularIntensity: material.specularIntensity,
			specularColor: material.specularColor,
			thickness: material.thickness ?? 0.1,
			clearcoat: material.clearcoat ?? 0.0,
			clearcoatRoughness: material.clearcoatRoughness ?? 0.0,
			iridescence: material.iridescence,
			iridescenceIOR: material.iridescenceIOR,
			iridescenceThicknessRange: material.iridescenceThicknessRange,
			side: this.getMaterialSide( material ),
			normalScale: material.normalScale ?? { x: 1, y: 1 },
			transparent: material.transparent ? 1 : 0,
			alphaTest: material.alphaTest ?? 0.0,
			alphaMode: alphaMode,
			depthWrite: material.depthWrite ? 1 : 0,
			visible: material.visible ? 1 : 0,

			map: this.processTexture( material.map, this.maps ),
			normalMap: this.processTexture( material.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( material.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( material.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( material.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( material.emissiveMap, this.emissiveMaps ),
			clearcoatMap: this.processTexture( material.clearcoatMap, [] ),
			clearcoatRoughnessMap: this.processTexture( material.clearcoatRoughnessMap, [] ),

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

		}

	}


	processTexture( texture, textureArray ) {

		if ( ! texture ) return - 1;
		let textureIndex = textureArray.findIndex( x => x.source.uuid === texture.source.uuid );
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
		if ( ! geometry.normals ) geometry.computeVertexNormals();
		const positions = geometry.attributes.position;
		const normals = geometry.attributes.normal;
		const uvs = geometry.attributes.uv;
		const indices = geometry.index ? geometry.index.array : null;

		// Compute matrices
		this.worldMatrix.copy( mesh.matrixWorld );
		this.normalMatrix.getNormalMatrix( this.worldMatrix );

		const triangleCount = indices ? indices.length / 3 : positions.count / 3;

		for ( let i = 0; i < triangleCount; i ++ ) {

			this.extractTriangle( positions, normals, uvs, indices, i, materialIndex );

		}

	}

	extractTriangle( positions, normals, uvs, indices, i, materialIndex ) {

		const i3 = i * 3;

		if ( indices ) {

			this.setPositionsFromIndices( positions, indices, i3 );
			this.setNormalsFromIndices( normals, indices, i3 );
			if ( uvs ) this.setUVsFromIndices( uvs, indices, i3 );

		} else {

			this.setPositions( positions, i3 );
			this.setNormals( normals, i3 );
			if ( uvs ) this.setUVs( uvs, i3 );

		}

		this.applyWorldTransforms();
		this.addTriangle( materialIndex );

	}

	setPositionsFromIndices( positions, indices, i3 ) {

		this.posA.fromBufferAttribute( positions, indices[ i3 + 0 ] );
		this.posB.fromBufferAttribute( positions, indices[ i3 + 1 ] );
		this.posC.fromBufferAttribute( positions, indices[ i3 + 2 ] );

	}

	setNormalsFromIndices( normals, indices, i3 ) {

		this.normalA.fromBufferAttribute( normals, indices[ i3 + 0 ] );
		this.normalB.fromBufferAttribute( normals, indices[ i3 + 1 ] );
		this.normalC.fromBufferAttribute( normals, indices[ i3 + 2 ] );

	}

	setUVsFromIndices( uvs, indices, i3 ) {

		this.uvA.fromBufferAttribute( uvs, indices[ i3 + 0 ] );
		this.uvB.fromBufferAttribute( uvs, indices[ i3 + 1 ] );
		this.uvC.fromBufferAttribute( uvs, indices[ i3 + 2 ] );

	}

	setPositions( positions, i3 ) {

		this.posA.fromBufferAttribute( positions, i3 + 0 );
		this.posB.fromBufferAttribute( positions, i3 + 1 );
		this.posC.fromBufferAttribute( positions, i3 + 2 );

	}

	setNormals( normals, i3 ) {

		this.normalA.fromBufferAttribute( normals, i3 + 0 );
		this.normalB.fromBufferAttribute( normals, i3 + 1 );
		this.normalC.fromBufferAttribute( normals, i3 + 2 );

	}

	setUVs( uvs, i3 ) {

		this.uvA.fromBufferAttribute( uvs, i3 + 0 );
		this.uvB.fromBufferAttribute( uvs, i3 + 1 );
		this.uvC.fromBufferAttribute( uvs, i3 + 2 );

	}

	applyWorldTransforms() {

		// Transform positions
		this.posA.applyMatrix4( this.worldMatrix );
		this.posB.applyMatrix4( this.worldMatrix );
		this.posC.applyMatrix4( this.worldMatrix );

		// Transform normals
		this.normalA.applyMatrix3( this.normalMatrix ).normalize();
		this.normalB.applyMatrix3( this.normalMatrix ).normalize();
		this.normalC.applyMatrix3( this.normalMatrix ).normalize();

	}

	addTriangle( materialIndex ) {

		this.triangles.push( {
			posA: { x: this.posA.x, y: this.posA.y, z: this.posA.z },
			posB: { x: this.posB.x, y: this.posB.y, z: this.posB.z },
			posC: { x: this.posC.x, y: this.posC.y, z: this.posC.z },
			normalA: { x: this.normalA.x, y: this.normalA.y, z: this.normalA.z },
			normalB: { x: this.normalB.x, y: this.normalB.y, z: this.normalB.z },
			normalC: { x: this.normalC.x, y: this.normalC.y, z: this.normalC.z },
			uvA: { x: this.uvA.x, y: this.uvA.y },
			uvB: { x: this.uvB.x, y: this.uvB.y },
			uvC: { x: this.uvC.x, y: this.uvC.y },
			materialIndex: materialIndex
		} );

	}

	logStats() {

		console.log( "materials:", this.materials.length );
		console.log( "triangles:", this.triangles.length );
		console.log( "maps:", this.maps.length );

	}

	resetArrays() {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.roughnessMaps = [];
		this.directionalLights = [];

	}

	getExtractedData() {

		return {
			triangles: this.triangles,
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
