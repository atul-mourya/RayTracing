import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PathTracerUtils } from '@/core/Processor/PathTracerUtils.js';

// ── clamp ────────────────────────────────────────────────────────

describe( 'PathTracerUtils.clamp', () => {

	it( 'clamps value below min', () => {

		expect( PathTracerUtils.clamp( - 5, 0, 10 ) ).toBe( 0 );

	} );

	it( 'clamps value above max', () => {

		expect( PathTracerUtils.clamp( 15, 0, 10 ) ).toBe( 10 );

	} );

	it( 'returns value when within range', () => {

		expect( PathTracerUtils.clamp( 5, 0, 10 ) ).toBe( 5 );

	} );

	it( 'returns min when value equals min', () => {

		expect( PathTracerUtils.clamp( 0, 0, 10 ) ).toBe( 0 );

	} );

	it( 'returns max when value equals max', () => {

		expect( PathTracerUtils.clamp( 10, 0, 10 ) ).toBe( 10 );

	} );

} );

// ── lerp ─────────────────────────────────────────────────────────

describe( 'PathTracerUtils.lerp', () => {

	it( 'returns a when t=0', () => {

		expect( PathTracerUtils.lerp( 10, 20, 0 ) ).toBe( 10 );

	} );

	it( 'returns b when t=1', () => {

		expect( PathTracerUtils.lerp( 10, 20, 1 ) ).toBe( 20 );

	} );

	it( 'returns midpoint when t=0.5', () => {

		expect( PathTracerUtils.lerp( 0, 100, 0.5 ) ).toBe( 50 );

	} );

	it( 'clamps t below 0', () => {

		expect( PathTracerUtils.lerp( 10, 20, - 1 ) ).toBe( 10 );

	} );

	it( 'clamps t above 1', () => {

		expect( PathTracerUtils.lerp( 10, 20, 2 ) ).toBe( 20 );

	} );

} );

// ── formatDuration ───────────────────────────────────────────────

describe( 'PathTracerUtils.formatDuration', () => {

	it( 'formats sub-second as ms', () => {

		expect( PathTracerUtils.formatDuration( 500 ) ).toBe( '500ms' );

	} );

	it( 'formats 0ms', () => {

		expect( PathTracerUtils.formatDuration( 0 ) ).toBe( '0ms' );

	} );

	it( 'formats seconds', () => {

		expect( PathTracerUtils.formatDuration( 1500 ) ).toBe( '1.5s' );

	} );

	it( 'formats minutes and seconds', () => {

		expect( PathTracerUtils.formatDuration( 65000 ) ).toBe( '1m 5s' );

	} );

	it( 'formats exact minute boundary', () => {

		expect( PathTracerUtils.formatDuration( 60000 ) ).toBe( '1m 0s' );

	} );

} );

// ── calculateAccumulationAlpha ───────────────────────────────────

describe( 'PathTracerUtils.calculateAccumulationAlpha', () => {

	it( 'returns 1.0 during interaction mode', () => {

		expect( PathTracerUtils.calculateAccumulationAlpha( 5, 0, 4, true ) ).toBe( 1.0 );

	} );

	it( 'full quad: frame 0 returns 1.0', () => {

		expect( PathTracerUtils.calculateAccumulationAlpha( 0, 0, 1 ) ).toBe( 1.0 );

	} );

	it( 'full quad: frame 1 returns 0.5', () => {

		expect( PathTracerUtils.calculateAccumulationAlpha( 1, 0, 1 ) ).toBe( 0.5 );

	} );

	it( 'full quad: frame 2 returns 1/3', () => {

		expect( PathTracerUtils.calculateAccumulationAlpha( 2, 0, 1 ) ).toBeCloseTo( 1 / 3 );

	} );

	it( 'tiled: frame 0 returns 1.0', () => {

		expect( PathTracerUtils.calculateAccumulationAlpha( 0, 1, 4 ) ).toBe( 1.0 );

	} );

	it( 'tiled: progressive decay after first frame', () => {

		const alpha = PathTracerUtils.calculateAccumulationAlpha( 5, 1, 4 );
		expect( alpha ).toBeGreaterThan( 0 );
		expect( alpha ).toBeLessThan( 1 );

	} );

} );

// ── isRenderComplete ─────────────────────────────────────────────

describe( 'PathTracerUtils.isRenderComplete', () => {

	it( 'full quad: not complete before maxFrames', () => {

		expect( PathTracerUtils.isRenderComplete( 5, 0, 10, 1 ) ).toBe( false );

	} );

	it( 'full quad: complete at maxFrames', () => {

		expect( PathTracerUtils.isRenderComplete( 10, 0, 10, 1 ) ).toBe( true );

	} );

	it( 'tiled: not complete before maxFrames * totalTiles', () => {

		expect( PathTracerUtils.isRenderComplete( 5, 1, 10, 4 ) ).toBe( false );

	} );

	it( 'tiled: complete at maxFrames * totalTiles', () => {

		expect( PathTracerUtils.isRenderComplete( 40, 1, 10, 4 ) ).toBe( true );

	} );

} );

// ── getCurrentSampleCount ────────────────────────────────────────

describe( 'PathTracerUtils.getCurrentSampleCount', () => {

	it( 'full quad: returns frame value directly', () => {

		expect( PathTracerUtils.getCurrentSampleCount( 10, 0, 1 ) ).toBe( 10 );

	} );

	it( 'tiled: returns floor(frame / totalTiles)', () => {

		expect( PathTracerUtils.getCurrentSampleCount( 10, 1, 4 ) ).toBe( 2 );

	} );

	it( 'tiled: handles partial cycle', () => {

		expect( PathTracerUtils.getCurrentSampleCount( 7, 1, 4 ) ).toBe( 1 );

	} );

} );

// ── updateCompletionThreshold ────────────────────────────────────

describe( 'PathTracerUtils.updateCompletionThreshold', () => {

	it( 'full quad: returns maxFrames', () => {

		expect( PathTracerUtils.updateCompletionThreshold( 0, 10, 4 ) ).toBe( 10 );

	} );

	it( 'tiled: returns totalTiles * maxFrames', () => {

		expect( PathTracerUtils.updateCompletionThreshold( 1, 10, 4 ) ).toBe( 40 );

	} );

} );

// ── calculateSpiralOrder ─────────────────────────────────────────

describe( 'PathTracerUtils.calculateSpiralOrder', () => {

	it( 'returns all tile indices for 2x2 grid', () => {

		const order = PathTracerUtils.calculateSpiralOrder( 2 );
		expect( order ).toHaveLength( 4 );
		expect( [ ...order ].sort() ).toEqual( [ 0, 1, 2, 3 ] );

	} );

	it( 'returns all tile indices for 3x3 grid', () => {

		const order = PathTracerUtils.calculateSpiralOrder( 3 );
		expect( order ).toHaveLength( 9 );
		expect( [ ...order ].sort() ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7, 8 ] );

	} );

	it( 'center tile appears first for odd grids', () => {

		const order = PathTracerUtils.calculateSpiralOrder( 3 );
		// Center of 3x3 grid is index 4 (row 1, col 1)
		expect( order[ 0 ] ).toBe( 4 );

	} );

	it( 'handles 1x1 grid', () => {

		const order = PathTracerUtils.calculateSpiralOrder( 1 );
		expect( order ).toEqual( [ 0 ] );

	} );

} );

// ── createLRUCache ───────────────────────────────────────────────

describe( 'PathTracerUtils.createLRUCache', () => {

	let cache;

	beforeEach( () => {

		cache = PathTracerUtils.createLRUCache( 3 );

	} );

	it( 'returns undefined for missing keys', () => {

		expect( cache.get( 'missing' ) ).toBeUndefined();

	} );

	it( 'stores and retrieves values', () => {

		cache.set( 'a', 1 );
		expect( cache.get( 'a' ) ).toBe( 1 );

	} );

	it( 'evicts LRU entry when capacity exceeded', () => {

		cache.set( 'a', 1 );
		cache.set( 'b', 2 );
		cache.set( 'c', 3 );
		cache.set( 'd', 4 ); // should evict 'a'
		expect( cache.get( 'a' ) ).toBeUndefined();
		expect( cache.get( 'd' ) ).toBe( 4 );

	} );

	it( 'get() refreshes entry (prevents eviction)', () => {

		cache.set( 'a', 1 );
		cache.set( 'b', 2 );
		cache.set( 'c', 3 );
		cache.get( 'a' ); // refresh 'a'
		cache.set( 'd', 4 ); // should evict 'b' not 'a'
		expect( cache.get( 'a' ) ).toBe( 1 );
		expect( cache.get( 'b' ) ).toBeUndefined();

	} );

	it( 'tracks size correctly', () => {

		expect( cache.size() ).toBe( 0 );
		cache.set( 'a', 1 );
		expect( cache.size() ).toBe( 1 );
		cache.set( 'b', 2 );
		expect( cache.size() ).toBe( 2 );

	} );

	it( 'clear() removes all entries', () => {

		cache.set( 'a', 1 );
		cache.set( 'b', 2 );
		cache.clear();
		expect( cache.size() ).toBe( 0 );
		expect( cache.get( 'a' ) ).toBeUndefined();

	} );

	it( 'updates existing keys in-place', () => {

		cache.set( 'a', 1 );
		cache.set( 'a', 99 );
		expect( cache.get( 'a' ) ).toBe( 99 );
		expect( cache.size() ).toBe( 1 );

	} );

} );

// ── createPerformanceMonitor ─────────────────────────────────────

describe( 'PathTracerUtils.createPerformanceMonitor', () => {

	it( 'returns 0 avg frame time with no data', () => {

		const monitor = PathTracerUtils.createPerformanceMonitor();
		expect( monitor.getAverageFrameTime() ).toBe( 0 );

	} );

	it( 'returns 0 FPS with no data', () => {

		const monitor = PathTracerUtils.createPerformanceMonitor();
		expect( monitor.getFPS() ).toBe( 0 );

	} );

	it( 'tracks frame time', () => {

		const monitor = PathTracerUtils.createPerformanceMonitor();
		monitor.start();
		const frameTime = monitor.end();
		expect( frameTime ).toBeGreaterThanOrEqual( 0 );
		expect( monitor.getAverageFrameTime() ).toBeGreaterThanOrEqual( 0 );

	} );

	it( 'reset clears accumulated data', () => {

		const monitor = PathTracerUtils.createPerformanceMonitor();
		monitor.start();
		monitor.end();
		monitor.reset();
		expect( monitor.getAverageFrameTime() ).toBe( 0 );
		expect( monitor.getFPS() ).toBe( 0 );

	} );

} );

// ── createDebounceFunction ───────────────────────────────────────

describe( 'PathTracerUtils.createDebounceFunction', () => {

	it( 'calls callback after delay', async () => {

		vi.useFakeTimers();
		const callback = vi.fn();
		const debounced = PathTracerUtils.createDebounceFunction( callback, 100 );

		debounced( 'test' );
		expect( callback ).not.toHaveBeenCalled();

		vi.advanceTimersByTime( 100 );
		expect( callback ).toHaveBeenCalledWith( 'test' );

		vi.useRealTimers();

	} );

	it( 'resets timer on repeated calls', () => {

		vi.useFakeTimers();
		const callback = vi.fn();
		const debounced = PathTracerUtils.createDebounceFunction( callback, 100 );

		debounced( 'first' );
		vi.advanceTimersByTime( 50 );
		debounced( 'second' );
		vi.advanceTimersByTime( 50 );
		expect( callback ).not.toHaveBeenCalled();

		vi.advanceTimersByTime( 50 );
		expect( callback ).toHaveBeenCalledTimes( 1 );
		expect( callback ).toHaveBeenCalledWith( 'second' );

		vi.useRealTimers();

	} );

} );

// ── areValuesEqual ───────────────────────────────────────────────

describe( 'PathTracerUtils.areValuesEqual', () => {

	it( 'primitives: same value', () => {

		expect( PathTracerUtils.areValuesEqual( 5, 5 ) ).toBe( true );

	} );

	it( 'primitives: different value', () => {

		expect( PathTracerUtils.areValuesEqual( 5, 10 ) ).toBe( false );

	} );

	it( 'arrays: equal', () => {

		expect( PathTracerUtils.areValuesEqual( [ 1, 2, 3 ], [ 1, 2, 3 ] ) ).toBe( true );

	} );

	it( 'arrays: different length', () => {

		expect( PathTracerUtils.areValuesEqual( [ 1, 2 ], [ 1, 2, 3 ] ) ).toBe( false );

	} );

	it( 'arrays: different values', () => {

		expect( PathTracerUtils.areValuesEqual( [ 1, 2, 3 ], [ 1, 2, 4 ] ) ).toBe( false );

	} );

	it( 'objects: equal', () => {

		expect( PathTracerUtils.areValuesEqual( { a: 1, b: 2 }, { a: 1, b: 2 } ) ).toBe( true );

	} );

	it( 'objects: different', () => {

		expect( PathTracerUtils.areValuesEqual( { a: 1 }, { a: 2 } ) ).toBe( false );

	} );

	it( 'objects with .equals method', () => {

		const a = { equals: ( other ) => other.val === 42, val: 42 };
		const b = { val: 42 };
		expect( PathTracerUtils.areValuesEqual( a, b ) ).toBe( true );

	} );

	it( 'null and undefined', () => {

		expect( PathTracerUtils.areValuesEqual( null, null ) ).toBe( true );
		expect( PathTracerUtils.areValuesEqual( null, undefined ) ).toBe( false );

	} );

} );

// ── optimizeShaderDefines ────────────────────────────────────────

describe( 'PathTracerUtils.optimizeShaderDefines', () => {

	it( 'removes ENABLE_ADAPTIVE_SAMPLING when disabled', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '', OTHER: 1 };
		const result = PathTracerUtils.optimizeShaderDefines( defines, { useAdaptiveSampling: false } );
		expect( result ).not.toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );
		expect( result ).toHaveProperty( 'OTHER' );

	} );

	it( 'keeps ENABLE_ADAPTIVE_SAMPLING when enabled', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '' };
		const result = PathTracerUtils.optimizeShaderDefines( defines, { useAdaptiveSampling: true } );
		expect( result ).toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );

	} );

	it( 'removes ENABLE_ACCUMULATION when disabled', () => {

		const defines = { ENABLE_ACCUMULATION: '' };
		const result = PathTracerUtils.optimizeShaderDefines( defines, { enableAccumulation: false } );
		expect( result ).not.toHaveProperty( 'ENABLE_ACCUMULATION' );

	} );

	it( 'sets MAX_SPHERE_COUNT to 0 when no spheres', () => {

		const defines = { MAX_SPHERE_COUNT: 5 };
		const result = PathTracerUtils.optimizeShaderDefines( defines, { sphereCount: 0 } );
		expect( result.MAX_SPHERE_COUNT ).toBe( 0 );

	} );

	it( 'does not mutate input defines', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '' };
		PathTracerUtils.optimizeShaderDefines( defines, { useAdaptiveSampling: false } );
		expect( defines ).toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );

	} );

} );
