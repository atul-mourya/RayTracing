import { Vector4 } from 'three';

/**
 * WebGPU Tile Manager
 *
 * Manages tile-based progressive rendering for high-quality output.
 * Splits the render target into tiles that are rendered sequentially,
 * allowing for higher samples per pixel in final renders.
 *
 * Features:
 * - Configurable tile size
 * - Spiral render order (center-out for better preview)
 * - Progress tracking
 * - Pause/resume support
 */
export class WebGPUTileManager {

	/**
	 * @param {Object} options - Tile manager options
	 * @param {number} options.tileSize - Size of tiles in pixels (default: 64)
	 * @param {string} options.order - Tile order: 'spiral', 'row', 'column' (default: 'spiral')
	 */
	constructor( options = {} ) {

		this.tileSize = options.tileSize || 64;
		this.order = options.order || 'spiral';

		// Render state
		this.width = 0;
		this.height = 0;
		this.tilesX = 0;
		this.tilesY = 0;
		this.totalTiles = 0;

		// Current progress
		this.currentTileIndex = 0;
		this.currentTile = null;
		this.tileOrder = [];

		// Tile rendering state
		this.samplesPerTile = 1;
		this.currentTileSamples = 0;
		this.targetSamplesPerTile = 64;

		// Status
		this.isComplete = false;
		this.isPaused = false;

		// Callbacks
		this.onTileStart = null;
		this.onTileComplete = null;
		this.onComplete = null;

	}

	/**
	 * Sets up tiles for the given resolution.
	 * @param {number} width - Render width
	 * @param {number} height - Render height
	 */
	setup( width, height ) {

		this.width = width;
		this.height = height;

		this.tilesX = Math.ceil( width / this.tileSize );
		this.tilesY = Math.ceil( height / this.tileSize );
		this.totalTiles = this.tilesX * this.tilesY;

		// Generate tile order
		this.tileOrder = this.generateTileOrder();

		// Reset state
		this.reset();

		console.log( `TileManager: ${this.tilesX}x${this.tilesY} tiles (${this.totalTiles} total), ${this.tileSize}px each` );

	}

	/**
	 * Generates the tile rendering order based on the order setting.
	 * @returns {Array} Array of tile indices in render order
	 */
	generateTileOrder() {

		const tiles = [];

		if ( this.order === 'spiral' ) {

			// Spiral order from center
			const centerX = Math.floor( this.tilesX / 2 );
			const centerY = Math.floor( this.tilesY / 2 );

			const visited = new Set();
			const directions = [[ 1, 0 ], [ 0, 1 ], [ - 1, 0 ], [ 0, - 1 ]]; // Right, Down, Left, Up

			let x = centerX;
			let y = centerY;
			let dir = 0;
			let stepsInDir = 1;
			let stepsTaken = 0;
			let turnsAtCurrentSteps = 0;

			while ( tiles.length < this.totalTiles ) {

				// Add current tile if valid and not visited
				if ( x >= 0 && x < this.tilesX && y >= 0 && y < this.tilesY ) {

					const index = y * this.tilesX + x;
					if ( ! visited.has( index ) ) {

						tiles.push( index );
						visited.add( index );

					}

				}

				// Move in current direction
				x += directions[ dir ][ 0 ];
				y += directions[ dir ][ 1 ];
				stepsTaken ++;

				// Check if we need to turn
				if ( stepsTaken === stepsInDir ) {

					stepsTaken = 0;
					dir = ( dir + 1 ) % 4;
					turnsAtCurrentSteps ++;

					// Increase steps every 2 turns
					if ( turnsAtCurrentSteps === 2 ) {

						turnsAtCurrentSteps = 0;
						stepsInDir ++;

					}

				}

			}

		} else if ( this.order === 'row' ) {

			// Row-major order
			for ( let y = 0; y < this.tilesY; y ++ ) {

				for ( let x = 0; x < this.tilesX; x ++ ) {

					tiles.push( y * this.tilesX + x );

				}

			}

		} else if ( this.order === 'column' ) {

			// Column-major order
			for ( let x = 0; x < this.tilesX; x ++ ) {

				for ( let y = 0; y < this.tilesY; y ++ ) {

					tiles.push( y * this.tilesX + x );

				}

			}

		} else if ( this.order === 'random' ) {

			// Random order
			for ( let i = 0; i < this.totalTiles; i ++ ) {

				tiles.push( i );

			}

			// Fisher-Yates shuffle
			for ( let i = tiles.length - 1; i > 0; i -- ) {

				const j = Math.floor( Math.random() * ( i + 1 ) );
				[ tiles[ i ], tiles[ j ] ] = [ tiles[ j ], tiles[ i ] ];

			}

		}

		return tiles;

	}

	/**
	 * Gets the bounds for a tile index.
	 * @param {number} tileIndex - Tile index
	 * @returns {Object} Tile bounds { x, y, width, height }
	 */
	getTileBounds( tileIndex ) {

		const tileX = tileIndex % this.tilesX;
		const tileY = Math.floor( tileIndex / this.tilesX );

		const x = tileX * this.tileSize;
		const y = tileY * this.tileSize;

		// Clamp to render bounds (handle edge tiles)
		const width = Math.min( this.tileSize, this.width - x );
		const height = Math.min( this.tileSize, this.height - y );

		return { x, y, width, height, tileX, tileY };

	}

	/**
	 * Gets the current tile to render.
	 * @returns {Object|null} Current tile bounds or null if complete
	 */
	getCurrentTile() {

		if ( this.isComplete || this.isPaused ) return null;

		if ( this.currentTileIndex >= this.totalTiles ) {

			this.isComplete = true;
			if ( this.onComplete ) this.onComplete();
			return null;

		}

		const tileIndex = this.tileOrder[ this.currentTileIndex ];
		return this.getTileBounds( tileIndex );

	}

	/**
	 * Gets the scissor rect for the current tile (WebGPU format).
	 * @returns {Vector4|null} Scissor rect (x, y, width, height) or null
	 */
	getScissorRect() {

		const tile = this.getCurrentTile();
		if ( ! tile ) return null;

		// WebGPU uses bottom-left origin for scissor
		return new Vector4(
			tile.x,
			this.height - tile.y - tile.height, // Flip Y for WebGPU
			tile.width,
			tile.height
		);

	}

	/**
	 * Gets the viewport for the current tile (normalized 0-1).
	 * @returns {Object|null} Normalized viewport { x, y, width, height }
	 */
	getNormalizedViewport() {

		const tile = this.getCurrentTile();
		if ( ! tile ) return null;

		return {
			x: tile.x / this.width,
			y: tile.y / this.height,
			width: tile.width / this.width,
			height: tile.height / this.height
		};

	}

	/**
	 * Advances to the next sample or tile.
	 * Call after each render pass.
	 */
	advance() {

		if ( this.isComplete || this.isPaused ) return;

		this.currentTileSamples ++;

		// Check if tile is complete
		if ( this.currentTileSamples >= this.targetSamplesPerTile ) {

			if ( this.onTileComplete ) {

				const tile = this.getCurrentTile();
				this.onTileComplete( tile, this.currentTileIndex );

			}

			// Move to next tile
			this.currentTileIndex ++;
			this.currentTileSamples = 0;

			if ( this.currentTileIndex < this.totalTiles ) {

				if ( this.onTileStart ) {

					const tile = this.getTileBounds( this.tileOrder[ this.currentTileIndex ] );
					this.onTileStart( tile, this.currentTileIndex );

				}

			} else {

				this.isComplete = true;
				if ( this.onComplete ) this.onComplete();

			}

		}

	}

	/**
	 * Resets the tile rendering progress.
	 */
	reset() {

		this.currentTileIndex = 0;
		this.currentTileSamples = 0;
		this.isComplete = false;
		this.isPaused = false;

		if ( this.tileOrder.length > 0 && this.onTileStart ) {

			const tile = this.getTileBounds( this.tileOrder[ 0 ] );
			this.onTileStart( tile, 0 );

		}

	}

	/**
	 * Pauses tile rendering.
	 */
	pause() {

		this.isPaused = true;

	}

	/**
	 * Resumes tile rendering.
	 */
	resume() {

		this.isPaused = false;

	}

	/**
	 * Sets the target samples per tile.
	 * @param {number} samples - Number of samples to render per tile
	 */
	setTargetSamples( samples ) {

		this.targetSamplesPerTile = samples;

	}

	/**
	 * Sets the tile size and regenerates tiles.
	 * @param {number} size - Tile size in pixels
	 */
	setTileSize( size ) {

		this.tileSize = size;
		if ( this.width > 0 && this.height > 0 ) {

			this.setup( this.width, this.height );

		}

	}

	/**
	 * Gets the current progress as a fraction.
	 * @returns {number} Progress from 0 to 1
	 */
	getProgress() {

		if ( this.totalTiles === 0 ) return 0;

		const tileProgress = this.currentTileSamples / this.targetSamplesPerTile;
		const completedTiles = this.currentTileIndex;

		return ( completedTiles + tileProgress ) / this.totalTiles;

	}

	/**
	 * Gets detailed progress information.
	 * @returns {Object} Progress details
	 */
	getProgressInfo() {

		return {
			currentTile: this.currentTileIndex,
			totalTiles: this.totalTiles,
			currentSamples: this.currentTileSamples,
			targetSamples: this.targetSamplesPerTile,
			progress: this.getProgress(),
			isComplete: this.isComplete,
			isPaused: this.isPaused
		};

	}

	/**
	 * Gets all tile bounds for visualization.
	 * @returns {Array} Array of tile bounds
	 */
	getAllTileBounds() {

		const bounds = [];
		for ( let i = 0; i < this.totalTiles; i ++ ) {

			bounds.push( this.getTileBounds( i ) );

		}

		return bounds;

	}

}
