import { Matrix4, Vector2, Vector3, Color } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( sdfs, width, height ) {

		let triangleTexture = sdfs.triangleTexture || null;
		let materialTexture = sdfs.materialTexture;
		let bvhTexture = sdfs.bvhTexture;
		let diffuseTextures = sdfs.diffuseTextures;

		super( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: sdfs.spheres.length,
				MAX_DIRECTIONAL_LIGHTS: sdfs.directionalLights.length
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				sceneBackground: { value: scene.background },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },

				directionalLightDirection: { value: scene.getObjectByName( 'directionLight' ).position.normalize().negate() },
				directionalLightColor: { value: scene.getObjectByName( 'directionLight' ).color },
				directionalLightIntensity: { value: scene.getObjectByName( 'directionLight' ).intensity },


				frame: { value: 0 },
				maxBounceCount: { value: 2 },
				numRaysPerPixel: { value: 1 },
				enableEnvironmentLight: { value: true },

				visualizeBVH: { value: false },
				maxBVHDepth: { value: 32 },

				spheres: { value: sdfs.spheres },

				diffuseTextures: { value: sdfs.diffuseTextures },
				diffuseTexSize: { value: diffuseTextures ? new Vector2( diffuseTextures.image.width, diffuseTextures.image.height ) : new Vector2() },

				triangleTexture: { value: triangleTexture },
				triangleTexSize: { value: triangleTexture ? new Vector2( triangleTexture.image.width, triangleTexture.image.height ) : new Vector2() },

				bvhTexture: { value: bvhTexture },
				bvhTexSize: { value: bvhTexture ? new Vector2( bvhTexture.image.width, bvhTexture.image.height ) : new Vector2() },

				materialTexture: { value: materialTexture },
				materialTexSize: { value: materialTexture ? new Vector2( materialTexture.image.width, materialTexture.image.height ) : new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

	}

}

export default PathTracingShader;
