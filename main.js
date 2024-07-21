import {
    Scene,
    PerspectiveCamera,
    Vector3,
    WebGLRenderer,
    Color,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';

import TriangleSDF from './src/TriangleSDF.js'

async function loadGLTFModel() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync('./model.glb');
    return gltf.scene.children.filter(child => child.isMesh);
}

function createSpheres() {
    return [
        { position: new Vector3(0, 4, -5), radius: 1.0, material: { color: new Color(1, 1, 1), emissionColor: new Color(1, 1, 1), emissionStrength: 2 } },
        { position: new Vector3(2, 0, -5), radius: 1.0, material: { color: new Color(0, 1, 0), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
        { position: new Vector3(-2, 0, -5), radius: 1.0, material: { color: new Color(0, 0, 1), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
        { position: new Vector3(0, -26, -5), radius: 25.0, material: { color: new Color(0.9, 0.9, 0.9), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
    ];
}

function setupPane(pathTracingPass, accPass) {
    const pane = new Pane({ title: 'Parameters', expanded: false });
    pane.addBinding(pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 5, step: 1 });
    pane.addBinding(pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 });
    pane.addBinding(pathTracingPass.uniforms.spheres.value[0], 'position');
    pane.addBinding(pathTracingPass.uniforms.spheres.value[0].material, 'emissionStrength', { min: 0, max: 5 });
    pane.addBinding(pathTracingPass.uniforms.spheres.value[0].material, 'emissionColor', { color: { type: 'float' } });
    pane.on('change', () => accPass.iteration = 0);
}

async function init() {
    const scene = new Scene();
    const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, -1);

    const renderer = new WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const stats = new Stats();
    document.body.appendChild(stats.dom);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.addEventListener('change', () => accPass.iteration = 0);
    controls.update();

    const meshes = await loadGLTFModel();
	const triangles = TriangleSDF.extractTrianglesFromMeshes(meshes);
	const triangleTexture = TriangleSDF.createTriangleTexture(triangles);
	const normalTexture = TriangleSDF.createNormalTexture(triangles);
	const spheres = createSpheres();

	const composer = new EffectComposer(renderer);
	const pathTracingPass = new PathTracingShader(triangles, triangleTexture, normalTexture, spheres);
	composer.addPass(pathTracingPass);

	const accPass = new AccumulationPass(scene, window.innerWidth, window.innerHeight);
	composer.addPass(accPass);

	setupPane(pathTracingPass, accPass);

	function animate() {
		requestAnimationFrame(animate);
		controls.update();

		const tempMatrix = controls.object.matrixWorld.elements;
		pathTracingPass.uniforms.cameraPos.value.copy(controls.object.position);
		pathTracingPass.uniforms.cameraUp.value.set(tempMatrix[4], tempMatrix[5], tempMatrix[6]).normalize();
		pathTracingPass.uniforms.cameraRight.value.set(tempMatrix[0], tempMatrix[1], tempMatrix[2]).normalize();
		pathTracingPass.uniforms.cameraDir.value.set(tempMatrix[8], tempMatrix[9], tempMatrix[10]).normalize();

		pathTracingPass.uniforms.frame.value++;
		composer.render();
		stats.update();
	}

	animate();

	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.updateProjectionMatrix();
		pathTracingPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
		accPass.iteration = 0;
	});

}

init();