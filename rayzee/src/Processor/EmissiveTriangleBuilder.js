/**
 * EmissiveTriangleBuilder
 *
 * Builds an index of emissive triangles for efficient direct lighting sampling.
 * Instead of randomly searching through all triangles, we maintain a list of
 * only the emissive ones, giving 100% sampling success rate.
 */

import { DataTexture, RGBAFormat, FloatType, NearestFilter } from 'three';
import { TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';
import { LightBVHBuilder } from './LightBVHBuilder.js';

export class EmissiveTriangleBuilder {

	constructor() {

		this.emissiveTriangles = [];
		this.emissiveCount = 0;
		this.totalEmissivePower = 0;
		this.emissiveIndicesArray = null;
		this.emissivePowerArray = null;
		this.cdfArray = null;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;

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

		const FLOATS_PER_TRIANGLE = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const MATERIAL_INDEX_OFFSET = TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET + 2; // materialIndex within vec4

		for ( let i = 0; i < triangleCount; i ++ ) {

			const baseOffset = i * FLOATS_PER_TRIANGLE;
			const materialIndex = Math.floor( triangleData[ baseOffset + MATERIAL_INDEX_OFFSET ] );

			// Get material
			const material = materials[ materialIndex ];
			if ( ! material ) continue;

			// Check if emissive and visible
			const emissive = material.emissive || { r: 0, g: 0, b: 0 };
			const emissiveIntensity = material.emissiveIntensity || 0;
			const isVisible = material.visible === undefined || material.visible !== 0;

			const isEmissive = isVisible && emissiveIntensity > 0 && (
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

				// Centroid for BVH split decisions
				const cx = ( v0x + v1x + v2x ) / 3;
				const cy = ( v0y + v1y + v2y ) / 3;
				const cz = ( v0z + v1z + v2z ) / 3;

				// AABB for BVH node bounds
				const bMinX = Math.min( v0x, v1x, v2x );
				const bMinY = Math.min( v0y, v1y, v2y );
				const bMinZ = Math.min( v0z, v1z, v2z );
				const bMaxX = Math.max( v0x, v1x, v2x );
				const bMaxY = Math.max( v0y, v1y, v2y );
				const bMaxZ = Math.max( v0z, v1z, v2z );

				this.emissiveTriangles.push( {
					triangleIndex: i,
					materialIndex: materialIndex,
					power: power,
					area: area,
					emissive: { r: emissive.r, g: emissive.g, b: emissive.b },
					emissiveIntensity: emissiveIntensity,
					cx, cy, cz,
					bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ,
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
	 * Create raw Float32Array for storage buffer (no 2D DataTexture padding).
	 * Each emissive entry is 2 vec4s (8 floats):
	 *   vec4[0]: triangleIndex, power, cdf, selectionPdf
	 *   vec4[1]: emission.r, emission.g, emission.b, area
	 * @returns {Float32Array} Tightly-packed emissive data
	 */
	createEmissiveRawData() {

		if ( this.emissiveCount === 0 ) {

			return new Float32Array( 8 ); // 2 dummy vec4s

		}

		const data = new Float32Array( this.emissiveCount * 8 );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const tri = this.emissiveTriangles[ i ];
			const offset = i * 8;

			// vec4[0]: triangleIndex, power, cdf, selectionPdf
			data[ offset + 0 ] = tri.triangleIndex;
			data[ offset + 1 ] = tri.power;
			data[ offset + 2 ] = this.cdfArray[ i ];
			data[ offset + 3 ] = this.totalEmissivePower > 0 ? tri.power / this.totalEmissivePower : 0;

			// vec4[1]: pre-multiplied emission (emissive * intensity), area
			data[ offset + 4 ] = tri.emissive.r * tri.emissiveIntensity;
			data[ offset + 5 ] = tri.emissive.g * tri.emissiveIntensity;
			data[ offset + 6 ] = tri.emissive.b * tri.emissiveIntensity;
			data[ offset + 7 ] = tri.area;

		}

		console.log( `[EmissiveTriangleBuilder] Created emissive raw data: ${this.emissiveCount} entries (${data.byteLength} bytes)` );

		return data;

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
	 * Fast update when a material's emissive properties change.
	 * Avoids full triangle scan when possible — only rescans if the set of
	 * emissive triangles may have changed (material became or stopped being emissive).
	 * @param {number} materialIndex - Index of the changed material
	 * @param {object} material - The updated material object
	 * @param {Array} triangleData - Full triangle data (only needed for full rescan)
	 * @param {Array} materials - Materials array (only needed for full rescan)
	 * @param {number} triangleCount - Total triangles (only needed for full rescan)
	 * @returns {boolean} true if data changed and needs GPU re-upload
	 */
	updateMaterialEmissive( materialIndex, material, triangleData, materials, triangleCount ) {

		const emissive = material.emissive || { r: 0, g: 0, b: 0 };
		const emissiveIntensity = material.emissiveIntensity || 0;
		const isVisible = material.visible === undefined || material.visible !== 0;
		const isNowEmissive = isVisible && emissiveIntensity > 0 && ( emissive.r > 0 || emissive.g > 0 || emissive.b > 0 );

		// Check if this material had any emissive triangles before
		const hadEmissive = this.emissiveTriangles.some( t => t.materialIndex === materialIndex );

		// If the emissive set changed (gained or lost emissive status), full rescan needed
		if ( isNowEmissive !== hadEmissive ) {

			this.extractEmissiveTriangles( triangleData, materials, triangleCount );
			return true;

		}

		// If not emissive before and not now, nothing to do
		if ( ! isNowEmissive ) return false;

		// Fast path: just update power + CDF for affected entries
		const avgEmissive = ( emissive.r + emissive.g + emissive.b ) / 3.0;

		this.totalEmissivePower = 0;
		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const tri = this.emissiveTriangles[ i ];
			if ( tri.materialIndex === materialIndex ) {

				tri.power = avgEmissive * emissiveIntensity * tri.area;
				tri.emissive = { r: emissive.r, g: emissive.g, b: emissive.b };
				tri.emissiveIntensity = emissiveIntensity;
				this.emissivePowerArray[ i ] = tri.power;

			}

			this.totalEmissivePower += this.emissiveTriangles[ i ].power;

		}

		this._buildCDF();
		return true;

	}

	/**
	 * Build a Light BVH over the current emissive triangles.
	 * Reorders emissiveTriangleData so that leaf node start/count indices are valid.
	 * @returns {number} nodeCount
	 */
	buildLightBVH() {

		if ( this.emissiveCount === 0 ) {

			// Dummy single leaf node
			this.lightBVHNodeData = new Float32Array( 16 );
			this.lightBVHNodeData[ 7 ] = 1.0; // isLeaf
			this.lightBVHNodeCount = 1;
			return 1;

		}

		const builder = new LightBVHBuilder();
		const { nodeData, nodeCount, sortedPerm } = builder.build( this.emissiveTriangles );
		this.lightBVHNodeData = nodeData;
		this.lightBVHNodeCount = nodeCount;

		// Rebuild emissive raw data in sorted leaf order so node start/count refs are valid
		this._rebuildSortedEmissiveData( sortedPerm );

		return nodeCount;

	}

	/**
	 * Rebuild emissive arrays and raw GPU data in the sorted leaf order given by sortedPerm.
	 * @param {Int32Array} sortedPerm - sortedPerm[i] = original emissiveTriangles index for position i
	 * @private
	 */
	_rebuildSortedEmissiveData( sortedPerm ) {

		const n = sortedPerm.length;

		// Rebuild typed arrays in sorted order
		this.emissiveIndicesArray = new Int32Array( n );
		this.emissivePowerArray = new Float32Array( n );

		for ( let i = 0; i < n; i ++ ) {

			const origIdx = sortedPerm[ i ];
			this.emissiveIndicesArray[ i ] = this.emissiveTriangles[ origIdx ].triangleIndex;
			this.emissivePowerArray[ i ] = this.emissiveTriangles[ origIdx ].power;

		}

		// Rebuild CDF for the sorted order (so fallback path still works)
		this._buildCDF();

		// Rebuild raw emissive GPU data (2 vec4s per entry) in sorted order
		const data = new Float32Array( n * 8 );

		for ( let i = 0; i < n; i ++ ) {

			const origIdx = sortedPerm[ i ];
			const tri = this.emissiveTriangles[ origIdx ];
			const offset = i * 8;

			// vec4[0]: triangleIndex, power, cdf, selectionPdf
			data[ offset + 0 ] = tri.triangleIndex;
			data[ offset + 1 ] = tri.power;
			data[ offset + 2 ] = this.cdfArray[ i ];
			data[ offset + 3 ] = this.totalEmissivePower > 0 ? tri.power / this.totalEmissivePower : 0;

			// vec4[1]: pre-multiplied emission (emissive * intensity), area
			data[ offset + 4 ] = tri.emissive.r * tri.emissiveIntensity;
			data[ offset + 5 ] = tri.emissive.g * tri.emissiveIntensity;
			data[ offset + 6 ] = tri.emissive.b * tri.emissiveIntensity;
			data[ offset + 7 ] = tri.area;

		}

		this.emissiveTriangleData = data;
		console.log( `[EmissiveTriangleBuilder] Rebuilt sorted emissive data: ${n} entries` );

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
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;

	}

}
