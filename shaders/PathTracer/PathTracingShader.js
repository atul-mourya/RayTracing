import { Matrix4, Vector2, Vector3, Color } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( sdfs = {}, width, height ) {

		let triangleTexture = sdfs.triangleTexture || null;
		let materialTexture = sdfs.materialTexture;
		let bvhTexture = sdfs.bvhTexture;
		let diffuseTextures = sdfs.diffuseTextures;
		let spheres = sdfs.spheres ?? [];
		const scene = window.scene ?? null;

		super( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: spheres.length,
				MAX_DIRECTIONAL_LIGHTS: sdfs?.directionalLights?.length
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				enableEnvironmentLight: { value: true },
				envMap: { value: scene ? scene.background : null },
				envMapIntensity: { value: scene ? scene.environmentIntensity : 0 },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focalDistance: { value: 1 },
				aperture: { value: 0.001 },

				directionalLightDirection: { value: scene ? scene.getObjectByName( 'directionLight' ).position.normalize().negate() : new Vector3() },
				directionalLightColor: { value: scene ? scene.getObjectByName( 'directionLight' ).color : new Vector3() },
				directionalLightIntensity: { value: scene ? scene.getObjectByName( 'directionLight' ).intensity : 0 },


				frame: { value: 0 },
				maxBounceCount: { value: 2 },
				numRaysPerPixel: { value: 1 },

				visMode: { value: 0 },
				debugVisScale: { value: 100 },

				spheres: { value: sdfs?.spheres },

				diffuseTextures: { value: sdfs?.diffuseTextures },
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

	update( sdfs ) {

		this.defines = {
			MAX_SPHERE_COUNT: sdfs.spheres.length,
			MAX_DIRECTIONAL_LIGHTS: sdfs.directionalLights.length
		};
		this.uniforms.spheres.value = sdfs.spheres;
		this.uniforms.diffuseTextures.value = sdfs.diffuseTextures;
		this.uniforms.diffuseTexSize.value = sdfs.diffuseTextures ? new Vector2( sdfs.diffuseTextures.image.width, sdfs.diffuseTextures.image.height ) : new Vector2();
		this.uniforms.triangleTexture.value = sdfs.triangleTexture;
		this.uniforms.triangleTexSize.value = sdfs.triangleTexture ? new Vector2( sdfs.triangleTexture.image.width, sdfs.triangleTexture.image.height ) : new Vector2();
		this.uniforms.bvhTexture.value = sdfs.bvhTexture;
		this.uniforms.bvhTexSize.value = sdfs.bvhTexture ? new Vector2( sdfs.bvhTexture.image.width, sdfs.bvhTexture.image.height ) : new Vector2();
		this.uniforms.materialTexture.value = sdfs.materialTexture;
		this.uniforms.materialTexSize.value = sdfs.materialTexture ? new Vector2( sdfs.materialTexture.image.width, sdfs.materialTexture.image.height ) : new Vector2();

	}

}

export default PathTracingShader;
