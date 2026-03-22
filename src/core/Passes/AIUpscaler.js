import * as ort from 'onnxruntime-web/webgpu';
import { EventDispatcher } from 'three';

// Configure ORT WASM paths for CDN delivery (avoids bundling large WASM files)
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';


// ─── Model Configuration ───────────────────────────────────────────────────────

const MODEL_CONFIG = {

	// Native 2x and 4x models — both compact, dynamic input dimensions
	// 2x: SPAN (1.6MB) — NTIRE 2024 winner, fast and compact
	// 4x: Real-ESRGAN SRVGGNetCompact (4.9MB) — general-purpose
	MODELS: {
		2: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/2x-spanx2-ch48.onnx',
		4: 'https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/realesr-general-x4v3.onnx'
	},

	// Larger tiles = fewer GPU dispatches = faster. 512 works on most GPUs with 4GB+ VRAM.
	TILE_SIZE: 512,

	// Overlap in pixels between adjacent tiles (prevents seam artifacts)
	TILE_OVERLAP: 16,

	// ORT session options — WebGPU EP requires preferredLayout: 'NCHW' for SR models
	// (default NHWC layout causes internal buffer shape mismatches).
	// Falls back to WASM if WebGPU is unavailable.
	SESSION_OPTIONS: {
		executionProviders: [
			{ name: 'webgpu', preferredLayout: 'NCHW' },
			'wasm'
		],
		graphOptimizationLevel: 'all'
	}

};

// ─── AIUpscaler ─────────────────────────────────────────────────────────────────

export class AIUpscaler extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} output - Canvas for upscaled output (shared with denoiser)
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {Object} options
	 * @param {number} [options.scaleFactor=2] - Upscale factor (2 or 4)
	 * @param {Function} [options.getSourceCanvas] - Returns the canvas to read source image from
	 * @param {number} [options.tileSize] - Override default tile size
	 */
	constructor( output, renderer, options = {} ) {

		super();

		if ( ! output || ! renderer ) {

			throw new Error( 'AIUpscaler requires output canvas and renderer' );

		}

		this.renderer = renderer;
		this.input = renderer.domElement;
		this.output = output;
		this.getSourceCanvas = options.getSourceCanvas || null;

		// Configuration
		this.enabled = false;
		this.scaleFactor = options.scaleFactor || 2;
		this.tileSize = options.tileSize || MODEL_CONFIG.TILE_SIZE;

		// State
		this.state = {
			isUpscaling: false,
			isLoading: false,
			abortController: null
		};

		// ORT session cache
		this._session = null;
		this._currentModelUrl = null;

		// Alpha channel cache (bilinear-upscaled from source, applied per tile)
		this._upscaledAlpha = null;
		this._upscaledAlphaWidth = 0;

		// Canvas state backup for abort recovery
		this._backupCanvas = null;
		this._baseWidth = output.width;
		this._baseHeight = output.height;

	}

	// ─── Model Management ─────────────────────────────────────────────────────

	/**
	 * Loads the ONNX model for the current scale factor.
	 */
	async _ensureSession() {

		const url = MODEL_CONFIG.MODELS[ this.scaleFactor ];
		if ( ! url ) throw new Error( `No model URL for scale factor ${this.scaleFactor}` );

		// Reuse cached session if model hasn't changed
		if ( this._session && this._currentModelUrl === url ) return;

		this.state.isLoading = true;
		this.dispatchEvent( { type: 'loading', message: `Loading ${this.scaleFactor}x upscale model...` } );

		try {

			// Dispose previous session (scale factor changed)
			if ( this._session ) {

				await this._session.release();
				this._session = null;

			}

			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `Failed to fetch model: ${response.status}` );
			const modelBuffer = await response.arrayBuffer();

			this._session = await ort.InferenceSession.create( modelBuffer, {
				...MODEL_CONFIG.SESSION_OPTIONS
			} );

			this._currentModelUrl = url;
			this.dispatchEvent( { type: 'loaded' } );

			const backend = ort.env.webgpu?.device ? 'webgpu' : 'wasm';
			console.log( `AI Upscaler: ${this.scaleFactor}x model loaded (${( modelBuffer.byteLength / 1024 / 1024 ).toFixed( 1 )}MB), backend: ${backend}` );

		} catch ( error ) {

			console.error( 'AI Upscaler: Failed to load model:', error );
			this.dispatchEvent( { type: 'error', error } );
			throw error;

		} finally {

			this.state.isLoading = false;

		}

	}

	// ─── Public Lifecycle ─────────────────────────────────────────────────────

	async start() {

		if ( ! this.enabled || this.state.isUpscaling || this.state.isLoading ) {

			return false;

		}

		this.dispatchEvent( { type: 'start' } );

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState?.();
			const duration = performance.now() - startTime;
			console.log( `AI Upscaler: ${this.scaleFactor}x upscale completed in ${duration.toFixed( 1 )}ms` );

		}

		return success;

	}

	async execute() {

		if ( ! this.enabled ) return false;

		this.state.abortController = new AbortController();
		this.state.isUpscaling = true;

		// Show output canvas and hide input (matching OIDN lifecycle)
		this.input.style.opacity = '0';
		this.output.style.display = 'block';

		// Capture source image SYNCHRONOUSLY before any async work.
		// WebGPU canvas textures expire after each compositor frame,
		// so we must grab the pixels before awaiting model load.
		this._capturedSource = this._captureSource();
		this._createBackup( this._capturedSource );

		// Immediately draw source image (bilinear-upscaled) as base so the user
		// sees the noisy/source image right away — not a blank canvas during model load.
		const outW = this._capturedSource.width * this.scaleFactor;
		const outH = this._capturedSource.height * this.scaleFactor;
		this.output.width = outW;
		this.output.height = outH;
		const ctx = this.output.getContext( '2d', { willReadFrequently: true, alpha: true } );
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage( this._backupCanvas, 0, 0, outW, outH );

		try {

			await this._ensureSession();
			await this._runUpscale();

			// Update dimension display to reflect upscaled resolution
			window.dispatchEvent( new CustomEvent( 'resolution_changed', {
				detail: { width: this.output.width, height: this.output.height }
			} ) );

			return true;

		} catch ( error ) {

			if ( error.name === 'AbortError' ) {

				console.log( 'AI Upscaler: Upscaling was aborted' );

			} else {

				console.error( 'AI Upscaler: Upscaling error:', error );
				this.dispatchEvent( { type: 'error', error } );

			}

			// Restore canvas and input visibility on failure
			this._restoreBackup();
			this.input.style.opacity = '1';

			// Restore original dimension display
			window.dispatchEvent( new CustomEvent( 'resolution_changed', {
				detail: { width: this._baseWidth, height: this._baseHeight }
			} ) );

			return false;

		} finally {

			this._capturedSource = null;
			this._upscaledAlpha = null;
			this.state.isUpscaling = false;
			this.state.abortController = null;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	abort() {

		if ( ! this.state.isUpscaling ) return;

		this.state.abortController?.abort();

		// Restore input visibility and canvas state
		this.input.style.opacity = '1';
		this._restoreBackup();

		// Restore original dimension display
		window.dispatchEvent( new CustomEvent( 'resolution_changed', {
			detail: { width: this._baseWidth, height: this._baseHeight }
		} ) );

		this.state.isUpscaling = false;
		this.dispatchEvent( { type: 'end' } );

		console.log( 'AI Upscaler: Aborted' );

	}

	// ─── Core Upscaling Pipeline ──────────────────────────────────────────────

	/**
	 * Main upscaling pipeline:
	 * 1. Capture source image from the appropriate canvas
	 * 2. Process in overlapping tiles through the ONNX model
	 * 3. Write upscaled result to output canvas
	 */
	async _runUpscale() {

		const signal = this.state.abortController.signal;

		// Source image and backup already set up in execute() before model load
		const sourceImageData = this._capturedSource;
		this._capturedSource = null;
		const { width: srcW, height: srcH } = sourceImageData;
		const scale = this.scaleFactor;

		// Canvas already sized and base image drawn in execute()
		const ctx = this.output.getContext( '2d', { willReadFrequently: true, alpha: true } );

		// Cache bilinear-upscaled alpha channel from source for restoration per tile.
		// The SR model outputs RGB only — alpha would be lost without this.
		this._cacheUpscaledAlpha( sourceImageData, srcW * scale, srcH * scale );

		// Tile-based inference
		const overlap = MODEL_CONFIG.TILE_OVERLAP;
		const tileSize = this.tileSize;
		const step = tileSize - overlap * 2;

		const tilesX = Math.ceil( srcW / step );
		const tilesY = Math.ceil( srcH / step );
		const totalTiles = tilesX * tilesY;
		let completedTiles = 0;

		for ( let ty = 0; ty < tilesY; ty ++ ) {

			for ( let tx = 0; tx < tilesX; tx ++ ) {

				if ( signal.aborted ) throw new DOMException( 'Aborted', 'AbortError' );

				// Calculate tile bounds in source image (clamped to edges)
				const srcX = Math.min( tx * step, Math.max( 0, srcW - tileSize ) );
				const srcY = Math.min( ty * step, Math.max( 0, srcH - tileSize ) );
				const tw = Math.min( tileSize, srcW - srcX );
				const th = Math.min( tileSize, srcH - srcY );

				// Extract tile from source
				const tileInput = this._extractTile( sourceImageData, srcX, srcY, tw, th );

				// Run inference on this tile
				const tileOutput = await this._inferTile( tileInput, tw, th );

				// Write upscaled tile to canvas with restored alpha
				const writeX = srcX * scale;
				const writeY = srcY * scale;
				const upscaledW = tw * scale;
				const upscaledH = th * scale;
				const tileImageData = this._tensorToImageData( tileOutput, upscaledW, upscaledH, writeX, writeY );
				ctx.putImageData( tileImageData, writeX, writeY );

				completedTiles ++;
				this.dispatchEvent( {
					type: 'progress',
					progress: completedTiles / totalTiles,
					tile: { x: tx, y: ty, total: totalTiles, completed: completedTiles }
				} );

			}

		}

	}

	/**
	 * Captures the source image from the appropriate canvas.
	 * If a denoiser ran, reads from the denoiser canvas (this.output).
	 * Otherwise, reads from the WebGPU renderer canvas.
	 */
	_captureSource() {

		const sourceCanvas = this.getSourceCanvas ? this.getSourceCanvas() : null;

		if ( sourceCanvas && sourceCanvas !== this.output ) {

			// Source is the WebGPU canvas — must copy to 2D canvas first.
			// WebGPU canvases expire their texture after each compositor frame,
			// so the caller (PathTracerApp) should re-render the display stage
			// before triggering the upscaler when OIDN is not used.
			const offscreen = document.createElement( 'canvas' );
			offscreen.width = sourceCanvas.width;
			offscreen.height = sourceCanvas.height;
			const offCtx = offscreen.getContext( '2d' );
			offCtx.drawImage( sourceCanvas, 0, 0 );
			return offCtx.getImageData( 0, 0, offscreen.width, offscreen.height );

		}

		// Default: read from the output canvas (denoiser already wrote to it)
		const ctx = this.output.getContext( '2d', { willReadFrequently: true } );
		return ctx.getImageData( 0, 0, this.output.width, this.output.height );

	}

	/**
	 * Extracts a tile region from the source ImageData.
	 * Returns a Float32Array in NCHW format [1, 3, H, W] normalized to [0, 1].
	 */
	_extractTile( sourceImageData, x, y, w, h ) {

		const { data, width } = sourceImageData;
		const pixelCount = w * h;
		const floats = new Float32Array( 3 * pixelCount );

		for ( let row = 0; row < h; row ++ ) {

			for ( let col = 0; col < w; col ++ ) {

				const srcIdx = ( ( y + row ) * width + ( x + col ) ) * 4;
				const dstIdx = row * w + col;

				// NCHW: channel planes [R plane][G plane][B plane]
				floats[ dstIdx ] = data[ srcIdx ] / 255;
				floats[ pixelCount + dstIdx ] = data[ srcIdx + 1 ] / 255;
				floats[ 2 * pixelCount + dstIdx ] = data[ srcIdx + 2 ] / 255;

			}

		}

		return floats;

	}

	/**
	 * Runs the ONNX model on a single tile.
	 * Input: NCHW Float32Array [1, 3, H, W], values in [0, 1]
	 * Output: NCHW Float32Array [1, 3, H*scale, W*scale]
	 */
	async _inferTile( tileData, width, height ) {

		const inputName = this._session.inputNames[ 0 ];
		const outputName = this._session.outputNames[ 0 ];
		const inputTensor = new ort.Tensor( 'float32', tileData, [ 1, 3, height, width ] );

		const results = await this._session.run( { [ inputName ]: inputTensor } );
		return results[ outputName ].data;

	}

	/**
	 * Converts NCHW Float32 tensor output [3, H, W] to RGBA ImageData.
	 * Restores alpha from the cached upscaled alpha channel.
	 * @param {Float32Array} tensorData - Model output in NCHW [1, 3, H, W]
	 * @param {number} width - Tile width in upscaled pixels
	 * @param {number} height - Tile height in upscaled pixels
	 * @param {number} tileX - Tile X offset in the upscaled canvas
	 * @param {number} tileY - Tile Y offset in the upscaled canvas
	 */
	_tensorToImageData( tensorData, width, height, tileX, tileY ) {

		const imageData = new ImageData( width, height );
		const pixels = imageData.data;
		const planeSize = width * height;
		const alpha = this._upscaledAlpha;
		const alphaW = this._upscaledAlphaWidth;

		for ( let i = 0; i < planeSize; i ++ ) {

			pixels[ i * 4 ] = Math.min( 255, Math.max( 0, tensorData[ i ] * 255 + 0.5 ) ) | 0;
			pixels[ i * 4 + 1 ] = Math.min( 255, Math.max( 0, tensorData[ planeSize + i ] * 255 + 0.5 ) ) | 0;
			pixels[ i * 4 + 2 ] = Math.min( 255, Math.max( 0, tensorData[ 2 * planeSize + i ] * 255 + 0.5 ) ) | 0;

			// Restore alpha from cached upscaled source
			if ( alpha ) {

				const row = ( i / width ) | 0;
				const col = i % width;
				pixels[ i * 4 + 3 ] = alpha[ ( tileY + row ) * alphaW + ( tileX + col ) ];

			} else {

				pixels[ i * 4 + 3 ] = 255;

			}

		}

		return imageData;

	}

	/**
	 * Extracts and bilinear-upscales the alpha channel from the source image.
	 * Uses canvas drawImage for high-quality interpolation.
	 */
	_cacheUpscaledAlpha( sourceImageData, outW, outH ) {

		const { data, width, height } = sourceImageData;

		// Check if source has any non-opaque pixels
		let hasAlpha = false;
		for ( let i = 3; i < data.length; i += 4 ) {

			if ( data[ i ] < 255 ) {

				hasAlpha = true;
				break;

			}

		}

		if ( ! hasAlpha ) {

			this._upscaledAlpha = null;
			this._upscaledAlphaWidth = 0;
			return;

		}

		// Create a canvas with just the alpha channel as grayscale
		const srcCanvas = document.createElement( 'canvas' );
		srcCanvas.width = width;
		srcCanvas.height = height;
		const srcCtx = srcCanvas.getContext( '2d' );
		const alphaImage = srcCtx.createImageData( width, height );

		for ( let i = 0, len = width * height; i < len; i ++ ) {

			const a = data[ i * 4 + 3 ];
			alphaImage.data[ i * 4 ] = a;
			alphaImage.data[ i * 4 + 1 ] = a;
			alphaImage.data[ i * 4 + 2 ] = a;
			alphaImage.data[ i * 4 + 3 ] = 255;

		}

		srcCtx.putImageData( alphaImage, 0, 0 );

		// Bilinear-upscale via canvas drawImage
		const dstCanvas = document.createElement( 'canvas' );
		dstCanvas.width = outW;
		dstCanvas.height = outH;
		const dstCtx = dstCanvas.getContext( '2d' );
		dstCtx.imageSmoothingEnabled = true;
		dstCtx.imageSmoothingQuality = 'high';
		dstCtx.drawImage( srcCanvas, 0, 0, outW, outH );

		// Extract the upscaled alpha as a flat Uint8Array (R channel = alpha)
		const upscaledData = dstCtx.getImageData( 0, 0, outW, outH ).data;
		const alphaArray = new Uint8Array( outW * outH );

		for ( let i = 0, len = outW * outH; i < len; i ++ ) {

			alphaArray[ i ] = upscaledData[ i * 4 ];

		}

		this._upscaledAlpha = alphaArray;
		this._upscaledAlphaWidth = outW;

	}

	// ─── Canvas Backup / Restore ──────────────────────────────────────────────

	_createBackup( sourceImageData ) {

		this._backupCanvas = document.createElement( 'canvas' );
		this._backupCanvas.width = sourceImageData.width;
		this._backupCanvas.height = sourceImageData.height;
		const ctx = this._backupCanvas.getContext( '2d' );
		ctx.putImageData( sourceImageData, 0, 0 );

	}

	_restoreBackup() {

		if ( ! this._backupCanvas ) return;

		this.output.width = this._backupCanvas.width;
		this.output.height = this._backupCanvas.height;
		const ctx = this.output.getContext( '2d' );
		ctx.drawImage( this._backupCanvas, 0, 0 );
		this._backupCanvas = null;

	}

	// ─── Configuration ────────────────────────────────────────────────────────

	setScaleFactor( scale ) {

		scale = Number( scale );
		if ( scale !== 2 && scale !== 4 ) {

			console.warn( `AIUpscaler: Invalid scale factor ${scale}, must be 2 or 4` );
			return;

		}

		this.scaleFactor = scale;

	}

	setBaseSize( width, height ) {

		this._baseWidth = width;
		this._baseHeight = height;

	}

	// ─── Disposal ─────────────────────────────────────────────────────────────

	async dispose() {

		this.abort();

		if ( this._session ) {

			await this._session.release();
			this._session = null;

		}

		this._currentModelUrl = null;
		this._backupCanvas = null;
		this._upscaledAlpha = null;
		this.state.abortController = null;

		console.log( 'AIUpscaler disposed' );

	}

}
