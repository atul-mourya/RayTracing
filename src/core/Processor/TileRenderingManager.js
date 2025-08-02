/**
 * TileRenderingManager.js
 * Handles all tile-based rendering logic including scissor testing,
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
		this.scissorEnabled = false;

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
     * @param {WebGLRenderer} renderer - The Three.js renderer
     * @param {Object} bounds - Scissor bounds {x, y, width, height}
     */
	enableScissorForTile( renderer, bounds ) {

		// Skip if already set to these exact bounds
		if ( this.scissorEnabled &&
            this.currentTileBounds &&
            this.currentTileBounds.x === bounds.x &&
            this.currentTileBounds.y === bounds.y &&
            this.currentTileBounds.width === bounds.width &&
            this.currentTileBounds.height === bounds.height ) {

			return;

		}

		const gl = renderer.getContext();

		// Enable scissor testing
		gl.enable( gl.SCISSOR_TEST );

		// Set scissor rectangle
		// Note: WebGL scissor coordinates are from bottom-left, Three.js render targets are top-left
		// We need to flip the Y coordinate
		const flippedY = this.height - bounds.y - bounds.height;
		gl.scissor( bounds.x, flippedY, bounds.width, bounds.height );

		this.scissorEnabled = true;
		this.currentTileBounds = { ...bounds };

	}

	/**
     * Disable scissor testing
     * @param {WebGLRenderer} renderer - The Three.js renderer
     */
	disableScissor( renderer ) {

		const gl = renderer.getContext();
		gl.disable( gl.SCISSOR_TEST );
		this.scissorEnabled = false;
		this.currentTileBounds = null;

	}

	/**
     * Generate spiral order for tile rendering (center-out pattern)
     * @param {number} tiles - Number of tiles per row/column
     * @returns {Array<number>} - Array of tile indices in spiral order
     */
	generateSpiralOrder( tiles ) {

		const totalTiles = tiles * tiles;
		const center = ( tiles - 1 ) / 2;
		const tilePositions = [];

		// Create array of tile positions with their distances from center
		for ( let i = 0; i < totalTiles; i ++ ) {

			const x = i % tiles;
			const y = Math.floor( i / tiles );
			const distanceFromCenter = Math.sqrt( Math.pow( x - center, 2 ) + Math.pow( y - center, 2 ) );

			// Calculate angle for spiral ordering within same distance rings
			const angle = Math.atan2( y - center, x - center );

			tilePositions.push( {
				index: i,
				x,
				y,
				distance: distanceFromCenter,
				angle: angle
			} );

		}

		// Sort by distance from center, then by angle for spiral effect
		tilePositions.sort( ( a, b ) => {

			const distanceDiff = a.distance - b.distance;
			if ( Math.abs( distanceDiff ) < 0.01 ) {

				// Within same distance ring, sort by angle for spiral
				return a.angle - b.angle;

			}

			return distanceDiff;

		} );

		return tilePositions.map( pos => pos.index );

	}

	/**
     * Handle tile rendering logic for a given frame and render mode
     * @param {WebGLRenderer} renderer - The Three.js renderer
     * @param {number} renderMode - Current render mode (0 = full, 1 = tiled)
     * @param {number} frameValue - Current frame number
     * @param {TileHighlightPass} tileHighlightPass - Optional tile highlight pass
     * @returns {Object} - Tile rendering info {tileIndex, tileBounds, shouldSwapTargets}
     */
	handleTileRendering( renderer, renderMode, frameValue, tileHighlightPass = null ) {

		let shouldSwapTargets = true;
		let currentTileIndex = - 1;
		let tileBounds = null;

		if ( renderMode === 1 ) { // Tiled rendering

			if ( frameValue === 0 ) {

				// First frame: render entire image, disable scissor
				this.disableScissor( renderer );
				currentTileIndex = - 1;

			} else {

				// Calculate current tile index (frames 1+ are tile-based)
				const linearTileIndex = ( frameValue - 1 ) % this.totalTilesCache;
				currentTileIndex = this.spiralOrder[ linearTileIndex ];

				// Set up scissor testing for current tile
				tileBounds = this.calculateTileBounds( currentTileIndex, this.tiles, this.width, this.height );
				this.enableScissorForTile( renderer, tileBounds );

				// Update tile highlight pass only when values change
				if ( tileHighlightPass?.enabled ) {

					this.updateTileHighlightPass( tileHighlightPass, currentTileIndex, renderMode, tileBounds );

				}

				// Only swap targets after completing all tiles in a sample
				shouldSwapTargets = ( linearTileIndex === this.totalTilesCache - 1 );

			}

		} else {

			// Regular rendering mode: disable scissor
			this.disableScissor( renderer );
			currentTileIndex = - 1;

			// Update tile highlight pass for non-tiled mode only when needed
			if ( tileHighlightPass?.enabled ) {

				this.updateTileHighlightPass( tileHighlightPass, currentTileIndex, renderMode, null );

			}

		}

		this.tileIndex = currentTileIndex;

		return {
			tileIndex: currentTileIndex,
			tileBounds,
			shouldSwapTargets
		};

	}

	/**
     * Update tile highlight pass uniforms when needed
     * @param {TileHighlightPass} tileHighlightPass - The tile highlight pass
     * @param {number} tileIndex - Current tile index
     * @param {number} renderMode - Current render mode
     * @param {Object|null} tileBounds - Current tile bounds
     */
	updateTileHighlightPass( tileHighlightPass, tileIndex, renderMode, tileBounds ) {

		const needsUpdate = (
			tileHighlightPass.uniforms.tileIndex.value !== tileIndex ||
            tileHighlightPass.uniforms.renderMode.value !== renderMode ||
            tileHighlightPass.uniforms.tiles.value !== this.tiles
		);

		if ( needsUpdate ) {

			tileHighlightPass.uniforms.tileIndex.value = tileIndex;
			tileHighlightPass.uniforms.renderMode.value = renderMode;
			tileHighlightPass.uniforms.tiles.value = this.tiles;

			if ( tileBounds && tileHighlightPass.setCurrentTileBounds ) {

				tileHighlightPass.setCurrentTileBounds( tileBounds );

			}

		}

	}

	/**
     * Set the number of tiles and regenerate order
     * @param {number} newTileCount - New tile count per row/column
     */
	setTileCount( newTileCount ) {

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
			currentBounds: this.currentTileBounds,
			scissorEnabled: this.scissorEnabled
		};

	}

	/**
     * Clean up resources
     */
	dispose() {

		this.tileBoundsCache.clear();
		this.currentTileBounds = null;
		this.scissorEnabled = false;

	}

}
