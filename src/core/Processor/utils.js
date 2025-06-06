import { SphereGeometry, Mesh, MeshPhysicalMaterial, Group, Object3D, Color, Vector3 } from 'three';
import { useStore } from '@/store';

export const resetLoading = () => useStore.getState().resetLoading();
export const updateLoading = ( loadingState ) => {

	const state = useStore.getState();
	const loading = state.loading;
	const newLoading = { ...loading, ...loadingState };
	state.setLoading( newLoading );

};

export const updateStats = ( statsUpdate ) => {

	const state = useStore.getState();
	const stats = state.stats || {};
	const newStats = { ...stats, ...statsUpdate };
	state.setStats( newStats );

};

export function getNearestPowerOf2( size ) {

	return Math.pow( 2, Math.ceil( Math.log2( size ) ) );

}

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

export function getDisneyUniforms( material ) {

	// Default Disney BRDF uniform values
	const defaults = {
		baseColor: new Color( 0xffffff ),
		subsurface: 0.0,
		metallic: 0.0,
		specular: 0.5,
		specularTint: 0.0,
		roughness: 0.5,
		anisotropic: 0.0,
		sheen: 0.0,
		sheenTint: 0.5,
		clearcoat: 0.0,
		clearcoatGloss: 0.0,
		ior: 1.5,
		transmission: 0.0,
		opacity: 1.0,
		emissive: new Color( 0x000000 ),
		emissiveIntensity: 1.0
	};

	// Initialize uniforms object with default values wrapped in uniform objects
	const uniforms = Object.entries( defaults ).reduce( ( acc, [ key, value ] ) => {

		acc[ key ] = { value: value };
		return acc;

	}, {} );

	// If no material is provided, return default uniforms
	if ( ! material ) return uniforms;

	// Map material properties to Disney uniforms
	if ( material.isMeshStandardMaterial ) {

		uniforms.baseColor.value = material.color;
		uniforms.roughness.value = material.roughness;
		uniforms.metallic.value = material.metallic;
		uniforms.emissive.value = material.emissive;
		uniforms.emissiveIntensity.value = material.emissiveIntensity;
		uniforms.opacity.value = material.opacity;

		// Extract maps if they exist
		if ( material.map ) {

			uniforms.baseColorMap = { value: material.map };

		}

		if ( material.roughnessMap ) {

			uniforms.roughnessMap = { value: material.roughnessMap };

		}

		if ( material.metalnessMap ) {

			uniforms.metallicMap = { value: material.metalnessMap };

		}

		if ( material.normalMap ) {

			uniforms.normalMap = { value: material.normalMap };
			uniforms.normalScale = { value: material.normalScale };

		}

		if ( material.emissiveMap ) {

			uniforms.emissiveMap = { value: material.emissiveMap };

		}

	} else if ( material.isMeshPhysicalMaterial ) {

		// Include all MeshStandardMaterial properties
		uniforms.baseColor.value = material.color;
		uniforms.roughness.value = material.roughness;
		uniforms.metallic.value = material.metallic;
		uniforms.emissive.value = material.emissive;
		uniforms.emissiveIntensity.value = material.emissiveIntensity;
		uniforms.opacity.value = material.opacity;

		// Add physical material specific properties
		uniforms.clearcoat.value = material.clearcoat;
		uniforms.clearcoatGloss.value = 1 - material.clearcoatRoughness;
		uniforms.ior.value = material.ior;
		uniforms.transmission.value = material.transmission;

		// Extract maps
		if ( material.clearcoatMap ) {

			uniforms.clearcoatMap = { value: material.clearcoatMap };

		}

		if ( material.clearcoatRoughnessMap ) {

			uniforms.clearcoatGlossMap = { value: material.clearcoatRoughnessMap };

		}

		if ( material.clearcoatNormalMap ) {

			uniforms.clearcoatNormalMap = { value: material.clearcoatNormalMap };

		}

		if ( material.transmissionMap ) {

			uniforms.transmissionMap = { value: material.transmissionMap };

		}

	} else if ( material.isMeshBasicMaterial ||
             material.isMeshLambertMaterial ||
             material.isMeshPhongMaterial ) {

		// Basic conversion for simpler materials
		uniforms.baseColor.value = material.color;
		uniforms.opacity.value = material.opacity;
		uniforms.emissive.value = material.emissive || new Color( 0x000000 );

		// Estimate roughness and metallic from shininess if available
		if ( 'shininess' in material ) {

			uniforms.roughness.value = 1 - Math.min( 1, material.shininess / 100 );
			uniforms.specular.value = material.specular ?
				( material.specular.r + material.specular.g + material.specular.b ) / 3 :
				0.5;

		}

		// Extract maps
		if ( material.map ) {

			uniforms.baseColorMap = { value: material.map };

		}

	}

	// Add common Three.js uniform values needed for shading
	uniforms.cameraPosition = { value: new Vector3() };
	uniforms.time = { value: 0 };

	return uniforms;

}

