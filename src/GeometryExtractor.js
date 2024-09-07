import { Vector3, Vector2, Color } from "three";

export default class GeometryExtractor {

	extract( object ) {

		const triangles = [];
		const materials = [];
		const maps = [];
		const directionalLights = [];

		const posA = new Vector3();
		const posB = new Vector3();
		const posC = new Vector3();
		const uvA = new Vector2();
		const uvB = new Vector2();
		const uvC = new Vector2();

		const normal = new Vector3();
		const tempNormal = new Vector3();

		object.traverse( obj => {

			if ( obj.isDirectionalLight ) {

				directionalLights.push( obj );
				return;

			}

		  	if ( obj.isMesh ) {

				let materialIndex = materials.findIndex( x => x.uuid === obj.material.uuid );
				if ( materialIndex === - 1 ) {

					let albedoTextureIndex = - 1;
					if ( obj.material.map ) {

						albedoTextureIndex = maps.findIndex( x => x.source.uuid === obj.material.map.source.uuid );
						if ( albedoTextureIndex === - 1 && maps.length < 48 ) {

							maps.push( obj.material.map );
							albedoTextureIndex = maps.length - 1;

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
						ior: obj.material.ior ?? 0,
						transmission: obj.material.transmission ?? 0.0,
						thickness: obj.material.thickness ?? 0.5,

						map: albedoTextureIndex === null ? - 1 : albedoTextureIndex
					};

					materials.push( material );
					materialIndex = materials.length - 1;

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

					triangles.push( {
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

				directionalLights.push( obj );

			}

		} );

		console.log( "materials:", materials.length );
		console.log( "triangles:", triangles.length );
		console.log( "maps:", maps.length );

		return { triangles, materials, maps, directionalLights };

	}

	// Helper methods for geometry extraction...

}
