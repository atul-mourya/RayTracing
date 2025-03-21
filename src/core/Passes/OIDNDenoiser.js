//https://github.com/DennisSmolek/Denoiser
import { Denoiser } from 'denoiser';
import { AlbedoNormalGenerator, renderImageDataToCanvas } from './AlbedoNormalGenerator';
import { EventDispatcher } from 'three';

export class OIDNDenoiser extends EventDispatcher {

	constructor( renderer, scene, camera, options = {} ) {

		super();

		this._initializeProperties( renderer, scene, camera, options );
		this._setupDenoiser();
		this._setupCanvas();
		this._setupMapGenerator();
		this._preloadDenoiser();

	}

	_initializeProperties( renderer, scene, camera, options ) {

		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.sourceCanvas = renderer.domElement;

		// State
		this.isDenoising = false;
		this.enabled = options.enableOIDN ?? true;
		this.useGBuffers = options.useGBuffers ?? true;
		this.quality = options.quality ?? 'balanced';
		this.hdr = options.oidnHdr ?? false;
		this.debugGbufferMaps = options.debugGbufferMaps ?? false;
		this.weightUrl = options.weightUrl ?? "https://cdn.jsdelivr.net/npm/denoiser/tzas";
		this.isPreloaded = false;
		this.currentDenoisePromise = null;
		this.timeoutDuration = options.timeoutDuration ?? 10000; // 10 second timeout

	}

	_setupDenoiser() {

		this.denoiser = new Denoiser( "webgl" );
		Object.assign( this.denoiser, {
			inputMode: 'webgl',
			outputMode: 'webgl',
			quality: this.quality,
			hdr: this.hdr,
			height: this.sourceCanvas.height,
			width: this.sourceCanvas.width,
			weightUrl: this.weightUrl,
			useNormalMap: this.useGBuffers,
			useAlbedoMap: this.useGBuffers
		} );

	}

	async _preloadDenoiser() {

		// if ( ! this.enabled ) return;

		try {

			// According to the docs, weights are loaded automatically when needed
			this.isPreloaded = true;
			console.log( "Denoiser initialized and ready" );

			// Optional: Run a small warm-up denoising
			await this._warmUp();

		} catch ( error ) {

			console.warn( "Failed to initialize denoiser:", error );

		}

	}

	async _warmUp() {

		// Create a tiny canvas for warm-up (minimal overhead)
		const warmupCanvas = document.createElement( 'canvas' );
		warmupCanvas.width = 64;
		warmupCanvas.height = 64;
		const ctx = warmupCanvas.getContext( '2d' );
		ctx.fillStyle = 'gray';
		ctx.fillRect( 0, 0, 64, 64 );

		// Run a quick warm-up denoising pass
		const tempDenoiser = new Denoiser( "webgl" );
		tempDenoiser.quality = "low";
		tempDenoiser.width = 64;
		tempDenoiser.height = 64;
		tempDenoiser.useNormalMap = false;
		tempDenoiser.useAlbedoMap = false;
		tempDenoiser.weightUrl = this.weightUrl;

		try {

			// According to docs, we can pass the image directly to execute
			await tempDenoiser.execute( warmupCanvas );
			console.log( "Denoiser warm-up completed" );

		} catch ( e ) {

			console.warn( "Denoiser warm-up failed:", e );

		} finally {

			tempDenoiser.dispose?.();

		}

	}

	// setGbuffers( useGBuffers ) {

	// 	this.useGBuffers = useGBuffers;
	// 	this.denoiser.useNormalMap = useGBuffers;
	// 	this.denoiser.useAlbedoMap = useGBuffers;

	// }

	_setupCanvas() {

		this.denoisedCanvas = document.createElement( 'canvas' );
		Object.assign( this.denoisedCanvas, {
			width: this.sourceCanvas.width,
			height: this.sourceCanvas.height
		} );

		Object.assign( this.denoisedCanvas.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			background: "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px"
		} );

		this.denoiser.setCanvas( this.denoisedCanvas );
		this.sourceCanvas.parentElement.prepend( this.denoisedCanvas );

	}

	_setupMapGenerator() {

		this.mapGenerator = new AlbedoNormalGenerator(
			this.scene,
			this.camera,
			this.renderer
		);

	}

	async start() {

		if ( ! this.enabled || this.isDenoising ) return false;

		const startTime = performance.now();
		const success = await this.execute( { quality: this.quality, hdr: this.hdr } );

		if ( success ) {

			this.renderer?.resetState();
			this.sourceCanvas.style.opacity = 0;
			console.log( `Denoising completed in ${performance.now() - startTime}ms (quality: ${this.quality})` );

		}

		return success;

	}

	async execute( options = {} ) {

		if ( ! this.enabled ) return false;

		// Apply passed options or use defaults
		const quality = options.quality || this.quality;
		const hdr = options.hdr !== undefined ? options.hdr : this.hdr;
		const useTimeout = options.timeout !== undefined ? options.timeout : true;

		try {

			// Abort any ongoing denoising
			if ( this.isDenoising ) {

				this.abort();

			}

			this.isDenoising = true;
			this.dispatchEvent( { type: 'start' } );

			// Update denoiser settings for this execution
			this.denoiser.quality = quality;
			this.denoiser.hdr = hdr;
			this.denoiser.setInputImage( 'color', this.sourceCanvas );

			if ( this.useGBuffers ) {

				const { albedo, normal } = this.mapGenerator.generateMaps();

				this.denoiser.setInputImage( 'albedo', albedo );
				this.denoiser.setInputImage( 'normal', normal );

				if ( this.debugGbufferMaps ) {

					renderImageDataToCanvas( albedo, 'debugAlbedoCanvas' );
					renderImageDataToCanvas( normal, 'debugNormalCanvas' );

				}

			}

			// Set up a timeout for denoising
			let timeoutId;
			const timeoutPromise = useTimeout ? new Promise( ( _, reject ) => {

				timeoutId = setTimeout( () => reject( new Error( "Denoising timed out" ) ), this.timeoutDuration );

			} ) : Promise.resolve();

			// Execute with timeout protection - no need to pass parameters as we've set inputs
			this.currentDenoisePromise = Promise.race( [
				this.denoiser.execute(),
				timeoutPromise
			] );

			await this.currentDenoisePromise;

			// Clear timeout if denoising completed successfully
			if ( timeoutId ) clearTimeout( timeoutId );

			this.renderResult();

			return true;

		} catch ( error ) {

			console.error( 'Denoising error:', error );
			// Restore original rendering on error
			this.sourceCanvas.style.opacity = 1;
			return false;

		} finally {

			this.isDenoising = false;
			this.currentDenoisePromise = null;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	renderResult() {

		this.sourceCanvas.style.opacity = 0;

	}

	abort() {

		if ( ! this.enabled || ! this.isDenoising ) return;

		this.denoiser.abort();
		this.sourceCanvas.style.opacity = 1;
		this.isDenoising = false;
		this.currentDenoisePromise = null;
		this.dispatchEvent( { type: 'end' } );

	}

	setSize( width, height ) {

		const pixelRatio = this.renderer.getPixelRatio();
		const scaledWidth = width * pixelRatio;
		const scaledHeight = height * pixelRatio;

		this.denoiser.width = scaledWidth;
		this.denoiser.height = scaledHeight;
		this.mapGenerator.setSize( scaledWidth, scaledHeight );

		Object.assign( this.denoisedCanvas, {
			width: scaledWidth,
			height: scaledHeight
		} );

	}

	dispose() {

		this.mapGenerator.dispose();
		this.denoiser?.dispose?.();
		this.denoisedCanvas.remove();

	}

}
