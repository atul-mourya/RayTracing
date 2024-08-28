import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	ACESFilmicToneMapping,
	DirectionalLight,
	SRGBColorSpace,
	EquirectangularReflectionMapping,
	TextureLoader,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ConvolutionShader } from 'three/addons/shaders/ConvolutionShader.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';

import TriangleSDF from './src/TriangleSDF.js';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const sampleCountsDiv = document.getElementById( 'sample-counts' );
const container = document.getElementById( 'container-3d' );

// const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/diamond/diamond.glb';
const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/hdri/photo_studio_01_2k.hdr';
// const ENV_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular.png';

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
	renderer.toneMappingExposure = Math.pow( 1.26, 4.0 );
	renderer.outputColorSpace = SRGBColorSpace;

	const canvas = renderer.domElement;
	canvas.height = container.clientHeight;
	canvas.width = container.clientWidth;

	renderer.setSize( canvas.width, canvas.height );
	container.appendChild( canvas );

	window.renderer = renderer;

	const envType = ENV_URL.split( '.' ).pop();
	const loader = envType == 'png' || envType == 'jpg' ? new TextureLoader() : new RGBELoader();
	const envMap = await loader.loadAsync( ENV_URL );
	envMap.mapping = EquirectangularReflectionMapping;
	scene.background = envMap;
	scene.environment = envMap;

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const camera = new PerspectiveCamera( 75, canvas.width / canvas.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );
	window.camera = camera;

	const controls = new OrbitControls( camera, canvas );
	// controls.target.set( 0, 1.5, 0 );
	controls.addEventListener( 'change', reset );

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

	const convolutionPass = new ShaderPass( ConvolutionShader );
	convolutionPass.enabled = false;
	composer.addPass( convolutionPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

	const parameters = {
		resolution: originalPixelRatio,
		toneMappingExposure: Math.pow( renderer.toneMappingExposure, 1 / 4 ),
		denoisingStrength: 0.1,
		kernelSize: 4,
	};

	const pane = new Pane( { title: 'Parameters', expanded: true } );
	const sceneFolder = pane.addFolder( { title: 'Scene' } ).on( 'change', reset );
	sceneFolder.addBinding( parameters, 'toneMappingExposure', { label: 'Exposue', min: 0, max: 4, step: 0.01 } ).on( 'change', e => renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
	sceneFolder.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Enviroment' } );

	const cameraFolder = pane.addFolder( { title: 'Camera' } ).on( 'change', reset );
	cameraFolder.addBinding( camera, 'fov', { label: 'FOV', min: 30, max: 90, step: 5 } ).on( 'change', onResize );
	cameraFolder.addBinding( pathTracingPass.uniforms.focalDistance, 'value', { label: 'Focal Distance', min: 0, max: 100, step: 1 } );
	cameraFolder.addBinding( pathTracingPass.uniforms.aperture, 'value', { label: 'Aperture', min: 0, max: 1, step: 0.001 } );

	const ptFolder = pane.addFolder( { title: 'Path Tracer' } ).on( 'change', reset );
	ptFolder.addBinding( pathTracingPass, 'enabled', { label: 'Enable' } ).on( 'change', e => {

		accPass.enabled = e.value;
		renderPass.enabled = ! e.value;

	} );
	ptFolder.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	ptFolder.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: { 'Quarter': 0.25, 'Half': 0.5, 'Full': 1 } } ).on( 'change', e => updateResolution( e.value ) );

	const lightFolder = pane.addFolder( { title: 'Directional Light' } ).on( 'change', reset );
	lightFolder.addBinding( pathTracingPass.uniforms.directionalLightIntensity, 'value', { label: 'Intensity', min: 0, max: 10 } );
	lightFolder.addBinding( pathTracingPass.uniforms.directionalLightColor, 'value', { label: 'Color', color: { type: 'float' } } ).on( 'change', () => {

		pathTracingPass.uniforms.directionalLightColor.value.copy( dirLight.color );

	} );
	lightFolder.addBinding( dirLight, 'position', { label: 'Position' } ).on( 'change', () => {

		pathTracingPass.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();

	} );

	const debugFolder = pane.addFolder( { title: 'Debugger' } );
	debugFolder.addBinding( pathTracingPass.uniforms.visMode, 'value', { label: 'Mode', options: { 'Beauty': 0, 'Triangle test count': 1, 'Box test count': 2, 'Distance': 3, 'Normal': 4 } } ).on( 'change', reset );
	debugFolder.addBinding( pathTracingPass.uniforms.debugVisScale, 'value', { label: 'Display Threshold', min: 1, max: 500, step: 1 } ).on( 'change', reset );

	const denoisingFolder = pane.addFolder( { title: 'Denoising' } );
	denoisingFolder.addBinding( convolutionPass, 'enabled', { label: 'Enable Denoising' } ).on( 'change', updateDenoisingUniforms );
	denoisingFolder.addBinding( parameters, 'denoisingStrength', { label: 'Denoising Strength', min: 0, max: 1, step: 0.01 } ).on( 'change', updateDenoisingUniforms );
	denoisingFolder.addBinding( parameters, 'kernelSize', { label: 'Kernel Size', options: { '2x2': 2, '4x4': 4, '7x7': 7, '13x13': 13 } } ).on( 'change', updateDenoisingUniforms );

	function updateDenoisingUniforms() {

	  convolutionPass.uniforms.uImageIncrement.value.set(
			parameters.denoisingStrength / canvas.width,
			parameters.denoisingStrength / canvas.height
	  );
	  convolutionPass.uniforms.cKernel.value = ConvolutionShader.buildKernel( parameters.kernelSize );

	}

	function reset() {

		if ( accPass ) accPass.iteration = 0;

	}

	function updateResolution( value ) {

		renderer.setPixelRatio( value );
		originalPixelRatio = value;
		onResize();

	}

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		if ( pathTracingPass.enabled ) {

			pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
			pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
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
