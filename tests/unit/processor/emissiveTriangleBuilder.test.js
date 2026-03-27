import { describe, it, expect, vi } from 'vitest';

// Mock Three.js imports that EmissiveTriangleBuilder needs
vi.mock( 'three', () => ( {
	DataTexture: class {},
	RGBAFormat: 1023,
	FloatType: 1015,
	NearestFilter: 1003,
} ) );

// Mock LightBVHBuilder to avoid its dependencies
vi.mock( '@/core/Processor/LightBVHBuilder.js', () => ( {
	LightBVHBuilder: class {

		constructor() { this.nodeCount = 0; }
		build() { return 0; }

	}
} ) );

import { EmissiveTriangleBuilder } from '@/core/Processor/EmissiveTriangleBuilder.js';

describe( 'EmissiveTriangleBuilder', () => {

	describe( '_calculateTriangleArea', () => {

		it( 'unit right triangle has area 0.5', () => {

			const builder = new EmissiveTriangleBuilder();
			// Triangle: (0,0,0), (1,0,0), (0,1,0) — right triangle in XY plane
			const area = builder._calculateTriangleArea(
				0, 0, 0,
				1, 0, 0,
				0, 1, 0
			);
			expect( area ).toBeCloseTo( 0.5 );

		} );

		it( 'degenerate triangle (all same point) has area 0', () => {

			const builder = new EmissiveTriangleBuilder();
			const area = builder._calculateTriangleArea(
				1, 1, 1,
				1, 1, 1,
				1, 1, 1
			);
			expect( area ).toBe( 0 );

		} );

		it( 'scaled right triangle has correct area', () => {

			const builder = new EmissiveTriangleBuilder();
			// Triangle: (0,0,0), (2,0,0), (0,3,0) — area = 0.5 * 2 * 3 = 3
			const area = builder._calculateTriangleArea(
				0, 0, 0,
				2, 0, 0,
				0, 3, 0
			);
			expect( area ).toBeCloseTo( 3.0 );

		} );

		it( '3D triangle in arbitrary plane', () => {

			const builder = new EmissiveTriangleBuilder();
			// Equilateral triangle with side length 2 in 3D
			// Area = sqrt(3)/4 * side^2 = sqrt(3)
			const area = builder._calculateTriangleArea(
				0, 0, 0,
				2, 0, 0,
				1, Math.sqrt( 3 ), 0
			);
			expect( area ).toBeCloseTo( Math.sqrt( 3 ) );

		} );

		it( 'collinear points have area 0', () => {

			const builder = new EmissiveTriangleBuilder();
			const area = builder._calculateTriangleArea(
				0, 0, 0,
				1, 1, 1,
				2, 2, 2
			);
			expect( area ).toBeCloseTo( 0 );

		} );

	} );

	describe( 'constructor', () => {

		it( 'initializes with empty state', () => {

			const builder = new EmissiveTriangleBuilder();
			expect( builder.emissiveTriangles ).toEqual( [] );
			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );

		} );

	} );

} );
