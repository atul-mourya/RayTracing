import { initUNetFromURL } from 'oidn-web';
import { EventDispatcher } from 'three';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';

/**
 * ACES Filmic tonemap matching Three.js ACESFilmicToneMapping.
 * Operates on linear light values and outputs display-encoded [0,1].
 */
function acesFilmic( x ) {

	const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
	return Math.max( 0, Math.min( 1, ( x * ( a * x + b ) ) / ( x * ( c * x + d ) + e ) ) );

}

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
		useGBuffer: true,
		oidnQuality: 'fast',
		oidnHdr: false,
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
		this.getMRTTexture = options.getMRTTexture || null;
		this.extractGBufferData = options.extractGBufferData || null;
		this.getMRTRenderTarget = options.getMRTRenderTarget || null;

		// WebGPU GPU-native path (no CPU readback for inputs)
		// backendParams: () => { device: GPUDevice, adapterInfo: GPUAdapterInfo|null }
		// getGPUTextures: () => { color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }
		// getExposure: () => number  (linear exposure value, same as app.exposure)
		this.backendParamsGetter = options.backendParams || null;
		this.getGPUTextures = options.getGPUTextures || null;
		this.getExposure = options.getExposure || ( () => 1.0 );
		this.isGPUMode = !! this.backendParamsGetter;
		this.gpuDevice = null;

		// Cached GPU storage buffers for texture→buffer copies (reused across denoise calls)
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputBufferSize = { width: 0, height: 0 };

		// Merge options with defaults
		this.config = { ...MODEL_CONFIG.DEFAULT_OPTIONS, ...options };

		// Destructure for easier access
		this.enabled = this.config.enableOIDN;
		this.useGBuffer = this.config.useGBuffer;
		this.quality = this.config.oidnQuality;
		this.hdr = this.config.oidnHdr;
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

			this.unet = await initUNetFromURL( tzaUrl, backendParams, {
				aux: this.useGBuffer,
				// GPU path requires hdr: true (only HDR+aux weight files have a GPU pipeline)
				hdr: this.isGPUMode ? true : this.hdr,
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
		// GPU path requires the HDR model variant (GPU pipeline only exists for hdr+aux weights)
		const dynamicRange = ( this.isGPUMode || this.hdr ) ? '_hdr' : '_ldr';
		const aux = this.useGBuffer ? '_alb_nrm' : '';

		return `${BASE_URL}rt${dynamicRange}${aux}${modelSize}.tza`;

	}

	// Public configuration methods with validation
	async updateConfiguration( newConfig ) {

		const hasChanged = Object.keys( newConfig ).some( key => this.config[ key ] !== newConfig[ key ] );

		if ( ! hasChanged ) return;

		// Update configuration
		Object.assign( this.config, newConfig );
		this.useGBuffer = this.config.useGBuffer;
		this.quality = this.config.oidnQuality;
		this.hdr = this.config.oidnHdr;
		this.debugGbufferMaps = this.config.debugGbufferMaps;
		this.tileSize = this.config.tileSize;

		// Reload denoiser if necessary
		await this._setupUNetDenoiser();

	}

	async toggleUseGBuffer( value ) {

		await this.updateConfiguration( { useGBuffer: value } );

	}

	async toggleHDR( value ) {

		await this.updateConfiguration( { oidnHdr: value } );

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

	/**
	 * Extract albedo and normal data from MRT normalDepth texture
	 * @returns {ImageData|null}
	 */
	_extractAlbedoNormalFromMRT() {

		if ( ! this.getMRTTexture ) return null;

		const data = this.getMRTTexture();
		if ( ! data?.renderTarget ) return null;

		const { width, height } = this.output;
		const pixelCount = width * height;
		const buffer = new Float32Array( pixelCount * 4 );
		const gl = this.renderer.getContext();

		// Pre-allocate ImageData objects
		const albedoData = new ImageData( width, height );
		const normalData = new ImageData( width, height );

		// Read albedo from MRT attachment 2
		this.renderer.setRenderTarget( data.renderTarget );
		gl.readBuffer( gl.COLOR_ATTACHMENT2 );
		gl.readPixels( 0, 0, width, height, gl.RGBA, gl.FLOAT, buffer );

		// Process albedo data with Y-flip (readPixels reads from bottom-left, ImageData expects top-left)
		const albedoArray = albedoData.data;
		for ( let y = 0; y < height; y ++ ) {

			const flippedY = height - 1 - y;
			const srcRowStart = flippedY * width * 4;
			const dstRowStart = y * width * 4;

			for ( let x = 0; x < width; x ++ ) {

				const srcIdx = srcRowStart + x * 4;
				const dstIdx = dstRowStart + x * 4;

				albedoArray[ dstIdx ] = Math.min( buffer[ srcIdx ] * 255, 255 ) | 0;
				albedoArray[ dstIdx + 1 ] = Math.min( buffer[ srcIdx + 1 ] * 255, 255 ) | 0;
				albedoArray[ dstIdx + 2 ] = Math.min( buffer[ srcIdx + 2 ] * 255, 255 ) | 0;
				albedoArray[ dstIdx + 3 ] = 255;

			}

		}

		// Read normals from MRT attachment 1
		gl.readBuffer( gl.COLOR_ATTACHMENT1 );
		gl.readPixels( 0, 0, width, height, gl.RGBA, gl.FLOAT, buffer );
		this.renderer.setRenderTarget( null );

		// Process normal data with Y-flip (decode from [0,1] to [-1,1] then remap to [0,255])
		const normalArray = normalData.data;
		for ( let y = 0; y < height; y ++ ) {

			const flippedY = height - 1 - y;
			const srcRowStart = flippedY * width * 4;
			const dstRowStart = y * width * 4;

			for ( let x = 0; x < width; x ++ ) {

				const srcIdx = srcRowStart + x * 4;
				const dstIdx = dstRowStart + x * 4;

				normalArray[ dstIdx ] = ( buffer[ srcIdx ] * 255 - 127.5 ) | 0;
				normalArray[ dstIdx + 1 ] = ( buffer[ srcIdx + 1 ] * 255 - 127.5 ) | 0;
				normalArray[ dstIdx + 2 ] = ( buffer[ srcIdx + 2 ] * 255 - 127.5 ) | 0;
				normalArray[ dstIdx + 3 ] = 255;

			}

		}

		return { albedo: albedoData, normal: normalData };

	}

	async _executeUNet() {

		if ( this.isGPUMode ) return this._executeUNetGPU();

		const { width, height } = this.output;

		// Clear and draw current renderer output
		this.ctx.clearRect( 0, 0, width, height );
		this.ctx.drawImage( this.input, 0, 0, width, height );

		// Get image data for denoising
		const imageData = this.ctx.getImageData( 0, 0, width, height );

		// Prepare denoising configuration
		const config = {
			color: imageData,
			tileSize: this.tileSize,
			denoiseAlpha: true
		};

		// Add G-buffer data if enabled
		if ( this.useGBuffer ) {

			// Use pluggable extraction callback if provided (e.g. WebGPU),
			// otherwise fall back to the built-in WebGL MRT readback.
			if ( this.extractGBufferData ) {

				const gbufferResult = await this.extractGBufferData( width, height );
				if ( gbufferResult?.albedo && gbufferResult?.normal ) {

					config.albedo = gbufferResult.albedo;
					config.normal = gbufferResult.normal;

				} else {

					console.warn( 'OIDNDenoiser: G-buffer extraction returned incomplete data, denoising without G-buffer' );

				}

				// Debug visualization for WebGPU path (uses MRT render target directly)
				if ( this.debugGbufferMaps && this.getMRTRenderTarget ) {

					const mrtRT = this.getMRTRenderTarget();
					if ( mrtRT ) {

						this._updateDebugVisualization( mrtRT );
						this.debugHelpers?.albedo?.show();
						this.debugHelpers?.normal?.show();

					}

				} else if ( this.debugHelpers ) {

					this.debugHelpers.albedo?.hide();
					this.debugHelpers.normal?.hide();

				}

			} else {

				const mrtData = this.getMRTTexture();

				// Extract ImageData for OIDN denoiser
				const { albedo, normal } = this._extractAlbedoNormalFromMRT();
				config.albedo = albedo;
				config.normal = normal;

				// Update debug visualization if enabled (uses MRT textures directly)
				if ( this.debugGbufferMaps && mrtData?.renderTarget ) {

					this._updateDebugVisualization( mrtData.renderTarget );
					this.debugHelpers.albedo.show();
					this.debugHelpers.normal.show();

				} else if ( this.debugHelpers ) {

					this.debugHelpers.albedo.hide();
					this.debugHelpers.normal.hide();

				}

			}

		}

		// Execute denoising with abort support
		return this._executeWithAbort( config );

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

		if ( this.useGBuffer ) {

			copyTex( textures.albedo, this._gpuInputBuffers.albedo );
			copyTex( textures.normal, this._gpuInputBuffers.normal );

		}

		device.queue.submit( [ encoder.finish() ] );

		// Draw the current noisy frame as the base — denoised tiles paint on top progressively
		this.ctx.drawImage( this.input, 0, 0, width, height );

		// Pass GPU storage buffers to oidn-web (GPUBuffer path, well-tested)
		const config = {
			color: { data: this._gpuInputBuffers.color, width, height }
		};

		if ( this.useGBuffer ) {

			config.albedo = { data: this._gpuInputBuffers.albedo, width, height };
			config.normal = { data: this._gpuInputBuffers.normal, width, height };

		}

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
						const exposure4 = Math.pow( this.getExposure(), 4.0 );

						for ( let i = 0, len = f32.length; i < len; i += 4 ) {

							tileImageData.data[ i ] = acesFilmic( f32[ i ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
							tileImageData.data[ i + 1 ] = acesFilmic( f32[ i + 1 ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
							tileImageData.data[ i + 2 ] = acesFilmic( f32[ i + 2 ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
							tileImageData.data[ i + 3 ] = 255;

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
		// DisplayStage applies exposure^4 before ACES tonemap — replicate the same curve
		const exposure4 = Math.pow( this.getExposure(), 4.0 );

		for ( let i = 0, len = float32.length; i < len; i += 4 ) {

			imageData.data[ i ] = acesFilmic( float32[ i ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
			imageData.data[ i + 1 ] = acesFilmic( float32[ i + 1 ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
			imageData.data[ i + 2 ] = acesFilmic( float32[ i + 2 ] * exposure4 ) ** ( 1 / 2.2 ) * 255 | 0;
			imageData.data[ i + 3 ] = 255;

		}

		stagingBuffer.unmap();
		stagingBuffer.destroy();

		this.ctx.putImageData( imageData, 0, 0 );

	}

	_executeWithAbort( config ) {

		return new Promise( ( resolve, reject ) => {

			// Check for abort before starting
			if ( this.state.abortController?.signal.aborted ) {

				reject( new DOMException( 'Aborted', 'AbortError' ) );
				return;

			}

			let abortDenoise = null;

			// Set up abort handling
			const abortHandler = () => {

				if ( abortDenoise ) {

					abortDenoise();
					abortDenoise = null;

				}

				reject( new DOMException( 'Aborted', 'AbortError' ) );

			};

			this.state.abortController.signal.addEventListener( 'abort', abortHandler, { once: true } );

			// Execute denoising
			abortDenoise = this.unet.tileExecute( {
				...config,
				done: () => {

					this.state.abortController.signal.removeEventListener( 'abort', abortHandler );
					abortDenoise = null;
					resolve();

				},
				progress: ( _outputData, tileData, tile ) => {

					// Check for abort during progress
					if ( this.state.abortController?.signal.aborted ) {

						abortHandler();
						return;

					}

					this.ctx.putImageData( tileData, tile.x, tile.y );

				}
			} );

		} );

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
	 * @param {WebGLRenderTarget} mrtRenderTarget - The MRT render target containing albedo and normal
	 */
	_updateDebugVisualization( mrtRenderTarget ) {

		if ( ! mrtRenderTarget?.textures || mrtRenderTarget.textures.length < 3 ) {

			return;

		}

		const isWebGPU = ! this.renderer.isWebGLRenderer;

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

			if ( isWebGPU ) {

				// WebGPU: pass full MRT render target with textureIndex for async readback
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

			} else {

				// WebGL: pass individual textures (rendered via internal ShaderMaterial)
				this.debugHelpers = {
					albedo: RenderTargetHelper( this.renderer, mrtRenderTarget.textures[ 2 ], {
						width: 250,
						height: 250,
						position: 'bottom-right',
						theme: 'dark',
						title: 'OIDN Albedo',
						autoUpdate: false
					} ),
					normal: RenderTargetHelper( this.renderer, mrtRenderTarget.textures[ 1 ], {
						width: 250,
						height: 250,
						position: 'bottom-left',
						theme: 'dark',
						title: 'OIDN Normal',
						autoUpdate: false,
						transform: 'normal-remap'
					} )
				};

			}

			// Store references to track texture changes
			this._lastAlbedoTexture = mrtRenderTarget.textures[ 2 ];
			this._lastNormalTexture = mrtRenderTarget.textures[ 1 ];

			// Add helpers to DOM
			document.body.appendChild( this.debugHelpers.albedo );
			document.body.appendChild( this.debugHelpers.normal );

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
