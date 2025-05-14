import { initUNetFromURL } from 'oidn-web';
import { AlbedoNormalGenerator, renderImageDataToCanvas } from './AlbedoNormalGenerator';
import { EventDispatcher } from 'three';

export class OIDNDenoiser extends EventDispatcher {

	constructor( output, renderer, scene, camera, options = {} ) {

		super();

		// Initialize properties with defaults
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.input = renderer.domElement;
		this.output = output;

		// Configuration options with defaults
		this.enabled = options.enableOIDN ?? true;
		this.useGBuffer = options.useGBuffer ?? true;
		this.quality = options.oidnQuality ?? 'fast';
		this.hdr = options.oidnHdr ?? false;
		this.debugGbufferMaps = options.debugGbufferMaps ?? true;
		this.tileSize = options.tileSize ?? 256;

		// State
		this.isDenoising = false;
		this.abortDenoise = null;

		this.currentTZAUrl = this.getTzasUrl();

		// Setup
		this._setupCanvas();
		this._setupUNetDenoiser( this.currentTZAUrl );
		this.mapGenerator = new AlbedoNormalGenerator( this.scene, this.camera, this.renderer );

	}

	async _setupUNetDenoiser( tzaUrl ) {

		try {

			this.dispatchEvent( { type: 'loading', message: 'Loading UNet denoiser...' } );
			this.unet = await initUNetFromURL( tzaUrl, undefined, {
				aux: this.useGBuffer,
				hdr: this.hdr,
				maxTileSize: this.tileSize
			} );
			this.dispatchEvent( { type: 'loaded' } );
			console.log( 'UNet denoiser loaded successfully' );

		} catch ( error ) {

			console.error( 'Failed to load UNet denoiser:', error );
			this.dispatchEvent( { type: 'error', error } );

		}

	}

	async toggleUseGBuffer( value ) {

		this.useGBuffer = value;
		const tzaUrl = this.getTzasUrl();
		if ( this.currentTZAUrl === tzaUrl ) return;
		this.currentTZAUrl = tzaUrl;
		this.unet.dispose();
		await this._setupUNetDenoiser( tzaUrl );

	}

	async toggleHDR( value ) {

		this.hdr = value;
		const tzaUrl = this.getTzasUrl();
		if ( this.currentTZAUrl === tzaUrl ) return;
		this.currentTZAUrl = tzaUrl;
		this.unet.dispose();
		await this._setupUNetDenoiser( tzaUrl );

	}

	async updateQuality( value ) {

		this.quality = value;
		const tzaUrl = this.getTzasUrl();
		if ( this.currentTZAUrl === tzaUrl ) return;
		this.currentTZAUrl = tzaUrl;
		this.unet.dispose();
		await this._setupUNetDenoiser( tzaUrl );

	}

	getTzasUrl() {

		const BASE_URL = 'https://cdn.jsdelivr.net/npm/denoiser/tzas/';

		// Map quality setting to model size suffix
		const modelSize = {
		  'fast': '_small',
		  'balance': '',
		  'high': '_large'
		}[ this.quality ] || '';

		// Map HDR boolean to dynamic range string
		const dynamicRange = this.hdr ? '_hdr' : '_ldr';

		// Add auxiliary buffers suffix if needed
		const aux = this.useGBuffer ? '_alb_nrm' : '';

		return `${BASE_URL}rt${dynamicRange}${aux}${modelSize}.tza`;

	}

	_setupCanvas() {

		this.output.willReadFrequently = true;

		// Set dimensions
		this.output.width = this.input.width;
		this.output.height = this.input.height;

		// Style canvas
		Object.assign( this.output.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			background: "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px"
		} );

		// Create context with optimization flag
		this.ctx = this.output.getContext( '2d', { willReadFrequently: true } );

	}

	async start() {

		if ( ! this.enabled || this.isDenoising ) return false;

		this.dispatchEvent( { type: 'start' } );

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState();
			this.input.style.opacity = 0;
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
			this.input.style.opacity = 0;

			await this._executeUNet();

			return true;

		} catch ( error ) {

			console.error( 'Denoising error:', error );
			// Restore original rendering on error
			this.input.style.opacity = 1;
			return false;

		} finally {

			this.isDenoising = false;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	async _executeUNet() {

		const w = this.output.width;
		const h = this.output.height;

		// Draw the current renderer output to our canvas
		this.ctx.clearRect( 0, 0, w, h );
		this.ctx.drawImage( this.input, 0, 0, w, h );

		// Get the image data for denoising
		const imageData = this.ctx.getImageData( 0, 0, w, h );

		// Prepare additional data for G-Buffers if enabled
		const config = { color: imageData, tileSize: this.tileSize, denoiseAlpha: true };
		if ( this.useGBuffer ) {

			const { albedo, normal } = this.mapGenerator.generateMaps();
			config.albedo = albedo;
			config.normal = normal;

			if ( this.debugGbufferMaps ) {

				renderImageDataToCanvas( albedo, 'debugAlbedoCanvas' );
				renderImageDataToCanvas( normal, 'debugNormalCanvas' );

			}

		}

		// Execute the UNet denoiser in tiles
		return new Promise( ( resolve ) => {

			this.abortDenoise = this.unet.tileExecute( {
				...config,
				done: () => {

					this.abortDenoise = null;
					resolve();

				},
				progress: ( outputData, tileData, tile, currentIdx, totalIdx ) => {

					// console.log( '_', _ );
					// console.log( 'tileData', tileData );
					// console.log( 'Tile:', tile );
					this.ctx.putImageData( tileData, tile.x, tile.y );

				}
			} );

		} );

	}
	abort() {

		if ( ! this.enabled || ! this.isDenoising ) return;

		if ( this.abortDenoise ) {

			this.abortDenoise();
			this.abortDenoise = null;

		}

		this.input.style.opacity = 1;
		this.isDenoising = false;
		this.dispatchEvent( { type: 'end' } );

	}

	setSize( width, height ) {

		this.mapGenerator.setSize( width, height );
		this.output.width = width;
		this.output.height = height;

		const tzaUrl = this.getTzasUrl();
		if ( this.currentTZAUrl === tzaUrl ) return;
		this.currentTZAUrl = tzaUrl;
		this.unet.dispose();
		this._setupUNetDenoiser( tzaUrl );

	}

	dispose() {

		this.mapGenerator.dispose();
		this.unet.dispose();

		if ( this.abortDenoise ) {

			this.abortDenoise();
			this.abortDenoise = null;

		}

		this.output.remove();

	}

}
