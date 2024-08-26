import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	ACESFilmicToneMapping,
	CubeTextureLoader,
	DirectionalLight,
	LinearSRGBColorSpace,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';

import TriangleSDF from './src/TriangleSDF.js';
import { OutputPass, RenderPass } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const sampleCountsDiv = document.getElementById( 'sample-counts' );
const container = document.getElementById( 'container-3d' );

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
	let originalPixelRatio = 0.5;

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

	const params = {
		clearAlpha: 1,
		antialias: false,
		alpha: false,
		logarithmicDepthBuffer: false,
		powerPreference: "high-performance",
	};

	const renderer = new WebGLRenderer( params );
	renderer.setClearColor( 0xffffff, params.clearAlpha );
	renderer.toneMapping = ACESFilmicToneMapping; // NoToneMapping
	renderer.toneMappingExposure = Math.pow( 1.68, 4.0 );
	renderer.outputColorSpace = LinearSRGBColorSpace;

	const canvas = renderer.domElement;
	canvas.height = container.clientHeight;
	canvas.width = container.clientWidth;

	renderer.setSize( canvas.width, canvas.height );
	container.appendChild( canvas );

	window.renderer = renderer;

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const camera = new PerspectiveCamera( 75, canvas.width / canvas.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );

	const controls = new OrbitControls( camera, canvas );
	// controls.target.set( 0, 1.5, 0 );
	controls.addEventListener( 'change', () => accPass && ( accPass.iteration = 0 ) );
	controls.addEventListener( 'start', () => {

		console.log( 'moving' );
		// renderPass.enabled = true;
		// pathTracingPass.enabled = false;
		// accPass.enabled = false;
		renderer.setPixelRatio( 0.25 );
		onResize();

	} );
	let timeout;
	controls.addEventListener( 'end', () => {

		console.log( 'stopped' );
		// renderPass.enabled = false;
		// pathTracingPass.enabled = true;
		// accPass.enabled = true;
		clearTimeout( timeout );
		timeout = setTimeout( () =>{

			renderer.setPixelRatio( originalPixelRatio );
			onResize();

		}, 1000 );


	} );
	controls.update();

	const dirLight = new DirectionalLight( 0xffffff, 0 );
	dirLight.name = 'directionLight';
	dirLight.position.set( 1, 3, 0 );
	scene.add( dirLight );

	const meshes = await loadGLTFModel();
	scene.add( meshes );

	const triangleSDF = new TriangleSDF( scene );

	const composer = new EffectComposer( renderer );
	const renderPass = new RenderPass( scene, camera );
	renderPass.enabled = false;
	composer.addPass( renderPass );

	const pathTracingPass = new PathTracingShader( triangleSDF, canvas.width, canvas.height );
	pathTracingPass.enabled = true;
	composer.addPass( pathTracingPass );

	accPass = new AccumulationPass( scene, canvas.width, canvas.height );
	accPass.enabled = true;
	composer.addPass( accPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

	const parameters = {
		enablePathTracer: true,
		resolution: 'half',
		resolutionOptions: { 'Quarter': 'quarter', 'Half': 'half', 'Full': 'full' },
		visualizeBVH: false,
		maxBVHDepth: 32,
		toneMappingExposure: Math.pow( renderer.toneMappingExposure, 1 / 4 )
	};

	const pane = new Pane( { title: 'Parameters', expanded: true } );
	const sceneFolder = pane.addFolder( { title: 'Scene' } );
	sceneFolder.addBinding( parameters, 'toneMappingExposure', { label: 'Exposue', min: 1, max: 4, step: 0.01 } ).on( 'change', e => renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
	sceneFolder.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Enviroment' } );

	const ptFolder = pane.addFolder( { title: 'Path Tracer' } );
	ptFolder.addBinding( parameters, 'enablePathTracer', { label: 'Enable' } );
	ptFolder.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	ptFolder.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: parameters.resolutionOptions } ).on( 'change', () => updateResolution() );

	const lightFolder = pane.addFolder( { title: 'Directional Light' } );
	lightFolder.addBinding( dirLight, 'intensity', { label: 'Intensity', min: 0, max: 10 } ).on( 'change', () => {

		pathTracingPass.uniforms.directionalLightIntensity.value = dirLight.intensity;

	} );
	lightFolder.addBinding( dirLight, 'color', { label: 'Color', color: { type: 'float' } } ).on( 'change', () => {

		pathTracingPass.uniforms.directionalLightColor.value.copy( dirLight.color );

	} );
	lightFolder.addBinding( dirLight, 'position', { label: 'Position' } ).on( 'change', () => {

		pathTracingPass.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();

	} );

	const debugFolder = pane.addFolder( { title: 'Debugger' } );
	debugFolder.addBinding( parameters, 'visualizeBVH', { label: 'Visualize BVH' } );
	debugFolder.addBinding( parameters, 'maxBVHDepth', { label: 'Max BVH Depth', min: 1, max: 32, step: 1 } );

	pane.on( 'change', () => accPass.iteration = 0 );

	function updateResolution() {

		switch ( parameters.resolution ) {

			case 'quarter': renderer.setPixelRatio( 0.25 ); break;
			case 'half': renderer.setPixelRatio( 0.5 ); break;
			case 'full':
			default: renderer.setPixelRatio( 1 ); break;

		}

		originalPixelRatio = renderer.getPixelRatio();
		onResize();

	}

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		if ( pathTracingPass.enabled ) {

			pathTracingPass.uniforms.directionalLightIntensity.value = dirLight.intensity;
			pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
			pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
			pathTracingPass.uniforms.visualizeBVH.value = parameters.visualizeBVH;
			pathTracingPass.uniforms.maxBVHDepth.value = parameters.maxBVHDepth;
			pathTracingPass.uniforms.frame.value ++;
			sampleCountsDiv.textContent = `Iterations: ${accPass.iteration}`;

		}

		composer.render();


		stats.update();


	}

	function onResize() {

		canvas.height = container.clientHeight;
		canvas.width = container.clientWidth;

		camera.aspect = canvas.width / canvas.height;
		camera.updateProjectionMatrix();
		renderer.setSize( canvas.width, canvas.height );
		composer.setSize( canvas.width, canvas.height );

		pathTracingPass.uniforms.resolution.value.set( canvas.width, canvas.height );
		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
		accPass.iteration = 0;

	}

	window.addEventListener( 'resize', onResize );

	renderer.setPixelRatio( originalPixelRatio );
	onResize();
	animate();

}

init();
