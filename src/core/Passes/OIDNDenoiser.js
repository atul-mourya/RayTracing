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
		this.quality = options.quality ?? 'medium';
		this.hdr = options.oidnHdr ?? false;
		this.debugGbufferMaps = options.debugGbufferMaps ?? false;

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
			weightsUrl: "https://cdn.jsdelivr.net/npm/denoiser/tzas",
			useNormalMap: this.useGBuffers,
			useAlbedoMap: this.useGBuffers
		} );

	}

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
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState();
			this.sourceCanvas.style.opacity = 0;
			console.log( `Denoising completed in ${performance.now() - startTime}ms` );

		}

		return success;

	}

	async execute() {

		if ( ! this.enabled ) return false;

		try {

			this.isDenoising = true;
			this.dispatchEvent( { type: 'start' } );
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

			await this.denoiser.execute();
			this.renderResult();

			return true;

		} catch ( error ) {

			console.error( 'Denoising error:', error );
			return false;

		} finally {

			this.isDenoising = false;
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
