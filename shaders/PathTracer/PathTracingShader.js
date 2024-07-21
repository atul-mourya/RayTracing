import { Vector2, Vector3 } from 'three';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';

const PathTracingShader = {

	name: 'PathTracingShader',

    defines: {
        MAX_TRIANGLE_COUNT: 12,
        MAX_SPHERE_COUNT: 0
    },

	uniforms: {

		resolution: { value: new Vector2(window.innerWidth, window.innerHeight) },

		cameraPos: { value: new Vector3() },
		cameraDir: { value: new Vector3() },
		cameraRight: { value: new Vector3() },
		cameraUp: { value: new Vector3() },

		frame: { value: 0 },
		maxBounceCount: { value: 1 },
		numRaysPerPixel: { value: 1 },

		spheres: { value: [] },
		// triangles: { value: [] },

        triangleTexture: { value: null },
        triangleTexSize: { value: new Vector2() },

        normalTexture: { value: null },
        normalTexSize: { value: new Vector2() },

	},

	vertexShader: VertexShader,
	fragmentShader: FragmentShader

};

export default PathTracingShader;