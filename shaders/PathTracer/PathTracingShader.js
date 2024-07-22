import { Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( triangleSDF, spheres = [] ) {

		let triangles = triangleSDF.triangles;
		let triangleTexture = triangleSDF.triangleTexture || null;
		let normalTexture = triangleSDF.normalTexture || null;
		let materialTexture = triangleSDF.materialTexture || null;
		let triangleMaterialMappingTexture = triangleSDF.triangleMaterialMappingTexture || null;

		super( {

			name: 'PathTracingShader',

			defines: {
				MAX_TRIANGLE_COUNT: triangles.length,
				MAX_SPHERE_COUNT: spheres.length
			},

			uniforms: {

				resolution: { value: new Vector2( window.innerWidth, window.innerHeight ) },

				cameraPos: { value: new Vector3() },
				cameraDir: { value: new Vector3() },
				cameraRight: { value: new Vector3() },
				cameraUp: { value: new Vector3() },

				frame: { value: 0 },
				maxBounceCount: { value: 1 },
				numRaysPerPixel: { value: 1 },

				spheres: { value: spheres },
				// triangles: { value: [] },

				triangleTexture: { value: triangleTexture },
				triangleTexSize: { value: triangleTexture ? new Vector2( triangleTexture.image.width, triangleTexture.image.height ) : new Vector2() },

				normalTexture: { value: normalTexture },
				normalTexSize: { value: normalTexture ? new Vector2( normalTexture.image.width, normalTexture.image.height ) : new Vector2() },

				materialTexture: { value: materialTexture },
				materialTexSize: { value: materialTexture ? new Vector2( materialTexture.image.width, materialTexture.image.height ) : new Vector2() },

				triangleMaterialMappingTexture: { value: triangleMaterialMappingTexture },
				triangleMaterialMappingTexSize: { value: triangleMaterialMappingTexture ? new Vector2( triangleMaterialMappingTexture.image.width, triangleMaterialMappingTexture.image.height ) : new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

	}

}

export default PathTracingShader;
