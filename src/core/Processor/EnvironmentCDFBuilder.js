import {
	DataTexture,
	RGBAFormat,
	FloatType,
	UnsignedByteType,
	UVMapping,
	RepeatWrapping,
	LinearFilter
} from 'three';

export class EnvironmentCDFBuilder {

	constructor( renderer ) {

		this.renderer = renderer;

	}

	async buildEnvironmentCDF( envMap ) {

		if ( ! envMap ) return null;

		let width, height;
		let pixelData;

		// Extract pixel data from different types of environment maps
		const extractionResult = this.extractPixelData( envMap );
		if ( ! extractionResult ) {

			console.warn( 'Unable to extract pixel data from environment map' );
			return null;

		}

		( { width, height, pixelData } = extractionResult );

		// Build luminance map
		const luminance = this.buildLuminanceMap( pixelData, width, height );

		// Build CDF texture
		const { cdfTexture, cdfSize, cdfHeight } = this.buildCDFTexture( luminance, width, height );

		console.log( "Environment CDF built successfully." );

		return {
			cdfTexture,
			cdfSize: { width: cdfSize, height: cdfHeight }
		};

	}

	extractPixelData( envMap ) {

		let width, height, pixelData;

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

	}

	buildLuminanceMap( pixelData, width, height ) {

		const luminance = new Float32Array( width * height );

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const i = ( y * width + x ) * 4;
				const r = pixelData[ i ];
				const g = pixelData[ i + 1 ];
				const b = pixelData[ i + 2 ];

				// Account for sin(theta) weighting
				const theta = ( y + 0.5 ) / height * Math.PI;
				const sinTheta = Math.sin( theta );

				luminance[ y * width + x ] = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) * sinTheta;

			}

		}

		return luminance;

	}

	buildCDFTexture( luminance, width, height ) {

		// Build CDFs - use a 512x513 texture (extra row for marginal)
		const cdfSize = Math.min( width, 1024 ); // Increased from 512
		const cdfHeight = cdfSize + 1;
		const cdfData = new Float32Array( cdfSize * cdfHeight * 4 );

		// Compute conditional CDFs (first 512 rows)
		for ( let y = 0; y < cdfSize; y ++ ) {

			let sum = 0.0;
			for ( let x = 0; x < cdfSize; x ++ ) {

				const srcX = Math.floor( x * width / cdfSize );
				const srcY = Math.floor( y * height / cdfSize );
				const pixelLum = luminance[ srcY * width + srcX ];

				sum += pixelLum;
				const idx = ( y * cdfSize + x ) * 4;
				cdfData[ idx ] = sum; // CDF in red channel
				cdfData[ idx + 1 ] = pixelLum; // PDF in green channel
				cdfData[ idx + 3 ] = 1.0; // Alpha

			}

			// Normalize
			if ( sum > 0 ) {

				for ( let x = 0; x < cdfSize; x ++ ) {

					const idx = ( y * cdfSize + x ) * 4;
					cdfData[ idx ] /= sum;
					cdfData[ idx + 1 ] /= sum;

				}

			}

		}

		// Compute marginal CDF (last row)
		let marginalSum = 0.0;
		const marginalY = cdfSize;
		for ( let x = 0; x < cdfSize; x ++ ) {

			// Sum the entire column
			let colSum = 0.0;
			for ( let y = 0; y < cdfSize; y ++ ) {

				const srcX = Math.floor( x * width / cdfSize );
				const srcY = Math.floor( y * height / cdfSize );
				colSum += luminance[ srcY * width + srcX ];

			}

			marginalSum += colSum;
			const idx = ( marginalY * cdfSize + x ) * 4;
			cdfData[ idx ] = marginalSum; // CDF in red channel
			cdfData[ idx + 1 ] = colSum; // PDF in green channel
			cdfData[ idx + 3 ] = 1.0; // Alpha

		}

		// Normalize marginal CDF
		if ( marginalSum > 0 ) {

			for ( let x = 0; x < cdfSize; x ++ ) {

				const idx = ( marginalY * cdfSize + x ) * 4;
				cdfData[ idx ] /= marginalSum;
				cdfData[ idx + 1 ] /= marginalSum;

			}

		}

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

		return { cdfTexture, cdfSize, cdfHeight };

	}

}
