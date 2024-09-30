import { Denoiser } from 'denoiser';

class OIDNDenoiser {

	constructor( sourceCanvas ) {

		this.sourceCanvas = sourceCanvas;
		this.renderer = null;
		this.isDenoising = false;
		this.enabled = true;

		this.denoiser = new Denoiser( "webgl" );

		const denoisedCanvas = document.createElement( 'canvas' );
		denoisedCanvas.width = sourceCanvas.width;
		denoisedCanvas.height = sourceCanvas.height;
		denoisedCanvas.style.position = 'absolute';
		denoisedCanvas.style.top = '0';
		denoisedCanvas.style.left = '0';
		denoisedCanvas.style.width = '100%';
		denoisedCanvas.style.height = '100%';

		this.denoiser.setCanvas( denoisedCanvas );
		this.sourceCanvas.parentElement.prepend( denoisedCanvas );

	}

	async execute() {

		console.log( 'Executing denoising...' );
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

		if ( ! this.isDenoising ) return;
		this.denoiser.abort();
		this.sourceCanvas.style.opacity = 1;
		console.log( 'Denoising aborted' );

	}

	async start() {

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

	}

}

export { OIDNDenoiser };
