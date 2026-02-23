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
	 * Gets raw BVH Float32Array from the BVH DataTexture.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Float32Array|null} Raw BVH data or null
	 */
	static getBVHRawData( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		return sdfs?.bvhTexture?.image?.data || null;

	}

	/**
	 * Gets raw material Float32Array from the material DataTexture.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Float32Array|null} Raw material data or null
	 */
	static getMaterialRawData( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		return sdfs?.materialTexture?.image?.data || null;

	}

	/**
	 * Gets raw triangle data and count from an existing PathTracerApp instance.
	 * Returns the original Float32Array from TriangleSDF (source data, not texture).
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {{ triangleData: Float32Array, triangleCount: number }|null} Raw data or null
	 */
	static getTriangleRawData( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );

		if ( sdfs?.triangleData && sdfs.triangleCount > 0 ) {

			return { triangleData: sdfs.triangleData, triangleCount: sdfs.triangleCount };

		}

		console.warn( 'DataTransfer: Could not find raw triangle data in PathTracerApp' );
		console.warn( '  - Check that a model is loaded and pathTracerApp.pathTracingPass.sdfs exists' );
		return null;

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
	 * Gets material texture arrays (albedo, normal, bump, etc.) from PathTracerApp.
	 * These are DataArrayTexture instances used for texture sampling in shaders.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Object} Object containing texture arrays
	 */
	static getMaterialTextureArrays( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		if ( ! sdfs ) return {};

		return {
			albedoMaps: sdfs.albedoTextures || null,
			normalMaps: sdfs.normalTextures || null,
			bumpMaps: sdfs.bumpTextures || null,
			roughnessMaps: sdfs.roughnessTextures || null,
			metalnessMaps: sdfs.metalnessTextures || null,
			emissiveMaps: sdfs.emissiveTextures || null,
			displacementMaps: sdfs.displacementTextures || null,
		};

	}

	/**
	 * Gets emissive triangle raw data for storage buffer upload.
	 *
	 * @param {PathTracerApp} pathTracerApp - The existing path tracer app
	 * @returns {Object} Object with emissiveTriangleData (Float32Array) and emissiveTriangleCount
	 */
	static getEmissiveTriangleData( pathTracerApp ) {

		const sdfs = this.getSDFs( pathTracerApp );
		const rawData = sdfs?.emissiveTriangleData || sdfs?.emissiveTriangleTexture?.image?.data || null;
		return {
			emissiveTriangleData: rawData,
			emissiveTriangleCount: sdfs?.emissiveTriangleCount || 0,
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
