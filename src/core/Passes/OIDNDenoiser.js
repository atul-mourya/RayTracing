import { initUNetFromURL } from 'oidn-web';
import { EventDispatcher, NoToneMapping, LinearToneMapping, ReinhardToneMapping, CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping } from 'three';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';

// ─── CPU tone mapping matching Three.js ToneMappingFunctions.js (WebGPU) ───
// All functions write tonemapped linear RGB into `out` array.

const clamp01 = x => Math.min( Math.max( x, 0 ), 1 );

function noToneMap( r, g, b, _exposure, out ) {

	out[ 0 ] = clamp01( r );
	out[ 1 ] = clamp01( g );
	out[ 2 ] = clamp01( b );

}

function linearToneMap( r, g, b, exposure, out ) {

	out[ 0 ] = clamp01( r * exposure );
	out[ 1 ] = clamp01( g * exposure );
	out[ 2 ] = clamp01( b * exposure );

}

function reinhardToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;
	out[ 0 ] = clamp01( r / ( r + 1 ) );
	out[ 1 ] = clamp01( g / ( g + 1 ) );
	out[ 2 ] = clamp01( b / ( b + 1 ) );

}

function cineonToneMap( r, g, b, exposure, out ) {

	r = Math.max( r * exposure - 0.004, 0 );
	g = Math.max( g * exposure - 0.004, 0 );
	b = Math.max( b * exposure - 0.004, 0 );
	const f = c => Math.pow( ( c * ( 6.2 * c + 0.5 ) ) / ( c * ( 6.2 * c + 1.7 ) + 0.06 ), 2.2 );
	out[ 0 ] = f( r );
	out[ 1 ] = f( g );
	out[ 2 ] = f( b );

}

// Full ACES RRT+ODT with colour-space matrices (matches Three.js WebGPU, NOT the Narkowicz fit)
function acesFilmicToneMap( r, g, b, exposure, out ) {

	r = r * exposure / 0.6;
	g = g * exposure / 0.6;
	b = b * exposure / 0.6;

	// ACESInputMat  (sRGB → AP1)
	let ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
	let ig = 0.07600 * r + 0.90834 * g + 0.01566 * b;
	let ib = 0.02840 * r + 0.13383 * g + 0.83777 * b;

	// RRTAndODTFit
	const fit = c => ( c * ( c + 0.0245786 ) - 0.000090537 ) / ( c * ( 0.983729 * c + 0.4329510 ) + 0.238081 );
	ir = fit( ir ); ig = fit( ig ); ib = fit( ib );

	// ACESOutputMat (AP1 → sRGB)
	out[ 0 ] = clamp01( 1.60475 * ir - 0.53108 * ig - 0.07367 * ib );
	out[ 1 ] = clamp01( - 0.10208 * ir + 1.10813 * ig - 0.00605 * ib );
	out[ 2 ] = clamp01( - 0.00327 * ir - 0.07276 * ig + 1.07602 * ib );

}

function agxToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;

	// LINEAR_SRGB_TO_LINEAR_REC2020
	let cr = 0.6274 * r + 0.3293 * g + 0.0433 * b;
	let cg = 0.0691 * r + 0.9195 * g + 0.0113 * b;
	let cb = 0.0164 * r + 0.0880 * g + 0.8956 * b;

	// AgXInsetMatrix
	let ar = 0.856627153315983 * cr + 0.0951212405381588 * cg + 0.0482516061458583 * cb;
	let ag = 0.137318972929847 * cr + 0.761241990602591 * cg + 0.101439036467562 * cb;
	let ab = 0.11189821299995 * cr + 0.0767994186031903 * cg + 0.811302368396859 * cb;

	// log2 → normalize to [0,1]
	const AgxMinEv = - 12.47393, AgxMaxEv = 4.026069, range = AgxMaxEv - AgxMinEv;
	ar = clamp01( ( Math.log2( Math.max( ar, 1e-10 ) ) - AgxMinEv ) / range );
	ag = clamp01( ( Math.log2( Math.max( ag, 1e-10 ) ) - AgxMinEv ) / range );
	ab = clamp01( ( Math.log2( Math.max( ab, 1e-10 ) ) - AgxMinEv ) / range );

	// agxDefaultContrastApprox  (6th-degree polynomial)
	const approx = x => {

		const x2 = x * x, x4 = x2 * x2;
		return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;

	};

	ar = approx( ar ); ag = approx( ag ); ab = approx( ab );

	// AgXOutsetMatrix
	let or = 1.1271005818144368 * ar - 0.11060664309660323 * ag - 0.016493938717834573 * ab;
	let og = - 0.1413297634984383 * ar + 1.157823702216272 * ag - 0.016493938717834257 * ab;
	let ob = - 0.14132976349843826 * ar - 0.11060664309660294 * ag + 1.2519364065950405 * ab;

	// pow 2.2
	or = Math.pow( Math.max( 0, or ), 2.2 );
	og = Math.pow( Math.max( 0, og ), 2.2 );
	ob = Math.pow( Math.max( 0, ob ), 2.2 );

	// LINEAR_REC2020_TO_LINEAR_SRGB
	out[ 0 ] = clamp01( 1.6605 * or - 0.5876 * og - 0.0728 * ob );
	out[ 1 ] = clamp01( - 0.1246 * or + 1.1329 * og - 0.0083 * ob );
	out[ 2 ] = clamp01( - 0.0182 * or - 0.1006 * og + 1.1187 * ob );

}

function neutralToneMap( r, g, b, exposure, out ) {

	const StartCompression = 0.8 - 0.04; // 0.76
	const Desaturation = 0.15;

	r *= exposure; g *= exposure; b *= exposure;

	const x = Math.min( r, Math.min( g, b ) );
	const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;

	r -= offset; g -= offset; b -= offset;

	const peak = Math.max( r, Math.max( g, b ) );

	if ( peak < StartCompression ) {

		out[ 0 ] = r; out[ 1 ] = g; out[ 2 ] = b;
		return;

	}

	const d = 1 - StartCompression;
	const newPeak = 1 - d * d / ( peak + d - StartCompression );
	const scale = newPeak / peak;
	r *= scale; g *= scale; b *= scale;
	const gFactor = 1 - 1 / ( Desaturation * ( peak - newPeak ) + 1 );

	out[ 0 ] = r + ( newPeak - r ) * gFactor;
	out[ 1 ] = g + ( newPeak - g ) * gFactor;
	out[ 2 ] = b + ( newPeak - b ) * gFactor;

}

/** Look-up table mapping Three.js ToneMapping constants to CPU functions. */
const TONE_MAP_FNS = new Map( [
	[ NoToneMapping, noToneMap ],
	[ LinearToneMapping, linearToneMap ],
	[ ReinhardToneMapping, reinhardToneMap ],
	[ CineonToneMapping, cineonToneMap ],
	[ ACESFilmicToneMapping, acesFilmicToneMap ],
	[ AgXToneMapping, agxToneMap ],
	[ NeutralToneMapping, neutralToneMap ]
] );

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
		this.extractGBufferData = options.extractGBufferData || null;
		this.getMRTRenderTarget = options.getMRTRenderTarget || null;

		// WebGPU GPU-native path (no CPU readback for inputs)
		// backendParams: () => { device: GPUDevice, adapterInfo: GPUAdapterInfo|null }
		// getGPUTextures: () => { color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }
		// getExposure: () => number  (effective exposure multiplier, pre-computed)
		// getToneMapping: () => number (Three.js ToneMapping constant)
		this.backendParamsGetter = options.backendParams || null;
		this.getGPUTextures = options.getGPUTextures || null;
		this.getExposure = options.getExposure || ( () => 1.0 );
		this.getToneMapping = options.getToneMapping || ( () => ACESFilmicToneMapping );
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

		if ( this.useGBuffer ) {

			copyTex( textures.albedo, this._gpuInputBuffers.albedo );
			copyTex( textures.normal, this._gpuInputBuffers.normal );

		}

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
						const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || acesFilmicToneMap;
						const gamma = 1 / 2.2;
						const alpha = this._cachedAlpha;
						const alphaW = this._cachedAlphaWidth;

						for ( let i = 0, len = f32.length; i < len; i += 4 ) {

							tmFn( f32[ i ], f32[ i + 1 ], f32[ i + 2 ], exposure, _tmOut );
							tileImageData.data[ i ] = _tmOut[ 0 ] ** gamma * 255 | 0;
							tileImageData.data[ i + 1 ] = _tmOut[ 1 ] ** gamma * 255 | 0;
							tileImageData.data[ i + 2 ] = _tmOut[ 2 ] ** gamma * 255 | 0;

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
		const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || acesFilmicToneMap;
		const gamma = 1 / 2.2;
		const alpha = this._cachedAlpha;

		for ( let i = 0, len = float32.length; i < len; i += 4 ) {

			tmFn( float32[ i ], float32[ i + 1 ], float32[ i + 2 ], exposure, _tmOut );
			imageData.data[ i ] = _tmOut[ 0 ] ** gamma * 255 | 0;
			imageData.data[ i + 1 ] = _tmOut[ 1 ] ** gamma * 255 | 0;
			imageData.data[ i + 2 ] = _tmOut[ 2 ] ** gamma * 255 | 0;
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
