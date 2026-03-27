import { describe, it, expect, vi } from 'vitest';

// Mock Three.js (LightDataTransfer imports Vector3, Quaternion)
vi.mock( 'three', () => ( {
	Vector3: class {

		constructor( x = 0, y = 0, z = 0 ) { this.x = x; this.y = y; this.z = z; }

	},
	Quaternion: class {

		constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }

	}
} ) );

import { LightDataTransfer } from '@/core/Processor/LightDataTransfer.js';

describe( 'LightDataTransfer', () => {

	describe( 'calculateLightImportance', () => {

		it( 'directional light: importance = intensity * luminance', () => {

			const transfer = new LightDataTransfer();
			const light = {
				color: { r: 1, g: 1, b: 1 }, // pure white
				intensity: 5.0
			};

			const importance = transfer.calculateLightImportance( light, 'directional' );
			// luminance of white = 0.2126 + 0.7152 + 0.0722 = 1.0
			expect( importance ).toBeCloseTo( 5.0 );

		} );

		it( 'directional light: colored light has lower importance', () => {

			const transfer = new LightDataTransfer();
			const red = { color: { r: 1, g: 0, b: 0 }, intensity: 5.0 };
			const white = { color: { r: 1, g: 1, b: 1 }, intensity: 5.0 };

			const redImportance = transfer.calculateLightImportance( red, 'directional' );
			const whiteImportance = transfer.calculateLightImportance( white, 'directional' );
			expect( redImportance ).toBeLessThan( whiteImportance );

		} );

		it( 'area light: factors in sqrt(area)', () => {

			const transfer = new LightDataTransfer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				width: 4,
				height: 4
			};

			const importance = transfer.calculateLightImportance( light, 'area' );
			// luminance=1, intensity=1, sqrt(16) = 4
			expect( importance ).toBeCloseTo( 4.0 );

		} );

		it( 'point light: factors in sqrt(distance)', () => {

			const transfer = new LightDataTransfer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				distance: 100
			};

			const importance = transfer.calculateLightImportance( light, 'point' );
			// luminance=1, intensity=1, sqrt(100) = 10
			expect( importance ).toBeCloseTo( 10.0 );

		} );

		it( 'spot light: factors in distance and cone angle', () => {

			const transfer = new LightDataTransfer();
			const light = {
				color: { r: 1, g: 1, b: 1 },
				intensity: 1.0,
				distance: 100,
				angle: Math.PI / 4
			};

			const importance = transfer.calculateLightImportance( light, 'spot' );
			// luminance=1, intensity=1, sqrt(100)=10, sin(PI/4)=~0.707
			expect( importance ).toBeCloseTo( 10 * Math.sin( Math.PI / 4 ) );

		} );

		it( 'zero intensity produces zero importance', () => {

			const transfer = new LightDataTransfer();
			const light = { color: { r: 1, g: 1, b: 1 }, intensity: 0 };
			expect( transfer.calculateLightImportance( light ) ).toBe( 0 );

		} );

	} );

	describe( 'clear', () => {

		it( 'resets all caches', () => {

			const transfer = new LightDataTransfer();
			transfer.directionalLightCache.push( {} );
			transfer.areaLightCache.push( {} );
			transfer.clear();
			expect( transfer.directionalLightCache ).toHaveLength( 0 );
			expect( transfer.areaLightCache ).toHaveLength( 0 );
			expect( transfer.pointLightCache ).toHaveLength( 0 );
			expect( transfer.spotLightCache ).toHaveLength( 0 );

		} );

	} );

} );
