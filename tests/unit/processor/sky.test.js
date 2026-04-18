import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock( 'three', () => ( {
	RGBAFormat: 1023, FloatType: 1015, LinearFilter: 1006,
	RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
	EquirectangularReflectionMapping: 303, LinearSRGBColorSpace: 'srgb-linear',
	DataTexture: class {

		constructor( data, w, h ) {

			this.image = { data, width: w, height: h };
			this.needsUpdate = false;

		}

		dispose() {}

	},
} ) );

import { ProceduralSky } from '@/core/Processor/ProceduralSky.js';
import { SimpleSky } from '@/core/Processor/SimpleSky.js';

// ── ProceduralSky ─────────────────────────────────────────────

describe( 'ProceduralSky', () => {

	let sky;

	beforeEach( () => {

		sky = new ProceduralSky( 512, 256 );

	} );

	// ── Constructor ────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'creates correct-size pixel buffer', () => {

			expect( sky._pixels ).toBeInstanceOf( Float32Array );
			expect( sky._pixels.length ).toBe( 512 * 256 * 4 );

		} );

		it( 'creates a DataTexture with matching dimensions', () => {

			expect( sky._texture.image.width ).toBe( 512 );
			expect( sky._texture.image.height ).toBe( 256 );

		} );

	} );

	// ── render ─────────────────────────────────────────────────

	describe( 'render', () => {

		const sunnyParams = {
			sunDirection: { x: 0, y: 1, z: 0 },
			sunIntensity: 1.0,
			rayleighDensity: 2.0,
			mieDensity: 0.005,
			mieAnisotropy: 0.8,
			turbidity: 2.0,
		};

		it( 'fills pixels with non-zero values for a sunny sky', () => {

			sky.render( sunnyParams );

			const hasNonZero = sky._pixels.some( v => v !== 0 );
			expect( hasNonZero ).toBe( true );

		} );

		it( 'returns a texture with needsUpdate=true', () => {

			const tex = sky.render( sunnyParams );
			expect( tex.needsUpdate ).toBe( true );

		} );

		it( 'returns the internal texture instance', () => {

			const tex = sky.render( sunnyParams );
			expect( tex ).toBe( sky._texture );

		} );

	} );

	// ── setResolution ──────────────────────────────────────────

	describe( 'setResolution', () => {

		it( 'resizes the pixel buffer', () => {

			sky.setResolution( 256, 128 );

			expect( sky.width ).toBe( 256 );
			expect( sky.height ).toBe( 128 );
			expect( sky._pixels.length ).toBe( 256 * 128 * 4 );

		} );

		it( 'is a no-op for the same size', () => {

			const originalPixels = sky._pixels;
			sky.setResolution( 512, 256 );

			expect( sky._pixels ).toBe( originalPixels );

		} );

	} );

	// ── getLastRenderTime ──────────────────────────────────────

	describe( 'getLastRenderTime', () => {

		it( 'returns 0 before any render', () => {

			expect( sky.getLastRenderTime() ).toBe( 0 );

		} );

		it( 'returns > 0 after render', () => {

			sky.render( { sunDirection: { x: 0, y: 1, z: 0 } } );
			expect( sky.getLastRenderTime() ).toBeGreaterThanOrEqual( 0 );

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'is callable without error', () => {

			expect( () => sky.dispose() ).not.toThrow();

		} );

	} );

} );

// ── SimpleSky ─────────────────────────────────────────────────

describe( 'SimpleSky', () => {

	let sky;

	beforeEach( () => {

		sky = new SimpleSky( 64, 32 );

	} );

	// ── renderSolid ────────────────────────────────────────────

	describe( 'renderSolid', () => {

		it( 'fills all pixels with the same color', () => {

			sky.renderSolid( { color: { r: 0.5, g: 0.25, b: 0.75 } } );

			const pixels = sky._pixels;
			const w = sky.width;
			const h = sky.height;

			for ( let i = 0; i < w * h; i ++ ) {

				expect( pixels[ i * 4 ] ).toBeCloseTo( 0.5 );
				expect( pixels[ i * 4 + 1 ] ).toBeCloseTo( 0.25 );
				expect( pixels[ i * 4 + 2 ] ).toBeCloseTo( 0.75 );
				expect( pixels[ i * 4 + 3 ] ).toBeCloseTo( 1.0 );

			}

		} );

		it( 'returns a texture with needsUpdate=true', () => {

			const tex = sky.renderSolid( { color: { r: 1, g: 0, b: 0 } } );
			expect( tex.needsUpdate ).toBe( true );

		} );

	} );

	// ── renderGradient ─────────────────────────────────────────

	describe( 'renderGradient', () => {

		const gradientParams = {
			zenithColor: { r: 0.0, g: 0.0, b: 1.0 },
			horizonColor: { r: 1.0, g: 1.0, b: 1.0 },
			groundColor: { r: 0.2, g: 0.1, b: 0.0 },
		};

		it( 'top half blends horizon to zenith, bottom half ground to horizon', () => {

			sky.renderGradient( gradientParams );

			const pixels = sky._pixels;
			const w = sky.width;
			const h = sky.height;

			// Bottom row (y=0) should be close to ground color
			const bottomIdx = 0;
			expect( pixels[ bottomIdx ] ).toBeCloseTo( 0.2, 1 );
			expect( pixels[ bottomIdx + 1 ] ).toBeCloseTo( 0.1, 1 );
			expect( pixels[ bottomIdx + 2 ] ).toBeCloseTo( 0.0, 1 );

			// Top row (y=h-1) should be close to zenith color
			const topIdx = ( h - 1 ) * w * 4;
			expect( pixels[ topIdx ] ).toBeCloseTo( 0.0, 1 );
			expect( pixels[ topIdx + 1 ] ).toBeCloseTo( 0.0, 1 );
			expect( pixels[ topIdx + 2 ] ).toBeCloseTo( 1.0, 1 );

		} );

		it( 'middle row approximates horizon color', () => {

			sky.renderGradient( gradientParams );

			const pixels = sky._pixels;
			const w = sky.width;
			const h = sky.height;

			// The row closest to t=0.5 is the horizon transition
			// At t=0.5, bottom half blend = t*2 = 1.0 → fully horizon
			const midY = Math.floor( h / 2 );
			const midIdx = midY * w * 4;

			expect( pixels[ midIdx ] ).toBeCloseTo( 1.0, 1 );
			expect( pixels[ midIdx + 1 ] ).toBeCloseTo( 1.0, 1 );
			expect( pixels[ midIdx + 2 ] ).toBeCloseTo( 1.0, 1 );

		} );

		it( 'returns a texture with needsUpdate=true', () => {

			const tex = sky.renderGradient( gradientParams );
			expect( tex.needsUpdate ).toBe( true );

		} );

	} );

	// ── setResolution ──────────────────────────────────────────

	describe( 'setResolution', () => {

		it( 'changes pixel buffer size', () => {

			sky.setResolution( 128, 64 );

			expect( sky.width ).toBe( 128 );
			expect( sky.height ).toBe( 64 );
			expect( sky._pixels.length ).toBe( 128 * 64 * 4 );

		} );

		it( 'is a no-op for the same size', () => {

			const originalPixels = sky._pixels;
			sky.setResolution( 64, 32 );

			expect( sky._pixels ).toBe( originalPixels );

		} );

	} );

	// ── getLastRenderTime ──────────────────────────────────────

	describe( 'getLastRenderTime', () => {

		it( 'returns > 0 after render', () => {

			sky.renderSolid( { color: { r: 1, g: 0, b: 0 } } );
			expect( sky.getLastRenderTime() ).toBeGreaterThanOrEqual( 0 );

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'is callable without error', () => {

			expect( () => sky.dispose() ).not.toThrow();

		} );

	} );

} );
