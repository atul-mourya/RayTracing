import { Matrix4, Vector2 } from 'three';
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

				numDirectionalLights: { value: sdfs.directionalLights.length },
				directionalLightDirections: { value: sdfs.directionalLights.map( d => d.position.normalize() ) },
				directionalLightColors: { value: sdfs.directionalLights.map( d => d.color ) },
				directionalLightIntensities: { value: sdfs.directionalLights.map( d => d.intensity ) },

				frame: { value: 0 },
				maxBounceCount: { value: 2 },
				numRaysPerPixel: { value: 1 },
				enableEnvironmentLight: { value: true },
				sunElevation: { value: - 0.5 },
				sunAzimuth: { value: 0.5 },
				sunIntensity: { value: 100.0 },

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
