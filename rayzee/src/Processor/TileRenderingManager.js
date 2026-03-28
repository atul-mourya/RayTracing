/**
 * TileRenderingManager.js
 * Handles all tile-based rendering logic including tile bounds calculation,
 * spiral order generation, and tile bounds calculation.
 */

export class TileRenderingManager {

	constructor( width, height, tiles ) {

		this.width = width;
		this.height = height;
		this.tiles = tiles;
		this.tileIndex = 0;

		// Performance caches
		this.tileBoundsCache = new Map();
		this.totalTilesCache = tiles * tiles;

		// Tile rendering state
		this.currentTileBounds = null;

		// Generate initial spiral order
		this.spiralOrder = this.generateSpiralOrder( tiles );

	}

	/**
     * Calculate the scissor bounds for a given tile
     * @param {number} tileIndex - The index of the tile
     * @param {number} totalTiles - Total number of tiles per row/column
     * @param {number} width - Render target width
     * @param {number} height - Render target height
     * @returns {Object} - Scissor bounds {x, y, width, height}
     */
	calculateTileBounds( tileIndex, totalTiles, width, height ) {

		// Use cache to avoid recalculation
		const cacheKey = `${tileIndex}-${totalTiles}-${width}-${height}`;
		if ( this.tileBoundsCache.has( cacheKey ) ) {

			return this.tileBoundsCache.get( cacheKey );

		}

		// Calculate tile size using ceiling division to ensure all pixels are covered
		const tileWidth = Math.ceil( width / totalTiles );
		const tileHeight = Math.ceil( height / totalTiles );

		// Calculate tile coordinates
		const tileX = tileIndex % totalTiles;
		const tileY = Math.floor( tileIndex / totalTiles );

		// Calculate pixel bounds
		const x = tileX * tileWidth;
		const y = tileY * tileHeight;

		// Clamp to actual render target bounds
		const clampedWidth = Math.min( tileWidth, width - x );
		const clampedHeight = Math.min( tileHeight, height - y );

		const bounds = {
			x: x,
			y: y,
			width: clampedWidth,
			height: clampedHeight
		};

		// Cache the result
		this.tileBoundsCache.set( cacheKey, bounds );
		return bounds;

	}

	/**
     * Set up scissor testing for tile rendering
     * @param {Object} renderer - The Three.js renderer
     * @param {Object} bounds - Scissor bounds {x, y, width, height}
     */

	/**
     * Generate spiral order for tile rendering (center-out pattern)
     * @param {number} tiles - Number of tiles per row/column
     * @returns {Array<number>} - Array of tile indices in spiral order
     */
	generateSpiralOrder( tiles ) {

		const totalTiles = tiles * tiles;
		const tilePositions = [];

		// Create array of tile positions with their distances from center
		for ( let i = 0; i < totalTiles; i ++ ) {

			const x = i % tiles;
			const y = Math.floor( i / tiles );

			// Improved distance calculation for better ordering with any tile count
			const center = ( tiles - 1 ) / 2;
			const dx = x - center;
			const dy = y - center;

			// Use Manhattan distance as primary sort key for more predictable ordering
			const manhattanDistance = Math.abs( dx ) + Math.abs( dy );

			// Use Euclidean distance as secondary sort key for smooth transitions
			const euclideanDistance = Math.sqrt( dx * dx + dy * dy );

			// Calculate angle with better precision for spiral ordering
			let angle = Math.atan( dy, dx );
			// Normalize angle to 0-2π range
			if ( angle < 0 ) angle += 2 * Math.PI;

			// Add small offset based on position to ensure deterministic ordering
			const positionOffset = ( x + y * tiles ) * 0.001;

			tilePositions.push( {
				index: i,
				x,
				y,
				manhattanDistance,
				euclideanDistance,
				angle,
				positionOffset
			} );

		}

		// Improved sorting: Manhattan distance first, then Euclidean, then angle
		tilePositions.sort( ( a, b ) => {

			// Primary: Manhattan distance (creates more predictable rings)
			const manhattanDiff = a.manhattanDistance - b.manhattanDistance;
			if ( Math.abs( manhattanDiff ) > 0.01 ) {

				return manhattanDiff;

			}

			// Secondary: Euclidean distance (smooth transitions within rings)
			const euclideanDiff = a.euclideanDistance - b.euclideanDistance;
			if ( Math.abs( euclideanDiff ) > 0.01 ) {

				return euclideanDiff;

			}

			// Tertiary: Angle for spiral effect within same distance
			const angleDiff = a.angle - b.angle;
			if ( Math.abs( angleDiff ) > 0.01 ) {

				return angleDiff;

			}

			// Final: Position offset for deterministic ordering
			return a.positionOffset - b.positionOffset;

		} );

		return tilePositions.map( pos => pos.index );

	}

	/**
     * Handle tile rendering logic for a given frame and render mode
     * @param {Object} renderer - The Three.js renderer
     * @param {number} renderMode - Current render mode (0 = full, 1 = tiled)
     * @param {number} frameValue - Current frame number
     * @param {TileHighlightStage} tileHighlightStage - Optional tile highlight pass
     * @returns {Object} - Tile rendering info {tileIndex, tileBounds, shouldSwapTargets, isCompleteCycle}
     */
	handleTileRendering( renderer, renderMode, frameValue, tileHighlightStage = null ) {

		let shouldSwapTargets = true;
		let currentTileIndex = - 1;
		let tileBounds = null;
		let isCompleteCycle = true; // Progressive mode is always complete

		if ( renderMode === 1 ) { // Tiled rendering

			if ( frameValue === 0 ) {

				// First frame: render entire image (full screen)
				currentTileIndex = - 1;
				isCompleteCycle = true;

			} else {

				// Calculate current tile index (frames 1+ are tile-based)
				const linearTileIndex = ( frameValue - 1 ) % this.totalTilesCache;
				currentTileIndex = this.spiralOrder[ linearTileIndex ];

				// Calculate tile bounds (scissor replaced by compute tile uniforms)
				tileBounds = this.calculateTileBounds( currentTileIndex, this.tiles, this.width, this.height );

				// Update tile highlight pass only when values change
				if ( tileHighlightStage?.enabled ) {

					this.updateTileHighlightStage( tileHighlightStage, currentTileIndex, renderMode, tileBounds );

				}

				// Check if this is the last tile in the cycle
				isCompleteCycle = ( linearTileIndex === this.totalTilesCache - 1 );

				// Only swap targets after completing all tiles in a sample
				shouldSwapTargets = isCompleteCycle;

			}

		} else {

			// Regular rendering mode: every frame is a complete cycle
			currentTileIndex = - 1;
			isCompleteCycle = true;

			// Update tile highlight pass for non-tiled mode only when needed
			if ( tileHighlightStage?.enabled ) {

				this.updateTileHighlightStage( tileHighlightStage, currentTileIndex, renderMode, null );

			}

		}

		this.tileIndex = currentTileIndex;

		return {
			tileIndex: currentTileIndex,
			tileBounds,
			shouldSwapTargets,
			isCompleteCycle // New flag for pipeline stage execution control
		};

	}

	/**
     * Update tile highlight pass uniforms when needed
     * @param {TileHighlightStage} tileHighlightStage - The tile highlight pass
     * @param {number} tileIndex - Current tile index
     * @param {number} renderMode - Current render mode
     * @param {Object|null} tileBounds - Current tile bounds
     */
	updateTileHighlightStage( tileHighlightStage, tileIndex, renderMode, tileBounds ) {

		const needsUpdate = (
			tileHighlightStage.uniforms.tileIndex.value !== tileIndex ||
            tileHighlightStage.uniforms.renderMode.value !== renderMode ||
            tileHighlightStage.uniforms.tiles.value !== this.tiles
		);

		if ( needsUpdate ) {

			tileHighlightStage.uniforms.tileIndex.value = tileIndex;
			tileHighlightStage.uniforms.renderMode.value = renderMode;
			tileHighlightStage.uniforms.tiles.value = this.tiles;

			if ( tileBounds && tileHighlightStage.setCurrentTileBounds ) {

				tileHighlightStage.setCurrentTileBounds( tileBounds );

			}

		}

	}

	/**
     * Set the number of tiles and regenerate order
     * @param {number} newTileCount - New tile count per row/column
     */
	setTileCount( newTileCount ) {

		// Validate tile count and provide warnings
		if ( newTileCount < 1 ) {

			console.warn( 'TileRenderingManager: Tile count must be at least 1, clamping to 1' );
			newTileCount = 1;

		}

		if ( newTileCount > 10 ) {

			console.warn( 'TileRenderingManager: Tile count > 10 may cause performance issues' );

		}

		if ( newTileCount > 6 ) {

			const totalTiles = newTileCount * newTileCount;
			console.warn( `TileRenderingManager: ${newTileCount}x${newTileCount} = ${totalTiles} tiles may impact performance and memory usage` );

		}


		this.tiles = newTileCount;
		this.totalTilesCache = newTileCount * newTileCount;
		this.tileIndex = 0;
		this.spiralOrder = this.generateSpiralOrder( newTileCount );
		this.tileBoundsCache.clear(); // Clear cache when tile count changes

	}

	/**
     * Update dimensions when render target size changes
     * @param {number} width - New width
     * @param {number} height - New height
     */
	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.tileBoundsCache.clear(); // Clear cache when size changes

	}

	/**
     * Calculate completion threshold for tiled rendering
     * @param {number} maxFrames - Maximum frames to render
     * @returns {number} - Total frames needed for completion
     */
	calculateCompletionThreshold( maxFrames ) {

		return this.totalTilesCache * maxFrames;

	}

	/**
     * Get current tile information
     * @returns {Object} - Current tile state
     */
	getCurrentTileInfo() {

		return {
			tileIndex: this.tileIndex,
			tiles: this.tiles,
			totalTiles: this.totalTilesCache,
			currentBounds: this.currentTileBounds
		};

	}

	/**
     * Clean up resources
     */
	dispose() {

		this.tileBoundsCache.clear();
		this.currentTileBounds = null;

	}

}
