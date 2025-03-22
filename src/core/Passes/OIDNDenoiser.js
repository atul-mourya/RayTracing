import { initUNetFromURL } from 'oidn-web';
import { AlbedoNormalGenerator, renderImageDataToCanvas } from './AlbedoNormalGenerator';
import { EventDispatcher } from 'three';

export class OIDNDenoiser extends EventDispatcher {

	constructor( renderer, scene, camera, options = {} ) {

		super();

		// Initialize properties with defaults
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.sourceCanvas = renderer.domElement;

		// Configuration options with defaults
		this.enabled = options.enableOIDN ?? true;
		this.useGBuffer = options.useGBuffer ?? true;
		this.quality = options.oidnQuality ?? 'fast';
		this.hdr = options.oidnHdr ?? false;
		this.debugGbufferMaps = options.debugGbufferMaps ?? false;
		this.tileSize = options.tileSize ?? 256;

		// State
		this.isDenoising = false;
		this.abortDenoise = null;

		// Setup
		this._setupCanvas();
		this._setupUNetDenoiser();
		this.mapGenerator = new AlbedoNormalGenerator( this.scene, this.camera, this.renderer );

	}

	async _setupUNetDenoiser() {

		try {

			this.dispatchEvent( { type: 'loading', message: 'Loading UNet denoiser...' } );
			this.unet = await initUNetFromURL( this.getTzasUrl(), undefined, {
				aux: this.useGBuffer,
				hdr: this.hdr
			} );
			this.dispatchEvent( { type: 'loaded' } );
			console.log( 'UNet denoiser loaded successfully' );

		} catch ( error ) {

			console.error( 'Failed to load UNet denoiser:', error );
			this.dispatchEvent( { type: 'error', error } );

		}

	}

	async toggleUseGBuffer( value ) {

		this.unet.dispose();
		this.useGBuffer = value;
		await this._setupUNetDenoiser();

	}

	async toggleHDR( value ) {

		this.unet.dispose();
		this.hdr = value;
		await this._setupUNetDenoiser();

	}

	async updateQuality( value ) {

		this.unet.dispose();
		this.quality = value;
		await this._setupUNetDenoiser();

	}

	getTzasUrl() {

		const BASE_URL = 'https://cdn.jsdelivr.net/npm/denoiser/tzas/';

		// Map quality setting to model size suffix
		const modelSize = {
		  'fast': '_small',
		  'balanced': '',
		  'high': '_large'
		}[ this.quality ] || '';

		// Map HDR boolean to dynamic range string
		const dynamicRange = this.hdr ? '_hdr' : '_ldr';

		// Add auxiliary buffers suffix if needed
		const aux = this.useGBuffer ? '_alb_nrm' : '';

		return `${BASE_URL}rt${dynamicRange}${aux}${modelSize}.tza`;

	}

	_setupCanvas() {

		this.denoisedCanvas = document.createElement( 'canvas' );
		this.denoisedCanvas.willReadFrequently = true;

		// Set dimensions
		this.denoisedCanvas.width = this.sourceCanvas.width;
		this.denoisedCanvas.height = this.sourceCanvas.height;

		// Style canvas
		Object.assign( this.denoisedCanvas.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			background: "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px"
		} );

		// Add to DOM
		this.sourceCanvas.parentElement.prepend( this.denoisedCanvas );

		// Create context with optimization flag
		this.ctx = this.denoisedCanvas.getContext( '2d', { willReadFrequently: true } );

	}

	async start() {

		if ( ! this.enabled || this.isDenoising ) return false;

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState();
			this.sourceCanvas.style.opacity = 0;
			console.log( `Denoising completed in ${performance.now() - startTime}ms (quality: ${this.quality})` );

		}

		return success;

	}

	async execute() {

		if ( ! this.enabled ) return false;

		try {

			// Abort any ongoing operation
			this.isDenoising && this.abort();

			this.isDenoising = true;
			this.dispatchEvent( { type: 'start' } );
			await this._executeUNet();

			this.renderResult();
			return true;

		} catch ( error ) {

			console.error( 'Denoising error:', error );
			// Restore original rendering on error
			this.sourceCanvas.style.opacity = 1;
			return false;

		} finally {

			this.isDenoising = false;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	async _executeUNet() {

		// Clear any previous denoise operation
		this.abort();

		const w = this.denoisedCanvas.width;
		const h = this.denoisedCanvas.height;

		// Draw the current renderer output to our canvas
		this.ctx.clearRect( 0, 0, w, h );
		this.ctx.drawImage( this.sourceCanvas, 0, 0, w, h );

		// Get the image data for denoising
		const imageData = this.ctx.getImageData( 0, 0, w, h );

		// Prepare additional data for G-Buffers if enabled
		const additionalData = {};
		if ( this.useGBuffer ) {

			const { albedo, normal } = this.mapGenerator.generateMaps();
			additionalData.albedo = albedo;
			additionalData.normal = normal;

			if ( this.debugGbufferMaps ) {

				renderImageDataToCanvas( albedo, 'debugAlbedoCanvas' );
				renderImageDataToCanvas( normal, 'debugNormalCanvas' );

			}

		}

		// Execute the UNet denoiser in tiles
		return new Promise( ( resolve ) => {

			this.abortDenoise = this.unet.tileExecute( {
				color: imageData,
				...additionalData,
				tileSize: this.tileSize,
				done: () => {

					this.abortDenoise = null;
					resolve();

				},
				progress: ( _, tileData, tile ) => {

					this.ctx.putImageData( tileData, tile.x, tile.y );

				}
			} );

		} );

	}

	renderResult() {

		this.sourceCanvas.style.opacity = 0;

	}

	abort() {

		if ( ! this.enabled || ! this.isDenoising ) return;

		if ( this.abortDenoise ) {

			this.abortDenoise();
			this.abortDenoise = null;

		}

		this.sourceCanvas.style.opacity = 1;
		this.isDenoising = false;
		this.dispatchEvent( { type: 'end' } );

	}

	setSize( width, height ) {

		const pixelRatio = this.renderer.getPixelRatio();
		const scaledWidth = width * pixelRatio;
		const scaledHeight = height * pixelRatio;

		this.mapGenerator.setSize( scaledWidth, scaledHeight );
		this.denoisedCanvas.width = scaledWidth;
		this.denoisedCanvas.height = scaledHeight;

	}

	dispose() {

		this.mapGenerator.dispose();
		this.unet.dispose();

		if ( this.abortDenoise ) {

			this.abortDenoise();
			this.abortDenoise = null;

		}

		this.denoisedCanvas.remove();

	}

}
