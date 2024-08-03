import {
	Scene,
	PerspectiveCamera,
	Vector3,
	WebGLRenderer,
	Color,
	ACESFilmicToneMapping,
	Mesh,
	MeshStandardMaterial,
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

async function loadGLTFModel() {

	const loader = new GLTFLoader();
	const result = await loader.loadAsync( './model6.glb' );
	return result.scene;
	// return new Mesh( new TeapotGeometry( 1, 5 ), new MeshStandardMaterial( { color: 0xff0000 } ) );

}

function createSpheres() {

	return [
		{ position: new Vector3( 0, 5, 0 ), radius: 1.0, material: new MeshStandardMaterial( { color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 10 } ) },
		{ position: new Vector3( 3, 0, 0 ), radius: 1.0, material: new MeshStandardMaterial( { color: 0x00ff00, emissive: 0xffffff, emissiveIntensity: 0 } ) },
		{ position: new Vector3( - 3, 0, 0 ), radius: 1.0, material: new MeshStandardMaterial( { color: 0x0000ff, emissive: 0xffffff, emissiveIntensity: 0 } ) },
		// { position: new Vector3( 0, - 26, 0 ), radius: 25.0, material: { color: new Color( 0.9, 0.9, 0.9 ), emissive: new Color( 1, 1, 1 ), emissiveIntensity: 0.0 } },
	];

}

function createCornellBox() {

	const materials = {
		white: new MeshStandardMaterial( { color: 0xffffff } ),
		red: new MeshStandardMaterial( { color: 0xff0000 } ),
		green: new MeshStandardMaterial( { color: 0x00ff00 } )
	};

	const planeParams = [
		{
			name: 'Floor', material: materials.white,
			width: 5, height: 5,
			position: { x: 0, y: 0, z: 0 },
			rotation: { x: - Math.PI / 2, y: 0, z: 0 },
		},
		{
			name: 'Ceiling', material: materials.white,
			width: 5, height: 5,
			position: { x: 0, y: 5, z: 0 },
			rotation: { x: Math.PI / 2, y: 0, z: 0 },
		},
		{
			name: 'BackWall', material: materials.white,
			width: 5, height: 5,
			position: { x: 0, y: 2.5, z: - 2.5 },
			rotation: { x: 0, y: 0, z: 0 },
		},
		{
			name: 'LeftWall', material: materials.red,
			width: 5, height: 5,
			position: { x: - 2.5, y: 2.5, z: 0 },
			rotation: { x: 0, y: Math.PI / 2, z: 0 },
		},
		{
			name: 'RightWall', material: materials.green,
			width: 5, height: 5,
			position: { x: 2.5, y: 2.5, z: 0 },
			rotation: { x: 0, y: - Math.PI / 2, z: 0 },
		},
		{
			name: 'FrontWall', material: materials.white,
			width: 5, height: 5,
			position: { x: 0, y: 2.5, z: 2.5 },
			rotation: { x: 0, y: Math.PI, z: 0 },
		}
	];

	function createPlane( material, width, height, rotation, position, name ) {

		const plane = new Mesh( new PlaneGeometry( width, height ), material );
		plane.name = name;
		plane.rotation.set( rotation.x, rotation.y, rotation.z );
		plane.position.set( position.x, position.y, position.z );
		return plane;

	}

	const planes = planeParams.map( params =>
		createPlane( params.material, params.width, params.height, params.rotation, params.position, params.name )
	);

	return planes;

}


function setupPane( pathTracingPass, accPass ) {

	const pane = new Pane( { title: 'Parameters', expanded: false } );
	pane.addBinding( pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 5, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 } );
	pane.addBinding( pathTracingPass.uniforms.spheres.value[ 0 ], 'position' );
	pane.addBinding( pathTracingPass.uniforms.spheres.value[ 0 ].material, 'emissiveIntensity', { min: 0, max: 5 } );
	pane.addBinding( pathTracingPass.uniforms.spheres.value[ 0 ].material, 'emissive', { color: { type: 'float' } } );
	pane.on( 'change', () => accPass.iteration = 0 );

}

async function init() {

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, viewPort.width / viewPort.height, 0.1, 1000 );
	camera.position.set( 0, 5, 5 );

	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false
	} );
	renderer.setSize( viewPort.width, viewPort.height );
	renderer.pixelRatio = 0.25;
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild( renderer.domElement );

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => accPass.iteration = 0 );
	controls.update();

	const hemLight = new HemisphereLight();
	scene.add( hemLight );

	const meshes = await loadGLTFModel();
	scene.add( meshes );

	// const cornellBox = createCornellBox();
	// cornellBox.forEach( mesh => scene.add( mesh ) );

	const triangleSDF = new TriangleSDF( scene );
	const spheres = createSpheres();

	const composer = new EffectComposer( renderer );
	const pathTracingPass = new PathTracingShader( triangleSDF, spheres, viewPort.width, viewPort.height );
	composer.addPass( pathTracingPass );

	const accPass = new AccumulationPass( scene, viewPort.width, viewPort.height );
	composer.addPass( accPass );

	const outputPass = new OutputPass();
	composer.addPass( outputPass );

	setupPane( pathTracingPass, accPass );

	function animate() {

		requestAnimationFrame( animate );
		controls.update();

		pathTracingPass.uniforms.cameraPos.value = camera.position;
		camera.getWorldDirection( pathTracingPass.uniforms.cameraDir.value );
		camera.getWorldDirection( pathTracingPass.uniforms.cameraRight.value );
		pathTracingPass.uniforms.cameraRight.value.cross( camera.up ).normalize();
		pathTracingPass.uniforms.cameraUp.value = camera.up;

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
		accPass.iteration = 0;

	} );

}

init();
