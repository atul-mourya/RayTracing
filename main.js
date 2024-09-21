import {
	Scene, PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping,
	FloatType, DirectionalLight, SRGBColorSpace,
	EquirectangularReflectionMapping, Group, Box3, Vector3, RGBAFormat, NearestFilter, WebGLRenderTarget, DataTexture, UnsignedByteType, RepeatWrapping
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { SimplexNoise } from 'three/examples/jsm/Addons.js';

import PathTracerPass from './shaders/PathTracer/PathTracerPass.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';
// import SpatialDenoiserPass from './shaders/Accumulator/SpatialDenoiserPass.js';
import LygiaSmartDenoiserPass from './shaders/Accumulator/LygiaSmartDenoiserPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import generateMaterialSpheres from './src/generateMaterialSpheres.js';

//some samples at https://casual-effects.com/data/
const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/colourdrafts/scene.glb';
// const MODEL_URL = './models/planes.glb';
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
const MODEL_FILES = [
	{ name: "3D Home Layout", url: "3d-home-layout/scene.glb" },
	{ name: "Astraia", url: "astraia/scene.gltf" },
	{ name: "Bao Robot", url: "bao-robot/bao-robot.glb" },
	{ name: "Botanist's Greenhouse", url: "botanists-greenhouse/scene.gltf" },
	{ name: "Botanist's Study", url: "botanists-study/scene.gltf" },
	{ name: "Colour Drafts", url: "colourdrafts/scene.glb" },
	{ name: "Diamond", url: "diamond/diamond.glb" },
	{ name: "Dragon Attenuation", url: "dragon-attenuation/DragonAttenuation.glb" },
	{ name: "Dream Apartment", url: "dream-apartment/dream-apartment.glb" },
	{ name: "Drone", url: "drone/drone.glb" },
	{ name: "Dungeon Warkarma", url: "dungeon-warkarma/scene.gltf" },
	{ name: "Gelatinous Cube", url: "gelatinous-cube/scene.gltf" },
	{ name: "Guitar", url: "guitar/guitar.glb" },
	{ name: "Happy Buddha", url: "happy-buddha/buddha.glb" },
	{ name: "Hotel Room Lotus Carpet", url: "hotel-room-lotus-carpet/scene.glb" },
	{ name: "Imaginary Friend Room", url: "imaginary-friend-room/scene.glb" },
	{ name: "Interior Scene", url: "interior-scene/scene.gltf" },
	{ name: "Internal Combustion Engine", url: "internal-combustion-engine/model.gltf" },
	{ name: "Japanese Bridge Garden", url: "japanese-bridge-garden/scene.glb" },
	{ name: "Japanese Temple", url: "japanese-temple/scene.gltf" },
	{ name: "Kitchen", url: "kitchen/scene.glb" },
	{ name: "Lamborghini", url: "lamborghini/scene.glb" },
	{ name: "Low Poly Jungle Scene", url: "low-poly-jungle-scene/scene.gltf" },
	{ name: "Lowpoly Space", url: "lowpoly-space/space_exploration.glb" },
	{ name: "Mars Site", url: "mars-site/scene.gltf" },
	{ name: "Material Balls", url: "material-balls/material-ball_v2.glb" },
	{ name: "Mercury About to Kill Argos", url: "mercury-about-to-kill-argos/scene.glb" },
	{ name: "Mosquito in Amber", url: "mosquito-in-amber/scene.gltf" },
	{ name: "NASA M2020", url: "nasa-m2020/Perseverance.glb" },
	{ name: "Natural Products Expo", url: "natural-products-expo/scene.glb" },
	{ name: "Neko Stop Diorama", url: "neko-stop-diorama/scene.gltf" },
	{ name: "Octocat", url: "octocat/octocat.glb" },
	{ name: "Octopus Tea", url: "octopus-tea/scene.gltf" },
	{ name: "Pathtracing Bathroom", url: "pathtracing-bathroom/modernbathroom.glb" },
	{ name: "Pigman", url: "pigman/scene.gltf" },
	{ name: "Ring Twist Halo", url: "ring-twist-halo/scene.glb" },
	{ name: "Scifi Toad", url: "scifi-toad/scene.gltf" },
	{ name: "SD Macross City Standoff Diorama", url: "sd-macross-city-standoff-diorama/scene.glb" },
	{ name: "Sofa Patricia", url: "sofa-patricia/scene.glb" },
	{ name: "Stanford Bunny", url: "stanford-bunny/bunny.glb" },
	{ name: "Steampunk Robot", url: "steampunk-robot/scene.gltf" },
	{ name: "Terrarium Robots", url: "terrarium-robots/scene.gltf" },
	{ name: "Threedscans", url: "threedscans/Crab.glb" },
	{ name: "T-Rex", url: "trex/scene.gltf" },
	{ name: "USD Shader Ball", url: "usd-shader-ball/usd-shaderball-scene.glb" },
	{ name: "Vilhelm 13", url: "vilhelm-13/vilhelm_13.glb" },
	{ name: "Vino Bike", url: "vino-bike/scene.gltf" },
	{ name: "Wooden Stylised Carriage", url: "wooden-stylised-carriage/scene.gltf" },
	{ name: "WW2 City Scene", url: "ww2-cityscene/scene.gltf" }
];
const ENV_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/hdri/';
const MODEL_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/';

const ORIGINAL_PIXEL_RATIO = window.devicePixelRatio / 4;

// DOM Elements
const container = document.getElementById( 'container-3d' );
const tweakpaneContainer = document.getElementById( 'tweakpane-container' );
const loadingOverlay = document.getElementById( 'loading-overlay' );

// Global Variables
let renderer, canvas, scene, dirLight, camera, controls;
let pane, fpsGraph;
let composer, renderPass, pathTracingPass, accPass, denoiserPass;
let currentHDRIndex = 2;
let currentModelIndex = 7;
let pauseRendering = false;

// Initialization Functions
function initScene() {

	scene = new Scene();
	window.scene = scene;

}

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

	renderPass = new RenderPass( scene, camera );
	renderPass.enabled = false;
	composer.addPass( renderPass );

	pathTracingPass = new PathTracerPass( renderer, scene, camera, canvas.width, canvas.height );
	pathTracingPass.enabled = true;
	composer.addPass( pathTracingPass );

	accPass = new AccumulationPass( scene, canvas.width, canvas.height );
	accPass.enabled = true;
	composer.addPass( accPass );

	denoiserPass = new LygiaSmartDenoiserPass( canvas.width, canvas.height );
	// denoiserPass = new SpatialDenoiserPass( canvas.width, canvas.width );
	denoiserPass.enabled = false;
	composer.addPass( denoiserPass );

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
	if ( pauseRendering ) return;
	fpsGraph.begin();
	controls.update();
	composer.render();
	fpsGraph.end();

}

function reset() {

	pathTracingPass.reset();
	accPass.reset( renderer );

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
	ptFolder.addBinding( pathTracingPass.material.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 0, max: 20, step: 1 } );
	ptFolder.addBinding( pathTracingPass.material.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );
	const renderModeControl = ptFolder.addBinding( pathTracingPass.material.uniforms.renderMode, 'value', { label: 'Render Mode', options: { "Regular": 0, "Checkered": 1, "Tiled": 2 } } );
	const tilesControl = ptFolder.addBinding( pathTracingPass.material.uniforms.tiles, 'value', { label: 'No. of Tiles', hidden: true, min: 1, max: 20, step: 1 } );
	const checkeredIntervalControl = ptFolder.addBinding( pathTracingPass.material.uniforms.checkeredFrameInterval, 'value', { label: 'Checkered Frame Interval', hidden: true, min: 1, max: 20, step: 1 } );
	ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: { 'Quarter': window.devicePixelRatio / 4, 'Half': window.devicePixelRatio / 2, 'Full': window.devicePixelRatio } } ).on( 'change', e => updateResolution( e.value ) );

	renderModeControl.on( 'change', e => {

		tilesControl.hidden = e.value !== 2; // Show only when Tiled (2) is selected
		checkeredIntervalControl.hidden = e.value !== 1; // Show only when Checkered (1) is selected

	} );

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
	debugFolder.addBinding( pathTracingPass.material.uniforms.visMode, 'value', { label: 'Mode', options: { 'Beauty': 0, 'Triangle test count': 1, 'Box test count': 2, 'Distance': 3, 'Normal': 4 } } ).on( 'change', reset );
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

			// Remove existing model
			scene.traverse( ( child ) => {

				if ( child instanceof Group ) {

					scene.remove( child );

				}

			} );

			// Add new model
			const model = result.scene;
			scene.add( model );

			centerModelAndAdjustCamera( model );

			pathTracingPass.build( scene );

			reset();
			onResize();
			toggleLoadingIndicator( false );

		} catch ( error ) {

			console.error( 'Error loading GLB:', error );

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
			toggleLoadingIndicator( true );
			reader.onload = ( event ) => {

				const arrayBuffer = event.target.result;
				loadGLBFromArrayBuffer( arrayBuffer );

			};

			reader.readAsArrayBuffer( file );

		} else {

			toggleLoadingIndicator( false );
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

		pathTracingPass.build( scene );

		reset();
		onResize();
		toggleLoadingIndicator( false );

	}, undefined, ( error ) => {

		console.error( 'Error loading GLB:', error );
		toggleLoadingIndicator( false );

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

function toggleLoadingIndicator( bool ) {

	loadingOverlay.style.display = bool ? 'flex' : 'none';
	pauseRendering = bool;

}

async function init() {

	toggleLoadingIndicator( true );

	initScene();
	initRenderer();
	setupScene();
	setupComposer();

	loadHDRBackground( currentHDRIndex );

	const modelUrl = `${MODEL_BASE_URL}${MODEL_FILES[ currentModelIndex ].url}`;
	const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
	const result = await loader.loadAsync( modelUrl );
	const meshes = result.scene;
	scene.add( meshes );

	// const meshes = generateMaterialSpheres();
	// scene.add( meshes );

	centerModelAndAdjustCamera( meshes );

	pathTracingPass.build( scene );

	setupGUI();

	setupDragAndDrop();
	window.addEventListener( 'resize', onResize );
	toggleLoadingIndicator( false );

	onResize();
	animate();

}

init();
