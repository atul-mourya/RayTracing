import {
	Scene,
	PerspectiveCamera,
	Vector3,
	WebGLRenderer,
	Color,
	ACESFilmicToneMapping,
	Mesh,
	MeshStandardMaterial,
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
	const result = await loader.loadAsync( './model3.glb' );
	return result.scene;
	// return new Mesh( new TeapotGeometry( 1, 1 ), new MeshStandardMaterial( { color: 0xff0000 } ) );

}

function createSpheres() {

	return [
		{ position: new Vector3( 0, 4, - 5 ), radius: 1.0, material: { color: new Color( 1, 1, 1 ), emissive: new Color( 1, 1, 1 ), emissiveIntensity: 2 } },
		{ position: new Vector3( 3, 0, - 5 ), radius: 1.0, material: { color: new Color( 0, 1, 0 ), emissive: new Color( 1, 1, 1 ), emissiveIntensity: 0.0 } },
		{ position: new Vector3( - 3, 0, - 5 ), radius: 1.0, material: { color: new Color( 0, 0, 1 ), emissive: new Color( 1, 1, 1 ), emissiveIntensity: 0.0 } },
		{ position: new Vector3( 0, - 26, - 5 ), radius: 25.0, material: { color: new Color( 0.9, 0.9, 0.9 ), emissive: new Color( 1, 1, 1 ), emissiveIntensity: 0.0 } },
	];

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
	camera.position.set( 0, 0, - 1 );

	const renderer = new WebGLRenderer( {
		antialias: false,
		alpha: false
	} );
	renderer.setSize( viewPort.width, viewPort.height );
	renderer.pixelRatio = 1;
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild( renderer.domElement );

	const stats = new Stats();
	document.body.appendChild( stats.dom );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => accPass.iteration = 0 );
	controls.update();

	const meshes = await loadGLTFModel();
	const triangleSDF = new TriangleSDF( meshes );
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

		const tempMatrix = controls.object.matrixWorld.elements;
		pathTracingPass.uniforms.cameraPos.value.copy( controls.object.position );
		pathTracingPass.uniforms.cameraUp.value.set( tempMatrix[ 4 ], tempMatrix[ 5 ], tempMatrix[ 6 ] ).normalize();
		pathTracingPass.uniforms.cameraRight.value.set( tempMatrix[ 0 ], tempMatrix[ 1 ], tempMatrix[ 2 ] ).normalize();
		pathTracingPass.uniforms.cameraDir.value.set( tempMatrix[ 8 ], tempMatrix[ 9 ], tempMatrix[ 10 ] ).normalize();

		pathTracingPass.uniforms.frame.value ++;
		composer.render();
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
