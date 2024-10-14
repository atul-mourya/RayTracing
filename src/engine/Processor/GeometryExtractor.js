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
		this.directionalLights = [];

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

		// this.convertOpacityToTransmission( mesh );
		const materialIndex = this.processMaterial( mesh.material );
		this.extractGeometry( mesh, materialIndex );

	}

	convertOpacityToTransmission( mesh, ior = 1.0 ) {

		let material = mesh.material;

		// // if (
		// // 	material.opacity < 0.65 &&
		// // 	material.opacity > 0.2 &&
		// // 	material.ior === 0
		// // ) {

		if ( ! material.isMeshPhysicalMaterial && material.opacity < 1 ) {

			let newMaterial = new MeshPhysicalMaterial();

			// Copy properties from the old material to the new one
			for ( const key in material ) {

				if ( key in material ) {

					if ( material[ key ] === null ) {

						continue;

					}

					if ( material[ key ].isTexture ) {

						newMaterial[ key ] = material[ key ];

					} else if ( material[ key ].copy && material[ key ].constructor === newMaterial[ key ].constructor ) {

						newMaterial[ key ].copy( material[ key ] );

					} else if ( typeof material[ key ] === 'number' ) {

						newMaterial[ key ] = material[ key ];

					}

				}

			}

			newMaterial.transmission = 1.0;
			newMaterial.thickness = 0.1;
			newMaterial.ior = ior;
			const hsl = {};
			newMaterial.color.getHSL( hsl );
			hsl.l = Math.max( hsl.l, 0.35 );
			newMaterial.color.setHSL( hsl.h, hsl.s, hsl.l );

			mesh.material = newMaterial;

		}

	}


	processMaterial( material ) {

		let materialIndex = this.materials.findIndex( x => x.uuid === material.uuid );
		if ( materialIndex === - 1 ) {

			const newMaterial = this.createMaterialObject( material );
			this.materials.push( newMaterial );
			materialIndex = this.materials.length - 1;

		}

		return materialIndex;

	}

	createMaterialObject( material ) {

		const emissive = material.emissive ?? new Color( 0, 0, 0 );
		// const isTransparent = material.opacity < 1.0 || false;
		// if ( isTransparent ) {

		// 	if ( material.transmission === 0 ) material.transmission = 1.0;
		// 	if ( material.thickness === 0 ) material.thickness = 0.1;
		// 	if ( material.ior == 1.5 ) material.ior = 1.0;

		// }

		return {
			color: material.color,
			emissive: emissive,
			emissiveIntensity: material.emissiveIntensity,
			roughness: material.roughness ?? 1.0,
			metalness: material.metalness ?? 0.0,
			ior: material.ior ?? 0,
			opacity: material.opacity ?? 0,
			transmission: material.transmission ?? 0.0,
			thickness: material.thickness ?? 0.1,
			clearcoat: material.clearcoat ?? 0.0,
			clearcoatRoughness: material.clearcoatRoughness ?? 0.0,
			side: this.getMaterialSide( material ),
			normalScale: material.normalScale ?? { x: 1, y: 1 },
			map: this.processTexture( material.map, this.maps ),
			normalMap: this.processTexture( material.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( material.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( material.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( material.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( material.emissiveMap, this.emissiveMaps ),
			clearcoatMap: this.processTexture( material.clearcoatMap, [] ),
			clearcoatRoughnessMap: this.processTexture( material.clearcoatRoughnessMap, [] )
		};

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
			posA: this.posA.clone(),
			posB: this.posB.clone(),
			posC: this.posC.clone(),
			normalA: this.normalA.clone(),
			normalB: this.normalB.clone(),
			normalC: this.normalC.clone(),
			uvA: this.uvA.clone(),
			uvB: this.uvB.clone(),
			uvC: this.uvC.clone(),
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
			directionalLights: this.directionalLights
		};

	}

}
