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
//https://casual-effects.com/data/
const MODEL_URL = './models/modernbathroom.glb';

async function loadGLTFModel() {

	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	const result = await loader.loadAsync( MODEL_URL );
	return result.scene;

}

async function init() {

	let accPass;

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
	scene.environment = scene.background;

	const camera = new PerspectiveCamera( 75, viewPort.width / viewPort.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );

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
	// controls.target.set( 0, 1.5, 0 );
	controls.addEventListener( 'change', () => accPass && ( accPass.iteration = 0 ) );
	controls.update();

	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.position.set( 1, 3, 0 );
	scene.add( dirLight );

	const meshes = await loadGLTFModel();
	scene.add( meshes );

	const triangleSDF = new TriangleSDF( scene );

	const composer = new EffectComposer( renderer );
	const pathTracingPass = new PathTracingShader( triangleSDF, viewPort.width * renderer.getPixelRatio(), viewPort.height * renderer.getPixelRatio() );
	composer.addPass( pathTracingPass );

	accPass = new AccumulationPass( scene, viewPort.width * renderer.getPixelRatio(), viewPort.height * renderer.getPixelRatio() );
	accPass.enabled = true;
	composer.addPass( accPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

	const parameters = {
		switchToRasterizer: false,
		resolution: 'half',
		resolutionOptions: { 'Quarter': 'quarter', 'Half': 'half', 'Full': 'full' },
		visualizeBVH: false,
		maxBVHDepth: 32
	};

	const pane = new Pane( { title: 'Parameters', expanded: false } );
	pane.addBinding( renderer, 'toneMappingExposure', { label: 'Exposue', min: 1, max: 20, step: 0.5 } );
	pane.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'env light' } );
	pane.addBinding( scene, 'environmentIntensity', { label: 'env intensity', min: 0, max: 10 } );

	pane.addBinding( dirLight, 'position', { label: 'light position' } );
	pane.addBinding( dirLight, 'color', { label: 'light color', color: { type: 'float' } } );
	pane.addBinding( dirLight, 'intensity', { label: 'light intensity', min: 0, max: 10 } );

	pane.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	pane.addBinding( parameters, 'switchToRasterizer', { label: 'Disable PathTracing' } );
	pane.addBinding( parameters, 'resolution', { label: 'Resolution', options: parameters.resolutionOptions } ).on( 'change', () => updateResolution() );

	pane.addBinding( parameters, 'visualizeBVH', { label: 'Visualize BVH' } );
	pane.addBinding( parameters, 'maxBVHDepth', { label: 'Max BVH Depth', min: 1, max: 32, step: 1 } );

	pane.on( 'change', () => accPass.iteration = 0 );

	function updateResolution() {

		let pixelRatio;
		switch ( parameters.resolution ) {

			case 'quarter':
				pixelRatio = 0.25;
				break;
			case 'half':
				pixelRatio = 0.5;
				break;
			case 'full':
			default:
				pixelRatio = 1;
				break;

		}

		renderer.setPixelRatio( pixelRatio );
		const newWidth = Math.floor( viewPort.width * pixelRatio );
		const newHeight = Math.floor( viewPort.height * pixelRatio );

		pathTracingPass.setSize( newWidth, newHeight );
		pathTracingPass.uniforms.resolution.value.set( newWidth, newHeight );
		accPass.setSize( newWidth, newHeight );
		composer.setSize( newWidth, newHeight );

	}

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
		pathTracingPass.uniforms.visualizeBVH.value = parameters.visualizeBVH;
		pathTracingPass.uniforms.maxBVHDepth.value = parameters.maxBVHDepth;
		pathTracingPass.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();
		pathTracingPass.uniforms.directionalLightColor.value.copy( dirLight.color );
		pathTracingPass.uniforms.directionalLightIntensity.value = dirLight.intensity;
		pathTracingPass.uniforms.frame.value ++;
		parameters.switchToRasterizer ? renderer.render( scene, camera ) : composer.render();
		stats.update();

		sampleCountsDiv.textContent = `Iterations: ${accPass.iteration}`;

	}

	animate();

	window.addEventListener( 'resize', () => {

		renderer.setSize( viewPort.width, viewPort.height );
		camera.updateProjectionMatrix();
		updateResolution();
		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
		accPass.iteration = 0;

	} );

}

init();
