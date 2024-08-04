import { Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( sdfs, width, height ) {

		let triangles = sdfs.triangles;
		let triangleTexture = sdfs.triangleTexture || null;
		let meshInfoTexture = sdfs.meshInfoTexture;

		super( {

			name: 'PathTracingShader',

			defines: {
				MAX_TRIANGLE_COUNT: triangles.length,
				MAX_SPHERE_COUNT: sdfs.spheres.length,
				MAX_MESH_COUNT: sdfs.meshInfos.length
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },

				cameraPos: { value: new Vector3() },
				cameraDir: { value: new Vector3() },
				cameraRight: { value: new Vector3() },
				cameraUp: { value: new Vector3() },

				frame: { value: 0 },
				maxBounceCount: { value: 2 },
				numRaysPerPixel: { value: 1 },
				enableEnvironmentLight: { value: true },
				sunElevation: { value: - 0.5 },
				sunAzimuth: { value: 0.5 },
				sunIntensity: { value: 100.0 },

				spheres: { value: sdfs.spheres },

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
