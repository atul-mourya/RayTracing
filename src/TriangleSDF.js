import { Vector3, DataTexture, RGBAFormat, FloatType } from "three";

export default class TriangleSDF {

	constructor( object ) {

		this.meshInfos = [];
		this.triangles = [];
		this.triangleMaterialIndices = [];

		this.extractTrianglesFromMeshes( object );
		this.triangleTexture = this.createTriangleDataTexture( this.triangles );
		this.meshInfoTexture = this.createMeshInfoDataTexture( this.meshInfos );

	}

	extractTrianglesFromMeshes( object ) {

		let startIndex = 0;
		this.meshInfos = [];
		this.triangleMaterialIndices = [];

		let meshCount = 0;

		object.traverse( obj => {

			if ( obj.isMesh ) {

				const geometry = obj.geometry.translate( - meshCount * 2, 0, - 5 ).toNonIndexed();
				meshCount ++;
				const positions = geometry.attributes.position;
				const normals = geometry.attributes.normal;
				const count = geometry.attributes.position.count;
				geometry.computeBoundingBox();

				if ( startIndex == 0 ) {

					// startIndex += count;
					// return;

				}

				const material = {
					color: obj.material.color,
					emissive: obj.material.emissive,
					emissiveIntensity: obj.material.emissiveIntensity
				};

				this.meshInfos.push( {
					firstTriangleIndex: this.triangles.length,
					numTriangles: count,
					material,
					boundsMin: geometry.boundingBox.min,
					boundsMax: geometry.boundingBox.max
				} );

				console.log( `Mesh: ${obj.name || 'unnamed'}, Triangles: ${count}` );

				for ( let i = 0; i < count; i += 3 ) {

					const posA = new Vector3( positions.getX( i ), positions.getY( i ), positions.getZ( i ) );
					const posB = new Vector3( positions.getX( i + 1 ), positions.getY( i + 1 ), positions.getZ( i + 1 ) );
					const posC = new Vector3( positions.getX( i + 2 ), positions.getY( i + 2 ), positions.getZ( i + 2 ) );

					const normal = new Vector3( normals.getX( i ), normals.getY( i ), normals.getZ( i ) );

					const triangle = { posA, posB, posC, normal };
					this.triangles.push( triangle );
					this.triangleMaterialIndices.push( this.meshInfos.length - 1 );

				}

				startIndex += count;

			}

		} );

		console.log( this.meshInfos );
		console.log( this.triangles );

	}

	createTriangleDataTexture( triangles ) {

		// Each triangle has 3 vertices, each vertex has 4 components (x, y, z, w)
		const dataLength = triangles.length * 3; // 3 vertices * 4 components each

		// Calculate dimensions
		const width = Math.ceil( Math.sqrt( dataLength ) ); // Divide by 4 because RGBA (4 components)
		const height = Math.ceil( dataLength / width );

		const size = width * height * 4; // Total size in terms of RGBA components
		const data = new Float32Array( size );

		for ( let i = 0; i < triangles.length; i ++ ) {

			const stride = i * 3 * 4;
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


		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

	createMeshInfoDataTexture( meshInfos ) {

		const dataLength = meshInfos.length * 5;

		const width = Math.ceil( Math.sqrt( dataLength ) );
		const height = Math.ceil( dataLength / width );

		const size = width * height;
		const data = new Float32Array( 5 * 4 * size ); // RGBA 4 componenet

		for ( let i = 0; i < meshInfos.length; i ++ ) {

			const stride = i * 5 * 4;
			data[ stride + 0 ] = meshInfos[ i ].firstTriangleIndex;
			data[ stride + 1 ] = meshInfos[ i ].numTriangles;
			data[ stride + 2 ] = 0;
			data[ stride + 3 ] = 0;

			data[ stride + 4 ] = meshInfos[ i ].material.color.r;
			data[ stride + 5 ] = meshInfos[ i ].material.color.g;
			data[ stride + 6 ] = meshInfos[ i ].material.color.b;
			data[ stride + 7 ] = 0;

			data[ stride + 8 ] = meshInfos[ i ].material.emissive.r;
			data[ stride + 9 ] = meshInfos[ i ].material.emissive.g;
			data[ stride + 10 ] = meshInfos[ i ].material.emissive.b;
			data[ stride + 11 ] = meshInfos[ i ].material.emissiveIntensity;

			data[ stride + 12 ] = meshInfos[ i ].boundsMin.x;
			data[ stride + 13 ] = meshInfos[ i ].boundsMin.y;
			data[ stride + 14 ] = meshInfos[ i ].boundsMin.z;
			data[ stride + 15 ] = 0;

			data[ stride + 16 ] = meshInfos[ i ].boundsMax.x;
			data[ stride + 17 ] = meshInfos[ i ].boundsMax.y;
			data[ stride + 18 ] = meshInfos[ i ].boundsMax.z;
			data[ stride + 19 ] = 0;

		}

		const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
		texture.needsUpdate = true;
		return texture;

	}

}
