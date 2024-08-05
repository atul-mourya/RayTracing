import {
	Scene,
	PerspectiveCamera,
	Vector3,
	WebGLRenderer,
	Color,
	ACESFilmicToneMapping,
	Mesh,
	MeshStandardMaterial,
	BoxGeometry,
	PlaneGeometry,
	HemisphereLight
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';

import TriangleSDF from './src/TriangleSDF.js';
import { OutputPass, TeapotGeometry } from 'three/examples/jsm/Addons.js';

const viewPort = {
	width: 500,
	height: 500,
};

const white = new Color( 0xffffff );
const black = new Color( 0x000000 );
const red = new Color( 0xff0000 );
const green = new Color( 0x00ff00 );


async function loadGLTFModel() {

	const loader = new GLTFLoader();
	const result = await loader.loadAsync( './model6.glb' );
	return result.scene;
	// return new Mesh( new TeapotGeometry( 1, 5 ), new MeshStandardMaterial( { color: 0xff0000 } ) );

}

function createCornellBox() {

	const materials = {
		floor: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1, specularColor: white, specularProbability: 1 },
		white: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1, specularColor: white, specularProbability: 0 },
		red: { color: red, emissive: black, emissiveIntensity: 0, roughness: 1, specularColor: white, specularProbability: 1 },
		green: { color: green, emissive: black, emissiveIntensity: 0, roughness: 1, specularColor: white, specularProbability: 0 },
		light: { color: white, emissive: white, emissiveIntensity: 4, roughness: 1, specularColor: white, specularProbability: 0 }
	};

	const width = 12;
	const height = 5;
	const depth = 6;
	const thickness = 0.1;

	const boxParams = [
		{
			name: 'Floor', material: materials.floor, meshType: 'box',
			width, height: thickness, depth,
			position: { x: 0, y: 0, z: 0 }
		},
		{
			name: 'Ceiling', material: materials.white, meshType: 'box',
			width, height: thickness, depth,
			position: { x: 0, y: height, z: 0 }
		},
		{
			name: 'BackWall', material: materials.white, meshType: 'box',
			width, height, depth: thickness,
			position: { x: 0, y: height / 2, z: - depth / 2 }
		},
		{
			name: 'LeftWall', material: materials.red, meshType: 'box',
			width: thickness, height, depth,
			position: { x: - width / 2, y: height / 2, z: 0 }
		},
		{
			name: 'RightWall', material: materials.green, meshType: 'box',
			width: thickness, height, depth,
			position: { x: width / 2, y: height / 2, z: 0 }
		},
		// {
		// 	name: 'FrontWall', material: materials.white, meshType: 'box',
		// 	width, height, depth: thickness,
		// 	position: { x: 0, y: height / 2, z: depth / 2 }
		// },
		{
			name: 'Light', material: materials.light, meshType: 'box',
			width: 2, height: thickness, depth: 1,
			position: { x: 0, y: height - thickness, z: 0 }
		},
	];

	const boxes = boxParams.map( params =>
		createBox( params.meshType, params.material, params.width, params.height, params.depth, params.position, params.name )
	);

	return boxes;

}

function setupPane( pathTracingPass, accPass ) {

	const pane = new Pane( { title: 'Parameters', expanded: false } );
	pane.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 5, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'env light' } );
	pane.addBinding( pathTracingPass.uniforms.sunElevation, 'value', { label: 'sun elevation', min: - Math.PI / 2, max: Math.PI / 2 } );
	pane.addBinding( pathTracingPass.uniforms.sunAzimuth, 'value', { label: 'sun azimuth', min: 0, max: 2 * Math.PI } );
	pane.addBinding( pathTracingPass.uniforms.sunIntensity, 'value', { label: 'sun intensity', min: 0, max: 100 } );

	pane.on( 'change', () => accPass.iteration = 0 );

}

function createDummyFailureResistenceObjects( scene, count ) {

	let material = { color: white, emissive: black, emissiveIntensity: 0, roughness: 0, specularColor: white, specularProbability: 0 };
	for ( let i = 0; i < count; i ++ ) {

		let obj = createBox( 'box', material, 0.1, 0.1, 0.1, { x: 0, y: 0.1, z: 0 }, 'dummy_' + i );
		scene.add( obj );

	}

}

function createBox( type, mat, width, height, depth, position, name ) {

	const geometry = type === 'box' ? new BoxGeometry( width, height, depth ) : new PlaneGeometry( width, height );
	const material = new MeshStandardMaterial( mat );
	material.specularColor = mat.specularColor ?? white;
	material.specularProbability = mat.specularProbability ?? 0;
	const mesh = new Mesh( geometry, material );
	mesh.position.set( position.x, position.y, position.z );
	mesh.name = name;
	return mesh;


}

async function init() {

	const scene = new Scene();
	const camera = new PerspectiveCamera( 75, viewPort.width / viewPort.height, 0.1, 1000 );
	camera.position.set( 0, 2.5, 5 );

	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false
	} );
	renderer.setSize( viewPort.width, viewPort.height );
	// renderer.pixelRatio = 0.25;
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild( renderer.domElement );

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => accPass.iteration = 0 );
	controls.update();

	const hemLight = new HemisphereLight();
	scene.add( hemLight );

	// const meshes = await loadGLTFModel();
	// scene.add( meshes );

	const cornellBox = createCornellBox();
	cornellBox.forEach( mesh => scene.add( mesh ) );
	createDummyFailureResistenceObjects( scene, 4 );

	const triangleSDF = new TriangleSDF( scene );

	const composer = new EffectComposer( renderer );
	const pathTracingPass = new PathTracingShader( triangleSDF, viewPort.width, viewPort.height );
	composer.addPass( pathTracingPass );

	const accPass = new AccumulationPass( scene, viewPort.width, viewPort.height );
	composer.addPass( accPass );

	// const outputPass = new OutputPass();
	// composer.addPass( outputPass );

	setupPane( pathTracingPass, accPass );
	controls.target.set( 0, 2.5, 0 );

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );

		pathTracingPass.uniforms.frame.value ++;
		composer.render();
		// renderer.render( scene, camera );
		stats.update();

	}

	animate();

	window.addEventListener( 'resize', () => {

		renderer.setSize( viewPort.width, viewPort.height );
		camera.updateProjectionMatrix();
		pathTracingPass.uniforms.resolution.value.set( viewPort.width, viewPort.height );
		pathTracingPass.uniforms.cameraWorldMatrix.value.copy( camera.matrixWorld );
		pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( camera.projectionMatrixInverse );
		accPass.iteration = 0;

	} );

}

init();
