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
