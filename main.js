import {
	Scene, PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping, Vector2,
	FloatType, DirectionalLight, SRGBColorSpace, Mesh, PlaneGeometry, MeshStandardMaterial,
	EquirectangularReflectionMapping, Sphere, Box3, Vector3, RGBAFormat, NearestFilter, WebGLRenderTarget
} from 'three';
import { HDR_FILES, MODEL_FILES, ENV_BASE_URL, MODEL_BASE_URL, ORIGINAL_PIXEL_RATIO } from './src/Constants.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { disposeObjectFromMemory } from './src/utils.js';
import PathTracerPass from './shaders/PathTracer/PathTracerPass.js';
import AccumulationPass from './shaders/Passes/AccumulationPass.js';
import LygiaSmartDenoiserPass from './shaders/Passes/LygiaSmartDenoiserPass.js';
import TileHighlightPass from './shaders/Passes/TileHighlightPass.js';
import UpScalerPass from './shaders/Passes/UpscalerPass.js';
// import SpatialDenoiserPass from './shaders/Accumulator/SpatialDenoiserPass.js';
// import generateMaterialSpheres from './src/generateMaterialSpheres.js';

// DOM Elements
const container = document.getElementById( 'container-3d' );
const tweakpaneContainer = document.getElementById( 'tweakpane-container' );
const loadingOverlay = document.getElementById( 'loading-overlay' );

// Global Variables
let renderer, canvas, scene, dirLight, camera, controls;
let pane, fpsGraph;
let composer, renderPass, pathTracingPass, accPass, denoiserPass, tileHighlightPass, upScalerPass;
let targetModel, floorPlane;

let currentHDRIndex = 2;
let currentModelIndex = 27;
let pauseRendering = false;
let stopRendering = false;
let UPSCALE_FACTOR = 2;

async function loadHDRBackground( index ) {

	toggleLoadingIndicator( true );

	const loader = new RGBELoader();
	loader.setDataType( FloatType );

	const texture = await loader.loadAsync( `${ENV_BASE_URL}${HDR_FILES[ index ].url}` );
	texture.mapping = EquirectangularReflectionMapping;

	scene.background = texture;
	scene.environment = texture;

	if ( pathTracingPass ) {

		pathTracingPass.material.uniforms.environmentIntensity.value = scene.environmentIntensity;
		pathTracingPass.material.uniforms.environment.value = texture;
		reset();

	}

	toggleLoadingIndicator( false );

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
	renderer.toneMappingExposure = Math.pow( 1.18, 4.0 );
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.setPixelRatio( ORIGINAL_PIXEL_RATIO );

	canvas = renderer.domElement;
	canvas.height = container.clientHeight;
	canvas.width = container.clientWidth;

	renderer.setSize( canvas.width, canvas.height );
	container.appendChild( canvas );

	window.renderer = renderer;

	return renderer;

}

function setupScene() {

	scene = new Scene();
	window.scene = scene;

	camera = new PerspectiveCamera( 75, canvas.width / canvas.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );

	controls = new OrbitControls( camera, canvas );
	controls.addEventListener( 'change', reset );
	controls.update();

	dirLight = new DirectionalLight( 0xffffff, 0 );
	dirLight.name = 'directionLight';
	dirLight.position.set( 0.3, 1, 3 );
	dirLight.intensity = 0;
	scene.add( dirLight );

}

function setupComposer() {

	const renderTarget = new WebGLRenderTarget( canvas.width, canvas.height, {
		format: RGBAFormat,
		type: FloatType,
		minFilter: NearestFilter,
		magFilter: NearestFilter
	} );

	composer = new EffectComposer( renderer, renderTarget );
	window.composer = composer;

	renderPass = new RenderPass( scene, camera );
	renderPass.enabled = false;
	composer.addPass( renderPass );

	pathTracingPass = new PathTracerPass( renderer, scene, camera, canvas.width, canvas.height );
	pathTracingPass.enabled = true;
	composer.addPass( pathTracingPass );

	upScalerPass = new UpScalerPass( canvas.width, canvas.height, UPSCALE_FACTOR );
	upScalerPass.enabled = false;
	composer.addPass( upScalerPass );

	accPass = new AccumulationPass( scene, canvas.width, canvas.height );
	accPass.enabled = true;
	composer.addPass( accPass );

	pathTracingPass.setAccumulationPass( accPass );

	denoiserPass = new LygiaSmartDenoiserPass( canvas.width, canvas.height );
	// denoiserPass = new SpatialDenoiserPass( canvas.width, canvas.width );
	denoiserPass.enabled = false;
	composer.addPass( denoiserPass );

	tileHighlightPass = new TileHighlightPass( new Vector2( canvas.width, canvas.height ) );
	tileHighlightPass.enabled = false;
	composer.addPass( tileHighlightPass );


	const outputPass = new OutputPass();
	composer.addPass( outputPass );

}

function handleLayoutChange() {

	const isMobile = window.innerWidth <= 768;
	tweakpaneContainer.style.position = isMobile ? 'absolute' : 'relative';
	pane.expanded = isMobile ? false : true;

}

function onResize() {

	handleLayoutChange();

	const width = container.clientWidth;
	const height = container.clientHeight;

	camera.aspect = width / height;
	camera.updateProjectionMatrix();
	renderer.setSize( width, height );
	composer.setSize( width, height );

	reset();

}

// Animation and Rendering
function animate() {

	requestAnimationFrame( animate );
	if ( stopRendering ) return;
	if ( pauseRendering ) return;
	fpsGraph.begin();
	controls.update();
	// Update the TileHighlightPass uniforms
	tileHighlightPass.uniforms.frame.value = pathTracingPass.material.uniforms.frame.value + 1;
	tileHighlightPass.uniforms.renderMode.value = pathTracingPass.material.uniforms.renderMode.value;
	tileHighlightPass.uniforms.tiles.value = pathTracingPass.material.uniforms.tiles.value;

	composer.render();
	fpsGraph.end();

}

function reset() {

	pathTracingPass.reset();
	accPass.reset( renderer );

}

// GUI Setup
function setupGUI() {

	const parameters = {
		stopRendering: stopRendering,
		model: currentModelIndex,
		hdrBackground: currentHDRIndex,
		resolution: renderer.getPixelRatio(),
		toneMappingExposure: Math.pow( renderer.toneMappingExposure, 1 / 4 )
	};

	pane = new Pane( { title: 'Settings', expanded: window.innerWidth <= 768 ? false : true, container: tweakpaneContainer } );
	pane.registerPlugin( EssentialsPlugin );

	setupStatsFolder( pane, parameters );
	setupSceneFolder( pane, parameters );
	setupCameraFolder( pane );
	setupPathTracerFolder( pane, parameters );
	setupLightFolder( pane );
	setupDenoisingFolder( pane );
	setupDebugFolder( pane );

}


function setupStatsFolder( pane ) {

	const folder = pane.addFolder( { title: 'Stats' } );
	folder.addBinding( accPass, 'timeElapsed', { label: 'Time Elapsed (s)', readonly: true } );
	folder.addBinding( accPass, 'iteration', { label: 'Samples', readonly: true } );
	fpsGraph = folder.addBlade( { view: 'fpsgraph', label: 'fps', rows: 2, } );

}

function setupSceneFolder( pane, parameters ) {

	const param = { useBackground: scene.background ? true : false };
	const sceneFolder = pane.addFolder( { title: 'Scene' } ).on( 'change', reset );
	sceneFolder.addBinding( renderer, 'toneMappingExposure', { label: 'Exposure', min: 0, max: 2, step: 0.01 } );//.on( 'change', e => pathTracingPass.material.uniforms.envMapIntensity.value = renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
	sceneFolder.addBinding( pathTracingPass.material.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Environment' } );
	sceneFolder.addBinding( param, 'useBackground', { label: 'Show Background' } ).on( 'change', e => {

		scene.background = e.value ? scene.environment : null;
		pathTracingPass.material.uniforms.useBackground.value = e.value;

	} );
	sceneFolder.addBinding( parameters, 'model', { label: 'Model',
		options: Object.fromEntries( MODEL_FILES.map( ( file, index ) => [ file.name, index ] ) ) } ).on( 'change', e => switchModel( e.value ) );

	sceneFolder.addBinding( parameters, 'hdrBackground', { label: 'HDR Environment',
		options: Object.fromEntries( HDR_FILES.map( ( file, index ) => [ file.name, index ] ) ) } ).on( 'change', e => switchHDRBackground( e.value ) );
	sceneFolder.addBinding( scene, 'environmentIntensity', { label: 'Enviroment Intensity', min: 0, max: 2, step: 0.01 } ).on( 'change', e => pathTracingPass.material.uniforms.environmentIntensity.value = e.value );

}

function setupCameraFolder( pane ) {

	const folder = pane.addFolder( { title: 'Camera' } ).on( 'change', reset );
	folder.addBinding( camera, 'fov', { label: 'FOV', min: 30, max: 90, step: 5 } ).on( 'change', onResize );
	folder.addBinding( pathTracingPass.material.uniforms.focalDistance, 'value', { label: 'Focal Distance', min: 0, max: 100, step: 1 } );
	folder.addBinding( pathTracingPass.material.uniforms.aperture, 'value', { label: 'Aperture', min: 0, max: 1, step: 0.001 } );

}

function setupPathTracerFolder( pane, parameters ) {

	const ptFolder = pane.addFolder( { title: 'Path Tracer' } ).on( 'change', reset );
	ptFolder.addBinding( pathTracingPass, 'enabled', { label: 'Enable' } ).on( 'change', e => {

		accPass.enabled = e.value;
		renderPass.enabled = ! e.value;

	} );
	ptFolder.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	ptFolder.addBinding( parameters, 'stopRendering', { label: 'Stop Rendering' } ).on( 'change', e => stopRendering = e.value );
	ptFolder.addBinding( pathTracingPass.material.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 0, max: 20, step: 1 } );

	// Fixed samples per pixel control
	const samplesPerPixelControl = ptFolder.addBinding( pathTracingPass.material.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );

	ptFolder.addBinding( pathTracingPass.material.uniforms.samplingTechnique, 'value', { label: 'Noise Sampler', options: { PCG: 0, Halton: 1, Sobol: 2, SBTN: 3, Stratified: 4, BlueNoise: 5 } } );

	// Add adaptive sampling toggle
	const useAdaptiveSamplingControl = ptFolder.addBinding( pathTracingPass.material.uniforms.useAdaptiveSampling, 'value', { label: 'Use Adaptive Sampling' } );

	// Adaptive sampling controls
	const minSamplesControl = ptFolder.addBinding( pathTracingPass.material.uniforms.minSamples, 'value', { label: 'Min Samples', min: 0, max: 4, step: 1 } );
	const maxSamplesControl = ptFolder.addBinding( pathTracingPass.material.uniforms.maxSamples, 'value', { label: 'Max Samples', min: 4, max: 16, step: 2 } );
	const varianceThresholdControl = ptFolder.addBinding( pathTracingPass.material.uniforms.varianceThreshold, 'value', { label: 'Variance Threshold', min: 0.0001, max: 0.01, step: 0.0001 } );

	// Function to toggle visibility of controls
	function toggleSamplingControls( useAdaptive ) {

		samplesPerPixelControl.hidden = useAdaptive;
		minSamplesControl.hidden = ! useAdaptive;
		maxSamplesControl.hidden = ! useAdaptive;
		varianceThresholdControl.hidden = ! useAdaptive;

	}

	// Initial setup
	toggleSamplingControls( pathTracingPass.material.uniforms.useAdaptiveSampling.value );

	// Listen for changes on the adaptive sampling toggle
	useAdaptiveSamplingControl.on( 'change', e => toggleSamplingControls( e.value ) );

	const renderModeControl = ptFolder.addBinding( pathTracingPass.material.uniforms.renderMode, 'value', { label: 'Render Mode', options: { "Regular": 0, "Checkered": 1, "Tiled": 2 } } );
	const tilesControl = ptFolder.addBinding( pathTracingPass.material.uniforms.tiles, 'value', { label: 'No. of Tiles', hidden: true, min: 1, max: 20, step: 1 } );
	const tileHighlightControl = ptFolder.addBinding( tileHighlightPass, 'enabled', { label: 'Show Tile Highlight', hidden: true, } );

	renderModeControl.on( 'change', e => {

		tilesControl.hidden = e.value !== 2;
		tileHighlightControl.hidden = e.value !== 2;
		tileHighlightPass.enabled = e.value === 2 && tileHighlightPass.enabled;

	} );
	let param = { upscaleFactor: UPSCALE_FACTOR };
	const checkeredIntervalControl = ptFolder.addBinding( pathTracingPass.material.uniforms.checkeredFrameInterval, 'value', { label: 'Checkered Frame Interval', hidden: true, min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: { 'Quarter': window.devicePixelRatio / 4, 'Half': window.devicePixelRatio / 2, 'Full': window.devicePixelRatio } } ).on( 'change', e => updateResolution( e.value ) );
	ptFolder.addBinding( param, 'upscaleFactor', { label: 'Up Scale', options: { '1x': 1, '2x': 2, '4x': 4 } } ).on( 'change', e => {

		UPSCALE_FACTOR = e.value;
		onResize();

	} );

	renderModeControl.on( 'change', e => {

		tilesControl.hidden = e.value !== 2; // Show only when Tiled (2) is selected
		checkeredIntervalControl.hidden = e.value !== 1; // Show only when Checkered (1) is selected

	} );

	ptFolder.addBinding( pathTracingPass, 'useDownSampledInteractions', { label: 'Use Interactive Features'} ).on( 'change', ( ev ) => {

		if ( ! ev.value ) {

			// Reset interaction state when disabling interactive features
			pathTracingPass.isInteracting = false;
			pathTracingPass.isTransitioning = false;
			pathTracingPass.transitionClock.stop();
			if ( pathTracingPass.interactionTimeout ) {

				clearTimeout( pathTracingPass.interactionTimeout );

			}

		}

		reset();

	} );

	// Only show these controls when interactive features are enabled
	const interactiveFolder = ptFolder.addFolder( { title: 'Interactive Settings', expanded: true, hidden: ! pathTracingPass.useDownSampledInteractions } );

	interactiveFolder.addBinding( pathTracingPass, 'downsampleFactor', { label: 'Downsample Factor', min: 1, max: 4, step: 1 } ).on( 'change', ( ev ) => {

		pathTracingPass.setSize( canvas.width, canvas.height );
		reset();

	} );

	interactiveFolder.addBinding( pathTracingPass, 'interactionDelay', { label: 'Interaction Delay (s)', min: 0.1, max: 2.0, step: 0.1 } );
	interactiveFolder.addBinding( pathTracingPass, 'transitionDuration', { label: 'Transition Duration (s)', min: 0.1, max: 2.0, step: 0.1 } );
	ptFolder.children.find( child => child.label === 'Use Interactive Features' ).on( 'change', ( ev ) => interactiveFolder.hidden = ! ev.value );

}

function setupLightFolder( pane ) {

	const lightFolder = pane.addFolder( { title: 'Directional Light' } ).on( 'change', () => {

		pathTracingPass.updateLight( dirLight );
		reset();

	} );
	lightFolder.addBinding( dirLight, 'intensity', { label: 'Intensity', min: 0, max: 2 } );
	lightFolder.addBinding( dirLight, 'color', { label: 'Color', color: { type: 'float' } } );
	lightFolder.addBinding( dirLight, 'position', { label: 'Position' } );

}

function setupDenoisingFolder( pane ) {

	const denoisingFolder = pane.addFolder( { title: 'Denoising' } );
	denoisingFolder.addBinding( denoiserPass, 'enabled', { label: 'Enable Denoiser' } );
	// --- SmartDenoiser ---
	denoisingFolder.addBinding( denoiserPass.denoiseQuad.material.uniforms.sigma, 'value', { label: 'Blur Strength', min: 0.5, max: 5, step: 0.1 } );
	denoisingFolder.addBinding( denoiserPass.denoiseQuad.material.uniforms.kSigma, 'value', { label: 'Blur Radius', min: 1, max: 3, step: 0.1 } );
	denoisingFolder.addBinding( denoiserPass.denoiseQuad.material.uniforms.threshold, 'value', { label: 'Detail Preservation', min: 0.01, max: 0.1, step: 0.01 } );
	// --- ConvolutionDenoiser ---
	// denoisingFolder.addBinding( denoiserPass.denoiseQuad.material.uniforms.kernelSize, 'value', { label: 'Strength', min: 1, max: 10, step: 1 } );

}

function setupDebugFolder( pane ) {

	const debugFolder = pane.addFolder( { title: 'Debugger' } );
	debugFolder.addBinding( pathTracingPass.material.uniforms.visMode, 'value', { label: 'Mode', options: { 'Beauty': 0, 'Triangle test count': 1, 'Box test count': 2, 'Distance': 3, 'Normal': 4, 'Sampling': 5 } } ).on( 'change', reset );
	debugFolder.addBinding( pathTracingPass.material.uniforms.debugVisScale, 'value', { label: 'Display Threshold', min: 1, max: 500, step: 1 } ).on( 'change', reset );

}

function switchHDRBackground( index ) {

	if ( index !== currentHDRIndex ) {

		currentHDRIndex = index;
		loadHDRBackground( currentHDRIndex );

	}

}

async function switchModel( index ) {

	if ( index !== currentModelIndex ) {

		currentModelIndex = index;
		const modelUrl = `${MODEL_BASE_URL}${MODEL_FILES[ currentModelIndex ].url}`;

		toggleLoadingIndicator( true );

		try {

			const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
			const result = await loader.loadAsync( modelUrl );
			disposeObjectFromMemory( targetModel );
			onModelLoad( result.scene );

		} catch ( error ) {

			alert( 'Error loading GLB:', error );

		} finally {

			toggleLoadingIndicator( false );

		}


	}

}

// GUI Helper Functions
function updateResolution( value ) {

	renderer.setPixelRatio( value );
	composer.setPixelRatio( value );
	onResize();

}

function setupDragAndDrop() {

	const dropZone = document.body;
	dropZone.addEventListener( 'drop', ( event ) => {

		event.preventDefault();
		event.stopPropagation();

		dropZone.classList.remove( 'drag-over' );

		const file = event.dataTransfer.files[ 0 ];
		if ( file && file.name.toLowerCase().endsWith( '.glb' ) ) {

			toggleLoadingIndicator( true );

			const reader = new FileReader();
			reader.onload = ( event ) => loadGLBFromArrayBuffer( event.target.result );
			reader.readAsArrayBuffer( file );

		} else {

			toggleLoadingIndicator( false );
			alert( 'Please drop a GLB file.' );

		}

	} );

}

function loadGLBFromArrayBuffer( arrayBuffer ) {

	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	loader.parse( arrayBuffer, '', g => {

		disposeObjectFromMemory( targetModel );
		onModelLoad( g.scene );

	}, undefined, ( error ) => {

		alert( 'Error loading GLB:', error );
		toggleLoadingIndicator( false );

	} );

}

function onModelLoad( model ) {

	// Add new model
	targetModel = model;
	scene.add( targetModel );

	let box = new Box3().setFromObject( targetModel );
	let sphere = box.getBoundingSphere( new Sphere() );
	floorPlane.scale.setScalar( sphere.radius * 3 );
	floorPlane.rotation.x = - Math.PI / 2;
	floorPlane.position.y = box.min.y;

	centerModelAndAdjustCamera( targetModel );

	pathTracingPass.build( scene );

	reset();
	toggleLoadingIndicator( false );

}

function centerModelAndAdjustCamera( model ) {

	// Compute the bounding box of the model
	const boundingBox = new Box3().setFromObject( model );
	const center = boundingBox.getCenter( new Vector3() );
	const size = boundingBox.getSize( new Vector3() );

	// Set the OrbitControls target to the center of the model
	controls.target.copy( center );

	// Calculate the distance to place the camera
	const maxDim = Math.max( size.x, size.y, size.z );
	const fov = camera.fov * ( Math.PI / 180 );
	const cameraDistance = Math.abs( maxDim / Math.sin( fov / 2 ) / 2 );

	// Position the camera
	const direction = new Vector3().subVectors( camera.position, controls.target ).normalize();
	camera.position.copy( direction.multiplyScalar( cameraDistance ).add( controls.target ) );

	// Update camera and controls
	camera.near = maxDim / 100;
	camera.far = maxDim * 100;
	camera.updateProjectionMatrix();
	controls.maxDistance = cameraDistance * 10;
	controls.update();

}

function toggleLoadingIndicator( bool ) {

	loadingOverlay.style.display = bool ? 'flex' : 'none';
	pauseRendering = bool;

}

async function init() {

	toggleLoadingIndicator( true );

	initRenderer();
	setupScene();
	setupComposer();

	loadHDRBackground( currentHDRIndex );

	const modelUrl = `${MODEL_BASE_URL}${MODEL_FILES[ currentModelIndex ].url}`;
	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	targetModel = await loader.loadAsync( modelUrl );
	floorPlane = new Mesh(
		new PlaneGeometry(),
		new MeshStandardMaterial( {
			// map: floorTex,
			transparent: false,
			color: 0x555555,
			roughness: 0.05,
			metalness: 0.0,
			// side: DoubleSide,
		} )
	);
	scene.add( floorPlane );

	// targetModel = generateMaterialSpheres();
	onModelLoad( targetModel.scene );

	setupGUI();

	setupDragAndDrop();
	window.addEventListener( 'resize', onResize );
	toggleLoadingIndicator( false );

	onResize();
	animate();

}

init();
