import { Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( triangleSDF, spheres = [], width, height ) {

		let triangles = triangleSDF.triangles;
		let triangleTexture = triangleSDF.triangleTexture || null;
		let meshInfoTexture = triangleSDF.meshInfoTexture;

		super( {

			name: 'PathTracingShader',

			defines: {
				MAX_TRIANGLE_COUNT: triangles.length,
				MAX_SPHERE_COUNT: spheres.length,
				MAX_MESH_COUNT: triangleSDF.meshInfos.length
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },

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

				meshInfoTexture: { value: meshInfoTexture },
				meshInfoTexSize: { value: meshInfoTexture ? new Vector2( meshInfoTexture.image.width, meshInfoTexture.image.height ) : new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

	}

}

export default PathTracingShader;
