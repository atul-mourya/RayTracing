import { 
	Scene,
	OrthographicCamera,
	PerspectiveCamera,
	Vector2,
	Vector3,
	WebGLRenderer,
	BoxGeometry,
	MeshBasicMaterial,
	Color,
	RGBAFormat,
	DataTexture,
	FloatType,
	TorusGeometry,
	ConeGeometry,
	CapsuleGeometry
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';

import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';
import { TeapotGeometry } from 'three/examples/jsm/Addons.js';

class RayTracingMaterial {
	constructor(color = new Vector3(1, 1, 1), emissionColor = new Vector3(0, 0, 0), emissionStrength = 0) {
		this.color = color;
		this.emissionColor = emissionColor;
		this.emissionStrength = emissionStrength;
	}
}

class Triangle {
	constructor(posA, posB, posC, normalA, normalB, normalC, material) {
		this.posA = posA;
		this.posB = posB;
		this.posC = posC;
		this.normalA = normalA;
		this.normalB = normalB;
		this.normalC = normalC;
		this.material = material;
	}
}

async function init() {

	// Initialize the scene
	const scene = new Scene();
	// const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
	const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
	let cameraPosition = camera.position.set(0, 0, -1);
	let cameraDirection = new Vector3(0, 0, -1);
	let cameraRight = new Vector3(1, 0, 0);
	let cameraUp = new Vector3(0, 1, 0);

	// Initialize the renderer
	const renderer = new WebGLRenderer();
	renderer.setSize(window.innerWidth, window.innerHeight);
	document.body.appendChild(renderer.domElement);
	const stats = new Stats();
	document.body.appendChild(stats.dom);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.addEventListener('change', () => accPass.iteration = 0);
	controls.update();


	// Load the GLTF model
	const loader = new GLTFLoader();
	const gltf = await loader.loadAsync('./model.glb');

	let meshes = [];
	gltf.scene.traverse((child) => {
		if (child.isMesh) {
			meshes.push(child);
		}
	});

	
	
	
	const triangles = [];
	meshes.forEach(mesh => {
		// const geometry = new TeapotGeometry().toNonIndexed().scale(0.01, 0.01, 0.01).translate(0,0,-5);
		// const material = new MeshBasicMaterial( { color: 0xff0000 } );
		const geometry = mesh.geometry.rotateX(-Math.PI/2).rotateY(-Math.PI/2).translate(0,-1,-5);//new PlaneGeometry( 1, 1 ).translate(0,0,-5);
		const defaultMaterial = new RayTracingMaterial(); // Default material with placeholder values
		// const material = mesh.material;//new MeshBasicMaterial( { color: 0xff0000 } );

		const positions = geometry.attributes.position.array;
		const normals = geometry.attributes.normal.array;
		const count = geometry.attributes.position.count;
		
		
		for (let i = 0; i < count; i += 3) {
			// Create vectors for positions
			const posA = new Vector3(positions[i * 3 + 0], positions[i * 3 + 1], positions[i * 3 + 2]);
			const posB = new Vector3(positions[(i + 1) * 3 + 0], positions[(i + 1) * 3 + 1], positions[(i + 1) * 3 + 2]);
			const posC = new Vector3(positions[(i + 2) * 3 + 0], positions[(i + 2) * 3 + 1], positions[(i + 2) * 3 + 2]);
		
			// Create vectors for normals
			const normalA = new Vector3(normals[i * 3 + 0], normals[i * 3 + 1], normals[i * 3 + 2]);
			const normalB = new Vector3(normals[(i + 1) * 3 + 0], normals[(i + 1) * 3 + 1], normals[(i + 1) * 3 + 2]);
			const normalC = new Vector3(normals[(i + 2) * 3 + 0], normals[(i + 2) * 3 + 1], normals[(i + 2) * 3 + 2]);
		
			// Create a triangle and add it to the list
			const triangle = new Triangle(posA, posB, posC, normalA, normalB, normalC, defaultMaterial);
			triangles.push(triangle);
		}
	});

	// Define the spheres and their materials
	const spheres = [
		{ position: new Vector3(0, 4, -5), radius: 1.0, material: { color: new Color(1, 1, 1), emissionColor: new Color(1, 1, 1), emissionStrength: 2 } },
		{ position: new Vector3(2, 0, -5), radius: 1.0, material: { color: new Color(0, 1, 0), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
		{ position: new Vector3(-2, 0, -5), radius: 1.0, material: { color: new Color(0, 0, 1), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
		{ position: new Vector3(0, -26, -5), radius: 25.0, material: { color: new Color(0.9, 0.9, 0.9), emissionColor: new Color(1, 1, 1), emissionStrength: 0.0 } },
	];

	function createTriangleTexture(triangles) {
		const texWidth = 2048; // Set a reasonable texture width
		const texHeight = Math.ceil(triangles.length / texWidth);
		const data = new Float32Array(texWidth * texHeight * 4 * 3); // 4 values per pixel, 3 sets of 4 for posA, posB, posC

		for (let i = 0; i < triangles.length; i++) {
			const triangle = triangles[i];
			const offset = i * 12;

			// Store posA
			data[offset] = triangle.posA.x;
			data[offset + 1] = triangle.posA.y;
			data[offset + 2] = triangle.posA.z;
			data[offset + 3] = 0; // Padding

			// Store posB
			data[offset + 4] = triangle.posB.x;
			data[offset + 5] = triangle.posB.y;
			data[offset + 6] = triangle.posB.z;
			data[offset + 7] = 0; // Padding

			// Store posC
			data[offset + 8] = triangle.posC.x;
			data[offset + 9] = triangle.posC.y;
			data[offset + 10] = triangle.posC.z;
			data[offset + 11] = 0; // Padding
		}

		const texture = new DataTexture(data, texWidth, texHeight, RGBAFormat, FloatType);
		texture.needsUpdate = true;

		return texture;
	}

	function createNormalTexture(triangles) {
		const texWidth = 2048; // Set a reasonable texture width
		const texHeight = Math.ceil(triangles.length / texWidth);
		const data = new Float32Array(texWidth * texHeight * 4 * 3); // 4 values per pixel, 3 sets of 4 for posA, posB, posC

		for (let i = 0; i < triangles.length; i++) {
			const triangle = triangles[i];
			const offset = i * 12;

			// Store posA
			data[offset] = triangle.normalA.x;
			data[offset + 1] = triangle.normalA.y;
			data[offset + 2] = triangle.normalA.z;
			data[offset + 3] = 0; // Padding

			// Store posB
			data[offset + 4] = triangle.normalB.x;
			data[offset + 5] = triangle.normalB.y;
			data[offset + 6] = triangle.normalB.z;
			data[offset + 7] = 0; // Padding

			// Store posC
			data[offset + 8] = triangle.normalC.x;
			data[offset + 9] = triangle.normalC.y;
			data[offset + 10] = triangle.normalC.z;
			data[offset + 11] = 0; // Padding
		}

		const texture = new DataTexture(data, texWidth, texHeight, RGBAFormat, FloatType);
		texture.needsUpdate = true;

		return texture;
	}

	const triangleTexture = createTriangleTexture(triangles);
	const normalTexture = createNormalTexture(triangles);

	const composer = new EffectComposer(renderer);
	const pathTracingPass = new ShaderPass(PathTracingShader);
	pathTracingPass.uniforms.resolution.value = new Vector2(window.innerWidth, window.innerHeight),
	pathTracingPass.uniforms.cameraPos.value = cameraPosition;
	pathTracingPass.uniforms.cameraDir.value = cameraDirection;
	pathTracingPass.uniforms.cameraRight.value = cameraRight;
	pathTracingPass.uniforms.cameraUp.value = cameraUp;

	pathTracingPass.uniforms.frame.value = 0;
	pathTracingPass.uniforms.maxBounceCount.value = 1;
	pathTracingPass.uniforms.numRaysPerPixel.value = 1;

	pathTracingPass.uniforms.spheres.value = spheres;
	pathTracingPass.material.defines.MAX_SPHERE_COUNT = spheres.length;

	// pathTracingPass.uniforms.triangles.value = triangles;
	pathTracingPass.material.defines.MAX_TRIANGLE_COUNT = triangles.length;

	pathTracingPass.uniforms.triangleTexture = { value: triangleTexture };
	pathTracingPass.uniforms.triangleTexSize = { value: new Vector2(triangleTexture.image.width, triangleTexture.image.height) };

	pathTracingPass.uniforms.normalTexture = { value: normalTexture };
	pathTracingPass.uniforms.normalTexSize = { value: new Vector2(normalTexture.image.width, normalTexture.image.height) };

	pathTracingPass.name = 'pathTracingPass';
	composer.addPass(pathTracingPass);

	const accPass = new AccumulationPass(scene, window.innerWidth, window.innerHeight);
	composer.addPass(accPass);

	const pane = new Pane({ title: 'Parameters', expanded: false });
	pane.addBinding(pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'bounce', min: 1, max: 5, step: 1 });
	pane.addBinding(pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'rays per pixel', min: 1, max: 20, step: 1 });
	pane.addBinding(pathTracingPass.uniforms.spheres.value[0], 'position');
	pane.addBinding(pathTracingPass.uniforms.spheres.value[0].material, 'emissionStrength', { min: 0, max: 5, });
	pane.addBinding(pathTracingPass.uniforms.spheres.value[0].material, 'emissionColor', { color: { type: 'float' } });
	// pane.addBinding(pathTracingPass.uniforms.spheres.value[1].material, 'color', { color: { type: 'float' } });
	// pane.addBinding(pathTracingPass.uniforms.spheres.value[2].material, 'color', { color: { type: 'float' } });
	// pane.addBinding(pathTracingPass.uniforms.spheres.value[3].material, 'color', { color: { type: 'float' } });
	pane.on('change', ev => accPass.iteration = 0);

	let tempMatrix = null;
	// Render the scene
	function animate() {
		requestAnimationFrame(animate);
		controls.update();

		cameraPosition = controls.object.position;
		tempMatrix = controls.object.matrixWorld.elements;
		cameraUp.set(tempMatrix[4], tempMatrix[5], tempMatrix[6]).normalize();
		cameraRight.set(tempMatrix[0], tempMatrix[1], tempMatrix[2]).normalize();
		cameraDirection.set(tempMatrix[8], tempMatrix[9], tempMatrix[10]).normalize();

		pathTracingPass.uniforms.frame.value++;
		composer.render();
		stats.update();
	}

	animate();

	// Handle window resize
	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		pathTracingPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
	});
}
init();