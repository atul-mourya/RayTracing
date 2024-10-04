//https://github.com/DennisSmolek/Denoiser
import { Denoiser } from 'denoiser';
import { generateAlbedoAndNormalMaps, debugGeneratedMaps } from './AlbedoNormalGenerator';


class OIDNDenoiser {

	constructor( renderer, scene, camera ) {

		this.sourceCanvas = renderer.domElement;
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.isDenoising = false;
		this.enabled = false;

		this.denoiser = new Denoiser( "webgl" );
		this.denoiser.quality = 'fast';
		this.denoiser.hdr = false;

		this.denoisedCanvas = document.createElement( 'canvas' );
		this.denoisedCanvas.width = this.sourceCanvas.width;
		this.denoisedCanvas.height = this.sourceCanvas.height;
		this.denoisedCanvas.style.position = 'absolute';
		this.denoisedCanvas.style.top = '0';
		this.denoisedCanvas.style.left = '0';
		this.denoisedCanvas.style.width = '100%';
		this.denoisedCanvas.style.height = '100%';

		this.denoiser.setCanvas( this.denoisedCanvas );
		this.sourceCanvas.parentElement.prepend( this.denoisedCanvas );

	}

	async execute() {

		if ( ! this.enabled ) return false;
		console.log( 'Executing denoising...' );

		const { albedo, normal } = generateAlbedoAndNormalMaps( this.scene, this.camera, this.renderer );
		// debugGeneratedMaps( albedo, normal );

		// Use albedoMap and normalMap in your denoiser
		this.denoiser.setImage( 'albedo', albedo );
		this.denoiser.setImage( 'normal', normal );

		this.isDenoising = true;
		await this.denoiser.execute();
		this.isDenoising = false;

		this.renderResult();

	}

	renderResult() {

		// Render the denoised result to the canvas
		// @TODO: Implement this showing the denoised result on the canvas
		console.log( 'Rendering denoised result' );
		this.sourceCanvas.style.opacity = 0;

	}

	abort() {

		if ( ! this.enabled ) return false;
		if ( ! this.isDenoising ) return;
		this.denoiser.abort();
		this.sourceCanvas.style.opacity = 1;
		console.log( 'Denoising aborted' );

	}

	async start() {

		if ( ! this.enabled ) return false;
		if ( this.isDenoising ) return false;

		const startTime = performance.now();

		this.denoiser.setImage( 'color', this.sourceCanvas );

		await this.execute();
		if ( this.renderer ) this.renderer.resetState();
		this.sourceCanvas.style.opacity = 0;

		console.log( `Denoising took ${ performance.now() - startTime }ms` );

		return true; // Indicates that denoising is complete

	}

	setSize( width, height ) {

		this.denoiser.width = width;
		this.denoiser.height = height;
		this.denoisedCanvas.width = width;
		this.denoisedCanvas.height = height;

	}

}

export { OIDNDenoiser };
