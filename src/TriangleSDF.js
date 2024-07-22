import { Vector3, DataTexture, RGBAFormat, FloatType } from "three";

const PER_VERTEX_TEXTURE_LENGTH = 2048;
const PER_OBJECT_TEXTURE_LENGTH = 1024;

export default class TriangleSDF {

	constructor( object ) {


		this.materials = [];
		this.triangles = [];
		this.triangleMaterialIndices = [];

		this.extractTrianglesFromMeshes( object );
		this.triangleTexture = this.createTriangleDataTexture( this.triangles );
		this.normalTexture = this.createNormalDataTexture( this.triangles );
		this.materialTexture = this.createMaterialDataTexture( this.materials );
		this.triangleMaterialMappingTexture = this.createTriangleMaterialMapping( this.triangleMaterialIndices );

	}

	extractTrianglesFromMeshes( object ) {

		let startIndex = 0;
		this.materials = [];
		this.triangleMaterialIndices = [];

		let meshCount = 0;

		object.traverse( obj => {

			if ( obj.isMesh ) {

				const geometry = obj.geometry
					.translate( meshCount * 3, 0, - 5 );
				const positions = geometry.attributes.position.array;
				const normals = geometry.attributes.normal.array;
				const count = geometry.attributes.position.count;

				const materialIndex = this.materials.length;
				this.materials.push( { startIndex, count, material: { color: obj.material.color, emissive: obj.material.emissive, emissiveIntensity: obj.material.emissiveIntensity } } );

				for ( let i = 0; i < count; i += 3 ) {

					const posA = new Vector3( positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] );
					const posB = new Vector3( positions[ ( i + 1 ) * 3 ], positions[ ( i + 1 ) * 3 + 1 ], positions[ ( i + 1 ) * 3 + 2 ] );
					const posC = new Vector3( positions[ ( i + 2 ) * 3 ], positions[ ( i + 2 ) * 3 + 1 ], positions[ ( i + 2 ) * 3 + 2 ] );

					const normalA = new Vector3( normals[ i * 3 ], normals[ i * 3 + 1 ], normals[ i * 3 + 2 ] );
					const normalB = new Vector3( normals[ ( i + 1 ) * 3 ], normals[ ( i + 1 ) * 3 + 1 ], normals[ ( i + 1 ) * 3 + 2 ] );
					const normalC = new Vector3( normals[ ( i + 2 ) * 3 ], normals[ ( i + 2 ) * 3 + 1 ], normals[ ( i + 2 ) * 3 + 2 ] );

					const triangle = { posA, posB, posC, normalA, normalB, normalC };
					this.triangles.push( triangle );
					this.triangleMaterialIndices.push( materialIndex );

				}

				startIndex += count;
				meshCount ++;

			}

		} );

	}

	createTriangleDataTexture() {

		const texWidth = PER_VERTEX_TEXTURE_LENGTH;
		const texHeight = Math.ceil( this.triangles.length / texWidth );
		const data = new Float32Array( texWidth * texHeight * 4 * 3 );

		this.triangles.forEach( ( triangle, i ) => {

			const offset = i * 12;
			data.set( [ triangle.posA.x, triangle.posA.y, triangle.posA.z, 0 ], offset );
			data.set( [ triangle.posB.x, triangle.posB.y, triangle.posB.z, 0 ], offset + 4 );
			data.set( [ triangle.posC.x, triangle.posC.y, triangle.posC.z, 0 ], offset + 8 );

		} );

		const texture = new DataTexture( data, texWidth, texHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createNormalDataTexture() {

		const texWidth = PER_VERTEX_TEXTURE_LENGTH;
		const texHeight = Math.ceil( this.triangles.length / texWidth );
		const data = new Float32Array( texWidth * texHeight * 4 * 3 );

		this.triangles.forEach( ( triangle, i ) => {

			const offset = i * 12;
			data.set( [ triangle.normalA.x, triangle.normalA.y, triangle.normalA.z, 0 ], offset );
			data.set( [ triangle.normalB.x, triangle.normalB.y, triangle.normalB.z, 0 ], offset + 4 );
			data.set( [ triangle.normalC.x, triangle.normalC.y, triangle.normalC.z, 0 ], offset + 8 );

		} );

		const texture = new DataTexture( data, texWidth, texHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createMaterialDataTexture( materialsData ) {

		const texWidth = PER_OBJECT_TEXTURE_LENGTH;
		const texHeight = Math.ceil( materialsData.length / texWidth );
		const data = new Float32Array( texWidth * texHeight * 4 * 3 );

		materialsData.forEach( ( d, i ) => {

			const offset = i * 12;
			data.set( [ d.material.color.r, d.material.color.g, d.material.color.b, 0 ], offset );
			data.set( [ d.material.emissive.r, d.material.emissive.g, d.material.emissive.b, 0 ], offset + 4 );
			data.set( [ d.material.emissiveIntensity, d.startIndex, d.count, 0 ], offset + 8 );

		} );

		const texture = new DataTexture( data, texWidth, texHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createTriangleMaterialMapping( triangleMaterialIndices ) {

		const texWidth = PER_VERTEX_TEXTURE_LENGTH;
		const texHeight = Math.ceil( triangleMaterialIndices.length / texWidth );
		const data = new Float32Array( texWidth * texHeight * 4 );

		triangleMaterialIndices.forEach( ( index, i ) => {

			const offset = i * 4;
			data.set( [ index, 0, 0, 0 ], offset );

		} );

		const texture = new DataTexture( data, texWidth, texHeight, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

}
