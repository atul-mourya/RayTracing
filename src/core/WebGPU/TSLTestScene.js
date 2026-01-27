import { Fn, uv, sin, cos, time, vec4, float } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';

/**
 * Creates a test material to validate TSL works correctly.
 * Displays an animated color gradient based on UV coordinates.
 *
 * @returns {MeshBasicNodeMaterial} The test material
 */
export function createTestMaterial() {

	const testShader = Fn( () => {

		const screenUV = uv();
		const t = time;

		// Create animated color gradient
		const r = sin( screenUV.x.mul( 10.0 ).add( t ) ).mul( 0.5 ).add( 0.5 );
		const g = cos( screenUV.y.mul( 10.0 ).add( t ) ).mul( 0.5 ).add( 0.5 );
		const b = float( 0.5 );

		return vec4( r, g, b, 1.0 );

	} );

	const material = new MeshBasicNodeMaterial();
	material.colorNode = testShader();

	return material;

}

/**
 * Creates a fullscreen quad with the test material.
 *
 * @returns {QuadMesh} The test quad mesh
 */
export function createTestQuad() {

	const material = createTestMaterial();
	return new QuadMesh( material );

}
