import { Vector3, DataTexture, RGBAFormat, FloatType, Box3, Color } from "three";

Vector3.prototype.toFixed = function ( num ) {

	this.x = parseFloat( this.x.toFixed( num ) );
	this.y = parseFloat( this.y.toFixed( num ) );
	this.z = parseFloat( this.z.toFixed( num ) );
	return this;

};

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

		const posA = new Vector3();
		const posB = new Vector3();
		const posC = new Vector3();
		const normal = new Vector3();
		const tempNormal = new Vector3();

		object.traverse( obj => {

		  if ( obj.isMesh ) {

				obj.updateMatrix();
				obj.updateMatrixWorld();

				const geometry = obj.geometry;
				const positions = geometry.attributes.position;
				const indices = geometry.index ? geometry.index.array : null;

				geometry.computeBoundingBox();

				const material = {
					color: obj.material.color,
					emissive: obj.material.emissive ?? new Color( 0, 0, 0 ),
					emissiveIntensity: obj.material.emissiveIntensity ?? 0
				};

				const triangleCount = indices ? indices.length / 3 : positions.count / 3;
				const box = new Box3();//.setFromObject( obj );
				box.copy( geometry.boundingBox ).applyMatrix4( obj.matrixWorld );

				this.meshInfos.push( {
					name: obj.name,
					firstTriangleIndex: startIndex,
					numTriangles: triangleCount,
					material,
					boundsMin: box.min,
					boundsMax: box.max
				} );

				console.log( `Mesh: ${obj.name || 'unnamed'}, Triangles: ${triangleCount}` );

				for ( let i = 0; i < triangleCount; i ++ ) {

					const i3 = i * 3;

					if ( indices ) {

						posA.fromBufferAttribute( positions, indices[ i3 + 0 ] );
						posB.fromBufferAttribute( positions, indices[ i3 + 1 ] );
						posC.fromBufferAttribute( positions, indices[ i3 + 2 ] );

					} else {

						posA.fromBufferAttribute( positions, i3 + 0 );
						posB.fromBufferAttribute( positions, i3 + 1 );
						posC.fromBufferAttribute( positions, i3 + 2 );

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
						normal: normal.clone()
					} );
					this.triangleMaterialIndices.push( this.meshInfos.length - 1 );

				}

				startIndex += triangleCount;

			}

		} );

		console.log( this.meshInfos.map( m => [ m.boundsMin.toArray(), m.boundsMax.toArray() ] ) );
		console.log( this.meshInfos );
		console.log( this.triangles );

	}

	createTriangleDataTexture( triangles ) {

		// Each triangle has 3 vertices, each vertex has 4 components (x, y, z, w)
		const dataLength = triangles.length * 3 * 4; // 3 vertices * 4 components each

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

		const dataLength = meshInfos.length * 5 * 4;

		const width = Math.ceil( Math.sqrt( dataLength ) );
		const height = Math.ceil( dataLength / width );

		const size = width * height * 4;
		const data = new Float32Array( size ); // RGBA 4 componenet

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
