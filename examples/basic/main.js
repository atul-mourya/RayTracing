import { PathTracerApp, EngineEvents } from 'rayzee';

const canvas = document.getElementById( 'viewport' );
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const engine = new PathTracerApp( canvas );
await engine.init();
await engine.loadModel( 'https://assets.rayzee.atulmourya.com/models/CornellBox1.glb' );
await engine.loadEnvironment( 'https://assets.rayzee.atulmourya.com/hdri/Polyhaven/raw/adams_place_bridge_1k.hdr' );
engine.animate();

engine.set( 'bounces', 8 );
engine.set( 'exposure', 1.0 );

// Enable OIDN denoiser — runs automatically when render converges
// Requires: npm install oidn-web
engine.denoising.setOIDNEnabled( true );
engine.denoising.setOIDNQuality( 'balance' ); // 'fast' | 'balance' | 'high'

engine.addEventListener( EngineEvents.DENOISING_START, () => {

	console.log( 'Denoising started' );

} );
engine.addEventListener( EngineEvents.DENOISING_END, () => {

	console.log( 'Denoising complete' );

} );

window.addEventListener( 'resize', () => {

	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;
	engine.output.resize();

} );
