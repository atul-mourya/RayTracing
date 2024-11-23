//https://github.com/DennisSmolek/Denoiser
import { Denoiser } from 'denoiser';
import { AlbedoNormalGenerator } from './AlbedoNormalGenerator';
import { EventDispatcher } from 'three';
import { DEFAULT_STATE } from '../Processor/Constants';


export class OIDNDenoiser extends EventDispatcher {

	constructor( renderer, scene, camera ) {

		super();
		this.sourceCanvas = renderer.domElement;
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.isDenoising = false;
		this.enabled = true;
		this.useGBuffers = DEFAULT_STATE.useGBuffers;
		this.useNormalMap = DEFAULT_STATE.useNormalMap;
		this.useAlbedoMap = DEFAULT_STATE.useAlbedoMap;

		this.denoiser = new Denoiser( "webgl" );
		this.denoiser.quality = DEFAULT_STATE.oidnQuality;
		this.denoiser.hdr = false;
		this.denoiser.height = this.sourceCanvas.height;
		this.denoiser.width = this.sourceCanvas.width;

		this.denoisedCanvas = document.createElement( 'canvas' );
		this.denoisedCanvas.width = this.sourceCanvas.width;
		this.denoisedCanvas.height = this.sourceCanvas.height;
		this.denoisedCanvas.style.position = 'absolute';
		this.denoisedCanvas.style.top = '0';
		this.denoisedCanvas.style.left = '0';
		this.denoisedCanvas.style.width = '100%';
		this.denoisedCanvas.style.height = '100%';
		this.denoisedCanvas.style.background = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px;";

		this.denoiser.setCanvas( this.denoisedCanvas );
		this.sourceCanvas.parentElement.prepend( this.denoisedCanvas );

		this.mapGenerator = new AlbedoNormalGenerator( this.scene, this.camera, this.renderer );

	}

	async execute() {

		if ( ! this.enabled ) return false;
		this.isDenoising = true;
		this.dispatchEvent( { type: 'start' } );

		console.log( 'Executing denoising...' );

		if ( this.useGBuffers ) {

			this.mapGenerator.generateAlbedoMap = this.useAlbedoMap;
			this.mapGenerator.generateNormalMap = this.useNormalMap;
			const { albedo, normal } = this.mapGenerator.generateMaps();
			// debugGeneratedMaps( albedo, normal );

			// Use albedoMap and normalMap in your denoiser
			this.useAlbedoMap && this.denoiser.setInputImage( 'albedo', albedo );
			this.useNormalMap && this.denoiser.setInputImage( 'normal', normal );

		}

		await this.denoiser.execute();
		this.isDenoising = false;
		this.dispatchEvent( { type: 'end' } );

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
		this.dispatchEvent( { type: 'end' } );

	}

	async start() {

		if ( ! this.enabled ) return false;
		if ( this.isDenoising ) return false;

		const startTime = performance.now();

		this.denoiser.setInputImage( 'color', this.sourceCanvas );

		await this.execute();
		if ( this.renderer ) this.renderer.resetState();
		this.sourceCanvas.style.opacity = 0;

		console.log( `Denoising took ${ performance.now() - startTime }ms` );

		return true; // Indicates that denoising is complete

	}

	setSize( width, height ) {

		width *= this.renderer.getPixelRatio();
		height *= this.renderer.getPixelRatio();
		this.denoiser.width = width;
		this.denoiser.height = height;
		this.mapGenerator.setSize( width, height );
		this.denoisedCanvas.width = width;
		this.denoisedCanvas.height = height;

	}

}
