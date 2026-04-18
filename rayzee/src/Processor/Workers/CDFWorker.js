/**
 * Web Worker for computing environment map CDF (Cumulative Distribution Function)
 * for importance sampling. Pure math — no Three.js dependencies.
 *
 * Input:  { floatData: Float32Array, width, height }
 * Output: { marginalData: Float32Array, conditionalData: Float32Array, totalSum, width, height }
 */

function binarySearchFindClosestIndexOf( array, targetValue, offset, count ) {

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

function buildCDF( floatData, width, height ) {

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

			// Luminance (Rec. 709)
			const weight = 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
		cdfMarginal[ y ] = cumulativeWeightMarginal;

	}

	// Normalize marginal CDF to [0, 1]
	if ( cumulativeWeightMarginal !== 0 ) {

		for ( let i = 0, l = cdfMarginal.length; i < l; i ++ ) {

			cdfMarginal[ i ] /= cumulativeWeightMarginal;

		}

	}

	// Invert marginal CDF
	const marginalData = new Float32Array( height );
	for ( let i = 0; i < height; i ++ ) {

		const dist = ( i + 1 ) / height;
		const row = binarySearchFindClosestIndexOf( cdfMarginal, dist, 0, height );
		marginalData[ i ] = ( row + 0.5 ) / height;

	}

	// Invert conditional CDFs
	const conditionalData = new Float32Array( width * height );
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

self.onmessage = function ( e ) {

	const { floatData, width, height } = e.data;

	try {

		const result = buildCDF( floatData, width, height );

		// Transfer arrays back zero-copy
		self.postMessage(
			{
				marginalData: result.marginalData,
				conditionalData: result.conditionalData,
				totalSum: result.totalSum,
				width,
				height,
			},
			[ result.marginalData.buffer, result.conditionalData.buffer ]
		);

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
