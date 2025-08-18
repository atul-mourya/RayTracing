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

		return new ShaderMaterial( {
			name: 'PathTracingShader',
			defines: {
				MAX_SPHERE_COUNT: 0,
				MAX_DIRECTIONAL_LIGHTS: 0,
				MAX_AREA_LIGHTS: 0,
				ENABLE_ACCUMULATION: '',
				...defines
			},
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
