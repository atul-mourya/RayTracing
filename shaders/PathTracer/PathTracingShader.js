import { Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/examples/jsm/Addons.js';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

class PathTracingShader extends ShaderPass {

	constructor( triangles = [], triangleTexture = null, normalTexture = null, spheres = [] ) {

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
				triangleTexSize: { value: new Vector2() },

				normalTexture: { value: normalTexture },
				normalTexSize: { value: new Vector2() },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader

		} );

		this.uniforms.triangleTexSize.value.set( triangleTexture.image.width, triangleTexture.image.height );
		this.uniforms.normalTexSize.value.set( normalTexture.image.width, normalTexture.image.height );

	}

}

export default PathTracingShader;
