import { describe, it, expect, beforeEach } from 'vitest';
import { TileManager } from '@/core/managers/TileManager.js';

describe( 'TileManager', () => {

	let manager;

	beforeEach( () => {

		manager = new TileManager( 1920, 1080, 3 );

	} );

	// ── Constructor ────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'stores dimensions and tile count', () => {

			expect( manager.width ).toBe( 1920 );
			expect( manager.height ).toBe( 1080 );
			expect( manager.tiles ).toBe( 3 );

		} );

		it( 'caches total tiles (tiles^2)', () => {

			expect( manager.totalTilesCache ).toBe( 9 );

		} );

		it( 'generates spiral order on init', () => {

			expect( manager.spiralOrder ).toHaveLength( 9 );

		} );

	} );

	// ── calculateTileBounds ────────────────────────────────────

	describe( 'calculateTileBounds', () => {

		it( 'first tile starts at (0, 0)', () => {

			const bounds = manager.calculateTileBounds( 0, 3, 900, 900 );
			expect( bounds.x ).toBe( 0 );
			expect( bounds.y ).toBe( 0 );

		} );

		it( 'returns valid dimensions', () => {

			const bounds = manager.calculateTileBounds( 0, 3, 900, 900 );
			expect( bounds.width ).toBe( 300 );
			expect( bounds.height ).toBe( 300 );

		} );

		it( 'second tile in row starts after first', () => {

			const bounds = manager.calculateTileBounds( 1, 3, 900, 900 );
			expect( bounds.x ).toBe( 300 );
			expect( bounds.y ).toBe( 0 );

		} );

		it( 'first tile in second row', () => {

			const bounds = manager.calculateTileBounds( 3, 3, 900, 900 );
			expect( bounds.x ).toBe( 0 );
			expect( bounds.y ).toBe( 300 );

		} );

		it( 'handles non-divisible dimensions (clamps width)', () => {

			// 100px / 3 tiles = ceil(33.33) = 34px tiles
			// Tile 2 starts at 68, width = min(34, 100-68) = 32
			const bounds = manager.calculateTileBounds( 2, 3, 100, 100 );
			expect( bounds.x + bounds.width ).toBeLessThanOrEqual( 100 );

		} );

		it( 'covers full area with all tiles', () => {

			// Check that all tiles together cover the full 900x900 area
			const covered = new Set();
			for ( let i = 0; i < 9; i ++ ) {

				const b = manager.calculateTileBounds( i, 3, 900, 900 );
				for ( let x = b.x; x < b.x + b.width; x ++ ) {

					for ( let y = b.y; y < b.y + b.height; y ++ ) {

						covered.add( `${x},${y}` );

					}

				}

			}

			expect( covered.size ).toBe( 900 * 900 );

		} );

		it( 'caches results for same parameters', () => {

			const a = manager.calculateTileBounds( 0, 3, 900, 900 );
			const b = manager.calculateTileBounds( 0, 3, 900, 900 );
			expect( a ).toBe( b ); // Same reference (cached)

		} );

	} );

	// ── generateSpiralOrder ────────────────────────────────────

	describe( 'generateSpiralOrder', () => {

		it( 'returns all tile indices for 3x3', () => {

			const order = manager.generateSpiralOrder( 3 );
			expect( order ).toHaveLength( 9 );
			expect( [ ...order ].sort( ( a, b ) => a - b ) ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7, 8 ] );

		} );

		it( 'center tile is first for 3x3', () => {

			const order = manager.generateSpiralOrder( 3 );
			expect( order[ 0 ] ).toBe( 4 ); // center of 3x3

		} );

		it( 'returns [0] for 1x1', () => {

			const order = manager.generateSpiralOrder( 1 );
			expect( order ).toEqual( [ 0 ] );

		} );

		it( 'returns all indices for 2x2', () => {

			const order = manager.generateSpiralOrder( 2 );
			expect( order ).toHaveLength( 4 );
			expect( [ ...order ].sort( ( a, b ) => a - b ) ).toEqual( [ 0, 1, 2, 3 ] );

		} );

		it( 'handles larger grids (5x5)', () => {

			const order = manager.generateSpiralOrder( 5 );
			expect( order ).toHaveLength( 25 );
			// Center of 5x5 is index 12 (row 2, col 2)
			expect( order[ 0 ] ).toBe( 12 );

		} );

	} );

	// ── handleTileRendering ────────────────────────────────────

	describe( 'handleTileRendering', () => {

		it( 'progressive mode: always complete, no tile bounds', () => {

			const result = manager.handleTileRendering( null, 0, 5 );
			expect( result.isCompleteCycle ).toBe( true );
			expect( result.tileIndex ).toBe( - 1 );
			expect( result.tileBounds ).toBeNull();

		} );

		it( 'tile mode frame 0: full image, complete', () => {

			const result = manager.handleTileRendering( null, 1, 0 );
			expect( result.isCompleteCycle ).toBe( true );
			expect( result.tileIndex ).toBe( - 1 );

		} );

		it( 'tile mode frame 1+: returns tile bounds', () => {

			const result = manager.handleTileRendering( null, 1, 1 );
			expect( result.tileBounds ).not.toBeNull();
			expect( result.tileBounds ).toHaveProperty( 'x' );
			expect( result.tileBounds ).toHaveProperty( 'y' );
			expect( result.tileBounds ).toHaveProperty( 'width' );
			expect( result.tileBounds ).toHaveProperty( 'height' );

		} );

		it( 'tile mode: cycle completes after all tiles', () => {

			// 3x3 = 9 tiles. Frames 1-9 are the first tile cycle.
			let completedCycle = false;
			for ( let frame = 1; frame <= 9; frame ++ ) {

				const result = manager.handleTileRendering( null, 1, frame );
				if ( result.isCompleteCycle ) completedCycle = true;

			}

			expect( completedCycle ).toBe( true );

		} );

		it( 'tile mode: mid-cycle is not complete', () => {

			const result = manager.handleTileRendering( null, 1, 3 ); // 3rd tile of 9
			expect( result.isCompleteCycle ).toBe( false );

		} );

	} );

	// ── setTileCount ───────────────────────────────────────────

	describe( 'setTileCount', () => {

		it( 'updates tile count and regenerates spiral', () => {

			manager.setTileCount( 5 );
			expect( manager.tiles ).toBe( 5 );
			expect( manager.totalTilesCache ).toBe( 25 );
			expect( manager.spiralOrder ).toHaveLength( 25 );

		} );

		it( 'clears tile bounds cache', () => {

			manager.calculateTileBounds( 0, 3, 900, 900 );
			expect( manager.tileBoundsCache.size ).toBeGreaterThan( 0 );
			manager.setTileCount( 4 );
			expect( manager.tileBoundsCache.size ).toBe( 0 );

		} );

	} );

	// ── setSize ────────────────────────────────────────────────

	describe( 'setSize', () => {

		it( 'updates dimensions', () => {

			manager.setSize( 800, 600 );
			expect( manager.width ).toBe( 800 );
			expect( manager.height ).toBe( 600 );

		} );

		it( 'clears cache', () => {

			manager.calculateTileBounds( 0, 3, 1920, 1080 );
			manager.setSize( 800, 600 );
			expect( manager.tileBoundsCache.size ).toBe( 0 );

		} );

	} );

	// ── calculateCompletionThreshold ───────────────────────────

	describe( 'calculateCompletionThreshold', () => {

		it( 'returns totalTiles * maxFrames', () => {

			expect( manager.calculateCompletionThreshold( 10 ) ).toBe( 90 ); // 9 * 10

		} );

		it( 'updates after tile count change', () => {

			manager.setTileCount( 2 );
			expect( manager.calculateCompletionThreshold( 10 ) ).toBe( 40 ); // 4 * 10

		} );

	} );

	// ── getCurrentTileInfo ─────────────────────────────────────

	describe( 'getCurrentTileInfo', () => {

		it( 'returns current state', () => {

			const info = manager.getCurrentTileInfo();
			expect( info ).toHaveProperty( 'tileIndex' );
			expect( info ).toHaveProperty( 'tiles' );
			expect( info ).toHaveProperty( 'totalTiles' );
			expect( info.tiles ).toBe( 3 );
			expect( info.totalTiles ).toBe( 9 );

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'clears cache', () => {

			manager.calculateTileBounds( 0, 3, 900, 900 );
			manager.dispose();
			expect( manager.tileBoundsCache.size ).toBe( 0 );

		} );

	} );

} );
