import { EventDispatcher, ACESFilmicToneMapping } from 'three';

let _initUNetFromURL = null;
async function getInitUNetFromURL() {

	if ( ! _initUNetFromURL ) {

		const mod = await import( 'oidn-web' );
		_initUNetFromURL = mod.initUNetFromURL;

	}

	return _initUNetFromURL;

}

import RenderTargetHelper from '../Processor/RenderTargetHelper.js';
import { TONE_MAP_FNS, SRGB_GAMMA, applySaturation } from './ToneMapCPU.js';

/** Reusable RGB output buffer (avoids per-pixel allocation). */
const _tmOut = new Float32Array( 3 );

// Constants for better maintainability
const MODEL_CONFIG = {
	BASE_URL: 'https://cdn.jsdelivr.net/npm/denoiser/tzas/',
	QUALITY_SUFFIXES: {
		fast: '_small',
		balance: '',
		high: '_large'
	},
	DEFAULT_OPTIONS: {
		enableOIDN: true,
		oidnQuality: 'fast',
		debugGbufferMaps: true,
		tileSize: 256
	}
};

export class OIDNDenoiser extends EventDispatcher {

	constructor( output, renderer, scene, camera, options = {} ) {

		super();

		// Validate required parameters
		if ( ! output || ! renderer || ! scene || ! camera ) {

			throw new Error( 'OIDNDenoiser requires output canvas, renderer, scene, and camera' );

		}

		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.input = renderer.domElement;
		this.output = output;
		this.debugContainer = options.debugContainer || null;
		this.extractGBufferData = options.extractGBufferData || null;
		this.getMRTRenderTarget = options.getMRTRenderTarget || null;

		// Tile highlight visualization during denoising
		this.showTileHelper = true;

		// WebGPU GPU-native path (no CPU readback for inputs)
		// backendParams: () => { device: GPUDevice, adapterInfo: GPUAdapterInfo|null }
		// getGPUTextures: () => { color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }
		// getExposure: () => number  (effective exposure multiplier, pre-computed)
		// getToneMapping: () => number (Three.js ToneMapping constant)
		this.backendParamsGetter = options.backendParams || null;
		this.getGPUTextures = options.getGPUTextures || null;
		this.getExposure = options.getExposure || ( () => 1.0 );
		this.getToneMapping = options.getToneMapping || ( () => ACESFilmicToneMapping );
		this.getSaturation = options.getSaturation || ( () => 1.0 );
		this.getTransparentBackground = options.getTransparentBackground || ( () => false );
		this.isGPUMode = !! this.backendParamsGetter;
		this.gpuDevice = null;

		// Cached GPU storage buffers for texture→buffer copies (reused across denoise calls)
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputBufferSize = { width: 0, height: 0 };

		// Cached alpha channel from the input color buffer (OIDN discards alpha)
		this._cachedAlpha = null;
		this._cachedAlphaWidth = 0;

		// Merge options with defaults
		this.config = { ...MODEL_CONFIG.DEFAULT_OPTIONS, ...options };

		// Destructure for easier access
		this.enabled = this.config.enableOIDN;
		this.quality = this.config.oidnQuality;
		this.debugGbufferMaps = this.config.debugGbufferMaps;
		this.tileSize = this.config.tileSize;

		// State management
		this.state = {
			isDenoising: false,
			isLoading: false,
			abortController: null
		};

		this.currentTZAUrl = null;
		this.unet = null;

		// For debug visualization
		this.debugHelpers = null;
		this._lastAlbedoTexture = null;
		this._lastNormalTexture = null;

		// Initialize asynchronously
		this._initialize().catch( error => {

			console.error( 'Failed to initialize OIDNDenoiser:', error );
			this.dispatchEvent( { type: 'error', error } );

		} );

	}

	async _initialize() {

		try {

			this._setupCanvas();
			this._initDebugVisualization();
			await this._setupUNetDenoiser();

		} catch ( error ) {

			throw new Error( `Initialization failed: ${error.message}` );

		}

	}

	_initDebugVisualization() {

		// Note: Debug helpers will be created lazily when MRT textures are available
		// This avoids creating helpers without proper texture references
		this.debugHelpers = null;

	}

	_setupCanvas() {

		if ( ! this.output.getContext ) {

			throw new Error( 'Output must be a valid Canvas element' );

		}

		// Configure canvas for optimal performance
		this.output.willReadFrequently = true;
		this.output.width = this.input.width;
		this.output.height = this.input.height;

		// Apply styling efficiently
		Object.assign( this.output.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			borderRadius: '5px',
			background: "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px"
		} );

		this.ctx = this.output.getContext( '2d', {
			willReadFrequently: true,
			alpha: true
		} );

	}

	async _setupUNetDenoiser() {

		if ( this.state.isLoading ) return;

		this.state.isLoading = true;
		const tzaUrl = this._generateTzaUrl();

		// Skip setup if URL hasn't changed
		if ( this.currentTZAUrl === tzaUrl && this.unet ) {

			this.state.isLoading = false;
			return;

		}

		try {

			this.dispatchEvent( { type: 'loading', message: 'Loading UNet denoiser...' } );

			// Dispose previous instance
			if ( this.unet ) {

				this.unet.dispose();
				this.unet = null;

			}

			// GPU-native path: share the existing GPUDevice so oidn-web uses the
			// same device as the renderer — no second device, no CPU roundtrip for inputs.
			let backendParams;
			if ( this.isGPUMode && this.backendParamsGetter ) {

				const params = this.backendParamsGetter();
				this.gpuDevice = params?.device ?? null;
				backendParams = params?.device ? params : undefined;

			}

			const initFn = await getInitUNetFromURL();
			this.unet = await initFn( tzaUrl, backendParams, {
				aux: true,
				hdr: true,
				maxTileSize: this.tileSize
			} );

			this.currentTZAUrl = tzaUrl;
			this.dispatchEvent( { type: 'loaded' } );
			console.log( 'UNet denoiser loaded successfully:', tzaUrl );

		} catch ( error ) {

			console.error( 'Failed to load UNet denoiser:', error );
			this.dispatchEvent( { type: 'error', error: new Error( `Denoiser loading failed: ${error.message}` ) } );

		} finally {

			this.state.isLoading = false;

		}

	}

	_generateTzaUrl() {

		const { BASE_URL, QUALITY_SUFFIXES } = MODEL_CONFIG;

		const modelSize = QUALITY_SUFFIXES[ this.quality ] || '';

		return `${BASE_URL}rt_hdr_alb_nrm${modelSize}.tza`;

	}

	// Public configuration methods with validation
	async updateConfiguration( newConfig ) {

		const hasChanged = Object.keys( newConfig ).some( key => this.config[ key ] !== newConfig[ key ] );

		if ( ! hasChanged ) return;

		// Update configuration
		Object.assign( this.config, newConfig );
		this.quality = this.config.oidnQuality;
		this.debugGbufferMaps = this.config.debugGbufferMaps;
		this.tileSize = this.config.tileSize;

		// Reload denoiser if necessary
		await this._setupUNetDenoiser();

	}

	async updateQuality( value ) {

		if ( ! Object.prototype.hasOwnProperty.call( MODEL_CONFIG.QUALITY_SUFFIXES, value ) ) {

			throw new Error( `Invalid quality setting: ${value}. Must be one of: ${Object.keys( MODEL_CONFIG.QUALITY_SUFFIXES ).join( ', ' )}` );

		}

		await this.updateConfiguration( { oidnQuality: value } );

	}

	async start() {

		if ( ! this.enabled || this.state.isDenoising || this.state.isLoading ) {

			return false;

		}

		this.dispatchEvent( { type: 'start' } );

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState?.();
			this.input.style.opacity = '0';

			const duration = performance.now() - startTime;
			console.log( `Denoising completed in ${duration.toFixed( 1 )}ms (quality: ${this.quality})` );

		}

		return success;

	}

	async execute() {

		if ( ! this.enabled || ! this.unet ) return false;

		// Create abort controller for this execution
		this.state.abortController = new AbortController();
		this.state.isDenoising = true;
		this.input.style.opacity = '0';
		this.output.style.display = 'block';

		try {

			await this._executeUNet();
			return true;

		} catch ( error ) {

			if ( error.name === 'AbortError' ) {

				console.log( 'Denoising was aborted' );

			} else {

				console.error( 'Denoising error:', error );

			}

			// Restore original rendering on error
			this.input.style.opacity = '1';
			return false;

		} finally {

			this.state.isDenoising = false;
			this.state.abortController = null;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	async _executeUNet() {

		return this._executeUNetGPU();

	}

	/**
	 * GPU-native execution path. Copies render target textures into GPU storage buffers
	 * via copyTextureToBuffer (GPU-only, no CPU roundtrip), then passes those buffers to
	 * oidn-web's well-tested GPUBuffer path.
	 *
	 * Note: oidn-web's GPUTexture input path produces NaN outputs — using GPUBuffer instead.
	 */
	async _executeUNetGPU() {

		const { width, height } = this.output;

		if ( ! this.getGPUTextures ) {

			console.warn( 'OIDNDenoiser: GPU mode enabled but getGPUTextures not provided' );
			return false;

		}

		const textures = this.getGPUTextures();
		if ( ! textures?.color ) {

			console.warn( 'OIDNDenoiser: GPU textures not ready yet' );
			return false;

		}

		const device = this.gpuDevice;
		if ( ! device ) {

			console.warn( 'OIDNDenoiser: gpuDevice not available' );
			return false;

		}

		// Ensure storage buffers are sized correctly (recreate on resolution change)
		this._ensureGPUInputBuffers( width, height );

		// Copy render target textures → GPU storage buffers in a single command submission.
		// copyTextureToBuffer requires COPY_SRC on the texture (Three.js render targets have it)
		// and COPY_DST on the buffer. bytesPerRow for rgba32float = width * 16.
		const encoder = device.createCommandEncoder( { label: 'oidn-tex-to-buf' } );
		const bytesPerRow = width * 16; // rgba32float = 4 channels × 4 bytes

		const copyTex = ( tex, buf ) => encoder.copyTextureToBuffer(
			{ texture: tex, mipLevel: 0 },
			{ buffer: buf, offset: 0, bytesPerRow, rowsPerImage: height },
			{ width, height, depthOrArrayLayers: 1 }
		);

		copyTex( textures.color, this._gpuInputBuffers.color );
		copyTex( textures.albedo, this._gpuInputBuffers.albedo );
		copyTex( textures.normal, this._gpuInputBuffers.normal );

		device.queue.submit( [ encoder.finish() ] );

		// Cache alpha channel from input color buffer when transparent background is enabled.
		// OIDN only processes RGB — the alpha channel is lost, so we read it before denoising.
		if ( this.getTransparentBackground() ) {

			await this._cacheInputAlpha( device, width, height );

		} else {

			this._cachedAlpha = null;

		}

		// Draw the current noisy frame as the base — denoised tiles paint on top progressively
		this.ctx.drawImage( this.input, 0, 0, width, height );
		this._tileGridDrawn = false;

		// Pass GPU storage buffers to oidn-web (GPUBuffer path, well-tested)
		const config = {
			color: { data: this._gpuInputBuffers.color, width, height },
			albedo: { data: this._gpuInputBuffers.albedo, width, height },
			normal: { data: this._gpuInputBuffers.normal, width, height }
		};

		return this._executeWithAbortGPU( config );

	}

	/**
	 * Creates or recreates the GPU storage buffers used as oidn-web inputs.
	 * Reuses existing buffers if the resolution hasn't changed.
	 * Usage: COPY_DST (for copyTextureToBuffer) | STORAGE (for oidn-web WGSL read) | COPY_SRC
	 */
	_ensureGPUInputBuffers( width, height ) {

		const { width: cw, height: ch } = this._gpuInputBufferSize;
		if ( cw === width && ch === height && this._gpuInputBuffers.color ) return;

		// Destroy stale buffers
		this._destroyGPUInputBuffers();

		const device = this.gpuDevice;
		const byteSize = width * height * 4 * 4; // rgba32float = 16 bytes/pixel
		const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;

		this._gpuInputBuffers.color = device.createBuffer( { label: 'oidn-in-color', size: byteSize, usage } );
		this._gpuInputBuffers.albedo = device.createBuffer( { label: 'oidn-in-albedo', size: byteSize, usage } );
		this._gpuInputBuffers.normal = device.createBuffer( { label: 'oidn-in-normal', size: byteSize, usage } );
		this._gpuInputBufferSize = { width, height };

	}

	_destroyGPUInputBuffers() {

		this._gpuInputBuffers.color?.destroy();
		this._gpuInputBuffers.albedo?.destroy();
		this._gpuInputBuffers.normal?.destroy();
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputBufferSize = { width: 0, height: 0 };

	}

	/**
	 * Reads the alpha channel from the input color GPU buffer and caches it as a Uint8Array.
	 * Called before OIDN denoising when transparent background is enabled.
	 */
	async _cacheInputAlpha( device, width, height ) {

		const byteSize = width * height * 4 * 4; // rgba32float
		const staging = device.createBuffer( {
			label: 'oidn-alpha-staging',
			size: byteSize,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
		} );

		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer( this._gpuInputBuffers.color, 0, staging, 0, byteSize );
		device.queue.submit( [ enc.finish() ] );

		await staging.mapAsync( GPUMapMode.READ );
		const f32 = new Float32Array( staging.getMappedRange() );

		// Extract alpha channel as uint8 (pre-multiplied is not needed — alpha is 0 or 1)
		const pixelCount = width * height;
		const alpha = new Uint8Array( pixelCount );
		for ( let i = 0; i < pixelCount; i ++ ) {

			alpha[ i ] = Math.min( Math.max( f32[ i * 4 + 3 ] * 255, 0 ), 255 ) | 0;

		}

		staging.unmap();
		staging.destroy();

		this._cachedAlpha = alpha;
		this._cachedAlphaWidth = width;

	}

	/**
	 * Promise wrapper around tileExecute for the GPU path.
	 * Outputs a GPUBuffer — copied to a staging buffer then converted to ImageData for the 2D canvas.
	 */
	_executeWithAbortGPU( config ) {

		return new Promise( ( resolve, reject ) => {

			if ( this.state.abortController?.signal.aborted ) {

				reject( new DOMException( 'Aborted', 'AbortError' ) );
				return;

			}

			let abortDenoise = null;

			const abortHandler = () => {

				if ( abortDenoise ) {

					abortDenoise();
					abortDenoise = null;

				}

				reject( new DOMException( 'Aborted', 'AbortError' ) );

			};

			this.state.abortController.signal.addEventListener( 'abort', abortHandler, { once: true } );

			abortDenoise = this.unet.tileExecute( {
				...config,
				done: async ( output ) => {

					this.state.abortController.signal.removeEventListener( 'abort', abortHandler );
					abortDenoise = null;

					try {

						await this._displayGPUOutput( output );
						resolve();

					} catch ( err ) {

						reject( err );

					}

				},
				progress: ( outputData, _tileData, tile ) => {

					// oidn-web GPU path: tileData is null, but outputData holds the assembled
					// full-image buffer updated after each tile. Extract the tile region via
					// row-by-row copyBufferToBuffer (no stride support in WebGPU buffer copies).
					if ( ! outputData?.data || ! tile ) return;

					// Draw tile grid overlay once on the noisy base image
					if ( this.showTileHelper && ! this._tileGridDrawn ) {

						this._tileGridDrawn = true;
						this._drawTileGrid( tile, outputData.width, outputData.height );

					}

					const device = this.gpuDevice;
					const fullWidth = outputData.width;
					const bytesPerPixel = 16; // rgba32float = 4 × float32
					const tileRowBytes = tile.width * bytesPerPixel;
					const tileByteSize = tile.width * tile.height * bytesPerPixel;

					const staging = device.createBuffer( {
						size: tileByteSize,
						usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
					} );

					// Copy each tile row from its position in the full output buffer
					const enc = device.createCommandEncoder();

					for ( let row = 0; row < tile.height; row ++ ) {

						const srcOffset = ( ( tile.y + row ) * fullWidth + tile.x ) * bytesPerPixel;
						const dstOffset = row * tileRowBytes;
						enc.copyBufferToBuffer( outputData.data, srcOffset, staging, dstOffset, tileRowBytes );

					}

					device.queue.submit( [ enc.finish() ] );

					// Map and blit asynchronously — GPU copy is already queued
					staging.mapAsync( GPUMapMode.READ ).then( () => {

						const f32 = new Float32Array( staging.getMappedRange() );
						const tileImageData = new ImageData( tile.width, tile.height );
						const exposure = this.getExposure();
						const saturation = this.getSaturation();
						const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
						const alpha = this._cachedAlpha;
						const alphaW = this._cachedAlphaWidth;

						for ( let i = 0, len = f32.length; i < len; i += 4 ) {

							// Exposure + saturation (pre-tonemap, matching DisplayStage)
							let er = f32[ i ] * exposure, eg = f32[ i + 1 ] * exposure, eb = f32[ i + 2 ] * exposure;
							if ( saturation !== 1.0 ) {

								_tmOut[ 0 ] = er; _tmOut[ 1 ] = eg; _tmOut[ 2 ] = eb;
								applySaturation( _tmOut, saturation );
								er = _tmOut[ 0 ]; eg = _tmOut[ 1 ]; eb = _tmOut[ 2 ];

							}

							tmFn( er, eg, eb, 1.0, _tmOut );
							tileImageData.data[ i ] = _tmOut[ 0 ] ** SRGB_GAMMA * 255 | 0;
							tileImageData.data[ i + 1 ] = _tmOut[ 1 ] ** SRGB_GAMMA * 255 | 0;
							tileImageData.data[ i + 2 ] = _tmOut[ 2 ] ** SRGB_GAMMA * 255 | 0;

							if ( alpha ) {

								const px = ( i >> 2 ) % tile.width;
								const py = ( i >> 2 ) / tile.width | 0;
								tileImageData.data[ i + 3 ] = alpha[ ( tile.y + py ) * alphaW + tile.x + px ];

							} else {

								tileImageData.data[ i + 3 ] = 255;

							}

						}

						staging.unmap();
						staging.destroy();
						this.ctx.putImageData( tileImageData, tile.x, tile.y );

					} );

				}
			} );

		} );

	}

	/**
	 * Draws a grid overlay on the noisy base image. Called once when the first
	 * progress tile arrives. As each tile is denoised, putImageData naturally
	 * overwrites the grid lines for that region — the grid "erases itself".
	 */
	_drawTileGrid( firstTile, imageWidth, imageHeight ) {

		const tileW = firstTile.width;
		const tileH = firstTile.height;
		const cols = Math.ceil( imageWidth / tileW );
		const rows = Math.ceil( imageHeight / tileH );
		const ctx = this.ctx;

		ctx.save();
		ctx.strokeStyle = 'rgba(255, 0, 0, 0.25)';
		ctx.lineWidth = 1;

		// Vertical lines
		for ( let c = 1; c < cols; c ++ ) {

			const x = c * tileW + 0.5;
			ctx.beginPath();
			ctx.moveTo( x, 0 );
			ctx.lineTo( x, imageHeight );
			ctx.stroke();

		}

		// Horizontal lines
		for ( let r = 1; r < rows; r ++ ) {

			const y = r * tileH + 0.5;
			ctx.beginPath();
			ctx.moveTo( 0, y );
			ctx.lineTo( imageWidth, y );
			ctx.stroke();

		}

		ctx.restore();

	}

	/**
	 * Reads a GPUBuffer (oidn-web output, rgba32float linear) back to CPU via a staging buffer,
	 * applies exposure * pow(4) + ACES filmic tonemap + sRGB gamma 2.2, then draws to the 2D canvas.
	 * @param {{ data: GPUBuffer, width: number, height: number }} output
	 */
	async _displayGPUOutput( { data: gpuBuffer, width, height } ) {

		const device = this.gpuDevice;
		if ( ! device ) {

			console.error( 'OIDNDenoiser: gpuDevice not available for output readback' );
			return;

		}

		const byteSize = width * height * 4 * 4; // rgba32float = 16 bytes/pixel

		// Staging buffer with MAP_READ so we can copy the output into it and read from CPU
		const stagingBuffer = device.createBuffer( {
			label: 'oidn-output-staging',
			size: byteSize,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
		} );

		// Queue a copy from the oidn output buffer (STORAGE|COPY_SRC) to staging
		const encoder = device.createCommandEncoder( { label: 'oidn-readback' } );
		encoder.copyBufferToBuffer( gpuBuffer, 0, stagingBuffer, 0, byteSize );
		device.queue.submit( [ encoder.finish() ] );

		await stagingBuffer.mapAsync( GPUMapMode.READ );
		const float32 = new Float32Array( stagingBuffer.getMappedRange() );

		const imageData = new ImageData( width, height );
		const exposure = this.getExposure();
		const saturation = this.getSaturation();
		const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
		const alpha = this._cachedAlpha;

		for ( let i = 0, len = float32.length; i < len; i += 4 ) {

			// Exposure + saturation (pre-tonemap, matching DisplayStage)
			let er = float32[ i ] * exposure, eg = float32[ i + 1 ] * exposure, eb = float32[ i + 2 ] * exposure;
			if ( saturation !== 1.0 ) {

				_tmOut[ 0 ] = er; _tmOut[ 1 ] = eg; _tmOut[ 2 ] = eb;
				applySaturation( _tmOut, saturation );
				er = _tmOut[ 0 ]; eg = _tmOut[ 1 ]; eb = _tmOut[ 2 ];

			}

			tmFn( er, eg, eb, 1.0, _tmOut );
			imageData.data[ i ] = _tmOut[ 0 ] ** SRGB_GAMMA * 255 | 0;
			imageData.data[ i + 1 ] = _tmOut[ 1 ] ** SRGB_GAMMA * 255 | 0;
			imageData.data[ i + 2 ] = _tmOut[ 2 ] ** SRGB_GAMMA * 255 | 0;
			imageData.data[ i + 3 ] = alpha ? alpha[ i >> 2 ] : 255;

		}

		stagingBuffer.unmap();
		stagingBuffer.destroy();

		this.ctx.putImageData( imageData, 0, 0 );

	}

	abort() {

		if ( ! this.enabled || ! this.state.isDenoising ) return;

		// Signal abort to current operation
		this.state.abortController?.abort();

		// Restore input visibility
		this.input.style.opacity = '1';

		// Reset denoising state and dispatch end event
		this.state.isDenoising = false;
		this.dispatchEvent( { type: 'end' } );

		console.log( 'Denoising aborted' );

	}

	setSize( width, height ) {

		if ( width <= 0 || height <= 0 ) {

			throw new Error( `Invalid dimensions: ${width}x${height}` );

		}

		this.output.width = width;
		this.output.height = height;

		// Reinitialize denoiser if tile size changes relative to image size
		this._setupUNetDenoiser().catch( error => {

			console.error( 'Failed to reinitialize denoiser after size change:', error );

		} );

	}

	/**
	 * Update debug visualization using MRT textures directly
	 * @param {RenderTarget} mrtRenderTarget - The MRT render target containing albedo and normal
	 */
	_updateDebugVisualization( mrtRenderTarget ) {

		if ( ! mrtRenderTarget?.textures || mrtRenderTarget.textures.length < 3 ) {

			return;

		}

		// Check if textures have changed (render target was recreated)
		const texturesChanged = this.debugHelpers &&
			( this._lastAlbedoTexture !== mrtRenderTarget.textures[ 2 ] ||
			  this._lastNormalTexture !== mrtRenderTarget.textures[ 1 ] );

		// Create or recreate helpers when textures change
		if ( ! this.debugHelpers || texturesChanged ) {

			// Dispose existing helpers if they exist
			if ( this.debugHelpers ) {

				this.debugHelpers.albedo?.dispose();
				this.debugHelpers.normal?.dispose();
				console.log( 'OIDNDenoiser: Recreating debug helpers due to texture change' );

			}

			// Pass full MRT render target with textureIndex for async readback
			this.debugHelpers = {
				albedo: RenderTargetHelper( this.renderer, mrtRenderTarget, {
					width: 250,
					height: 250,
					position: 'bottom-right',
					theme: 'dark',
					title: 'OIDN Albedo',
					autoUpdate: false,
					textureIndex: 2
				} ),
				normal: RenderTargetHelper( this.renderer, mrtRenderTarget, {
					width: 250,
					height: 250,
					position: 'bottom-left',
					theme: 'dark',
					title: 'OIDN Normal',
					autoUpdate: false,
					textureIndex: 1
				} )
			};

			// Store references to track texture changes
			this._lastAlbedoTexture = mrtRenderTarget.textures[ 2 ];
			this._lastNormalTexture = mrtRenderTarget.textures[ 1 ];

			// Add helpers to DOM
			const container = this.debugContainer || document.body;
			container.appendChild( this.debugHelpers.albedo );
			container.appendChild( this.debugHelpers.normal );

			// Hide by default (visibility state will be restored by calling code)
			this.debugHelpers.albedo.hide();
			this.debugHelpers.normal.hide();

		}

		// Update the displays
		this.debugHelpers.albedo.update();
		this.debugHelpers.normal.update();

	}

	dispose() {

		// Abort any ongoing operations
		this.abort();

		// Dispose resources
		this.unet?.dispose();
		this._destroyGPUInputBuffers();

		// Dispose debug helpers
		if ( this.debugHelpers ) {

			this.debugHelpers.albedo?.dispose();
			this.debugHelpers.normal?.dispose();
			this.debugHelpers = null;

		}

		// Clear texture references
		this._lastAlbedoTexture = null;
		this._lastNormalTexture = null;

		// Clean up DOM
		if ( this.output?.parentNode ) {

			this.output.remove();

		}

		// Clear references
		this.unet = null;
		this.ctx = null;
		this.state.abortController = null;

		// Remove all event listeners
		this.removeAllListeners?.();

		console.log( 'OIDNDenoiser disposed' );

	}

}
