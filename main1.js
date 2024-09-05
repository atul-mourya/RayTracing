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
import { Pane } from 'tweakpane';
import Stats from 'three/addons/libs/stats.module.js';
import PathTracingShader from './shaders/PathTracer/PathTracingShader.js';
import AccumulationPass from './shaders/Accumulator/AccumulationPass.js';
import SpatialDenoiserPass from './shaders/Accumulator/SpatialDenoiserPass.js';
import TriangleSDF from './src/TriangleSDF.js';
import { OutputPass, RenderPass, RGBELoader } from 'three/examples/jsm/Addons.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

class PathTracer {

	constructor( containerElement, modelUrl, envUrl ) {

		this.container = containerElement;
		this.modelUrl = modelUrl;
		this.envUrl = envUrl;

		this.originalPixelRatio = window.devicePixelRatio / 2;

		this.scene = new Scene();
		this.camera = new PerspectiveCamera( 75, this.container.clientWidth / this.container.clientHeight, 0.01, 1000 );
		this.renderer = this.createRenderer();
		this.controls = new OrbitControls( this.camera, this.renderer.domElement );
		this.composer = new EffectComposer( this.renderer );
		this.stats = new Stats();

		containerElement.appendChild( this.stats.dom );

		this.dirLight = null;
		this.triangleSDF = null;
		this.renderPass = null;
		this.accPass = null;
		this.pathTracingPass = null;
		this.denoiserPass = null;

		this.setupEventListeners();
		this.setupDragAndDrop();

		window.scene = this.scene;

	}

	createRenderer() {

		const renderer = new WebGLRenderer( {
			clearAlpha: 1,
			antialias: false,
			alpha: false,
			logarithmicDepthBuffer: false,
			powerPreference: "high-performance",
		} );
		renderer.setClearColor( 0xffffff, 1 );
		renderer.toneMapping = ACESFilmicToneMapping;
		renderer.toneMappingExposure = Math.pow( 1.26, 4.0 );
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.setPixelRatio( this.originalPixelRatio );

		renderer.setSize( this.container.clientWidth, this.container.clientHeight );

		this.container.appendChild( renderer.domElement );
		return renderer;

	}

	async init() {

		await this.loadEnvironmentMap();
		await this.loadModel();
		this.setupScene();
		this.setupComposer();
		this.setupGUI();
		this.onResize();
		this.animate();

	}

	async loadEnvironmentMap() {

		const envType = this.envUrl.split( '.' ).pop();
		const loader = envType == 'png' || envType == 'jpg' ? new TextureLoader() : new RGBELoader();
		const envMap = await loader.loadAsync( this.envUrl );
		envMap.mapping = EquirectangularReflectionMapping;
		this.scene.background = envMap;
		this.scene.environment = envMap;

	}

	async loadModel() {

		const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
		const result = await loader.loadAsync( this.modelUrl );
		this.scene.add( result.scene );
		this.triangleSDF = new TriangleSDF( this.scene );

	}

	setupScene() {

		this.camera.position.set( 0, 0, 5 );
		this.controls.addEventListener( 'change', () => this.reset() );

		this.dirLight = new DirectionalLight( 0xffffff, 0 );
		this.dirLight.name = 'directionLight';
		this.dirLight.position.set( 1, 3, 0 );
		this.scene.add( this.dirLight );

	}

	setupComposer() {

		this.renderPass = new RenderPass( this.scene, this.camera );
		this.renderPass.enabled = false;
		this.composer.addPass( this.renderPass );

		this.pathTracingPass = new PathTracingShader( this.triangleSDF, this.container.clientWidth, this.container.clientHeight );
		this.pathTracingPass.enabled = true;
		this.composer.addPass( this.pathTracingPass );

		this.accPass = new AccumulationPass( this.scene, this.container.clientWidth, this.container.clientHeight );
		this.accPass.enabled = true;
		this.composer.addPass( this.accPass );

		this.denoiserPass = new SpatialDenoiserPass( this.container.clientWidth, this.container.clientHeight );
		this.denoiserPass.enabled = false;
		this.composer.addPass( this.denoiserPass );

		const outputPass = new OutputPass();
		this.composer.addPass( outputPass );

		this.onResize();

	}

	setupGUI() {

		const parameters = {
			resolution: this.renderer.getPixelRatio(),
			toneMappingExposure: Math.pow( this.renderer.toneMappingExposure, 1 / 4 ),
		};

		const pane = new Pane( { title: 'Parameters', expanded: true } );
		const sceneFolder = pane.addFolder( { title: 'Scene' } ).on( 'change', () => {

			this.reset();

		} );
		sceneFolder.addBinding( parameters, 'toneMappingExposure', { label: 'Exposue', min: 0, max: 4, step: 0.01 } ).on( 'change', e => this.renderer.toneMappingExposure = Math.pow( e.value, 4.0 ) );
		sceneFolder.addBinding( this.pathTracingPass.uniforms.enableEnvironmentLight, 'value', { label: 'Enable Enviroment' } );

		const cameraFolder = pane.addFolder( { title: 'Camera' } ).on( 'change', () => {

			this.reset();

		} );
		cameraFolder.addBinding( this.camera, 'fov', { label: 'FOV', min: 30, max: 90, step: 5 } ).on( 'change', () => {

			this.onResize();

		} );
		cameraFolder.addBinding( this.pathTracingPass.uniforms.focalDistance, 'value', { label: 'Focal Distance', min: 0, max: 100, step: 1 } );
		cameraFolder.addBinding( this.pathTracingPass.uniforms.aperture, 'value', { label: 'Aperture', min: 0, max: 1, step: 0.001 } );

		const ptFolder = pane.addFolder( { title: 'Path Tracer' } ).on( 'change', () => {

			this.reset();

		} );
		ptFolder.addBinding( this.pathTracingPass, 'enabled', { label: 'Enable' } ).on( 'change', e => {

			this.accPass.enabled = e.value;
			this.renderPass.enabled = ! e.value;

		} );
		ptFolder.addBinding( this.accPass, 'enabled', { label: 'Enable Accumulation' } );
		ptFolder.addBinding( this.pathTracingPass.uniforms.maxBounceCount, 'value', { label: 'Bounces', min: 1, max: 20, step: 1 } );
		ptFolder.addBinding( this.pathTracingPass.uniforms.numRaysPerPixel, 'value', { label: 'Samples Per Pixel', min: 1, max: 20, step: 1 } );
		ptFolder.addBinding( parameters, 'resolution', { label: 'Resolution', options: { 'Quarter': window.devicePixelRatio / 4, 'Half': window.devicePixelRatio / 2, 'Full': window.devicePixelRatio } } ).on( 'change', e => this.updateResolution( e.value ) );

		const lightFolder = pane.addFolder( { title: 'Directional Light' } ).on( 'change', () => {

			this.reset();

		} );
		lightFolder.addBinding( this.pathTracingPass.uniforms.directionalLightIntensity, 'value', { label: 'Intensity', min: 0, max: 10 } );
		lightFolder.addBinding( this.pathTracingPass.uniforms.directionalLightColor, 'value', { label: 'Color', color: { type: 'float' } } ).on( 'change', () => {

			this.pathTracingPass.uniforms.directionalLightColor.value.copy( this.dirLight.color );

		} );
		lightFolder.addBinding( this.dirLight, 'position', { label: 'Position' } ).on( 'change', () => {

			this.pathTracingPass.uniforms.directionalLightDirection.value.copy( this.dirLight.position ).normalize().negate();

		} );

		const debugFolder = pane.addFolder( { title: 'Debugger' } );
		debugFolder.addBinding( this.pathTracingPass.uniforms.visMode, 'value', { label: 'Mode', options: { 'Beauty': 0, 'Triangle test count': 1, 'Box test count': 2, 'Distance': 3, 'Normal': 4 } } ).on( 'change', () => {

			this.reset();

		} );
		debugFolder.addBinding( this.pathTracingPass.uniforms.debugVisScale, 'value', { label: 'Display Threshold', min: 1, max: 500, step: 1 } ).on( 'change', () => {

			this.reset();

		} );

		const denoisingFolder = pane.addFolder( { title: 'Denoising' } );
		denoisingFolder.addBinding( this.denoiserPass, 'enabled', { label: 'Enable Denoiser' } );
		denoisingFolder.addBinding( this.denoiserPass.denoiseQuad.material.uniforms.kernelSize, 'value', { label: 'Strenght', min: 1, max: 10, step: 1 } );

	}

	reset() {

		if ( this.accPass ) this.accPass.iteration = 0;

	}

	updateResolution( value ) {

		this.renderer.setPixelRatio( value );
		this.onResize();

	}

	onResize() {

		const width = this.container.clientWidth;
		const height = this.container.clientHeight;

		this.renderer.domElement.height = height;
		this.renderer.domElement.width = width;

		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize( width, height );
		this.composer.setSize( width, height );

		this.pathTracingPass.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );
		this.reset();

	}

	animate() {

		requestAnimationFrame( () => this.animate() );
		this.controls.update();

		if ( this.pathTracingPass.enabled ) {


			this.pathTracingPass.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.pathTracingPass.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );
			this.pathTracingPass.uniforms.frame.value ++;
			document.getElementById( 'sample-counts' ).textContent = `Iterations: ${this.accPass.iteration}`;

		}

		this.composer.render();
		this.stats.update();

	}

	setupEventListeners() {

		window.addEventListener( 'resize', () => this.onResize() );

	}

	setupDragAndDrop() {

		this.container.addEventListener( 'dragover', ( e ) => {

			e.preventDefault();
			e.stopPropagation();

		} );

		this.container.addEventListener( 'drop', ( e ) => {

			e.preventDefault();
			e.stopPropagation();

			const file = e.dataTransfer.files[ 0 ];
			if ( file && file.name.toLowerCase().endsWith( '.glb' ) ) {

				this.loadDroppedModel( file );

			} else {

				console.warn( 'Please drop a valid .glb file.' );

			}

		} );

	}

	async loadDroppedModel( file ) {

		const url = URL.createObjectURL( file );
		try {

			await this.loadNewModel( url );

		} finally {

			// revoke the object URL to avoid memory leaks
			URL.revokeObjectURL( url );

		}

	}

	async loadNewModel( url ) {

		this.disposeCurrentModel();

		const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
		const result = await loader.loadAsync( url );
		this.scene.add( result.scene );
		this.triangleSDF = new TriangleSDF( this.scene );
		this.pathTracingPass.update( this.triangleSDF );
		this.reset();

	}

	disposeCurrentModel() {

		this.scene.traverse( ( object ) => {

			if ( object.isMesh ) {

				object.geometry.dispose();
				if ( object.material.isMaterial ) {

					this.disposeMaterial( object.material );

				} else {

					for ( const material of object.material ) {

						this.disposeMaterial( material );

					}

				}

			}

		} );

		// Clear the scene of the old model
		while ( this.scene.children.length > 0 ) {

			this.scene.remove( this.scene.children[ 0 ] );

		}

		// Dispose of old TriangleSDF
		if ( this.triangleSDF ) {

			this.triangleSDF.dispose();
			this.triangleSDF = null;

		}

	}

	disposeMaterial( material ) {

		material.dispose();

		for ( const value of Object.values( material ) ) {

			if ( value && typeof value === 'object' && 'minFilter' in value ) {

				value.dispose(); // Dispose textures

			}

		}

	}

}

const container = document.getElementById( 'container-3d' );
// const MODEL_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/diamond/diamond.glb';
const MODEL_URL = './models/modernbathroom.glb';
// const ENV_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular.png';
const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/hdri/photo_studio_01_2k.hdr';

const pathTracer = new PathTracer( container, MODEL_URL, ENV_URL );
pathTracer.init();
