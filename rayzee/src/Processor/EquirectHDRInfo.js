import { DataUtils, HalfFloatType, FloatType } from 'three';

/**
 * Binary search to find the closest index
 */
function binarySearchFindClosestIndexOf( array, targetValue, offset = 0, count = array.length ) {

	let lower = offset;
	let upper = offset + count - 1;

	while ( lower < upper ) {

		const mid = ( lower + upper ) >> 1;

		if ( array[ mid ] < targetValue ) {

			lower = mid + 1;

		} else {

			upper = mid;

		}

	}

	return lower - offset;

}

/**
 * Calculate luminance from RGB values
 */
function colorToLuminance( r, g, b ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;

}

/**
 * Extract Float32 RGBA pixel data from an environment map.
 * Handles HalfFloat/integer type conversion and Y-flip.
 * @returns {{ floatData: Float32Array, width: number, height: number }}
 */
export function extractFloatData( envMap ) {

	const { width, height, data } = envMap.image;

	if ( ! data ) {

		throw new Error( 'EquirectHDRInfo: Environment map must have CPU-accessible image data. Render target textures are not supported.' );

	}

	// Convert to Float32 regardless of source type
	let floatData;

	if ( envMap.type === FloatType && data instanceof Float32Array ) {

		// Copy so the original texture buffer is not detached by worker transfer
		floatData = new Float32Array( data );

	} else if ( envMap.type === HalfFloatType ) {

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = DataUtils.fromHalfFloat( data[ i ] );

		}

	} else {

		// Integer types (Uint8, Int16, etc.)
		let maxIntValue;
		if ( data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array ) {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT - 1 ) - 1;

		} else {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT ) - 1;

		}

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = data[ i ] / maxIntValue;

		}

	}

	// Remove Y-flip for CDF computation
	if ( envMap.flipY ) {

		const flipped = new Float32Array( floatData.length );
		for ( let y = 0; y < height; y ++ ) {

			const newY = height - y - 1;
			const srcOffset = y * width * 4;
			const dstOffset = newY * width * 4;
			flipped.set( floatData.subarray( srcOffset, srcOffset + width * 4 ), dstOffset );

		}

		floatData = flipped;

	}

	return { floatData, width, height };

}

/**
 * EquirectHDRInfo - Importance sampling data for equirectangular HDR maps
 *
 * Builds inverted marginal and conditional CDFs from an HDR environment map.
 * Outputs Float32Arrays consumed directly by StorageInstancedBufferAttribute
 * on the GPU — no intermediate DataTexture or HalfFloat conversion needed.
 *
 * Supports two modes:
 * - `updateFrom(hdr)`: synchronous, runs on main thread
 * - `updateFromAsync(hdr)`: offloads CDF math to a Web Worker
 */
export class EquirectHDRInfo {

	constructor() {

		// Placeholder data matching the default storage buffer sizes in PathTracer
		this.marginalData = new Float32Array( [ 0, 1 ] );
		this.conditionalData = new Float32Array( [ 0, 0, 1, 1 ] );
		this.totalSum = 0;
		this.width = 0;
		this.height = 0;

		this._worker = null;

	}

	dispose() {

		this.marginalData = null;
		this.conditionalData = null;

		if ( this._worker ) {

			this._worker.terminate();
			this._worker = null;

		}

	}

	/**
	 * Synchronous CDF build on main thread (fallback path).
	 */
	updateFrom( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );

		const result = EquirectHDRInfo.computeCDF( floatData, width, height );

		this.marginalData = result.marginalData;
		this.conditionalData = result.conditionalData;
		this.totalSum = result.totalSum;
		this.width = width;
		this.height = height;

	}

	/**
	 * Async CDF build offloaded to a Web Worker.
	 * Float extraction (HalfFloat → Float32) runs on main thread (needs Three.js DataUtils),
	 * then the pure-math CDF computation runs off-thread.
	 * @returns {Promise<void>}
	 */
	async updateFromAsync( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );

		// Reuse worker across calls; create on first use
		if ( ! this._worker ) {

			this._worker = new Worker(
				new URL( './Workers/CDFWorker.js', import.meta.url ),
				{ type: 'module' }
			);

		}

		const result = await new Promise( ( resolve, reject ) => {

			this._worker.onmessage = ( e ) => {

				if ( e.data.error ) {

					reject( new Error( e.data.error ) );

				} else {

					resolve( e.data );

				}

			};

			this._worker.onerror = reject;

			// Transfer floatData to worker (zero-copy)
			this._worker.postMessage(
				{ floatData, width, height },
				[ floatData.buffer ]
			);

		} );

		this.marginalData = result.marginalData;
		this.conditionalData = result.conditionalData;
		this.totalSum = result.totalSum;
		this.width = result.width;
		this.height = result.height;

	}

	/**
	 * Pure-math CDF computation. Used by both the sync path and CDFWorker.
	 * Static so it can be called without an instance.
	 */
	static computeCDF( floatData, width, height ) {

		const cdfConditional = new Float32Array( width * height );
		const cdfMarginal = new Float32Array( height );

		let totalSumValue = 0.0;
		let cumulativeWeightMarginal = 0.0;

		// Build conditional CDFs (per-row distribution)
		for ( let y = 0; y < height; y ++ ) {

			let cumulativeRowWeight = 0.0;
			for ( let x = 0; x < width; x ++ ) {

				const i = y * width + x;
				const r = floatData[ 4 * i ];
				const g = floatData[ 4 * i + 1 ];
				const b = floatData[ 4 * i + 2 ];

				// Weight by luminance
				const weight = colorToLuminance( r, g, b );
				cumulativeRowWeight += weight;
				totalSumValue += weight;

				cdfConditional[ i ] = cumulativeRowWeight;

			}

			// Normalize row CDF to [0, 1]
			if ( cumulativeRowWeight !== 0 ) {

				for ( let i = y * width, l = y * width + width; i < l; i ++ ) {

					cdfConditional[ i ] /= cumulativeRowWeight;

				}

			}

			cumulativeWeightMarginal += cumulativeRowWeight;

			// Build marginal CDF (row distribution)
			cdfMarginal[ y ] = cumulativeWeightMarginal;

		}

		// Normalize marginal CDF to [0, 1]
		if ( cumulativeWeightMarginal !== 0 ) {

			for ( let i = 0, l = cdfMarginal.length; i < l; i ++ ) {

				cdfMarginal[ i ] /= cumulativeWeightMarginal;

			}

		}

		// Create inverted CDF arrays (Float32 directly for storage buffers)
		const marginalData = new Float32Array( height );
		const conditionalData = new Float32Array( width * height );

		// Invert marginal CDF
		for ( let i = 0; i < height; i ++ ) {

			const dist = ( i + 1 ) / height;
			const row = binarySearchFindClosestIndexOf( cdfMarginal, dist );

			marginalData[ i ] = ( row + 0.5 ) / height;

		}

		// Invert conditional CDFs
		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const i = y * width + x;
				const dist = ( x + 1 ) / width;
				const col = binarySearchFindClosestIndexOf( cdfConditional, dist, y * width, width );

				conditionalData[ i ] = ( col + 0.5 ) / width;

			}

		}

		return { marginalData, conditionalData, totalSum: totalSumValue };

	}

}
