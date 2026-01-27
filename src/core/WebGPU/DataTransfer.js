import { TRIANGLE_DATA_LAYOUT } from '../../Constants.js';

/**
 * Data Transfer utility for bridging existing PathTracerApp data to WebGPU.
 * Extracts triangle and BVH data from the existing WebGL-based implementation.
 */
export class DataTransfer {

	/**
	 * Gets the TriangleSDF instance from PathTracerApp.
	 * Data is stored at pathTracerApp.pathTracingPass.sdfs
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {TriangleSDF|null} The SDF instance or null
	 */
	static getSDFs( pathTracerApp ) {

		return pathTracerApp?.pathTracingPass?.sdfs || null;

	}

	/**
	 * Gets the triangle texture directly from PathTracerApp.
	 * This is the preferred method as it avoids data copying.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {DataTexture|null} Triangle texture or null if not available
	 */
	static getTriangleTexture( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		return sdfs?.triangleTexture || null;

	}

	/**
	 * Gets the BVH texture directly from PathTracerApp.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {DataTexture|null} BVH texture or null if not available
	 */
	static getBVHTexture( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		return sdfs?.bvhTexture || null;

	}

	/**
	 * Gets triangle data from an existing PathTracerApp instance.
	 * Reuses the same Float32Array format used by the WebGL path tracer.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Float32Array|null} Triangle data or null if not available
	 */
	static getTriangleData( pathTracerApp ) {

		// Primary location: pathTracerApp.pathTracingPass.sdfs.triangleTexture
		const sdfs = this.getSDFs( pathTracerApp );
		const triangleTexture = sdfs?.triangleTexture;

		if ( triangleTexture?.image?.data ) {

			return triangleTexture.image.data;

		}

		// Fallback: Try from uniform value
		const uniformTexture = pathTracerApp?.pathTracingPass?.material?.uniforms?.triangleTexture?.value;

		if ( uniformTexture?.image?.data ) {

			return uniformTexture.image.data;

		}

		console.warn( 'DataTransfer: Could not find triangle data in PathTracerApp' );
		console.warn( '  - Check that a model is loaded and pathTracerApp.pathTracingPass.sdfs exists' );
		return null;

	}

	/**
	 * Gets BVH data from an existing PathTracerApp instance.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Float32Array|null} BVH data or null if not available
	 */
	static getBVHData( pathTracerApp ) {

		// Primary location: pathTracerApp.pathTracingPass.sdfs.bvhTexture
		const sdfs = this.getSDFs( pathTracerApp );
		const bvhTexture = sdfs?.bvhTexture;

		if ( bvhTexture?.image?.data ) {

			return bvhTexture.image.data;

		}

		// Fallback: Try from uniform value
		const uniformTexture = pathTracerApp?.pathTracingPass?.material?.uniforms?.bvhTexture?.value;

		if ( uniformTexture?.image?.data ) {

			return uniformTexture.image.data;

		}

		console.warn( 'DataTransfer: Could not find BVH data in PathTracerApp' );
		return null;

	}

	/**
	 * Gets the material texture directly from PathTracerApp.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {DataTexture|null} Material texture or null if not available
	 */
	static getMaterialTexture( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		return sdfs?.materialTexture || null;

	}

	/**
	 * Gets the environment texture from PathTracerApp.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {DataTexture|null} Environment texture or null if not available
	 */
	static getEnvironmentTexture( pathTracerApp ) {

		// Try from stage uniforms
		const stage = pathTracerApp?.pathTracingPass;
		if ( stage?.material?.uniforms?.envMap?.value ) {

			return stage.material.uniforms.envMap.value;

		}

		// Try from scene environment
		if ( pathTracerApp?.scene?.environment ) {

			return pathTracerApp.scene.environment;

		}

		return null;

	}

	/**
	 * Gets material data from an existing PathTracerApp instance.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Float32Array|null} Material data or null if not available
	 */
	static getMaterialData( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		const materialTexture = sdfs?.materialTexture;

		if ( materialTexture?.image?.data ) {

			return materialTexture.image.data;

		}

		return null;

	}

	/**
	 * Gets all scene data from an existing PathTracerApp instance.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Object} Object containing all available data
	 */
	static getAllSceneData( pathTracerApp ) {

		return {
			triangles: this.getTriangleData( pathTracerApp ),
			bvh: this.getBVHData( pathTracerApp ),
			materials: this.getMaterialData( pathTracerApp )
		};

	}

	/**
	 * Validates triangle data structure.
	 *
	 * @param {Float32Array} data - Triangle data to validate
	 * @returns {Object} Validation result with isValid and stats
	 */
	static validateTriangleData( data ) {

		if ( ! data || ! ( data instanceof Float32Array ) ) {

			return { isValid: false, error: 'Data is not a Float32Array' };

		}

		const floatsPerTriangle = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const triangleCount = data.length / floatsPerTriangle;

		if ( ! Number.isInteger( triangleCount ) ) {

			return {
				isValid: false,
				error: `Data length ${data.length} is not divisible by ${floatsPerTriangle}`
			};

		}

		return {
			isValid: true,
			triangleCount,
			totalFloats: data.length,
			vec4Count: data.length / 4
		};

	}

	/**
	 * Copies camera settings from existing app to target camera.
	 *
	 * @param {PathTracerApp} pathTracerApp - Source app
	 * @param {PerspectiveCamera} targetCamera - Target camera to configure
	 */
	static copyCameraSettings( pathTracerApp, targetCamera ) {

		const sourceCamera = pathTracerApp?.camera;

		if ( ! sourceCamera ) {

			console.warn( 'DataTransfer: No source camera found' );
			return;

		}

		targetCamera.position.copy( sourceCamera.position );
		targetCamera.quaternion.copy( sourceCamera.quaternion );
		targetCamera.fov = sourceCamera.fov;
		targetCamera.near = sourceCamera.near;
		targetCamera.far = sourceCamera.far;
		targetCamera.updateProjectionMatrix();

	}

	/**
	 * Checks if scene data is available and logs debug info.
	 *
	 * @param {PathTracerApp} pathTracerApp - The path tracer app to check
	 * @returns {Object} Status object with availability info
	 */
	static checkDataAvailability( pathTracerApp ) {

		const status = {
			appExists: !! pathTracerApp,
			pathTracingPassExists: !! pathTracerApp?.pathTracingPass,
			sdfsExists: !! pathTracerApp?.pathTracingPass?.sdfs,
			triangleTextureExists: !! pathTracerApp?.pathTracingPass?.sdfs?.triangleTexture,
			bvhTextureExists: !! pathTracerApp?.pathTracingPass?.sdfs?.bvhTexture,
			triangleDataExists: !! pathTracerApp?.pathTracingPass?.sdfs?.triangleTexture?.image?.data,
			bvhDataExists: !! pathTracerApp?.pathTracingPass?.sdfs?.bvhTexture?.image?.data
		};

		status.ready = status.triangleDataExists && status.bvhDataExists;

		console.log( 'DataTransfer availability check:', status );

		if ( ! status.ready ) {

			console.log( 'Data path: window.pathTracerApp.pathTracingPass.sdfs.triangleTexture.image.data' );

			if ( ! status.appExists ) {

				console.warn( '  -> pathTracerApp is not available' );

			} else if ( ! status.pathTracingPassExists ) {

				console.warn( '  -> pathTracingPass not initialized yet' );

			} else if ( ! status.sdfsExists ) {

				console.warn( '  -> sdfs (TriangleSDF) not created yet' );

			} else if ( ! status.triangleTextureExists ) {

				console.warn( '  -> No model loaded - triangleTexture is null' );

			}

		}

		return status;

	}

}
