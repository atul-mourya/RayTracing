/**
 * PathTracerUtils.js
 * Utility functions and helpers for path tracing operations
 */

import {
	ShaderMaterial,
	Vector2,
	Matrix4,
	GLSL3
} from 'three';

export class PathTracerUtils {

	/**
     * Calculate completion threshold based on render mode
     * @param {number} renderMode - 0 for full quad, 1 for tiled
     * @param {number} maxFrames - Maximum frames to render
     * @param {number} totalTiles - Total number of tiles (tiles²)
     * @returns {number} - Completion threshold
     */
	static updateCompletionThreshold( renderMode, maxFrames, totalTiles ) {

		return renderMode === 1 ? totalTiles * maxFrames : maxFrames;

	}

	/**
     * Create a debounced function for render mode changes
     * @param {Function} callback - Function to call after debounce
     * @param {number} delay - Delay in milliseconds
     * @returns {Function} - Debounced function
     */
	static createDebounceFunction( callback, delay ) {

		let timeoutId = null;
		let pendingValue = null;

		return function ( value ) {

			if ( timeoutId ) {

				clearTimeout( timeoutId );

			}

			pendingValue = value;
			timeoutId = setTimeout( () => {

				if ( pendingValue !== null ) {

					callback( pendingValue );

				}

				timeoutId = null;
				pendingValue = null;

			}, delay );

		};

	}

	/**
     * Create shader material with standard path tracing setup
     * @param {Object} options - Material options
     * @param {string} options.vertexShader - Vertex shader source
     * @param {string} options.fragmentShader - Fragment shader source
     * @param {Object} options.uniforms - Uniform definitions
     * @param {Object} options.defines - Shader defines
     * @returns {ShaderMaterial} - Configured shader material
     */
	static createPathTracingMaterial( options ) {

		const {
			vertexShader,
			fragmentShader,
			uniforms = {},
			defines = {}
		} = options;

		const finalDefines = {
			MAX_SPHERE_COUNT: 0,
			MAX_DIRECTIONAL_LIGHTS: 0,
			MAX_AREA_LIGHTS: 0,
			MAX_POINT_LIGHTS: 0,
			MAX_SPOT_LIGHTS: 0,
			ENABLE_ACCUMULATION: '',
			...defines
		};

		// Check for old GPU and enable compatibility mode
		const canvas = document.createElement( 'canvas' );
		const gl = canvas.getContext( 'webgl2' );
		if ( gl ) {

			const renderer = gl.getParameter( gl.RENDERER );
			const isOldGPU = renderer.includes( '8800' ) || // NVIDIA 8xxx series
							 renderer.includes( '9800' ) || // NVIDIA 9xxx series
							 renderer.includes( 'HD 2' ) || // AMD HD 2xxx
							 renderer.includes( 'HD 3' ) || // AMD HD 3xxx
							 renderer.includes( 'HD 4' ) || // AMD HD 4xxx
							 renderer.includes( 'Intel(R) HD Graphics 3' ) || // Intel HD 3xxx
							 renderer.includes( 'Intel(R) HD Graphics 4' ); // Intel HD 4xxx

			if ( isOldGPU ) {

				console.warn( '🚧 OLD GPU DETECTED - Enabling compatibility mode' );
				console.warn( '   GPU:', renderer );
				console.warn( '   Disabling advanced features to reduce shader complexity...' );

				// Disable all advanced features for old GPUs
				delete finalDefines.ENABLE_TRANSMISSION;
				delete finalDefines.ENABLE_CLEARCOAT;
				delete finalDefines.ENABLE_SHEEN;
				delete finalDefines.ENABLE_IRIDESCENCE;
				delete finalDefines.ENABLE_ANISOTROPY;
				delete finalDefines.ENABLE_EMISSIVE_TRIANGLE_SAMPLING;
				delete finalDefines.ENABLE_TRANSPARENCY;
				delete finalDefines.ENABLE_MRT_OUTPUTS;

				// Also reduce sampling complexity
				finalDefines.SIMPLE_SAMPLING = ''; // Signal to use simpler sampling in shaders

				console.warn( '   ✅ Compatibility mode enabled' );
				console.warn( '   - Disabled: transmission, clearcoat, sheen, iridescence' );
				console.warn( '   - Disabled: transparency, MRT outputs' );
				console.warn( '   - Shader size reduced by ~50%' );
				console.warn( '   - If still fails, this GPU may be too old for path tracing' );

			}

		}

		// Debug logging: Log shader compilation with defines
		console.log( '🔧 Creating PathTracingShader with defines:', finalDefines );

		const material = new ShaderMaterial( {
			name: 'PathTracingShader',
			defines: finalDefines,
			uniforms: {
				resolution: { value: new Vector2() },
				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				frame: { value: 0 },
				...uniforms
			},
			vertexShader,
			fragmentShader,
			glslVersion: GLSL3
		} );

		// Add onBeforeCompile callback to log shader compilation
		material.onBeforeCompile = ( shader ) => {

			const startTime = performance.now();
			console.log( '✨ PathTracingShader compilation started' );
			console.log( '   Defines:', shader.defines );
			console.log( '   Vertex shader length:', shader.vertexShader.length, 'chars' );
			console.log( '   Fragment shader length:', shader.fragmentShader.length, 'chars' );

			// Large shaders can take 5-30 seconds to compile
			if ( shader.fragmentShader.length > 100000 ) {

				console.warn( '⏳ Large shader detected - compilation may take 10-30 seconds. Please wait...' );

			}

			// Use setTimeout to detect if compilation completes
			const timeoutId = setTimeout( () => {

				const elapsed = ( ( performance.now() - startTime ) / 1000 ).toFixed( 1 );
				console.log( `⏱️  Shader still compiling after ${elapsed}s...` );

			}, 5000 ); // Log after 5 seconds

			// Clear timeout on next tick (shader will be compiled by then)
			setTimeout( () => {

				clearTimeout( timeoutId );
				const elapsed = ( ( performance.now() - startTime ) / 1000 ).toFixed( 1 );
				console.log( `✅ PathTracingShader compilation completed in ${elapsed}s` );

			}, 0 );

		};

		return material;

	}

	/**
     * Validate uniform updates and detect changes
     * @param {Object} material - Shader material
     * @param {Object} updates - Object containing uniform updates
     * @returns {boolean} - True if any uniforms were actually changed
     */
	static validateAndUpdateUniforms( material, updates ) {

		let hasChanges = false;

		Object.entries( updates ).forEach( ( [ key, value ] ) => {

			if ( material.uniforms[ key ] &&
                ! PathTracerUtils.areValuesEqual( material.uniforms[ key ].value, value ) ) {

				material.uniforms[ key ].value = value;
				hasChanges = true;

			}

		} );

		return hasChanges;

	}

	/**
     * Deep equality check for uniform values
     * @param {*} a - First value
     * @param {*} b - Second value
     * @returns {boolean} - True if values are equal
     */
	static areValuesEqual( a, b ) {

		if ( a === b ) return true;

		// Handle Vector2, Vector3, Vector4
		if ( a && b && typeof a.equals === 'function' ) {

			return a.equals( b );

		}

		// Handle Matrix3, Matrix4
		if ( a && b && typeof a.equals === 'function' ) {

			return a.equals( b );

		}

		// Handle arrays
		if ( Array.isArray( a ) && Array.isArray( b ) ) {

			if ( a.length !== b.length ) return false;
			return a.every( ( val, index ) => PathTracerUtils.areValuesEqual( val, b[ index ] ) );

		}

		// Handle objects
		if ( a && b && typeof a === 'object' && typeof b === 'object' ) {

			const keysA = Object.keys( a );
			const keysB = Object.keys( b );
			if ( keysA.length !== keysB.length ) return false;
			return keysA.every( key => PathTracerUtils.areValuesEqual( a[ key ], b[ key ] ) );

		}

		return false;

	}

	/**
     * Calculate accumulation alpha based on frame and render mode
     * @param {number} frameValue - Current frame number
     * @param {number} renderMode - Render mode (0 or 1)
     * @param {number} totalTiles - Total number of tiles
     * @param {boolean} isInteractionMode - Whether currently in interaction mode
     * @returns {number} - Alpha value for accumulation
     */
	static calculateAccumulationAlpha( frameValue, renderMode, totalTiles, isInteractionMode = false ) {

		// During interaction mode, always use alpha = 1.0 to avoid accumulating low-quality frames
		if ( isInteractionMode ) {

			return 1.0;

		}

		if ( renderMode === 0 ) {

			// Full quad rendering
			return 1.0 / Math.max( frameValue, 1 );

		} else {

			// Tiled rendering
			if ( frameValue === 0 ) {

				return 1.0; // First frame is full image

			} else {

				// Frame 0 was full image (sample 1), frames 1+ are tile-based
				// Calculate total samples: 1 (from frame 0) + completed tile cycles
				const completedTileCycles = Math.floor( ( frameValue - 1 ) / totalTiles );
				const totalSamples = 1 + completedTileCycles;
				return 1.0 / ( totalSamples + 1 ); // +1 for the current sample being added

			}

		}

	}

	/**
     * Create a performance monitor for tracking frame times
     * @returns {Object} - Performance monitor with start/end methods
     */
	static createPerformanceMonitor() {

		let startTime = 0;
		let endTime = 0;
		let frameCount = 0;
		let totalTime = 0;

		return {
			start() {

				startTime = performance.now();

			},

			end() {

				endTime = performance.now();
				const frameTime = endTime - startTime;
				totalTime += frameTime;
				frameCount ++;
				return frameTime;

			},

			getAverageFrameTime() {

				return frameCount > 0 ? totalTime / frameCount : 0;

			},

			getFPS() {

				const avgFrameTime = this.getAverageFrameTime();
				return avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

			},

			reset() {

				frameCount = 0;
				totalTime = 0;

			}
		};

	}

	/**
     * Optimize shader defines for current state
     * @param {Object} defines - Current shader defines
     * @param {Object} state - Current renderer state
     * @returns {Object} - Optimized defines
     */
	static optimizeShaderDefines( defines, state ) {

		const optimized = { ...defines };

		// Remove unused features to reduce shader compilation time
		if ( ! state.useAdaptiveSampling ) {

			delete optimized.ENABLE_ADAPTIVE_SAMPLING;

		}

		if ( ! state.enableAccumulation ) {

			delete optimized.ENABLE_ACCUMULATION;

		}

		if ( state.sphereCount === 0 ) {

			optimized.MAX_SPHERE_COUNT = 0;

		}

		return optimized;

	}

	/**
     * Calculate spiral tile order for progressive rendering
     * @param {number} tiles - Number of tiles per side
     * @param {Vector2} center - Optional center point (default: geometric center)
     * @returns {Array<number>} - Array of tile indices in spiral order
     */
	static calculateSpiralOrder( tiles, center = null ) {

		const totalTiles = tiles * tiles;
		const centerPoint = center || new Vector2( ( tiles - 1 ) / 2, ( tiles - 1 ) / 2 );
		const tilePositions = [];

		for ( let i = 0; i < totalTiles; i ++ ) {

			const x = i % tiles;
			const y = Math.floor( i / tiles );
			const distance = Math.sqrt(
				Math.pow( x - centerPoint.x, 2 ) +
                Math.pow( y - centerPoint.y, 2 )
			);
			const angle = Math.atan2( y - centerPoint.y, x - centerPoint.x );

			tilePositions.push( {
				index: i,
				x,
				y,
				distance,
				angle
			} );

		}

		// Sort by distance, then by angle for spiral effect
		tilePositions.sort( ( a, b ) => {

			const distanceDiff = a.distance - b.distance;
			if ( Math.abs( distanceDiff ) < 0.01 ) {

				return a.angle - b.angle;

			}

			return distanceDiff;

		} );

		return tilePositions.map( pos => pos.index );

	}

	/**
     * Clamp value between min and max
     * @param {number} value - Value to clamp
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @returns {number} - Clamped value
     */
	static clamp( value, min, max ) {

		return Math.min( Math.max( value, min ), max );

	}

	/**
     * Linear interpolation between two values
     * @param {number} a - Start value
     * @param {number} b - End value
     * @param {number} t - Interpolation factor (0-1)
     * @returns {number} - Interpolated value
     */
	static lerp( a, b, t ) {

		return a + ( b - a ) * PathTracerUtils.clamp( t, 0, 1 );

	}

	/**
     * Check if render is complete based on current state
     * @param {number} frameValue - Current frame
     * @param {number} renderMode - Render mode
     * @param {number} maxFrames - Maximum frames
     * @param {number} totalTiles - Total tiles
     * @returns {boolean} - True if rendering is complete
     */
	static isRenderComplete( frameValue, renderMode, maxFrames, totalTiles ) {

		if ( renderMode === 0 ) {

			return frameValue >= maxFrames;

		} else {

			return frameValue >= maxFrames * totalTiles;

		}

	}

	/**
     * Calculate sample count for current frame and render mode
     * @param {number} frameValue - Current frame
     * @param {number} renderMode - Render mode
     * @param {number} totalTiles - Total tiles
     * @returns {number} - Current sample count
     */
	static getCurrentSampleCount( frameValue, renderMode, totalTiles ) {

		if ( renderMode === 0 ) {

			return frameValue;

		} else {

			return Math.floor( frameValue / totalTiles );

		}

	}

	/**
     * Format time duration for display
     * @param {number} milliseconds - Duration in milliseconds
     * @returns {string} - Formatted duration string
     */
	static formatDuration( milliseconds ) {

		if ( milliseconds < 1000 ) {

			return `${milliseconds.toFixed( 0 )}ms`;

		}

		const seconds = milliseconds / 1000;
		if ( seconds < 60 ) {

			return `${seconds.toFixed( 1 )}s`;

		}

		const minutes = Math.floor( seconds / 60 );
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds.toFixed( 0 )}s`;

	}

	/**
     * Create a cache with LRU eviction policy
     * @param {number} maxSize - Maximum cache size
     * @returns {Object} - Cache object with get/set/clear methods
     */
	static createLRUCache( maxSize ) {

		const cache = new Map();

		return {
			get( key ) {

				if ( cache.has( key ) ) {

					// Move to end (most recently used)
					const value = cache.get( key );
					cache.delete( key );
					cache.set( key, value );
					return value;

				}

				return undefined;

			},

			set( key, value ) {

				if ( cache.has( key ) ) {

					// Update existing
					cache.delete( key );

				} else if ( cache.size >= maxSize ) {

					// Remove least recently used (first item)
					const firstKey = cache.keys().next().value;
					cache.delete( firstKey );

				}

				cache.set( key, value );

			},

			clear() {

				cache.clear();

			},

			size() {

				return cache.size;

			}
		};

	}

}
