import {
	Scene, PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping,
	FloatType, DirectionalLight, LinearSRGBColorSpace,
	EquirectangularReflectionMapping, Group, Box3, Vector3
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';
import SpatialDenoiserPass from './shaders/Accumulator/SpatialDenoiserPass.js';
import TriangleSDF from './src/TriangleSDF.js';


//some samples at https://casual-effects.com/data/
// const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/colourdrafts/scene.glb';
const MODEL_URL = './models/modernbathroom.glb';
const HDR_FILES = [
	{ name: "Adams Place Bridge", url: "adams_place_bridge_2k.hdr" },
	{ name: "Aerodynamics Workshop", url: "aerodynamics_workshop_2k.hdr" },
	{ name: "Aristea Wreck Pure Sky", url: "aristea_wreck_puresky_2k.hdr" },
	{ name: "Auto Shop", url: "autoshop_01_2k.hdr" },
	{ name: "Blocky Photo Studio", url: "blocky_photo_studio_1k.hdr" },
	{ name: "Brown Photo Studio 01", url: "brown_photostudio_01_2k.hdr" },
	{ name: "Brown Photo Studio 02", url: "brown_photostudio_02_2k.hdr" },
	{ name: "Brown Photo Studio 06", url: "brown_photostudio_06_2k.hdr" },
	{ name: "Brown Photo Studio 07", url: "brown_photostudio_07_2k.hdr" },
	{ name: "Chinese Garden", url: "chinese_garden_2k.hdr" },
	{ name: "Christmas Photo Studio 04", url: "christmas_photo_studio_04_2k.hdr" },
	{ name: "Christmas Photo Studio 05", url: "christmas_photo_studio_05_2k.hdr" },
	{ name: "Christmas Photo Studio 07", url: "christmas_photo_studio_07_2k.hdr" },
	{ name: "Circus Arena", url: "circus_arena_2k.hdr" },
	{ name: "Comfy Cafe", url: "comfy_cafe_2k.hdr" },
	{ name: "Dancing Hall", url: "dancing_hall_2k.hdr" },
	{ name: "Drachenfels Cellar", url: "drachenfels_cellar_2k.hdr" },
	{ name: "Hall of Mammals", url: "hall_of_mammals_2k.hdr" },
	{ name: "Herkulessaulen", url: "herkulessaulen_2k.hdr" },
	{ name: "Hilly Terrain", url: "hilly_terrain_01_2k.hdr" },
	{ name: "Kloppenheim", url: "kloppenheim_05_2k.hdr" },
	{ name: "Leadenhall Market", url: "leadenhall_market_2k.hdr" },
	{ name: "Modern Buildings", url: "modern_buildings_2_2k.hdr" },
	{ name: "Narrow Moonlit Road", url: "narrow_moonlit_road_2k.hdr" },
	{ name: "Noon Grass", url: "noon_grass_2k.hdr" },
	{ name: "Peppermint Powerplant", url: "peppermint_powerplant_2k.hdr" },
	{ name: "Phalzer Forest", url: "phalzer_forest_01_2k.hdr" },
	{ name: "Photo Studio", url: "photo_studio_01_2k.hdr" },
	{ name: "Photo Studio Loft Hall", url: "photo_studio_loft_hall_2k.hdr" },
	{ name: "Rainforest Trail", url: "rainforest_trail_2k.hdr" },
	{ name: "Sepulchral Chapel Rotunda", url: "sepulchral_chapel_rotunda_2k.hdr" },
	{ name: "St. Peter's Square Night", url: "st_peters_square_night_2k.hdr" },
	{ name: "Studio Small 05", url: "studio_small_05_2k.hdr" },
	{ name: "Studio Small 09", url: "studio_small_09_2k.hdr" },
	{ name: "Thatch Chapel", url: "thatch_chapel_2k.hdr" },
	{ name: "Urban Alley", url: "urban_alley_01_2k.hdr" },
	{ name: "Vestibule", url: "vestibule_2k.hdr" },
	{ name: "Vintage Measuring Lab", url: "vintage_measuring_lab_2k.hdr" },
	{ name: "Wasteland Clouds Pure Sky", url: "wasteland_clouds_puresky_2k.hdr" },
	{ name: "Whale Skeleton", url: "whale_skeleton_2k.hdr" }
];
const ENV_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/hdri/';
const ORIGINAL_PIXEL_RATIO = window.devicePixelRatio / 4;

// DOM Elements
const container = document.getElementById( 'container-3d' );
const tweakpaneContainer = document.getElementById( 'tweakpane-container' );

// Global Variables
let renderer, canvas, scene, dirLight, camera, controls;
let fpsGraph;
let composer, renderPass, pathTracingPass, accPass, denoiserPass;
let currentHDRIndex = 0, loadingOverlay;

// Initialization Functions
async function initScene() {

	scene = new Scene();
	window.scene = scene;

	await loadHDRBackground( currentHDRIndex );

}

async function loadHDRBackground( index ) {

	showLoadingIndicator();

	const loader = new RGBELoader();
	loader.setDataType( FloatType );

	try {

		const hdrTexture = await new Promise( ( resolve, reject ) => {

			loader.load(
				`${ENV_BASE_URL}${HDR_FILES[ index ].url}`,
				( texture ) => resolve( texture ),
				null,
				( error ) => reject( error )
			);

		} );

		hdrTexture.mapping = EquirectangularReflectionMapping;

		scene.background = hdrTexture;
		scene.environment = hdrTexture;

		// Update path tracing uniforms
		if ( pathTracingPass ) {

			pathTracingPass.uniforms.envMapIntensity.value = renderer.toneMappingExposure;
			pathTracingPass.uniforms.envMap.value = hdrTexture;

			// Reset accumulation
			reset();

		}

	} catch ( error ) {

		console.error( 'Error loading HDR:', error );

	} finally {

		hideLoadingIndicator();

	}


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
	renderer.outputColorSpace = LinearSRGBColorSpace;
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

	camera = new PerspectiveCamera( 75, canvas.width / canvas.height, 0.01, 1000 );
	camera.position.set( 0, 0, 5 );

	controls = new OrbitControls( camera, canvas );
	controls.addEventListener( 'change', reset );
	controls.addEventListener( 'start', onControlsStart );
	controls.addEventListener( 'end', onControlsEnd );
	controls.update();

	dirLight = new DirectionalLight( 0xffffff, 0 );
	dirLight.name = 'directionLight';
	dirLight.position.set( 0.3, 1, 3 );
	dirLight.intensity = 0;
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

	// renderPass.enabled = true;
	// pathTracingPass.enabled = false;
	// accPass.enabled = false;

}

function onControlsEnd() {

	// renderPass.enabled = false;
	// pathTracingPass.enabled = true;
	// accPass.enabled = true;

}

function handleLayoutChange() {

	const isMobile = window.innerWidth <= 768;
	tweakpaneContainer.style.position = isMobile ? 'absolute' : 'relative';
	onResize();

}

function onResize() {

	const width = container.clientWidth;
	const height = container.clientHeight;

	camera.aspect = width / height;
	camera.updateProjectionMatrix();
	renderer.setSize( width, height );
	composer.setSize( width, height );

	pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
	pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
	reset();

}

// Animation and Rendering
function animate() {

	fpsGraph.begin();
	controls.update();

	pathTracingPass.enabled && updatePathTracingUniforms();

	composer.render();
	fpsGraph.end();
	requestAnimationFrame( animate );

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
		hdrBackground: HDR_FILES[ currentHDRIndex ].name,
		resolution: renderer.getPixelRatio(),
		toneMappingExposure: Math.pow( renderer.toneMappingExposure, 1 / 4 )
	};

	const pane = new Pane( { title: 'Settings', expanded: true, container: tweakpaneContainer } );
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
	folder.addBinding( accPass, 'iteration', { label: 'Samples', readonly: true } );
	fpsGraph = folder.addBlade( { view: 'fpsgraph', label: 'fps', rows: 2, } );

}

function setupSceneFolder( pane, parameters ) {

	const sceneFolder = pane.addFolder( { title: 'Scene' } ).on( 'change', reset );
	sceneFolder.addBinding( parameters, 'toneMappingExposure', { label: 'Exposure', min: 0, max: 2, step: 0.01 } ).on( 'change', e => pathTracingPass.uniforms.envMapIntensity.value = renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
	sceneFolder.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Environment' } );
	sceneFolder.addBinding( parameters, 'hdrBackground', {
		label: 'HDR Environment',
		options: HDR_FILES.reduce( ( acc, file, index ) => {

			acc[ file.name ] = index;
			return acc;

		}, {} )
	} ).on( 'change', ( ev ) => {

		switchHDRBackground( ev.value );

	} );
	// sceneFolder.addBinding( scene, 'environmentIntensity', { label: 'Enviroment Intensity', min: 0, max: 2, step: 0.01 } ).on( 'change', e => pathTracingPass.uniforms.envMapIntensity.value = e.value );

}

function setupCameraFolder( pane ) {

	const folder = pane.addFolder( { title: 'Camera' } ).on( 'change', reset );
	folder.addBinding( camera, 'fov', { label: 'FOV', min: 30, max: 90, step: 5 } ).on( 'change', onResize );
	folder.addBinding( pathTracingPass.uniforms.focalDistance, 'value', { label: 'Focal Distance', min: 0, max: 100, step: 1 } );
	folder.addBinding( pathTracingPass.uniforms.aperture, 'value', { label: 'Aperture', min: 0, max: 1, step: 0.001 } );

}

function setupPathTracerFolder( pane, parameters ) {

	const ptFolder = pane.addFolder( { title: 'Path Tracer' } ).on( 'change', reset );
	ptFolder.addBinding( pathTracingPass, 'enabled', { label: 'Enable' } ).on( 'change', e => {

		accPass.enabled = e.value;
		renderPass.enabled = ! e.value;

	} );
	ptFolder.addBinding( accPass, 'enabled', { label: 'Enable Accumulation' } );
	ptFolder.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 0, max: 20, step: 1 } );
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

function switchHDRBackground( index ) {

	if ( index !== currentHDRIndex ) {

		currentHDRIndex = index;
		loadHDRBackground( currentHDRIndex );

	}

}

// GUI Helper Functions
function updateResolution( value ) {

	renderer.setPixelRatio( value );
	composer.setPixelRatio( value );
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

function setupDragAndDrop() {

	const dropZone = document.body;

	dropZone.addEventListener( 'dragenter', ( event ) => {

		event.preventDefault();
		event.stopPropagation();
		dropZone.classList.add( 'drag-over' );

	} );

	dropZone.addEventListener( 'dragleave', ( event ) => {

		event.preventDefault();
		event.stopPropagation();
		dropZone.classList.remove( 'drag-over' );

	} );


	dropZone.addEventListener( 'dragover', ( event ) => {

		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = 'copy';

	} );

	dropZone.addEventListener( 'drop', ( event ) => {

		event.preventDefault();
		event.stopPropagation();

		dropZone.classList.remove( 'drag-over' );

		const file = event.dataTransfer.files[ 0 ];
		if ( file && file.name.toLowerCase().endsWith( '.glb' ) ) {

			const reader = new FileReader();
			reader.onload = ( event ) => {

				const arrayBuffer = event.target.result;
				loadGLBFromArrayBuffer( arrayBuffer );

			};

			reader.readAsArrayBuffer( file );

		} else {

			console.warn( 'Please drop a GLB file.' );

		}

	} );

}

function loadGLBFromArrayBuffer( arrayBuffer ) {

	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	loader.parse( arrayBuffer, '', ( gltf ) => {

		// Remove existing model
		scene.traverse( ( child ) => {

			if ( child instanceof Group ) {

				scene.remove( child );

			}

		} );

		// Add new model
		const model = gltf.scene;
		scene.add( model );

		centerModelAndAdjustCamera( model );
		// Update triangleSDF
		const triangleSDF = new TriangleSDF( scene );
		pathTracingPass.update( triangleSDF );

		// Reset accumulation and update scene
		reset();
		onResize();

	}, undefined, ( error ) => {

		console.error( 'Error loading GLB:', error );

	} );

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

function setupLoadingIndicator() {

	loadingOverlay = document.getElementById( 'loading-overlay' );

}

function showLoadingIndicator() {

	loadingOverlay.style.display = 'flex';

}

function hideLoadingIndicator() {

	loadingOverlay.style.display = 'none';

}


// Main Initialization
async function init() {

	setupLoadingIndicator();

	await initScene();
	initRenderer();
	setupScene();

	const meshes = await loadGLTFModel();
	scene.add( meshes );
	centerModelAndAdjustCamera( meshes );

	const triangleSDF = new TriangleSDF( scene );

	setupComposer( triangleSDF );
	setupGUI();
	handleLayoutChange();
	setupDragAndDrop();
	window.addEventListener( 'resize', () => {

		handleLayoutChange();
		onResize();

	} );

	onResize();
	animate();

}

init();
