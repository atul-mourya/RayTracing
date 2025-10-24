/**
 * EmissiveTriangleBuilder
 *
 * Builds an index of emissive triangles for efficient direct lighting sampling.
 * Instead of randomly searching through all triangles, we maintain a list of
 * only the emissive ones, giving 100% sampling success rate.
 */

import { DataTexture, RGBAFormat, FloatType, NearestFilter } from 'three';

export class EmissiveTriangleBuilder {

	constructor() {

		this.emissiveTriangles = [];
		this.emissiveCount = 0;
		this.totalEmissivePower = 0;
		this.emissiveIndicesArray = null;
		this.emissivePowerArray = null;
		this.cdfArray = null;

	}

	/**
	 * Extract emissive triangles from processed geometry
	 * @param {Array} triangleData - Flat array of triangle data
	 * @param {Array} materials - Array of material objects
	 * @param {number} triangleCount - Total number of triangles
	 */
	extractEmissiveTriangles( triangleData, materials, triangleCount ) {

		console.log( '[EmissiveTriangleBuilder] Extracting emissive triangles...' );

		this.emissiveTriangles = [];
		this.totalEmissivePower = 0;

		// Triangle data layout: 32 floats per triangle (8 vec4s)
		// Index 7: vec4(uv2.x, uv2.y, materialIndex, meshIndex)
		const FLOATS_PER_TRIANGLE = 32;
		const MATERIAL_INDEX_OFFSET = 30; // Position in flat array

		for ( let i = 0; i < triangleCount; i ++ ) {

			const baseOffset = i * FLOATS_PER_TRIANGLE;
			const materialIndex = Math.floor( triangleData[ baseOffset + MATERIAL_INDEX_OFFSET ] );

			// Get material
			const material = materials[ materialIndex ];
			if ( ! material ) continue;

			// Check if emissive
			const emissive = material.emissive || { r: 0, g: 0, b: 0 };
			const emissiveIntensity = material.emissiveIntensity || 0;

			const isEmissive = emissiveIntensity > 0 && (
				emissive.r > 0 || emissive.g > 0 || emissive.b > 0
			);

			if ( isEmissive ) {

				// Calculate triangle area for power weighting
				// Positions are at offsets 0-11
				const v0x = triangleData[ baseOffset + 0 ];
				const v0y = triangleData[ baseOffset + 1 ];
				const v0z = triangleData[ baseOffset + 2 ];
				const v1x = triangleData[ baseOffset + 4 ];
				const v1y = triangleData[ baseOffset + 5 ];
				const v1z = triangleData[ baseOffset + 6 ];
				const v2x = triangleData[ baseOffset + 8 ];
				const v2y = triangleData[ baseOffset + 9 ];
				const v2z = triangleData[ baseOffset + 10 ];

				const area = this._calculateTriangleArea( v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z );

				// Calculate emissive power (luminance * intensity * area)
				const avgEmissive = ( emissive.r + emissive.g + emissive.b ) / 3.0;
				const power = avgEmissive * emissiveIntensity * area;

				this.emissiveTriangles.push( {
					triangleIndex: i,
					materialIndex: materialIndex,
					power: power,
					area: area,
					emissive: { r: emissive.r, g: emissive.g, b: emissive.b },
					emissiveIntensity: emissiveIntensity
				} );

				this.totalEmissivePower += power;

			}

		}

		this.emissiveCount = this.emissiveTriangles.length;

		console.log( `[EmissiveTriangleBuilder] Found ${this.emissiveCount} emissive triangles (${( this.emissiveCount / triangleCount * 100 ).toFixed( 2 )}%)` );
		console.log( `[EmissiveTriangleBuilder] Total emissive power: ${this.totalEmissivePower.toFixed( 2 )}` );

		// Build data arrays
		this._buildDataArrays();

		return this.emissiveCount;

	}

	/**
	 * Calculate triangle area using cross product
	 */
	_calculateTriangleArea( v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z ) {

		// Edge vectors
		const e1x = v1x - v0x;
		const e1y = v1y - v0y;
		const e1z = v1z - v0z;
		const e2x = v2x - v0x;
		const e2y = v2y - v0y;
		const e2z = v2z - v0z;

		// Cross product
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;

		// Half the length of cross product
		return Math.sqrt( cx * cx + cy * cy + cz * cz ) * 0.5;

	}

	/**
	 * Build typed arrays for GPU upload
	 */
	_buildDataArrays() {

		// Array of emissive triangle indices
		this.emissiveIndicesArray = new Int32Array( this.emissiveCount );

		// Array of emissive power for each triangle (for importance sampling)
		this.emissivePowerArray = new Float32Array( this.emissiveCount );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			this.emissiveIndicesArray[ i ] = this.emissiveTriangles[ i ].triangleIndex;
			this.emissivePowerArray[ i ] = this.emissiveTriangles[ i ].power;

		}

		// Build CDF for importance sampling (optional but recommended)
		this._buildCDF();

	}

	/**
	 * Build Cumulative Distribution Function for importance sampling
	 * This allows sampling brighter emissive triangles more frequently
	 */
	_buildCDF() {

		if ( this.emissiveCount === 0 ) {

			this.cdfArray = new Float32Array( 1 );
			this.cdfArray[ 0 ] = 0;
			return;

		}

		this.cdfArray = new Float32Array( this.emissiveCount );

		let cumulativeSum = 0;
		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			cumulativeSum += this.emissivePowerArray[ i ];
			this.cdfArray[ i ] = cumulativeSum;

		}

		// Normalize CDF to [0, 1]
		if ( cumulativeSum > 0 ) {

			for ( let i = 0; i < this.emissiveCount; i ++ ) {

				this.cdfArray[ i ] /= cumulativeSum;

			}

		}

	}

	/**
	 * Binary search in CDF for importance sampling
	 * @param {number} u - Random value in [0, 1]
	 * @returns {number} - Index of selected emissive triangle
	 */
	sampleCDF( u ) {

		if ( this.emissiveCount === 0 ) return - 1;
		if ( this.emissiveCount === 1 ) return 0;

		// Binary search
		let left = 0;
		let right = this.emissiveCount - 1;

		while ( left < right ) {

			const mid = Math.floor( ( left + right ) / 2 );
			if ( this.cdfArray[ mid ] < u ) {

				left = mid + 1;

			} else {

				right = mid;

			}

		}

		return left;

	}

	/**
	 * Get data for GPU upload
	 */
	getGPUData() {

		return {
			emissiveIndices: this.emissiveIndicesArray,
			emissivePower: this.emissivePowerArray,
			emissiveCDF: this.cdfArray,
			emissiveCount: this.emissiveCount,
			totalPower: this.totalEmissivePower
		};

	}

	/**
	 * Create a DataTexture for GPU upload of emissive indices
	 * We'll pack the indices into a texture for efficient access
	 */
	createEmissiveTexture() {

		if ( this.emissiveCount === 0 ) {

			// Create a 1x1 dummy texture
			const dummyData = new Float32Array( 4 );

			return new DataTexture(
				dummyData,
				1,
				1,
				RGBAFormat,
				FloatType
			);

		}

		// Pack data into RGBA texture: R=triangleIndex, G=power, B=cdf, A=unused
		// Each pixel stores data for one emissive triangle
		const data = new Float32Array( this.emissiveCount * 4 );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const offset = i * 4;
			data[ offset + 0 ] = this.emissiveIndicesArray[ i ]; // R: triangle index
			data[ offset + 1 ] = this.emissivePowerArray[ i ]; // G: power
			data[ offset + 2 ] = this.cdfArray[ i ]; // B: CDF value
			data[ offset + 3 ] = 0; // A: unused

		}

		// Calculate texture dimensions (prefer square-ish textures)
		const width = Math.ceil( Math.sqrt( this.emissiveCount ) );
		const height = Math.ceil( this.emissiveCount / width );

		// Pad data if needed
		const requiredSize = width * height * 4;
		const paddedData = new Float32Array( requiredSize );
		paddedData.set( data );

		const texture = new DataTexture(
			paddedData,
			width,
			height,
			RGBAFormat,
			FloatType
		);

		texture.needsUpdate = true;
		texture.generateMipmaps = false;
		texture.minFilter = NearestFilter;
		texture.magFilter = NearestFilter;

		console.log( `[EmissiveTriangleBuilder] Created ${width}x${height} emissive texture (${this.emissiveCount} emissives)` );

		return texture;

	}

	/**
	 * Get statistics for debugging
	 */
	getStats() {

		if ( this.emissiveCount === 0 ) {

			return {
				count: 0,
				totalPower: 0,
				averagePower: 0,
				minPower: 0,
				maxPower: 0
			};

		}

		let minPower = Infinity;
		let maxPower = - Infinity;

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const power = this.emissivePowerArray[ i ];
			minPower = Math.min( minPower, power );
			maxPower = Math.max( maxPower, power );

		}

		return {
			count: this.emissiveCount,
			totalPower: this.totalEmissivePower,
			averagePower: this.totalEmissivePower / this.emissiveCount,
			minPower: minPower,
			maxPower: maxPower
		};

	}

	/**
	 * Clear all data
	 */
	clear() {

		this.emissiveTriangles = [];
		this.emissiveCount = 0;
		this.totalEmissivePower = 0;
		this.emissiveIndicesArray = null;
		this.emissivePowerArray = null;
		this.cdfArray = null;

	}

}
