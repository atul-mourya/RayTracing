import { Fn, vec4, uniform, uv } from 'three/tsl';
import { Matrix4 } from 'three';

/**
 * Creates a ray generator for camera rays.
 * Generates primary rays from the camera through each pixel.
 *
 * @param {PerspectiveCamera} camera - Three.js camera
 * @returns {Object} Ray generator with generateRay function and update method
 */
export const createRayGenerator = ( camera ) => {

	// Uniforms for camera matrices - updated each frame
	const cameraWorldMatrix = uniform( new Matrix4() );
	const cameraProjectionMatrixInverse = uniform( new Matrix4() );

	/**
	 * Generates a ray for the current fragment/pixel.
	 * Uses UV coordinates to determine screen position.
	 *
	 * @returns {Object} Ray with origin and direction
	 */
	const generateRay = Fn( () => {

		// Get screen UV (0-1 range)
		const screenUV = uv();

		// Convert UV to NDC (-1 to 1 range)
		const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

		// Create clip space position (near plane)
		const clipPos = vec4( ndc.x, ndc.y, - 1.0, 1.0 );

		// Unproject to view space
		const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
		const viewDir = viewPos.xyz.div( viewPos.w );

		// Transform direction to world space (w=0 for direction)
		const worldDir = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz.normalize();

		// Get camera world position (w=1 for position)
		const worldOrigin = cameraWorldMatrix.mul( vec4( 0, 0, 0, 1 ) ).xyz;

		return {
			origin: worldOrigin,
			direction: worldDir
		};

	} );

	/**
	 * Updates camera uniforms. Must be called before rendering.
	 */
	const update = () => {

		camera.updateMatrixWorld();
		cameraWorldMatrix.value.copy( camera.matrixWorld );
		cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );

	};

	return {
		generateRay,
		update,
		// Expose uniforms for external access if needed
		uniforms: {
			cameraWorldMatrix,
			cameraProjectionMatrixInverse
		}
	};

};

/**
 * Creates a ray generator with manual matrix inputs.
 * Useful when camera matrices are managed externally.
 *
 * @param {Matrix4Uniform} worldMatrix - Camera world matrix uniform
 * @param {Matrix4Uniform} projInvMatrix - Camera projection inverse matrix uniform
 * @returns {Function} Ray generation TSL function
 */
export const createRayGeneratorManual = ( worldMatrix, projInvMatrix ) => {

	return Fn( () => {

		const screenUV = uv();
		const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

		const clipPos = vec4( ndc.x, ndc.y, - 1.0, 1.0 );
		const viewPos = projInvMatrix.mul( clipPos );
		const viewDir = viewPos.xyz.div( viewPos.w );

		const worldDir = worldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz.normalize();
		const worldOrigin = worldMatrix.mul( vec4( 0, 0, 0, 1 ) ).xyz;

		return {
			origin: worldOrigin,
			direction: worldDir
		};

	} );

};
