import { SphereGeometry, Mesh, MeshPhysicalMaterial, Group, Object3D } from 'three';

export function disposeMaterial( material ) {

	if ( Array.isArray( material ) ) {

		material.forEach( mat => {

			if ( mat.userData && mat.userData.isFallback ) return;
			disposeMaterialTextures( mat );
			mat.dispose();

		} );

	} else {

		if ( material.userData && material.userData.isFallback ) return;
		disposeMaterialTextures( material );
		material.dispose();

	}

}

export function disposeMaterialTextures( material ) {

	if ( ! material ) return;

	const textures = [
		'alphaMap', 'aoMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'displacementMap',
		'emissiveMap', 'envMap', 'gradientMap', 'lightMap', 'map', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap',
		'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'thicknessMap', 'transmissionMap'
	];

	textures.forEach( texture => {

		if ( material[ texture ] ) {

			material[ texture ].dispose();
			material[ texture ] = null;

		}

	} );

}

export function distroyBuffers( { material, geometry, children } ) {

	material && disposeMaterial( material );
	geometry && geometry.dispose();

	if ( children.length > 0 ) {

		for ( const child of children ) {

			distroyBuffers( child );

		}

	}

}

export function disposeObjectFromMemory( object, exeptions = [] ) {

	if ( ! object ) return;
	if ( exeptions.includes( object.name ) || object.isScene ) return;

	if ( object.isMaterial ) {

		disposeMaterial( object );
		return;

	}

	while ( object.children.length > 0 ) {

		for ( const child of object.children ) {

			disposeObjectFromMemory( child );

		}

	}

	distroyBuffers( object );

	object.removeFromParent();
	object.clear();

}



/**
 Metalness (increases left to right):
   0.00  0.25  0.50  0.75  1.00
   +-----------------------------> X
 1 |  o     o     o     o     o
   |
0.75  o     o     o     o     o
   |
0.50  o     o     o     o     o
   |
0.25  o     o     o     o     o
   |
 0 |  o     o     o     o     o
   v
   Y

Roughness (decreases bottom to top)

Legend:
o : Sphere
X : Metalness axis
Y : Roughness axis

Example sphere properties:
Top-left     : Metalness 0.00, Roughness 1.00 (Matte)
Top-right    : Metalness 1.00, Roughness 1.00 (Rough Metal)
Bottom-left  : Metalness 0.00, Roughness 0.00 (Glossy Dielectric)
Bottom-right : Metalness 1.00, Roughness 0.00 (Polished Metal)
Center       : Metalness 0.50, Roughness 0.50 (Semi-glossy, Semi-metallic)
 */

export function generateMaterialSpheres( rows = 5, columns = 5, spacing = 1.2 ) {

	const sphereGroup = new Group();
	const sphereGeometry = new SphereGeometry( 0.5, 32, 32 );

	for ( let i = 0; i < rows; i ++ ) {

		for ( let j = 0; j < columns; j ++ ) {

			const material = new MeshPhysicalMaterial( {
				metalness: j / ( columns - 1 ),
				roughness: i / ( rows - 1 ),
				color: 0xFFD700
			} );

			const sphere = new Mesh( sphereGeometry, material );
			sphere.position.set(
				( j - ( columns - 1 ) / 2 ) * spacing,
				( i - ( rows - 1 ) / 2 ) * spacing,
				0
			);

			// Add a label to the sphere
			const label = new Object3D();
			label.name = `Metalness: ${material.metalness.toFixed( 2 )}, Roughness: ${material.roughness.toFixed( 2 )}`;
			sphere.add( label );

			sphereGroup.add( sphere );

		}

	}

	return sphereGroup;

}


