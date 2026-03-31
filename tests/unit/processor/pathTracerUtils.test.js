import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clamp, lerp, formatDuration, calculateAccumulationAlpha,
	isRenderComplete, getCurrentSampleCount, updateCompletionThreshold,
	calculateSpiralOrder, createLRUCache, createPerformanceMonitor,
	createDebounceFunction, areValuesEqual, optimizeShaderDefines } from '@/core/Processor/utils.js';

// ── clamp ────────────────────────────────────────────────────────

describe( 'clamp', () => {

	it( 'clamps value below min', () => {

		expect( clamp( - 5, 0, 10 ) ).toBe( 0 );

	} );

	it( 'clamps value above max', () => {

		expect( clamp( 15, 0, 10 ) ).toBe( 10 );

	} );

	it( 'returns value when within range', () => {

		expect( clamp( 5, 0, 10 ) ).toBe( 5 );

	} );

	it( 'returns min when value equals min', () => {

		expect( clamp( 0, 0, 10 ) ).toBe( 0 );

	} );

	it( 'returns max when value equals max', () => {

		expect( clamp( 10, 0, 10 ) ).toBe( 10 );

	} );

} );

// ── lerp ─────────────────────────────────────────────────────────

describe( 'lerp', () => {

	it( 'returns a when t=0', () => {

		expect( lerp( 10, 20, 0 ) ).toBe( 10 );

	} );

	it( 'returns b when t=1', () => {

		expect( lerp( 10, 20, 1 ) ).toBe( 20 );

	} );

	it( 'returns midpoint when t=0.5', () => {

		expect( lerp( 0, 100, 0.5 ) ).toBe( 50 );

	} );

	it( 'clamps t below 0', () => {

		expect( lerp( 10, 20, - 1 ) ).toBe( 10 );

	} );

	it( 'clamps t above 1', () => {

		expect( lerp( 10, 20, 2 ) ).toBe( 20 );

	} );

} );

// ── formatDuration ───────────────────────────────────────────────

describe( 'formatDuration', () => {

	it( 'formats sub-second as ms', () => {

		expect( formatDuration( 500 ) ).toBe( '500ms' );

	} );

	it( 'formats 0ms', () => {

		expect( formatDuration( 0 ) ).toBe( '0ms' );

	} );

	it( 'formats seconds', () => {

		expect( formatDuration( 1500 ) ).toBe( '1.5s' );

	} );

	it( 'formats minutes and seconds', () => {

		expect( formatDuration( 65000 ) ).toBe( '1m 5s' );

	} );

	it( 'formats exact minute boundary', () => {

		expect( formatDuration( 60000 ) ).toBe( '1m 0s' );

	} );

} );

// ── calculateAccumulationAlpha ───────────────────────────────────

describe( 'calculateAccumulationAlpha', () => {

	it( 'returns 1.0 during interaction mode', () => {

		expect( calculateAccumulationAlpha( 5, 0, 4, true ) ).toBe( 1.0 );

	} );

	it( 'full quad: frame 0 returns 1.0', () => {

		expect( calculateAccumulationAlpha( 0, 0, 1 ) ).toBe( 1.0 );

	} );

	it( 'full quad: frame 1 returns 0.5', () => {

		expect( calculateAccumulationAlpha( 1, 0, 1 ) ).toBe( 0.5 );

	} );

	it( 'full quad: frame 2 returns 1/3', () => {

		expect( calculateAccumulationAlpha( 2, 0, 1 ) ).toBeCloseTo( 1 / 3 );

	} );

	it( 'tiled: frame 0 returns 1.0', () => {

		expect( calculateAccumulationAlpha( 0, 1, 4 ) ).toBe( 1.0 );

	} );

	it( 'tiled: progressive decay after first frame', () => {

		const alpha = calculateAccumulationAlpha( 5, 1, 4 );
		expect( alpha ).toBeGreaterThan( 0 );
		expect( alpha ).toBeLessThan( 1 );

	} );

} );

// ── isRenderComplete ─────────────────────────────────────────────

describe( 'isRenderComplete', () => {

	it( 'full quad: not complete before maxFrames', () => {

		expect( isRenderComplete( 5, 0, 10, 1 ) ).toBe( false );

	} );

	it( 'full quad: complete at maxFrames', () => {

		expect( isRenderComplete( 10, 0, 10, 1 ) ).toBe( true );

	} );

	it( 'tiled: not complete before maxFrames * totalTiles', () => {

		expect( isRenderComplete( 5, 1, 10, 4 ) ).toBe( false );

	} );

	it( 'tiled: complete at maxFrames * totalTiles', () => {

		expect( isRenderComplete( 40, 1, 10, 4 ) ).toBe( true );

	} );

} );

// ── getCurrentSampleCount ────────────────────────────────────────

describe( 'getCurrentSampleCount', () => {

	it( 'full quad: returns frame value directly', () => {

		expect( getCurrentSampleCount( 10, 0, 1 ) ).toBe( 10 );

	} );

	it( 'tiled: returns floor(frame / totalTiles)', () => {

		expect( getCurrentSampleCount( 10, 1, 4 ) ).toBe( 2 );

	} );

	it( 'tiled: handles partial cycle', () => {

		expect( getCurrentSampleCount( 7, 1, 4 ) ).toBe( 1 );

	} );

} );

// ── updateCompletionThreshold ────────────────────────────────────

describe( 'updateCompletionThreshold', () => {

	it( 'full quad: returns maxFrames', () => {

		expect( updateCompletionThreshold( 0, 10, 4 ) ).toBe( 10 );

	} );

	it( 'tiled: returns totalTiles * maxFrames', () => {

		expect( updateCompletionThreshold( 1, 10, 4 ) ).toBe( 40 );

	} );

} );

// ── calculateSpiralOrder ─────────────────────────────────────────

describe( 'calculateSpiralOrder', () => {

	it( 'returns all tile indices for 2x2 grid', () => {

		const order = calculateSpiralOrder( 2 );
		expect( order ).toHaveLength( 4 );
		expect( [ ...order ].sort() ).toEqual( [ 0, 1, 2, 3 ] );

	} );

	it( 'returns all tile indices for 3x3 grid', () => {

		const order = calculateSpiralOrder( 3 );
		expect( order ).toHaveLength( 9 );
		expect( [ ...order ].sort() ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7, 8 ] );

	} );

	it( 'center tile appears first for odd grids', () => {

		const order = calculateSpiralOrder( 3 );
		// Center of 3x3 grid is index 4 (row 1, col 1)
		expect( order[ 0 ] ).toBe( 4 );

	} );

	it( 'handles 1x1 grid', () => {

		const order = calculateSpiralOrder( 1 );
		expect( order ).toEqual( [ 0 ] );

	} );

} );

// ── createLRUCache ───────────────────────────────────────────────

describe( 'createLRUCache', () => {

	let cache;

	beforeEach( () => {

		cache = createLRUCache( 3 );

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

describe( 'createPerformanceMonitor', () => {

	it( 'returns 0 avg frame time with no data', () => {

		const monitor = createPerformanceMonitor();
		expect( monitor.getAverageFrameTime() ).toBe( 0 );

	} );

	it( 'returns 0 FPS with no data', () => {

		const monitor = createPerformanceMonitor();
		expect( monitor.getFPS() ).toBe( 0 );

	} );

	it( 'tracks frame time', () => {

		const monitor = createPerformanceMonitor();
		monitor.start();
		const frameTime = monitor.end();
		expect( frameTime ).toBeGreaterThanOrEqual( 0 );
		expect( monitor.getAverageFrameTime() ).toBeGreaterThanOrEqual( 0 );

	} );

	it( 'reset clears accumulated data', () => {

		const monitor = createPerformanceMonitor();
		monitor.start();
		monitor.end();
		monitor.reset();
		expect( monitor.getAverageFrameTime() ).toBe( 0 );
		expect( monitor.getFPS() ).toBe( 0 );

	} );

} );

// ── createDebounceFunction ───────────────────────────────────────

describe( 'createDebounceFunction', () => {

	it( 'calls callback after delay', async () => {

		vi.useFakeTimers();
		const callback = vi.fn();
		const debounced = createDebounceFunction( callback, 100 );

		debounced( 'test' );
		expect( callback ).not.toHaveBeenCalled();

		vi.advanceTimersByTime( 100 );
		expect( callback ).toHaveBeenCalledWith( 'test' );

		vi.useRealTimers();

	} );

	it( 'resets timer on repeated calls', () => {

		vi.useFakeTimers();
		const callback = vi.fn();
		const debounced = createDebounceFunction( callback, 100 );

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

describe( 'areValuesEqual', () => {

	it( 'primitives: same value', () => {

		expect( areValuesEqual( 5, 5 ) ).toBe( true );

	} );

	it( 'primitives: different value', () => {

		expect( areValuesEqual( 5, 10 ) ).toBe( false );

	} );

	it( 'arrays: equal', () => {

		expect( areValuesEqual( [ 1, 2, 3 ], [ 1, 2, 3 ] ) ).toBe( true );

	} );

	it( 'arrays: different length', () => {

		expect( areValuesEqual( [ 1, 2 ], [ 1, 2, 3 ] ) ).toBe( false );

	} );

	it( 'arrays: different values', () => {

		expect( areValuesEqual( [ 1, 2, 3 ], [ 1, 2, 4 ] ) ).toBe( false );

	} );

	it( 'objects: equal', () => {

		expect( areValuesEqual( { a: 1, b: 2 }, { a: 1, b: 2 } ) ).toBe( true );

	} );

	it( 'objects: different', () => {

		expect( areValuesEqual( { a: 1 }, { a: 2 } ) ).toBe( false );

	} );

	it( 'objects with .equals method', () => {

		const a = { equals: ( other ) => other.val === 42, val: 42 };
		const b = { val: 42 };
		expect( areValuesEqual( a, b ) ).toBe( true );

	} );

	it( 'null and undefined', () => {

		expect( areValuesEqual( null, null ) ).toBe( true );
		expect( areValuesEqual( null, undefined ) ).toBe( false );

	} );

} );

// ── optimizeShaderDefines ────────────────────────────────────────

describe( 'optimizeShaderDefines', () => {

	it( 'removes ENABLE_ADAPTIVE_SAMPLING when disabled', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '', OTHER: 1 };
		const result = optimizeShaderDefines( defines, { useAdaptiveSampling: false } );
		expect( result ).not.toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );
		expect( result ).toHaveProperty( 'OTHER' );

	} );

	it( 'keeps ENABLE_ADAPTIVE_SAMPLING when enabled', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '' };
		const result = optimizeShaderDefines( defines, { useAdaptiveSampling: true } );
		expect( result ).toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );

	} );

	it( 'removes ENABLE_ACCUMULATION when disabled', () => {

		const defines = { ENABLE_ACCUMULATION: '' };
		const result = optimizeShaderDefines( defines, { enableAccumulation: false } );
		expect( result ).not.toHaveProperty( 'ENABLE_ACCUMULATION' );

	} );

	it( 'sets MAX_SPHERE_COUNT to 0 when no spheres', () => {

		const defines = { MAX_SPHERE_COUNT: 5 };
		const result = optimizeShaderDefines( defines, { sphereCount: 0 } );
		expect( result.MAX_SPHERE_COUNT ).toBe( 0 );

	} );

	it( 'does not mutate input defines', () => {

		const defines = { ENABLE_ADAPTIVE_SAMPLING: '' };
		optimizeShaderDefines( defines, { useAdaptiveSampling: false } );
		expect( defines ).toHaveProperty( 'ENABLE_ADAPTIVE_SAMPLING' );

	} );

} );
