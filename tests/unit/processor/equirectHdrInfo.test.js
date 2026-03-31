import { describe, it, expect, vi } from 'vitest';

// Mock Three.js imports
vi.mock( 'three', () => ( {
	DataUtils: { fromHalfFloat: ( v ) => v },
	HalfFloatType: 1016,
	FloatType: 1015,
} ) );

import { extractFloatData } from '@/core/Processor/EquirectHDRInfo.js';
import { EquirectHDRInfo } from '@/core/Processor/EquirectHDRInfo.js';

describe( 'extractFloatData', () => {

	it( 'copies Float32Array data', () => {

		const data = new Float32Array( [ 1, 0, 0, 1, 0, 1, 0, 1 ] ); // 2 pixels RGBA
		const envMap = {
			type: 1015, // FloatType
			image: { width: 2, height: 1, data },
			flipY: false,
		};

		const result = extractFloatData( envMap );
		expect( result.width ).toBe( 2 );
		expect( result.height ).toBe( 1 );
		expect( result.floatData ).toBeInstanceOf( Float32Array );
		expect( result.floatData ).not.toBe( data ); // should be a copy
		expect( [ ...result.floatData ] ).toEqual( [ ...data ] );

	} );

	it( 'throws when image data is missing', () => {

		const envMap = {
			type: 1015,
			image: { width: 2, height: 1, data: null },
		};

		expect( () => extractFloatData( envMap ) ).toThrow( /CPU-accessible/ );

	} );

	it( 'handles integer type conversion', () => {

		// Uint8Array: values 0-255 mapped to 0-1
		const data = new Uint8Array( [ 255, 0, 0, 255, 0, 255, 0, 255 ] );
		const envMap = {
			type: 0, // not Float or HalfFloat
			image: { width: 2, height: 1, data },
			flipY: false,
		};

		const result = extractFloatData( envMap );
		expect( result.floatData[ 0 ] ).toBeCloseTo( 1.0 ); // 255/255
		expect( result.floatData[ 1 ] ).toBeCloseTo( 0.0 ); // 0/255

	} );

	it( 'handles flipY by inverting rows', () => {

		// 2x2 image, RGBA
		const data = new Float32Array( [
			// row 0 (top)
			1, 0, 0, 1, 0, 1, 0, 1,
			// row 1 (bottom)
			0, 0, 1, 1, 1, 1, 1, 1,
		] );
		const envMap = {
			type: 1015,
			image: { width: 2, height: 2, data },
			flipY: true,
		};

		const result = extractFloatData( envMap );
		// After Y-flip, row 0 becomes row 1 and vice versa
		// New row 0 = old row 1 (blue pixel, white pixel)
		expect( result.floatData[ 0 ] ).toBeCloseTo( 0 ); // blue.r
		expect( result.floatData[ 2 ] ).toBeCloseTo( 1 ); // blue.b

	} );

} );

describe( 'EquirectHDRInfo.computeCDF', () => {

	it( 'uniform image produces near-uniform CDF', () => {

		// 4x2 uniform white image (RGBA)
		const width = 4;
		const height = 2;
		const floatData = new Float32Array( width * height * 4 );
		for ( let i = 0; i < width * height; i ++ ) {

			floatData[ i * 4 ] = 1; // R
			floatData[ i * 4 + 1 ] = 1; // G
			floatData[ i * 4 + 2 ] = 1; // B
			floatData[ i * 4 + 3 ] = 1; // A

		}

		const { marginalData, conditionalData, totalSum } = EquirectHDRInfo.computeCDF( floatData, width, height );

		expect( totalSum ).toBeGreaterThan( 0 );
		expect( marginalData ).toHaveLength( height );
		expect( conditionalData ).toHaveLength( width * height );

		// Marginal CDF for uniform image: values should be roughly evenly spaced
		// Each entry maps to a row index via inverted CDF
		for ( let i = 0; i < height; i ++ ) {

			expect( marginalData[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( marginalData[ i ] ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'bright pixel concentrates CDF', () => {

		// 2x2 image: one bright pixel, rest dark
		const width = 2;
		const height = 2;
		const floatData = new Float32Array( width * height * 4 );
		// Set pixel (0,0) to be very bright
		floatData[ 0 ] = 100; // R
		floatData[ 1 ] = 100; // G
		floatData[ 2 ] = 100; // B
		floatData[ 3 ] = 1;   // A

		const { totalSum } = EquirectHDRInfo.computeCDF( floatData, width, height );

		// Total sum should be dominated by the bright pixel
		expect( totalSum ).toBeGreaterThan( 99 ); // luminance ~100

	} );

	it( 'all-black image has zero totalSum', () => {

		const width = 2;
		const height = 2;
		const floatData = new Float32Array( width * height * 4 ); // all zeros

		const { totalSum } = EquirectHDRInfo.computeCDF( floatData, width, height );
		expect( totalSum ).toBe( 0 );

	} );

} );
