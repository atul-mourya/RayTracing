import {
	Scene, PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping,
	TextureLoader, DirectionalLight, LinearSRGBColorSpace,
	EquirectangularReflectionMapping, Group
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';
import SpatialDenoiserPass from './shaders/Accumulator/SpatialDenoiserPass.js';
import TriangleSDF from './src/TriangleSDF.js';

//some samples at https://casual-effects.com/data/
// const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/diamond/diamond.glb';
const MODEL_URL = './models/diorama.glb';
const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/hdri/photo_studio_01_2k.hdr';
const ORIGINAL_PIXEL_RATIO = window.devicePixelRatio / 4;

// DOM Elements
const sampleCountsDiv = document.getElementById( 'sample-counts' );
const container = document.getElementById( 'container-3d' );

// Global Variables
let renderer, canvas, scene, dirLight, camera, controls;
let stats;
let composer, renderPass, pathTracingPass, accPass, denoiserPass;

// Initialization Functions
async function initScene() {

	scene = new Scene();
	window.scene = scene;

	const envType = ENV_URL.split( '.' ).pop();
	const loader = envType === 'png' || envType === 'jpg' ? new TextureLoader() : new RGBELoader();
	const envMap = await loader.loadAsync( ENV_URL );
	envMap.mapping = EquirectangularReflectionMapping;
	scene.background = envMap;
	scene.environment = envMap;

}

function initRenderer() {

	const params = {
		clearAlpha: 1,
		antialias: false,
		alpha: false,
		logarithmicDepthBuffer: false,
		powerPreference: "high-performance",
	};

	renderer = new WebGLRenderer( params );
	renderer.setClearColor( 0xffffff, params.clearAlpha );
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = Math.pow( 1.68, 4.0 );
	renderer.outputColorSpace = LinearSRGBColorSpace;
	renderer.setPixelRatio( ORIGINAL_PIXEL_RATIO );

	canvas = renderer.domElement;
	canvas.height = container.clientHeight;
	canvas.width = container.clientWidth;

	renderer.setSize( canvas.width, canvas.height );
	container.appendChild( canvas );

	window.renderer = renderer;
	stats = new Stats();
	document.body.appendChild( stats.dom );

	return renderer;

}

function setupScene() {

	camera = new PerspectiveCamera( 75, canvas.width / canvas.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );

	controls = new OrbitControls( camera, canvas );
	controls.addEventListener( 'change', reset );
	controls.addEventListener( 'start', onControlsStart );
	controls.addEventListener( 'end', onControlsEnd );
	controls.update();

	dirLight = new DirectionalLight( 0xffffff, 0 );
	dirLight.name = 'directionLight';
	dirLight.position.set( 1, 3, 0 );
	scene.add( dirLight );

}

function setupComposer( triangleSDF ) {

	composer = new EffectComposer( renderer );

	renderPass = new RenderPass( scene, camera );
	renderPass.enabled = false;
	composer.addPass( renderPass );

	pathTracingPass = new PathTracingShader( triangleSDF, canvas.width, canvas.height );
	pathTracingPass.enabled = true;
	composer.addPass( pathTracingPass );

	accPass = new AccumulationPass( scene, canvas.width, canvas.height );
	accPass.enabled = true;
	composer.addPass( accPass );

	denoiserPass = new SpatialDenoiserPass( canvas.width, canvas.width );
	denoiserPass.enabled = false;
	composer.addPass( denoiserPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

}

// Event Handlers
function onControlsStart() {

	console.log( 'moving' );
	renderPass.enabled = true;
	pathTracingPass.enabled = false;
	accPass.enabled = false;

}

function onControlsEnd() {

	console.log( 'stopped' );
	renderPass.enabled = false;
	pathTracingPass.enabled = true;
	accPass.enabled = true;

}

function onResize() {

	canvas.height = container.clientHeight;
	canvas.width = container.clientWidth;

	camera.aspect = canvas.width / canvas.height;
	camera.updateProjectionMatrix();
	renderer.setSize( canvas.width, canvas.height );
	composer.setSize( canvas.width, canvas.height );

	pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
	pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
	reset();

}

// Animation and Rendering
function animate() {

	requestAnimationFrame( animate );
	controls.update();

	if ( pathTracingPass.enabled ) {

		updatePathTracingUniforms();
		sampleCountsDiv.textContent = `Iterations: ${accPass.iteration}`;

	}

	composer.render();
	stats.update();

}

function updatePathTracingUniforms() {

	pathTracingPass.uniforms.directionalLightIntensity.value = dirLight.intensity;
	pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
	pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
	pathTracingPass.uniforms.frame.value ++;

}

function reset() {

	if ( accPass ) accPass.iteration = 0;

}

// Helper Functions
async function loadGLTFModel() {

	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	const result = await loader.loadAsync( MODEL_URL );
	return result.scene;

}

// GUI Setup
function setupGUI() {

	const parameters = {
		resolution: renderer.getPixelRatio(),
		toneMappingExposure: Math.pow( renderer.toneMappingExposure, 1 / 4 )
	};

	const pane = new Pane( { title: 'Parameters', expanded: true } );

	setupSceneFolder( pane, parameters );
	setupPathTracerFolder( pane, parameters );
	setupLightFolder( pane );
	setupDenoisingFolder( pane );
	setupDebugFolder( pane );

}

function setupSceneFolder( pane, parameters ) {

	const sceneFolder = pane.addFolder( { title: 'Scene' } ).on( 'change', reset );
	sceneFolder.addBinding( parameters, 'toneMappingExposure', { label: 'Exposure', min: 1, max: 4, step: 0.01 } ).on( 'change', e => renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
	sceneFolder.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Environment' } );

}

function setupPathTracerFolder( pane, parameters ) {

	const ptFolder = pane.addFolder( { title: 'Path Tracer' } ).on( 'change', reset );
	ptFolder.addBinding( pathTracingPass, 'enabled', { label: 'Enable' } );
	ptFolder.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	ptFolder.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( pathTracingPass.uniforms.useCheckeredRendering, 'value', { label: 'Use Checkered' } );
	ptFolder.addBinding( pathTracingPass.uniforms.checkeredFrameInterval, 'value', { label: 'Checkered Frame Interval', min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: { 'Quarter': window.devicePixelRatio / 4, 'Half': window.devicePixelRatio / 2, 'Full': window.devicePixelRatio } } ).on( 'change', e => updateResolution( e.value ) );

}

function setupLightFolder( pane ) {

	const lightFolder = pane.addFolder( { title: 'Directional Light' } ).on( 'change', reset );
	lightFolder.addBinding( dirLight, 'intensity', { label: 'Intensity', min: 0, max: 10 } ).on( 'change', updateLightIntensity );
	lightFolder.addBinding( dirLight, 'color', { label: 'Color', color: { type: 'float' } } ).on( 'change', updateLightColor );
	lightFolder.addBinding( dirLight, 'position', { label: 'Position' } ).on( 'change', updateLightPosition );

}

function setupDenoisingFolder( pane ) {

	const denoisingFolder = pane.addFolder( { title: 'Denoising' } );
	denoisingFolder.addBinding( denoiserPass, 'enabled', { label: 'Enable Denoiser' } );
	denoisingFolder.addBinding( denoiserPass.denoiseQuad.material.uniforms.kernelSize, 'value', { label: 'Strength', min: 1, max: 10, step: 1 } );

}

function setupDebugFolder( pane ) {

	const debugFolder = pane.addFolder( { title: 'Debugger' } );
	debugFolder.addBinding( pathTracingPass.uniforms.visMode, 'value', { label: 'Mode', options: { 'Beauty': 0, 'Triangle test count': 1, 'Box test count': 2, 'Distance': 3, 'Normal': 4 } } ).on( 'change', reset );
	debugFolder.addBinding( pathTracingPass.uniforms.debugVisScale, 'value', { label: 'Display Threshold', min: 1, max: 500, step: 1 } ).on( 'change', reset );

}

// GUI Helper Functions
function updateResolution( value ) {

	renderer.setPixelRatio( value );
	onResize();

}

function updateLightIntensity() {

	pathTracingPass.uniforms.directionalLightIntensity.value = dirLight.intensity;

}

function updateLightColor() {

	pathTracingPass.uniforms.directionalLightColor.value.copy( dirLight.color );

}

function updateLightPosition() {

	pathTracingPass.uniforms.directionalLightDirection.value.copy( dirLight.position ).normalize().negate();

}

// Main Initialization
async function init() {

	await initScene();
	initRenderer();
	setupScene();

	const meshes = await loadGLTFModel();
	scene.add( meshes );

	const triangleSDF = new TriangleSDF( scene );

	setupComposer( triangleSDF );
	setupGUI();

	window.addEventListener( 'resize', onResize );

	onResize();
	animate();

}

init();
