import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Color,
	ACESFilmicToneMapping,
	CubeTextureLoader,
	DirectionalLight
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';

import TriangleSDF from './src/TriangleSDF.js';
import { OutputPass } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// free models at https://casual-effects.com/data/

const sampleCountsDiv = document.getElementById( 'sample-counts' );

const viewPort = {
	width: 500,
	height: 500,
};

const white = new Color( 0xffffff );
const black = new Color( 0x000000 );
const red = new Color( 0xff0000 );
const green = new Color( 0x00ff00 );

// const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/3d-home-layout/scene.glb';
const MODEL_URL = './models/modernbathroom.glb';

async function loadGLTFModel() {

	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	const result = await loader.loadAsync( MODEL_URL );
	return result.scene;

}

function setupPane( pathTracingPass, accPass, parameters, renderer ) {

	const pane = new Pane( { title: 'Parameters', expanded: false } );
	pane.addBinding( renderer, 'toneMappingExposure', { label: 'Exposue', min: 1, max: 20, step: 0.5 } );
	pane.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'env light' } );
	pane.addBinding( pathTracingPass.uniforms.sunElevation, 'value', { label: 'sun elevation', min: - Math.PI / 2, max: Math.PI / 2 } );
	pane.addBinding( pathTracingPass.uniforms.sunAzimuth, 'value', { label: 'sun azimuth', min: 0, max: 2 * Math.PI } );
	pane.addBinding( pathTracingPass.uniforms.sunIntensity, 'value', { label: 'sun intensity', min: 0, max: 100 } );
	pane.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	pane.addBinding( parameters, 'switchToRasterizer', { label: 'Disable PathTracing' } );

	pane.on( 'change', () => accPass.iteration = 0 );

}

async function init() {

	const scene = new Scene();
	window.scene = scene;
	const cubeTextureLoader = new CubeTextureLoader();

	const path = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/cube/pisa/';
	const format = '.png';
	const envUrls = [
		path + 'px' + format, path + 'nx' + format,
		path + 'py' + format, path + 'ny' + format,
		path + 'pz' + format, path + 'nz' + format
	];
	scene.background = await cubeTextureLoader.loadAsync( envUrls );

	const camera = new PerspectiveCamera( 60, viewPort.width / viewPort.height, 0.01, 1000 );
	camera.position.set( 0, 1.5, 5 );

	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false
	} );
	renderer.setSize( viewPort.width, viewPort.height );
	renderer.setPixelRatio( 0.5 );
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 2;
	renderer.debug.checkShaderErrors = true;
	document.body.appendChild( renderer.domElement );

	window.renderer = renderer;

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => accPass.iteration = 0 );
	controls.update();

	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.position.set( 1, 3, 0 );
	scene.add( dirLight );

	const meshes = await loadGLTFModel();
	scene.add( meshes );

	// const cornellBox = createCornellBox();
	// cornellBox.forEach( mesh => scene.add( mesh ) );

	const triangleSDF = new TriangleSDF( scene );

	const composer = new EffectComposer( renderer );
	const pathTracingPass = new PathTracingShader( triangleSDF, viewPort.width * renderer.getPixelRatio(), viewPort.height * renderer.getPixelRatio() );
	composer.addPass( pathTracingPass );

	const accPass = new AccumulationPass( scene, viewPort.width * renderer.getPixelRatio(), viewPort.height * renderer.getPixelRatio() );
	accPass.enabled = true;
	composer.addPass( accPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

	const parameters = {
		switchToRasterizer: false,
	};

	setupPane( pathTracingPass, accPass, parameters, renderer );
	controls.target.set( 0, 2.5, 0 );

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );

		pathTracingPass.uniforms.frame.value ++;
		parameters.switchToRasterizer ? renderer.render( scene, camera ) : composer.render();
		stats.update();

		sampleCountsDiv.textContent = `Iterations: ${accPass.iteration}`;

	}

	animate();

	window.addEventListener( 'resize', () => {

		renderer.setSize( viewPort.width, viewPort.height );
		camera.updateProjectionMatrix();
		pathTracingPass.setSize( viewPort.width * renderer.getPixelRatio(), viewPort.height * renderer.getPixelRatio() );
		pathTracingPass.uniforms.resolution.value.set( viewPort.width, viewPort.height );
		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
		accPass.iteration = 0;

	} );

}

init();
