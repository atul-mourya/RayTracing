import { Vector3, Vector2, Color } from "three";

export default class GeometryExtractor {

	extract( object ) {

		const triangles = [];
		const materials = [];
		const maps = [];
		const normalMaps = [];
		const bumpMaps = [];
		const metalnessMaps = [];
		const roughnessMaps = [];
		const directionalLights = [];

		const posA = new Vector3();
		const posB = new Vector3();
		const posC = new Vector3();
		const uvA = new Vector2();
		const uvB = new Vector2();
		const uvC = new Vector2();

		const normal = new Vector3();
		const normalA = normal.clone();
		const normalB = normal.clone();
		const normalC = normal.clone();

		object.traverse( obj => {

			if ( obj.isDirectionalLight ) {

				directionalLights.push( obj );
				return;

			}

		  	if ( obj.isMesh ) {

				let materialIndex = materials.findIndex( x => x.uuid === obj.material.uuid );
				if ( materialIndex === - 1 ) {

					const emissive = obj.material.emissive ?? new Color( 0, 0, 0 );
					const isEmissive = emissive.r > 0 || emissive.g > 0 || emissive.b > 0 ? true : false;
					if ( isEmissive ) console.log( obj );
					const material = {
						color: obj.material.color,
						emissive: emissive,
						emissiveIntensity: isEmissive ? obj.material.emissiveIntensity ?? 0 : 0,
						clearCoat: obj.material.clearCoat ?? 0.0,
						clearCoatRoughness: obj.material.clearCoatRoughness ?? 0.0,
						roughness: obj.material.roughness ?? 1.0,
						metalness: obj.material.metalness ?? 0.0,
						ior: obj.material.ior ?? 0,
						transmission: obj.material.transmission ?? 0.0,
						thickness: obj.material.thickness ?? 0.5,
						map: - 1,
						normalMap: - 1,
						bumpMap: - 1,
						roughnessMap: - 1,
						metalnessMap: - 1,
					};

					if ( obj.material.map ) {

						let textureIndex = maps.findIndex( x => x.source.uuid === obj.material.map.source.uuid );
						if ( textureIndex === - 1 && maps.length < 48 ) {

							maps.push( obj.material.map );
							material.map = maps.length - 1;

						}

					}

					if ( obj.material.normalMap ) {

						let textureIndex = normalMaps.findIndex( x => x.source.uuid === obj.material.normalMap.source.uuid );
						if ( textureIndex === - 1 && normalMaps.length < 48 ) {

							normalMaps.push( obj.material.normalMap );
							material.normalMap = normalMaps.length - 1;

						}

					}

					if ( obj.material.bumpMap ) {

						let textureIndex = bumpMaps.findIndex( x => x.source.uuid === obj.material.bumpMap.source.uuid );
						if ( textureIndex === - 1 && bumpMaps.length < 48 ) {

							bumpMaps.push( obj.material.bumpMap );
							material.bumpMap = bumpMaps.length - 1;

						}

					}

					if ( obj.material.roughnessMap ) {

						let textureIndex = roughnessMaps.findIndex( x => x.source.uuid === obj.material.roughnessMap.source.uuid );
						if ( textureIndex === - 1 && roughnessMaps.length < 48 ) {

							roughnessMaps.push( obj.material.roughnessMap );
							material.roughtnessMap = roughnessMaps.length - 1;

						}

					}

					if ( obj.material.metalnessMap ) {

						let textureIndex = metalnessMaps.findIndex( x => x.source.uuid === obj.material.metalnessMap.source.uuid );
						if ( textureIndex === - 1 && metalnessMaps.length < 48 ) {

							metalnessMaps.push( obj.material.metalnessMap );
							material.metalnessMap = metalnessMaps.length - 1;

						}

					}

					materials.push( material );
					materialIndex = materials.length - 1;

				}

				obj.updateMatrix();
				obj.updateMatrixWorld();

				const geometry = obj.geometry;
				const positions = geometry.attributes.position;
				const normals = geometry.attributes.normal;
				const uvs = geometry.attributes.uv;
				const indices = geometry.index ? geometry.index.array : null;

				const triangleCount = indices ? indices.length / 3 : positions.count / 3;

				for ( let i = 0; i < triangleCount; i ++ ) {

					const i3 = i * 3;

					if ( indices ) {

						posA.fromBufferAttribute( positions, indices[ i3 + 0 ] );
						posB.fromBufferAttribute( positions, indices[ i3 + 1 ] );
						posC.fromBufferAttribute( positions, indices[ i3 + 2 ] );

						// Extract normals from the geometry
						normal.fromBufferAttribute( normals, indices[ i3 + 0 ] );
						normalA.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();
						normal.fromBufferAttribute( normals, indices[ i3 + 1 ] );
						normalB.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();
						normal.fromBufferAttribute( normals, indices[ i3 + 2 ] );
						normalC.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();

						if ( uvs ) {

							uvA.fromBufferAttribute( uvs, indices[ i3 + 0 ] );
							uvB.fromBufferAttribute( uvs, indices[ i3 + 1 ] );
							uvC.fromBufferAttribute( uvs, indices[ i3 + 2 ] );

						}

					} else {

						posA.fromBufferAttribute( positions, i3 + 0 );
						posB.fromBufferAttribute( positions, i3 + 1 );
						posC.fromBufferAttribute( positions, i3 + 2 );

						// Extract normals from the geometry
						normal.fromBufferAttribute( normals, i3 + 0 );
						normalA.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();
						normal.fromBufferAttribute( normals, i3 + 1 );
						normalB.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();
						normal.fromBufferAttribute( normals, i3 + 2 );
						normalC.copy( normal ).applyMatrix3( obj.normalMatrix ).normalize();

						if ( uvs ) {

							uvA.fromBufferAttribute( uvs, i3 + 0 );
							uvB.fromBufferAttribute( uvs, i3 + 1 );
							uvC.fromBufferAttribute( uvs, i3 + 2 );

						}

					}

					posA.applyMatrix4( obj.matrixWorld );
					posB.applyMatrix4( obj.matrixWorld );
					posC.applyMatrix4( obj.matrixWorld );

					triangles.push( {
						posA: posA.clone(),
						posB: posB.clone(),
						posC: posC.clone(),
						normalA: normalA.clone(),
						normalB: normalB.clone(),
						normalC: normalC.clone(),
						uvA: uvA.clone(),
						uvB: uvB.clone(),
						uvC: uvC.clone(),
						materialIndex: materialIndex
					} );

				}

			} else if ( obj.isDirectionalLight === true ) {

				directionalLights.push( obj );

			}

		} );

		console.log( "materials:", materials.length );
		console.log( "triangles:", triangles.length );
		console.log( "maps:", maps.length );

		return {
			triangles,
			materials,
			maps,
			normalMaps,
			bumpMaps,
			metalnessMaps,
			roughnessMaps,
			directionalLights
		};

	}

	// Helper methods for geometry extraction...

}