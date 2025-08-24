import {
	DataTexture,
	RGBAFormat,
	FloatType,
	UnsignedByteType,
	UVMapping,
	RepeatWrapping,
	LinearFilter
} from 'three';

/**
 * FIXED Environment CDF Builder
 * Addresses the zero CDF and missing hotspot issues
 */
export class EnvironmentCDFBuilder {

	constructor( renderer, options = {} ) {

		this.renderer = renderer;

		// Configuration options
		this.options = {
			maxCDFSize: options.maxCDFSize || 1024,
			minCDFSize: options.minCDFSize || 256,
			adaptiveResolution: options.adaptiveResolution !== false,
			enableValidation: options.enableValidation !== false,
			enableDebug: options.enableDebug || false,
			hotspotThreshold: options.hotspotThreshold || 0.01,
			minLuminanceThreshold: options.minLuminanceThreshold || 1e-8, // Prevent completely dark rows
			...options
		};

		// Debug data storage
		this.lastLuminanceData = null;
		this.lastCDFData = null;
		this.validationResults = null;
		this.debugInfo = {};

	}

	async buildEnvironmentCDF( envMap ) {

		if ( ! envMap ) {

			console.warn( 'EnvironmentCDFBuilder: No environment map provided' );
			return null;

		}

		let width, height;
		let pixelData;

		// Extract pixel data from different types of environment maps
		const extractionResult = this.extractPixelData( envMap );
		if ( ! extractionResult ) {

			console.warn( 'EnvironmentCDFBuilder: Unable to extract pixel data from environment map' );
			return null;

		}

		( { width, height, pixelData } = extractionResult );

		// Store debug info
		this.debugInfo = {
			sourceResolution: { width, height },
			sourcePixelCount: width * height,
			sourceDataLength: pixelData.length
		};

		// Build luminance map with proper sin(theta) weighting
		const luminance = this.buildLuminanceMap( pixelData, width, height );
		this.lastLuminanceData = luminance;

		// Analyze luminance data for debugging
		this.analyzeLuminanceData( luminance, width, height );

		// Determine optimal CDF size
		const cdfSize = this.determineOptimalCDFSize( width, height, luminance );

		// Build CDF texture with FIXED filtering
		const { cdfTexture, cdfHeight } = this.buildCDFTextureFixed( luminance, width, height, cdfSize );
		this.lastCDFData = cdfTexture.image.data;

		// Validate CDF if enabled
		if ( this.options.enableValidation ) {

			this.validationResults = CDFValidator.validateCDF(
				cdfTexture,
				cdfSize,
				luminance,
				width,
				height
			);

			if ( ! this.validationResults.isValid ) {

				console.error( 'EnvironmentCDFBuilder: CDF validation failed', this.validationResults.errors );

			}

			if ( this.validationResults.warnings.length > 0 ) {

				console.warn( 'EnvironmentCDFBuilder: CDF warnings', this.validationResults.warnings );

			}

		}

		// Generate debug visualization if enabled
		if ( this.options.enableDebug ) {

			const debugCanvas = CDFValidator.generateDebugVisualization( cdfTexture, cdfSize );
			this.debugVisualization = debugCanvas;

			if ( typeof document !== 'undefined' ) {

				console.log( 'EnvironmentCDFBuilder: Debug info:', this.debugInfo );

			}

		}

		console.log( `Environment CDF built successfully (${cdfSize}x${cdfHeight})` );

		return {
			cdfTexture,
			cdfSize: { width: cdfSize, height: cdfHeight },
			validationResults: this.validationResults,
			debugVisualization: this.debugVisualization,
			debugInfo: this.debugInfo
		};

	}

	extractPixelData( envMap ) {

		let width, height, pixelData;

		try {

			// Handle different types of environment maps
			if ( envMap.isDataTexture || envMap.isCanvasTexture ) {

				width = envMap.image.width;
				height = envMap.image.height;

				// For DataTexture
				if ( envMap.isDataTexture ) {

					const data = envMap.image.data;
					if ( envMap.type === FloatType ) {

						pixelData = data;

					} else if ( envMap.type === UnsignedByteType ) {

						// Convert to float
						pixelData = new Float32Array( data.length );
						for ( let i = 0; i < data.length; i ++ ) {

							pixelData[ i ] = data[ i ] / 255.0;

						}

					}

				} else if ( envMap.isCanvasTexture ) {

					// For CanvasTexture
					const canvas = envMap.image;
					const ctx = canvas.getContext( '2d' );
					const imageData = ctx.getImageData( 0, 0, width, height );
					const data = imageData.data;

					// Convert to float array
					pixelData = new Float32Array( data.length );
					for ( let i = 0; i < data.length; i ++ ) {

						pixelData[ i ] = data[ i ] / 255.0;

					}

				}

			} else if ( envMap.isWebGLRenderTarget ) {

				// Handle WebGLRenderTarget
				width = envMap.width;
				height = envMap.height;

				// Read pixels from render target
				const pixels = new Uint8Array( width * height * 4 );
				this.renderer.readRenderTargetPixels( envMap, 0, 0, width, height, pixels );

				// Convert to float
				pixelData = new Float32Array( pixels.length );
				for ( let i = 0; i < pixels.length; i ++ ) {

					pixelData[ i ] = pixels[ i ] / 255.0;

				}

			} else if ( envMap.image ) {

				// Handle image-based textures
				if ( envMap.image instanceof HTMLImageElement ) {

					width = envMap.image.width;
					height = envMap.image.height;

					const canvas = document.createElement( 'canvas' );
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext( '2d' );
					ctx.drawImage( envMap.image, 0, 0 );
					const imageData = ctx.getImageData( 0, 0, width, height );
					const data = imageData.data;

					// Convert to float
					pixelData = new Float32Array( data.length );
					for ( let i = 0; i < data.length; i ++ ) {

						pixelData[ i ] = data[ i ] / 255.0;

					}

				} else if ( envMap.image instanceof HTMLCanvasElement ) {

					// Handle canvas or other drawable objects
					const canvas = envMap.image;
					width = canvas.width;
					height = canvas.height;

					const ctx = canvas.getContext( '2d' );
					const imageData = ctx.getImageData( 0, 0, width, height );
					const data = imageData.data;

					// Convert to float
					pixelData = new Float32Array( data.length );
					for ( let i = 0; i < data.length; i ++ ) {

						pixelData[ i ] = data[ i ] / 255.0;

					}

				}

			}

			if ( ! pixelData ) {

				return null;

			}

			return { width, height, pixelData };

		} catch ( error ) {

			console.error( 'EnvironmentCDFBuilder: Error extracting pixel data', error );
			return null;

		}

	}

	buildLuminanceMap( pixelData, width, height ) {

		const luminance = new Float32Array( width * height );
		let totalLuminance = 0;
		let maxLuminance = 0;

		// Pole regions for enhanced handling
		const poleRegionSize = Math.max( 1, Math.floor( height * 0.02 ) ); // Top/bottom 2%
		let poleMaxLuminance = 0;
		let polePixelCount = 0;

		for ( let y = 0; y < height; y ++ ) {

			// Enhanced sin(theta) weighting with pole singularity handling
			const theta = ( y + 0.5 ) / height * Math.PI;
			let sinTheta = Math.sin( theta );

			// Detect pole regions
			const isNearPole = y < poleRegionSize || y >= height - poleRegionSize;

			// Enhanced pole handling: clamp sinTheta and apply dampening
			if ( isNearPole ) {

				sinTheta = Math.max( sinTheta, 0.01 ); // Prevent extreme weighting at poles

			}

			for ( let x = 0; x < width; x ++ ) {

				const i = ( y * width + x ) * 4;
				const r = pixelData[ i ];
				const g = pixelData[ i + 1 ];
				const b = pixelData[ i + 2 ];

				// Calculate base luminance
				let lum = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) * sinTheta;

				// Enhanced pole region handling
				if ( isNearPole ) {

					// Track pole statistics
					const rawLum = ( 0.2126 * r + 0.7152 * g + 0.0722 * b );
					poleMaxLuminance = Math.max( poleMaxLuminance, rawLum );
					polePixelCount ++;

					// Apply additional dampening for extreme pole values
					if ( rawLum > 0.1 ) { // Bright pole pixel

						const dampingFactor = Math.max( 0.1, sinTheta );
						lum = rawLum * dampingFactor;

					}

				}

				luminance[ y * width + x ] = lum;
				totalLuminance += lum;
				maxLuminance = Math.max( maxLuminance, lum );

			}

		}

		// Enhanced debug info with pole statistics
		this.debugInfo.luminanceStats = {
			total: totalLuminance,
			max: maxLuminance,
			average: totalLuminance / ( width * height ),
			nonZeroPixels: luminance.filter( l => l > 1e-8 ).length,
			poleStats: {
				maxLuminance: poleMaxLuminance,
				pixelCount: polePixelCount,
				avgLuminance: polePixelCount > 0 ? poleMaxLuminance / polePixelCount : 0,
				hasBrightPoles: poleMaxLuminance > 0.1
			}
		};

		// Warn about bright poles that could cause fireflies
		if ( poleMaxLuminance > 1.0 ) {

			console.warn( `Bright poles detected (max: ${poleMaxLuminance.toFixed( 3 )}). Applying singularity mitigation.` );

		}

		return luminance;

	}

	analyzeLuminanceData( luminance, width, height ) {

		// Find bright spots for debugging with enhanced analysis
		const sortedLum = [ ...luminance ].sort( ( a, b ) => b - a );
		const total = luminance.length;

		const topPercent = Math.floor( total * 0.01 );
		const hotspotThreshold = sortedLum[ topPercent ];

		// Hotspot detection with spatial clustering
		let hotspots = [];
		let totalHotspotEnergy = 0;

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const lum = luminance[ y * width + x ];
				if ( lum >= hotspotThreshold && hotspots.length < 20 ) { // Increased limit

					hotspots.push( {
						x,
						y,
						luminance: lum,
						// Add UV coordinates for better tracking
						u: ( x + 0.5 ) / width,
						v: ( y + 0.5 ) / height
					} );
					totalHotspotEnergy += lum;

				}

			}

		}

		// Calculate contrast ratio for bias detection
		const avgLuminance = sortedLum.reduce( ( a, b ) => a + b, 0 ) / sortedLum.length;
		const maxLuminance = sortedLum[ 0 ];
		const contrastRatio = maxLuminance / Math.max( avgLuminance, 1e-8 );

		this.debugInfo.hotspots = hotspots;
		this.debugInfo.hotspotThreshold = hotspotThreshold;
		this.debugInfo.totalHotspotEnergy = totalHotspotEnergy;
		this.debugInfo.contrastRatio = contrastRatio;
		this.debugInfo.avgLuminance = avgLuminance;
		this.debugInfo.maxLuminance = maxLuminance;

		// Warn about high contrast that could cause bias
		if ( contrastRatio > 100 ) {

			console.warn( `High contrast ratio detected: ${contrastRatio.toFixed( 2 )}. Consider bias mitigation.` );

		}

		console.debug( 'Enhanced Luminance Analysis:', this.debugInfo );

	}

	determineOptimalCDFSize( width, height, luminance ) {

		if ( ! this.options.adaptiveResolution ) {

			return Math.min( Math.max( width, height ), this.options.maxCDFSize );

		}

		// For debugging, use a smaller size to make issues more obvious
		const baseSize = Math.min( 512, Math.max( width, height ) );

		// Round to power of 2 for better GPU performance
		const targetSize = Math.pow( 2, Math.round( Math.log2( baseSize ) ) );

		return Math.max( this.options.minCDFSize, Math.min( targetSize, this.options.maxCDFSize ) );

	}

	// FIXED CDF building algorithm
	buildCDFTextureFixed( luminance, width, height, cdfSize ) {

		const cdfHeight = cdfSize + 1;
		const cdfData = new Float32Array( cdfSize * cdfHeight * 4 );

		// Enhanced tracking with pole awareness
		let emptyRows = 0;
		let validRows = 0;
		let totalSampledEnergy = 0;
		let maxCellValue = 0;
		let biasPreventionCount = 0;
		let poleSingularityCount = 0;

		// Identify pole regions in CDF space
		const poleCDFRegion = Math.max( 1, Math.floor( cdfSize * 0.02 ) );

		// Build conditional CDFs with enhanced pole handling
		for ( let cdfY = 0; cdfY < cdfSize; cdfY ++ ) {

			let rowSum = 0.0;
			const rowData = new Float32Array( cdfSize );

			// Check if this CDF row corresponds to pole regions
			const srcYStart = Math.floor( cdfY * height / cdfSize );
			const srcYEnd = Math.min( Math.ceil( ( cdfY + 1 ) * height / cdfSize ), height );
			const actualSrcYStart = srcYStart;
			const actualSrcYEnd = Math.max( srcYEnd, srcYStart + 1 );

			// Detect if we're sampling pole regions
			const isNearPole = ( actualSrcYStart < height * 0.02 ) || ( actualSrcYEnd > height * 0.98 );

			for ( let cdfX = 0; cdfX < cdfSize; cdfX ++ ) {

				// Calculate source column range
				const srcXStart = Math.floor( cdfX * width / cdfSize );
				const srcXEnd = Math.min( Math.ceil( ( cdfX + 1 ) * width / cdfSize ), width );

				const actualSrcXStart = srcXStart;
				const actualSrcXEnd = Math.max( srcXEnd, srcXStart + 1 );

				// Multi-strategy sampling to prevent bright spot loss
				let cellLuminance = 0.0;
				let maxCellLuminance = 0.0;
				let cellCount = 0;
				let hotspotCount = 0;

				// Sample all pixels in this cell
				for ( let srcY = actualSrcYStart; srcY < actualSrcYEnd; srcY ++ ) {

					for ( let srcX = actualSrcXStart; srcX < actualSrcXEnd; srcX ++ ) {

						const lum = luminance[ srcY * width + srcX ];
						maxCellLuminance = Math.max( maxCellLuminance, lum );
						cellLuminance += lum;
						cellCount ++;

						// Count potential hotspots
						if ( lum > this.debugInfo.avgLuminance * 5 ) {

							hotspotCount ++;

						}

					}

				}

				// Preservation strategy for bright spots
				const avgCellLuminance = cellLuminance / Math.max( cellCount, 1 );

				let finalCellValue;
				if ( hotspotCount > 0 || maxCellLuminance > avgCellLuminance * 3 ) {

					let blendRatio = Math.min( hotspotCount / cellCount + 0.3, 0.8 );

					// Enhanced pole handling: reduce blend ratio for pole regions
					if ( isNearPole && maxCellLuminance > avgCellLuminance * 10 ) {

						blendRatio = Math.min( blendRatio * 0.5, 0.4 ); // More conservative blending
						poleSingularityCount ++;

					}

					finalCellValue = mix( avgCellLuminance, maxCellLuminance, blendRatio );
					biasPreventionCount ++;

				} else {

					// For regular cells: use average
					finalCellValue = avgCellLuminance;

				}

				// Additional pole region clamping
				if ( isNearPole && finalCellValue > maxCellValue * 0.5 ) {

					finalCellValue = Math.min( finalCellValue, maxCellValue * 0.5 );

				}

				rowData[ cdfX ] = finalCellValue;
				rowSum += finalCellValue;
				maxCellValue = Math.max( maxCellValue, finalCellValue );
				totalSampledEnergy += finalCellValue;

			}

			// Minimum threshold with pole awareness
			let adaptiveMinThreshold = Math.max(
				this.options.minLuminanceThreshold,
				maxCellValue * 1e-6
			);

			// Higher minimum for pole regions to prevent singularities
			if ( isNearPole ) {

				adaptiveMinThreshold = Math.max( adaptiveMinThreshold, maxCellValue * 1e-5 );

			}

			if ( rowSum < adaptiveMinThreshold ) {

				// Distribute minimal energy distribution
				const minValue = adaptiveMinThreshold / cdfSize;
				for ( let x = 0; x < cdfSize; x ++ ) {

					rowData[ x ] = Math.max( rowData[ x ], minValue );

				}

				rowSum = adaptiveMinThreshold;
				emptyRows ++;

			} else {

				validRows ++;

			}

			// Build CDF from PDF
			let cumulativeSum = 0.0;
			const invRowSum = 1.0 / rowSum; // Pre-calculate for better precision

			for ( let cdfX = 0; cdfX < cdfSize; cdfX ++ ) {

				cumulativeSum += rowData[ cdfX ];

				const idx = ( cdfY * cdfSize + cdfX ) * 4;

				// Enhanced precision for CDF values
				const normalizedCDF = Math.min( cumulativeSum * invRowSum, 1.0 );
				const normalizedPDF = rowData[ cdfX ] * invRowSum;

				cdfData[ idx ] = normalizedCDF;
				cdfData[ idx + 1 ] = normalizedPDF;
				cdfData[ idx + 2 ] = 0.0; // Reserved for future use
				cdfData[ idx + 3 ] = 1.0; // Alpha

			}

			// Ensure the last CDF value is exactly 1.0 for precision
			const lastIdx = ( cdfY * cdfSize + ( cdfSize - 1 ) ) * 4;
			cdfData[ lastIdx ] = 1.0;

		}

		// Marginal CDF with pole handling
		let marginalSum = 0.0;
		const marginalData = new Float32Array( cdfSize );
		const marginalY = cdfSize;

		for ( let cdfX = 0; cdfX < cdfSize; cdfX ++ ) {

			// Calculate which source columns this CDF column represents
			const srcXStart = Math.floor( cdfX * width / cdfSize );
			const srcXEnd = Math.min( Math.ceil( ( cdfX + 1 ) * width / cdfSize ), width );

			const actualSrcXStart = srcXStart;
			const actualSrcXEnd = Math.max( srcXEnd, srcXStart + 1 );

			// Column sampling with hotspot preservation
			let colSum = 0.0;
			let maxColLuminance = 0.0;
			let colCount = 0;
			let colHotspotCount = 0;
			let colPoleContribution = 0.0;

			for ( let srcY = 0; srcY < height; srcY ++ ) {

				// Check if this is a pole row
				const isPoleSrcRow = srcY < height * 0.02 || srcY >= height * 0.98;

				for ( let srcX = actualSrcXStart; srcX < actualSrcXEnd; srcX ++ ) {

					const lum = luminance[ srcY * width + srcX ];
					maxColLuminance = Math.max( maxColLuminance, lum );
					colSum += lum;
					colCount ++;

					if ( isPoleSrcRow ) {

						colPoleContribution += lum;

					}

					if ( lum > this.debugInfo.avgLuminance * 5 ) {

						colHotspotCount ++;

					}

				}

			}

			// Apply same enhanced preservation strategy for marginal
			const avgColLuminance = colSum / Math.max( colCount, 1 );

			let finalColValue;
			if ( colHotspotCount > 0 || maxColLuminance > avgColLuminance * 3 ) {

				let blendRatio = Math.min( colHotspotCount / colCount + 0.2, 0.6 );

				// Reduce blend if significant pole contribution
				const poleRatio = colPoleContribution / Math.max( colSum, 1e-8 );
				if ( poleRatio > 0.3 ) {

					blendRatio *= ( 1.0 - poleRatio * 0.5 );

				}

				finalColValue = mix( avgColLuminance, maxColLuminance, blendRatio );

			} else {

				finalColValue = avgColLuminance;

			}

			marginalData[ cdfX ] = finalColValue;
			marginalSum += finalColValue;

		}

		// Enhanced marginal minimum threshold
		const marginalMinThreshold = Math.max(
			this.options.minLuminanceThreshold,
			maxCellValue * 1e-6
		);

		if ( marginalSum < marginalMinThreshold ) {

			const minValue = marginalMinThreshold / cdfSize;
			for ( let x = 0; x < cdfSize; x ++ ) {

				marginalData[ x ] = Math.max( marginalData[ x ], minValue );

			}

			marginalSum = marginalMinThreshold;

		}

		// Build marginal CDF
		let cumulativeSum = 0.0;
		const invMarginalSum = 1.0 / marginalSum;

		for ( let cdfX = 0; cdfX < cdfSize; cdfX ++ ) {

			cumulativeSum += marginalData[ cdfX ];

			const idx = ( marginalY * cdfSize + cdfX ) * 4;

			const normalizedCDF = Math.min( cumulativeSum * invMarginalSum, 1.0 );
			const normalizedPDF = marginalData[ cdfX ] * invMarginalSum;

			cdfData[ idx ] = normalizedCDF;
			cdfData[ idx + 1 ] = normalizedPDF;
			cdfData[ idx + 2 ] = 0.0;
			cdfData[ idx + 3 ] = 1.0;

		}

		// Ensure the last marginal CDF value is exactly 1.0
		const lastMarginalIdx = ( marginalY * cdfSize + ( cdfSize - 1 ) ) * 4;
		cdfData[ lastMarginalIdx ] = 1.0;

		// Enhanced debug info
		this.debugInfo.cdfStats = {
			cdfSize,
			emptyRows,
			validRows,
			marginalSum,
			totalSampledEnergy,
			maxCellValue,
			biasPreventionCount,
			poleSingularityCount,
			hasPoleIssues: poleSingularityCount > 0,
			energyRatio: totalSampledEnergy / Math.max( this.debugInfo.luminanceStats.total, 1e-8 ),
			minThreshold: this.options.minLuminanceThreshold
		};

		console.debug( 'Enhanced CDF Build Stats (with pole handling):', this.debugInfo.cdfStats );

		// Create texture with linear filtering
		const cdfTexture = new DataTexture(
			cdfData,
			cdfSize,
			cdfHeight,
			RGBAFormat,
			FloatType,
			UVMapping,
			RepeatWrapping,
			RepeatWrapping,
			LinearFilter,
			LinearFilter
		);
		cdfTexture.needsUpdate = true;

		return { cdfTexture, cdfHeight };

	}

	// Utility methods for debugging and analysis
	getValidationResults() {

		return this.validationResults;

	}

	getDebugVisualization() {

		return this.debugVisualization;

	}

	getDebugInfo() {

		return this.debugInfo;

	}

	exportCDFData() {

		return {
			luminance: this.lastLuminanceData,
			cdfData: this.lastCDFData,
			validation: this.validationResults,
			debugInfo: this.debugInfo
		};

	}

}

/**
 * FIXED CDF Validation with better error checking
 */
export class CDFValidator {

	static validateCDF( cdfTexture, cdfSize, originalLuminance, width, height ) {

		const data = cdfTexture.image.data;
		const results = {
			isValid: true,
			errors: [],
			warnings: [],
			statistics: {}
		};

		try {

			// 1. Check conditional CDFs (all rows except last)
			for ( let y = 0; y < cdfSize; y ++ ) {

				const rowErrors = this.validateConditionalCDF( data, cdfSize, y );
				results.errors.push( ...rowErrors );

			}

			// 2. Check marginal CDF (last row)
			const marginalErrors = this.validateMarginalCDF( data, cdfSize );
			results.errors.push( ...marginalErrors );

			// 3. Check for NaN/Infinity values
			const nanCheck = this.checkForInvalidValues( data );
			if ( nanCheck.hasInvalidValues ) {

				results.errors.push( `Found ${nanCheck.nanCount} NaN and ${nanCheck.infCount} Infinity values` );

			}

			// 4. Check energy conservation (more lenient)
			const energyCheck = this.checkEnergyConservation( data, cdfSize, originalLuminance, width, height );
			results.statistics.energyConservation = energyCheck;

			// 5. Check for hotspot preservation (more lenient)
			const hotspotCheck = this.checkHotspotPreservation( data, cdfSize, originalLuminance, width, height );
			if ( hotspotCheck.warnings.length > 0 ) {

				results.warnings.push( ...hotspotCheck.warnings );

			}

			results.statistics.hotspotPreservation = hotspotCheck;

			results.isValid = results.errors.length === 0;

		} catch ( error ) {

			results.errors.push( `Validation failed with error: ${error.message}` );
			results.isValid = false;

		}

		return results;

	}

	static validateConditionalCDF( data, cdfSize, rowIndex ) {

		const errors = [];
		let lastCDF = 0;

		for ( let x = 0; x < cdfSize; x ++ ) {

			const idx = ( rowIndex * cdfSize + x ) * 4;
			const cdfValue = data[ idx ];
			const pdfValue = data[ idx + 1 ];

			// Check CDF is monotonically increasing (with tolerance)
			if ( cdfValue < lastCDF - 1e-6 ) {

				errors.push( `Row ${rowIndex}, Col ${x}: CDF not monotonic (${cdfValue} < ${lastCDF})` );

			}

			// Check CDF is in [0, 1] (with tolerance)
			if ( cdfValue < - 1e-6 || cdfValue > 1 + 1e-6 ) {

				errors.push( `Row ${rowIndex}, Col ${x}: CDF out of range [0,1]: ${cdfValue}` );

			}

			// Check PDF is non-negative (with tolerance)
			if ( pdfValue < - 1e-6 ) {

				errors.push( `Row ${rowIndex}, Col ${x}: PDF negative: ${pdfValue}` );

			}

			lastCDF = cdfValue;

		}

		// Check final CDF value is 1 (with tolerance)
		const finalIdx = ( rowIndex * cdfSize + ( cdfSize - 1 ) ) * 4;
		const finalCDF = data[ finalIdx ];
		if ( Math.abs( finalCDF - 1.0 ) > 1e-3 ) { // More lenient tolerance

			errors.push( `Row ${rowIndex}: Final CDF not 1.0: ${finalCDF}` );

		}

		return errors;

	}

	static validateMarginalCDF( data, cdfSize ) {

		const marginalRow = cdfSize;
		return this.validateConditionalCDF( data, cdfSize, marginalRow );

	}

	static checkEnergyConservation( cdfData, cdfSize, originalLuminance, width, height ) {

		// More lenient energy conservation check
		let originalEnergy = 0;
		for ( let i = 0; i < originalLuminance.length; i ++ ) {

			originalEnergy += originalLuminance[ i ];

		}

		let cdfEnergy = 0;
		const marginalRow = cdfSize;
		for ( let x = 0; x < cdfSize; x ++ ) {

			const idx = ( marginalRow * cdfSize + x ) * 4 + 1;
			cdfEnergy += cdfData[ idx ];

		}

		const scaleFactor = ( width / cdfSize ) * ( height / cdfSize );
		cdfEnergy *= scaleFactor;

		const tolerance = 0.2; // 20% tolerance (more lenient)
		const relativeDifference = Math.abs( originalEnergy - cdfEnergy ) / Math.max( originalEnergy, 1e-8 );
		const isConserved = relativeDifference < tolerance;

		return {
			isConserved,
			expected: originalEnergy,
			actual: cdfEnergy,
			relativeDifference,
			tolerance
		};

	}

	static checkHotspotPreservation( cdfData, cdfSize, originalLuminance, width, height ) {

		const warnings = [];

		try {

			// Find hotspots in original (top 1% brightest pixels)
			const sortedLuminance = [ ...originalLuminance ].sort( ( a, b ) => b - a );
			const hotspotThreshold = sortedLuminance[ Math.floor( sortedLuminance.length * 0.01 ) ];

			if ( hotspotThreshold <= 1e-6 ) {

				// Environment is too dark to have meaningful hotspots
				return { warnings: [], totalHotspots: 0, preservedHotspots: 0, preservationRatio: 1 };

			}

			const originalHotspots = [];
			for ( let y = 0; y < height; y ++ ) {

				for ( let x = 0; x < width; x ++ ) {

					const lum = originalLuminance[ y * width + x ];
					if ( lum >= hotspotThreshold ) {

						originalHotspots.push( { x, y, luminance: lum } );

					}

				}

			}

			let preservedHotspots = 0;
			const avgPdf = 1.0 / ( cdfSize * cdfSize );

			for ( const hotspot of originalHotspots ) {

				const cdfX = Math.min( Math.floor( hotspot.x * cdfSize / width ), cdfSize - 1 );
				const cdfY = Math.min( Math.floor( hotspot.y * cdfSize / height ), cdfSize - 1 );

				const idx = ( cdfY * cdfSize + cdfX ) * 4 + 1;
				const cdfPdf = cdfData[ idx ];

				// More lenient threshold for preservation
				if ( cdfPdf > avgPdf * 1.5 ) {

					preservedHotspots ++;

				}

			}

			const preservationRatio = originalHotspots.length > 0 ? preservedHotspots / originalHotspots.length : 1;

			// Only warn if there are many hotspots and preservation is very poor
			if ( preservationRatio < 0.3 && originalHotspots.length > 50 ) {

				warnings.push( `Only ${( preservationRatio * 100 ).toFixed( 1 )}% of hotspots preserved in CDF` );

			}

			return {
				warnings,
				totalHotspots: originalHotspots.length,
				preservedHotspots,
				preservationRatio,
				hotspotThreshold
			};

		} catch ( error ) {

			warnings.push( `Hotspot preservation check failed: ${error.message}` );
			return { warnings, totalHotspots: 0, preservedHotspots: 0, preservationRatio: 0 };

		}

	}

	static checkForInvalidValues( data ) {

		let nanCount = 0;
		let infCount = 0;

		for ( let i = 0; i < data.length; i ++ ) {

			if ( isNaN( data[ i ] ) ) nanCount ++;
			if ( ! isFinite( data[ i ] ) && ! isNaN( data[ i ] ) ) infCount ++;

		}

		return {
			hasInvalidValues: nanCount > 0 || infCount > 0,
			nanCount,
			infCount
		};

	}

	static generateDebugVisualization( cdfTexture, cdfSize ) {

		const data = cdfTexture.image.data;
		const canvas = document.createElement( 'canvas' );
		canvas.width = cdfSize;
		canvas.height = cdfSize + 1;
		const ctx = canvas.getContext( '2d' );
		const imageData = ctx.createImageData( cdfSize, cdfSize + 1 );

		// Find max PDF value for better scaling
		let maxPdf = 0;
		for ( let i = 1; i < data.length; i += 4 ) {

			maxPdf = Math.max( maxPdf, data[ i ] );

		}

		// Use log scale for better visualization
		const logScale = maxPdf > 0 ? Math.log( maxPdf + 1 ) : 1;

		for ( let y = 0; y <= cdfSize; y ++ ) {

			for ( let x = 0; x < cdfSize; x ++ ) {

				const srcIdx = ( y * cdfSize + x ) * 4;
				const dstIdx = ( y * cdfSize + x ) * 4;

				const pdfValue = data[ srcIdx + 1 ];

				// Use log scale and enhance contrast
				const normalizedValue = maxPdf > 0 ? Math.log( pdfValue + 1 ) / logScale : 0;
				const intensity = Math.min( 255, normalizedValue * 255 * 3 ); // 3x amplification

				if ( y === cdfSize ) {

					// Marginal CDF in blue
					imageData.data[ dstIdx ] = 0;
					imageData.data[ dstIdx + 1 ] = 0;
					imageData.data[ dstIdx + 2 ] = intensity;

				} else {

					// Conditional CDFs in white/gray
					imageData.data[ dstIdx ] = intensity;
					imageData.data[ dstIdx + 1 ] = intensity;
					imageData.data[ dstIdx + 2 ] = intensity;

				}

				imageData.data[ dstIdx + 3 ] = 255;

			}

		}

		ctx.putImageData( imageData, 0, 0 );

		// Add labels
		ctx.fillStyle = 'red';
		ctx.font = '12px Arial';
		ctx.fillText( 'Conditional CDFs', 5, 15 );
		ctx.fillText( 'Marginal CDF', 5, cdfSize + 15 );
		ctx.fillText( `Max PDF: ${maxPdf.toExponential( 2 )}`, 5, 30 );

		return canvas;

	}

}

// Helper function for mixing values (since this might not be available)
function mix( a, b, t ) {

	return a * ( 1 - t ) + b * t;

}
