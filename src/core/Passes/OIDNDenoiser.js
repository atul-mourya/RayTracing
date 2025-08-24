import { initUNetFromURL } from 'oidn-web';
import { AlbedoNormalGenerator } from './AlbedoNormalGenerator';
import { EventDispatcher } from 'three';

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
		this.mapGenerator = null;

		// For debug visualization
		this.debugHelpers = null;

		// Initialize asynchronously
		this._initialize().catch( error => {

			console.error( 'Failed to initialize OIDNDenoiser:', error );
			this.dispatchEvent( { type: 'error', error } );

		} );

	}

	async _initialize() {

		try {

			this._setupCanvas();
			this.mapGenerator = new AlbedoNormalGenerator( this.scene, this.camera, this.renderer );
			await this._setupUNetDenoiser();

		} catch ( error ) {

			throw new Error( `Initialization failed: ${error.message}` );

		}

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

			this.unet = await initUNetFromURL( tzaUrl, undefined, {
				aux: this.useGBuffer,
				hdr: this.hdr,
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
		const dynamicRange = this.hdr ? '_hdr' : '_ldr';
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
		if ( this.useGBuffer && this.mapGenerator ) {

			const { albedo, normal } = this.mapGenerator.generateMaps();
			config.albedo = albedo;
			config.normal = normal;

			// Debug output if enabled
			if ( this.debugGbufferMaps ) {

				// Create debug helpers if they don't exist
				if ( ! this.debugHelpers ) {

					this.debugHelpers = this.mapGenerator.createDebugHelpers( this.renderer );

					// Add helpers to DOM
					if ( this.debugHelpers.albedo ) document.body.appendChild( this.debugHelpers.albedo );
					if ( this.debugHelpers.normal ) document.body.appendChild( this.debugHelpers.normal );

				}

				// Visualize the G-buffer maps
				this.mapGenerator.visualizeImageDataInTarget( albedo, this.mapGenerator.albedoDebugTarget, this.renderer );
				this.mapGenerator.visualizeImageDataInTarget( normal, this.mapGenerator.normalDebugTarget, this.renderer );

				// Update the helpers
				if ( this.debugHelpers.albedo ) this.debugHelpers.albedo.update();
				if ( this.debugHelpers.normal ) this.debugHelpers.normal.update();

			} else if ( this.debugHelpers ) {

				// Hide helpers if debug is disabled
				if ( this.debugHelpers.albedo ) this.debugHelpers.albedo.hide();
				if ( this.debugHelpers.normal ) this.debugHelpers.normal.hide();

			}

		}

		// Execute denoising with abort support
		return this._executeWithAbort( config );

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
				progress: ( outputData, tileData, tile ) => {

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

		this.mapGenerator?.setSize( width, height );
		this.output.width = width;
		this.output.height = height;

		// Reinitialize denoiser if tile size changes relative to image size
		this._setupUNetDenoiser().catch( error => {

			console.error( 'Failed to reinitialize denoiser after size change:', error );

		} );

	}

	dispose() {

		// Abort any ongoing operations
		this.abort();

		// Dispose resources
		this.mapGenerator?.dispose();
		this.unet?.dispose();

		// Dispose debug helpers
		if ( this.debugHelpers ) {

			if ( this.debugHelpers.albedo ) this.debugHelpers.albedo.dispose();
			if ( this.debugHelpers.normal ) this.debugHelpers.normal.dispose();
			this.debugHelpers = null;

		}

		// Clean up DOM
		if ( this.output?.parentNode ) {

			this.output.remove();

		}

		// Clear references
		this.mapGenerator = null;
		this.unet = null;
		this.ctx = null;
		this.state.abortController = null;

		// Remove all event listeners
		this.removeAllListeners?.();

		console.log( 'OIDNDenoiser disposed' );

	}

}
