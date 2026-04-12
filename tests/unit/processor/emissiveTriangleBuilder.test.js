import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Three.js imports that EmissiveTriangleBuilder needs
vi.mock( 'three', () => ( {
	DataTexture: class {

		constructor( data, w, h ) {

			this.image = { data, width: w, height: h };

		}

	},
	RGBAFormat: 1023,
	FloatType: 1015,
	NearestFilter: 1003,
} ) );

// Mock LightBVHBuilder to avoid its dependencies
vi.mock( '@/core/Processor/LightBVHBuilder.js', () => ( {
	LightBVHBuilder: class {

		constructor() {

			this.nodeCount = 0;

		}
		build() {

			return 0;

		}

	}
} ) );

import { EmissiveTriangleBuilder } from '@/core/Processor/EmissiveTriangleBuilder.js';

// TRIANGLE_DATA_LAYOUT: 32 floats per tri, materialIndex at offset 30 (UV_C_MAT_OFFSET=28 + 2)
const FLOATS_PER_TRI = 32;
const MAT_INDEX_OFFSET = 30;

function makeTriangleData( triangles ) {

	const data = new Float32Array( triangles.length * FLOATS_PER_TRI );
	for ( let i = 0; i < triangles.length; i ++ ) {

		const t = triangles[ i ];
		const base = i * FLOATS_PER_TRI;
		data[ base + 0 ] = t.posA[ 0 ]; data[ base + 1 ] = t.posA[ 1 ]; data[ base + 2 ] = t.posA[ 2 ];
		data[ base + 4 ] = t.posB[ 0 ]; data[ base + 5 ] = t.posB[ 1 ]; data[ base + 6 ] = t.posB[ 2 ];
		data[ base + 8 ] = t.posC[ 0 ]; data[ base + 9 ] = t.posC[ 1 ]; data[ base + 10 ] = t.posC[ 2 ];
		data[ base + MAT_INDEX_OFFSET ] = t.materialIndex;

	}

	return data;

}

// Unit triangle in XY plane: A=(0,0,0), B=(1,0,0), C=(0,1,0) → area = 0.5
const UNIT_TRI = { posA: [ 0, 0, 0 ], posB: [ 1, 0, 0 ], posC: [ 0, 1, 0 ] };

describe( 'EmissiveTriangleBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new EmissiveTriangleBuilder();

	} );

	// ── _calculateTriangleArea ────────────────────────────────

	describe( '_calculateTriangleArea', () => {

		it( 'unit right triangle has area 0.5', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 1, 0, 0, 0, 1, 0 );
			expect( area ).toBeCloseTo( 0.5 );

		} );

		it( 'degenerate triangle (all same point) has area 0', () => {

			const area = builder._calculateTriangleArea( 1, 1, 1, 1, 1, 1, 1, 1, 1 );
			expect( area ).toBe( 0 );

		} );

		it( 'scaled right triangle has correct area', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 2, 0, 0, 0, 3, 0 );
			expect( area ).toBeCloseTo( 3.0 );

		} );

		it( '3D triangle in arbitrary plane', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 2, 0, 0, 1, Math.sqrt( 3 ), 0 );
			expect( area ).toBeCloseTo( Math.sqrt( 3 ) );

		} );

		it( 'collinear points have area 0', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 1, 1, 1, 2, 2, 2 );
			expect( area ).toBeCloseTo( 0 );

		} );

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'initializes with empty state', () => {

			expect( builder.emissiveTriangles ).toEqual( [] );
			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );

		} );

	} );

	// ── extractEmissiveTriangles ──────────────────────────────

	describe( 'extractEmissiveTriangles', () => {

		it( 'finds emissive triangles', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
			] );
			const materials = [
				{ emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5 },
			];

			const count = builder.extractEmissiveTriangles( triangleData, materials, 2 );
			expect( count ).toBe( 1 );
			expect( builder.emissiveTriangles[ 0 ].triangleIndex ).toBe( 1 );

		} );

		it( 'returns 0 for no emissive triangles', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];

			expect( builder.extractEmissiveTriangles( triangleData, materials, 1 ) ).toBe( 0 );

		} );

		it( 'skips triangles with missing material', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 99 } ] );
			expect( builder.extractEmissiveTriangles( triangleData, [], 1 ) ).toBe( 0 );

		} );

		it( 'ignores material visible flag (per-mesh visibility handled at BLAS-pointer level)', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5, visible: 0 } ];

			// Material visible flag no longer affects emissive extraction
			expect( builder.extractEmissiveTriangles( triangleData, materials, 1 ) ).toBe( 1 );

		} );

		it( 'calculates power as avgEmissive * intensity * area', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 3, g: 6, b: 9 }, emissiveIntensity: 2 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const expectedPower = ( ( 3 + 6 + 9 ) / 3 ) * 2 * 0.5; // avgEmissive * intensity * area
			expect( builder.emissiveTriangles[ 0 ].power ).toBeCloseTo( expectedPower );

		} );

		it( 'computes centroid and AABB', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const tri = builder.emissiveTriangles[ 0 ];

			// Centroid of (0,0,0),(1,0,0),(0,1,0)
			expect( tri.cx ).toBeCloseTo( 1 / 3 );
			expect( tri.cy ).toBeCloseTo( 1 / 3 );
			expect( tri.cz ).toBeCloseTo( 0 );

			// AABB
			expect( tri.bMinX ).toBe( 0 );
			expect( tri.bMinY ).toBe( 0 );
			expect( tri.bMaxX ).toBe( 1 );
			expect( tri.bMaxY ).toBe( 1 );

		} );

		it( 'accumulates totalEmissivePower across triangles', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 3 );
			const singlePower = builder.emissiveTriangles[ 0 ].power;
			expect( builder.totalEmissivePower ).toBeCloseTo( singlePower * 3 );

		} );

		it( 'builds emissiveIndicesArray and emissivePowerArray', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [
				{ emissive: { r: 1, g: 0, b: 0 }, emissiveIntensity: 2 },
				{ emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 },
			];

			builder.extractEmissiveTriangles( triangleData, materials, 3 );
			expect( builder.emissiveIndicesArray ).toHaveLength( 2 );
			expect( builder.emissivePowerArray ).toHaveLength( 2 );
			expect( builder.emissiveIndicesArray[ 0 ] ).toBe( 0 );
			expect( builder.emissiveIndicesArray[ 1 ] ).toBe( 2 );

		} );

	} );

	// ── CDF ───────────────────────────────────────────────────

	describe( 'CDF', () => {

		it( 'builds normalized CDF summing to 1.0', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.cdfArray ).toHaveLength( 2 );
			expect( builder.cdfArray[ 1 ] ).toBeCloseTo( 1.0 );

		} );

		it( 'equal-power triangles have evenly spaced CDF', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.cdfArray[ 0 ] ).toBeCloseTo( 0.5 );
			expect( builder.cdfArray[ 1 ] ).toBeCloseTo( 1.0 );

		} );

		it( 'handles zero emissive count', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.cdfArray ).toHaveLength( 1 );
			expect( builder.cdfArray[ 0 ] ).toBe( 0 );

		} );

	} );

	// ── sampleCDF ─────────────────────────────────────────────

	describe( 'sampleCDF', () => {

		it( 'returns -1 for empty set', () => {

			expect( builder.sampleCDF( 0.5 ) ).toBe( - 1 );

		} );

		it( 'returns 0 for single emissive triangle', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.sampleCDF( 0.0 ) ).toBe( 0 );
			expect( builder.sampleCDF( 0.5 ) ).toBe( 0 );
			expect( builder.sampleCDF( 1.0 ) ).toBe( 0 );

		} );

		it( 'binary search selects correct index based on CDF', () => {

			// Two triangles with different power (big has 4x area → 4x power)
			const big = { posA: [ 0, 0, 0 ], posB: [ 2, 0, 0 ], posC: [ 0, 2, 0 ], materialIndex: 0 };
			const small = { ...UNIT_TRI, materialIndex: 0 };

			const triangleData = makeTriangleData( [ big, small ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			// CDF[0] ≈ 0.8 (big tri has 4x power), CDF[1] = 1.0
			// u < CDF[0] → index 0 (big tri)
			expect( builder.sampleCDF( 0.0 ) ).toBe( 0 );
			// u > CDF[0] → index 1 (small tri)
			expect( builder.sampleCDF( 0.9 ) ).toBe( 1 );

		} );

	} );

	// ── getGPUData ────────────────────────────────────────────

	describe( 'getGPUData', () => {

		it( 'returns all required fields', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const data = builder.getGPUData();
			expect( data ).toHaveProperty( 'emissiveIndices' );
			expect( data ).toHaveProperty( 'emissivePower' );
			expect( data ).toHaveProperty( 'emissiveCDF' );
			expect( data.emissiveCount ).toBe( 1 );
			expect( data.totalPower ).toBeGreaterThan( 0 );

		} );

	} );

	// ── createEmissiveRawData ─────────────────────────────────

	describe( 'createEmissiveRawData', () => {

		it( 'returns 8-float dummy for zero emissives', () => {

			const data = builder.createEmissiveRawData();
			expect( data ).toHaveLength( 8 );

		} );

		it( 'packs 2 vec4s per entry (8 floats)', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.createEmissiveRawData() ).toHaveLength( 16 );

		} );

		it( 'stores triangle index, power, cdf, pdf in vec4[0]', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const data = builder.createEmissiveRawData();
			expect( data[ 0 ] ).toBe( 0 ); // triangleIndex
			expect( data[ 1 ] ).toBeGreaterThan( 0 ); // power
			expect( data[ 2 ] ).toBeCloseTo( 1.0 ); // CDF (single entry = 1.0)
			expect( data[ 3 ] ).toBeCloseTo( 1.0 ); // PDF (single entry = power/totalPower = 1.0)

		} );

		it( 'stores pre-multiplied emission and area in vec4[1]', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 2, g: 3, b: 4 }, emissiveIntensity: 5 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const data = builder.createEmissiveRawData();
			expect( data[ 4 ] ).toBeCloseTo( 10 ); // 2 * 5
			expect( data[ 5 ] ).toBeCloseTo( 15 ); // 3 * 5
			expect( data[ 6 ] ).toBeCloseTo( 20 ); // 4 * 5
			expect( data[ 7 ] ).toBeCloseTo( 0.5 ); // unit tri area

		} );

	} );

	// ── createEmissiveTexture ─────────────────────────────────

	describe( 'createEmissiveTexture', () => {

		it( 'returns 1x1 dummy texture for zero emissives', () => {

			const tex = builder.createEmissiveTexture();
			expect( tex ).toBeDefined();

		} );

		it( 'creates texture for emissive data', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const tex = builder.createEmissiveTexture();
			expect( tex ).toBeDefined();

		} );

	} );

	// ── getStats ──────────────────────────────────────────────

	describe( 'getStats', () => {

		it( 'returns zero stats when empty', () => {

			const stats = builder.getStats();
			expect( stats.count ).toBe( 0 );
			expect( stats.totalPower ).toBe( 0 );
			expect( stats.averagePower ).toBe( 0 );
			expect( stats.minPower ).toBe( 0 );
			expect( stats.maxPower ).toBe( 0 );

		} );

		it( 'computes correct min/max/average', () => {

			const big = { posA: [ 0, 0, 0 ], posB: [ 4, 0, 0 ], posC: [ 0, 4, 0 ], materialIndex: 0 };
			const small = { ...UNIT_TRI, materialIndex: 0 };

			const triangleData = makeTriangleData( [ big, small ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			const stats = builder.getStats();
			expect( stats.count ).toBe( 2 );
			expect( stats.minPower ).toBeLessThan( stats.maxPower );
			expect( stats.averagePower ).toBeCloseTo( stats.totalPower / 2 );

		} );

	} );

	// ── updateMaterialEmissive ────────────────────────────────

	describe( 'updateMaterialEmissive', () => {

		it( 'returns false when material was and remains non-emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( false );

		} );

		it( 'triggers full rescan when material becomes emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			expect( builder.emissiveCount ).toBe( 1 );

		} );

		it( 'triggers full rescan when material stops being emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			expect( builder.emissiveCount ).toBe( 1 );

			materials[ 0 ] = { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			expect( builder.emissiveCount ).toBe( 0 );

		} );

		it( 'fast-updates power when emissive intensity changes', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const oldPower = builder.totalEmissivePower;

			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 10 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			expect( builder.totalEmissivePower ).toBeGreaterThan( oldPower );

		} );

		it( 'fast-updates CDF after power change', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
			] );
			const materials = [
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 },
			];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			// Change mat 0 intensity → CDF should be rebuilt
			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 100 };
			builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 2 );

			// Last CDF entry always 1.0
			expect( builder.cdfArray[ builder.cdfArray.length - 1 ] ).toBeCloseTo( 1.0 );

		} );

	} );

	// ── clear ─────────────────────────────────────────────────

	describe( 'clear', () => {

		it( 'resets all state', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			builder.clear();

			expect( builder.emissiveTriangles ).toEqual( [] );
			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );
			expect( builder.emissiveIndicesArray ).toBeNull();
			expect( builder.emissivePowerArray ).toBeNull();
			expect( builder.cdfArray ).toBeNull();
			expect( builder.lightBVHNodeData ).toBeNull();
			expect( builder.lightBVHNodeCount ).toBe( 0 );

		} );

	} );

} );
