/**
 * TileHelper — 2D canvas overlay showing the active tile border.
 *
 * Universal: works for path tracer tiled rendering, OIDN denoiser,
 * and AI upscaler. Callers provide pixel-space tile bounds via
 * `setActiveTile()` and control visibility via `show()` / `hide()`.
 *
 * Layer: 'hud' (rendered by OverlayManager's 2D canvas pass).
 *
 * @example
 *   const tileHelper = new TileHelper();
 *   overlayManager.register( 'tiles', tileHelper );
 *   tileHelper.setRenderSize( 1920, 1080 );
 *   tileHelper.setActiveTile( { x: 0, y: 0, width: 480, height: 270 } );
 *   tileHelper.show();
 */
export class TileHelper {

	constructor() {

		this.layer = 'hud';
		this.visible = false;

		// Active tile bounds in render/image pixels
		this._tileBounds = null; // { x, y, width, height }

		// Source image dimensions (for mapping to display coordinates)
		this._imageWidth = 1;
		this._imageHeight = 1;

		// Whether the user has enabled the tile helper via UI toggle
		this.enabled = true;

		// Style
		this._borderColor = 'rgba(255, 0, 0, 0.6)';
		this._borderWidth = 2;

	}

	// ═══════════════════════════════════════════════════════════════
	// Data setters
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Sets the active tile to highlight.
	 * @param {{ x: number, y: number, width: number, height: number }|null} bounds
	 *   Pixel-space bounds in the source image. Pass null to clear.
	 */
	setActiveTile( bounds ) {

		this._tileBounds = bounds;

	}

	/**
	 * Sets the source image dimensions used to map tile bounds
	 * to display coordinates on the HUD canvas.
	 * @param {number} width
	 * @param {number} height
	 */
	setRenderSize( width, height ) {

		this._imageWidth = width;
		this._imageHeight = height;

	}

	// ═══════════════════════════════════════════════════════════════
	// Rendering (called by OverlayManager)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * @param {CanvasRenderingContext2D} ctx
	 * @param {number} displayW - Display width in CSS pixels
	 * @param {number} displayH - Display height in CSS pixels
	 */
	render( ctx, displayW, displayH ) {

		if ( ! this._tileBounds ) return;

		const bounds = this._tileBounds;
		const scaleX = displayW / this._imageWidth;
		const scaleY = displayH / this._imageHeight;

		const x = bounds.x * scaleX;
		const y = bounds.y * scaleY;
		const w = bounds.width * scaleX;
		const h = bounds.height * scaleY;

		// Active tile border
		ctx.strokeStyle = this._borderColor;
		ctx.lineWidth = this._borderWidth;
		ctx.strokeRect( x, y, w, h );

	}

	// ═══════════════════════════════════════════════════════════════
	// Visibility (required by OverlayManager interface)
	// ═══════════════════════════════════════════════════════════════

	show() {

		if ( this.enabled ) this.visible = true;

	}

	hide() {

		this.visible = false;
		this._tileBounds = null;

	}

	dispose() {

		this.visible = false;

	}

}
