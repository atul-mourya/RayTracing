import { Fn, vec3, vec4, float, uniform, uv, If } from 'three/tsl';
import { Matrix4, Vector3 } from 'three';
import { randomDisk } from './Random.js';

/**
 * Camera Ray module for TSL.
 *
 * Features:
 * - Basic pinhole camera ray generation
 * - Depth of Field (DOF) with thin lens model
 * - Photography-inspired aperture and focus controls
 */

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

/**
 * Creates a DOF (Depth of Field) ray generator using a thin lens model.
 * Produces realistic camera bokeh by sampling points on the lens aperture.
 *
 * @param {PerspectiveCamera} camera - Three.js camera
 * @param {Object} options - DOF options
 * @param {number} options.focusDistance - Distance to focus plane (world units)
 * @param {number} options.aperture - Aperture radius (world units, 0 = pinhole)
 * @param {number} options.focalLength - Focal length in mm (for reference)
 * @returns {Object} DOF ray generator with functions and uniforms
 */
export const createDOFRayGenerator = ( camera, options = {} ) => {

	// DOF uniforms
	const enableDOF = uniform( options.enableDOF !== undefined ? options.enableDOF : false );
	const focusDistance = uniform( options.focusDistance || 5.0 );
	const aperture = uniform( options.aperture || 0.05 );
	const focalLength = uniform( options.focalLength || 50.0 ); // mm

	// Camera uniforms
	const cameraWorldMatrix = uniform( new Matrix4() );
	const cameraProjectionMatrixInverse = uniform( new Matrix4() );

	// Camera basis vectors (extracted from world matrix)
	const cameraRight = uniform( new Vector3( 1, 0, 0 ) );
	const cameraUp = uniform( new Vector3( 0, 1, 0 ) );
	const cameraForward = uniform( new Vector3( 0, 0, - 1 ) );

	/**
	 * Generates a ray with DOF effect.
	 * If DOF is disabled, behaves like a pinhole camera.
	 *
	 * @param {TSLNode} rngState - Mutable RNG state for lens sampling
	 * @returns {Object} Ray with origin and direction
	 */
	const generateRay = Fn( ( [ rngState ] ) => {

		// Get screen UV
		const screenUV = uv();
		const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

		// Generate base ray (pinhole camera)
		const clipPos = vec4( ndc.x, ndc.y, float( - 1.0 ), float( 1.0 ) );
		const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
		const viewDir = viewPos.xyz.div( viewPos.w );

		const worldDirRaw = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
		const pinholeDir = worldDirRaw.normalize();

		// Camera origin (lens center for DOF)
		const cameraPos = vec3(
			cameraWorldMatrix.element( 3 ).x,
			cameraWorldMatrix.element( 3 ).y,
			cameraWorldMatrix.element( 3 ).z
		);

		// Initialize ray outputs
		const rayOrigin = cameraPos.toVar( 'rayOrigin' );
		const rayDir = pinholeDir.toVar( 'rayDir' );

		// Apply DOF if enabled
		If( enableDOF, () => {

			// Sample point on lens (disk sampling)
			const lensOffset2D = randomDisk( rngState ).mul( aperture );

			// Get camera basis vectors from world matrix
			const right = vec3(
				cameraWorldMatrix.element( 0 ).x,
				cameraWorldMatrix.element( 0 ).y,
				cameraWorldMatrix.element( 0 ).z
			).normalize();

			const up = vec3(
				cameraWorldMatrix.element( 1 ).x,
				cameraWorldMatrix.element( 1 ).y,
				cameraWorldMatrix.element( 1 ).z
			).normalize();

			const forward = vec3(
				cameraWorldMatrix.element( 2 ).x,
				cameraWorldMatrix.element( 2 ).y,
				cameraWorldMatrix.element( 2 ).z
			).negate().normalize(); // Camera looks down -Z

			// Lens position offset from camera center
			const lensOffset = right.mul( lensOffset2D.x ).add( up.mul( lensOffset2D.y ) );
			const lensPos = cameraPos.add( lensOffset );

			// Calculate focus point along the pinhole ray
			// t = focusDistance / dot(pinholeDir, forward)
			const rayForwardDot = pinholeDir.dot( forward ).abs().max( 0.001 );
			const focusT = focusDistance.div( rayForwardDot );
			const focusPoint = cameraPos.add( pinholeDir.mul( focusT ) );

			// New ray direction: from lens position to focus point
			const dofDir = focusPoint.sub( lensPos ).normalize();

			rayOrigin.assign( lensPos );
			rayDir.assign( dofDir );

		} );

		return {
			origin: rayOrigin,
			direction: rayDir
		};

	} );

	/**
	 * Updates camera uniforms. Must be called before rendering.
	 */
	const update = () => {

		camera.updateMatrixWorld();
		cameraWorldMatrix.value.copy( camera.matrixWorld );
		cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );

		// Extract basis vectors
		const matrix = camera.matrixWorld;
		cameraRight.value.set( matrix.elements[ 0 ], matrix.elements[ 1 ], matrix.elements[ 2 ] ).normalize();
		cameraUp.value.set( matrix.elements[ 4 ], matrix.elements[ 5 ], matrix.elements[ 6 ] ).normalize();
		cameraForward.value.set( - matrix.elements[ 8 ], - matrix.elements[ 9 ], - matrix.elements[ 10 ] ).normalize();

	};

	/**
	 * Sets the focus distance.
	 * @param {number} distance - Focus distance in world units
	 */
	const setFocusDistance = ( distance ) => {

		focusDistance.value = distance;

	};

	/**
	 * Sets the aperture size.
	 * @param {number} size - Aperture radius in world units (0 = pinhole)
	 */
	const setAperture = ( size ) => {

		aperture.value = size;

	};

	/**
	 * Enables or disables DOF effect.
	 * @param {boolean} enabled - Whether DOF is enabled
	 */
	const setDOFEnabled = ( enabled ) => {

		enableDOF.value = enabled ? 1 : 0;

	};

	/**
	 * Converts f-stop to aperture radius.
	 * Aperture = focalLength / (2 * fNumber)
	 * @param {number} fNumber - f-stop value (e.g., 2.8, 4, 5.6)
	 * @returns {number} Aperture radius in mm (needs to be scaled to world units)
	 */
	const fStopToAperture = ( fNumber ) => {

		return focalLength.value / ( 2 * fNumber );

	};

	return {
		generateRay,
		update,
		setFocusDistance,
		setAperture,
		setDOFEnabled,
		fStopToAperture,
		uniforms: {
			cameraWorldMatrix,
			cameraProjectionMatrixInverse,
			enableDOF,
			focusDistance,
			aperture,
			focalLength
		}
	};

};

/**
 * Creates a DOF ray generator with manual matrix and DOF uniform inputs.
 * Useful when camera matrices and DOF parameters are managed externally.
 *
 * @param {Matrix4Uniform} worldMatrix - Camera world matrix uniform
 * @param {Matrix4Uniform} projInvMatrix - Camera projection inverse matrix uniform
 * @param {Object} dofUniforms - DOF uniforms { enableDOF, focusDistance, aperture }
 * @returns {Function} DOF ray generation TSL function
 */
export const createDOFRayGeneratorManual = ( worldMatrix, projInvMatrix, dofUniforms ) => {

	const { enableDOF, focusDistance, aperture } = dofUniforms;

	return Fn( ( [ rngState ] ) => {

		// Get screen UV
		const screenUV = uv();
		const ndc = screenUV.mul( 2.0 ).sub( 1.0 );

		// Generate base ray (pinhole camera)
		const clipPos = vec4( ndc.x, ndc.y, float( - 1.0 ), float( 1.0 ) );
		const viewPos = projInvMatrix.mul( clipPos );
		const viewDir = viewPos.xyz.div( viewPos.w );

		const worldDirRaw = worldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
		const pinholeDir = worldDirRaw.normalize();

		// Camera origin
		const cameraPos = vec3(
			worldMatrix.element( 3 ).x,
			worldMatrix.element( 3 ).y,
			worldMatrix.element( 3 ).z
		);

		// Initialize ray outputs
		const rayOrigin = cameraPos.toVar( 'rayOrigin' );
		const rayDir = pinholeDir.toVar( 'rayDir' );

		// Apply DOF if enabled
		If( enableDOF, () => {

			// Sample lens
			const lensOffset2D = randomDisk( rngState ).mul( aperture );

			// Get camera basis
			const right = vec3(
				worldMatrix.element( 0 ).x,
				worldMatrix.element( 0 ).y,
				worldMatrix.element( 0 ).z
			).normalize();

			const up = vec3(
				worldMatrix.element( 1 ).x,
				worldMatrix.element( 1 ).y,
				worldMatrix.element( 1 ).z
			).normalize();

			const forward = vec3(
				worldMatrix.element( 2 ).x,
				worldMatrix.element( 2 ).y,
				worldMatrix.element( 2 ).z
			).negate().normalize();

			// Lens position
			const lensOffset = right.mul( lensOffset2D.x ).add( up.mul( lensOffset2D.y ) );
			const lensPos = cameraPos.add( lensOffset );

			// Focus point
			const rayForwardDot = pinholeDir.dot( forward ).abs().max( 0.001 );
			const focusT = focusDistance.div( rayForwardDot );
			const focusPoint = cameraPos.add( pinholeDir.mul( focusT ) );

			// DOF direction
			const dofDir = focusPoint.sub( lensPos ).normalize();

			rayOrigin.assign( lensPos );
			rayDir.assign( dofDir );

		} );

		return {
			origin: rayOrigin,
			direction: rayDir
		};

	} );

};
