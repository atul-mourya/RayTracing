import {
    Scene,
    PerspectiveCamera,
    WebGLRenderer,
    ACESFilmicToneMapping,
    SRGBColorSpace,
    DirectionalLight,
    WebGLRenderTarget,
    RGBAFormat,
    FloatType,
    NearestFilter,
    Vector2,
    Mesh,
    PlaneGeometry,
    MeshStandardMaterial,
    EquirectangularReflectionMapping,
    Box3,
    Vector3,
    EventDispatcher
} from 'three';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Import custom passes and constants
import { PathTracerPass } from './Shaders/PathTracerPass';
import { AccumulationPass } from './Passes/AccumulationPass';
import { LygiaSmartDenoiserPass } from './Passes/LygiaSmartDenoiserPass';
import { TileHighlightPass } from './Passes/TileHighlightPass';
import { OIDNDenoiser } from './Passes/OIDNDenoiser';
import { TemporalReprojectionPass } from './Passes/TemporalReprojectionPass';
import { disposeObjectFromMemory } from './Processor/utils';
import { HDR_FILES, MODEL_FILES, DEFAULT_STATE  } from './Processor/Constants';

class PathTracerApp extends EventDispatcher {
    constructor(container) {
        super();
        this.container = container;
        this.width = container.clientWidth;
        this.height = container.clientHeight;

        this.scene = new Scene();
        this.camera = new PerspectiveCamera(DEFAULT_STATE.fov, this.width / this.height, 0.01, 1000);
        this.renderer = new WebGLRenderer({
            powerPreference: "high-performance",
            antialias: false,
            stencil: false,
            depth: false
        });

        // Initialize other properties
        this.controls = null;
        this.composer = null;
        this.pathTracingPass = null;
        this.accPass = null;
        this.denoiserPass = null;
        this.tileHighlightPass = null;
        this.temporalReprojectionPass = null;
        this.denoiser = null;
        this.targetModel = null;
        this.floorPlane = null;
        this.animationFrameId = null;
        this.pauseRendering = true;
        this.canvas = this.renderer.domElement;        

    }

    async init() {
        // Setup renderer
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = Math.pow(DEFAULT_STATE.exposure, 4.0);
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.setPixelRatio(DEFAULT_STATE.originalPixelRatio);
        this.renderer.setSize(this.width, this.height);
        this.container.appendChild(this.canvas);

        // Setup canvas
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.background = "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px;";

        // Setup camera
        this.camera.position.set(0, 0, 5);

        // Setup controls
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.addEventListener('change', () => this.reset());
        this.controls.update();

        // Setup lighting
        this.directionalLight = new DirectionalLight(DEFAULT_STATE.directionalLightColor, DEFAULT_STATE.directionalLightIntensity);
        this.directionalLight.position.fromArray(DEFAULT_STATE.directionalLightPosition);
        
        // this.scene.add(this.directionalLight);
        // let a = this.directionalLight.clone();
        // a.position.set(-this.directionalLight.position.x, this.directionalLight.position.y+ 2.0, this.directionalLight.position.z);
        // this.scene.add(a);

        // Setup composer and passes
        this.setupComposer();
        this.setupFloorPlane();

        // Load HDR background and model
        await this.loadEnvironment(DEFAULT_STATE.environment);
        await this.loadModel(DEFAULT_STATE.model);
        this.pauseRendering = false;

        // Start animation loop
        this.animate();

        window.addEventListener( 'resize', () => this.onResize() );

    }

    reset() {

        this.canvas.style.opacity = 1;
        this.pathTracingPass.reset();
        this.accPass.reset(this.renderer);
        this.temporalReprojectionPass.frameCount = 0;
        this.denoiser.abort();
        this.dispatchEvent({ type: 'RenderReset' });

    }

    setupComposer() {
        const renderTarget = new WebGLRenderTarget(this.width, this.height, {
            format: RGBAFormat,
            type: FloatType,
            minFilter: NearestFilter,
            magFilter: NearestFilter
        });

        this.composer = new EffectComposer(this.renderer, renderTarget);

        this.renderPass = new RenderPass(this.scene, this.camera);
        this.renderPass.enabled = false;
        this.composer.addPass(this.renderPass);

        this.pathTracingPass = new PathTracerPass(this.renderer, this.scene, this.camera, this.width, this.height);
        this.composer.addPass(this.pathTracingPass);

        this.accPass = new AccumulationPass(this.scene, this.width, this.height);
        this.composer.addPass(this.accPass);

        this.pathTracingPass.setAccumulationPass(this.accPass);

        this.temporalReprojectionPass = new TemporalReprojectionPass(this.scene, this.camera, this.width, this.height);
        this.temporalReprojectionPass.material.uniforms.blendFactor.value = 0.9;
        this.temporalReprojectionPass.material.uniforms.neighborhoodClampIntensity.value = 0.5;
        this.composer.addPass(this.temporalReprojectionPass);
        window.temporalReprojectionPass = this.temporalReprojectionPass;


        this.denoiserPass = new LygiaSmartDenoiserPass(this.width, this.height);
        this.denoiserPass.enabled = false;
        this.composer.addPass(this.denoiserPass);

        this.tileHighlightPass = new TileHighlightPass(new Vector2(this.width, this.height));
        this.tileHighlightPass.enabled = false;
        this.composer.addPass(this.tileHighlightPass);

        const outputPass = new OutputPass();
        this.composer.addPass(outputPass);

        this.denoiser = new OIDNDenoiser(this.renderer, this.scene, this.camera);
        this.denoiser.enabled = DEFAULT_STATE.enableDenoiser;
    }

    setupFloorPlane() {
        this.floorPlane = new Mesh(
            new PlaneGeometry(),
            new MeshStandardMaterial({
                transparent: false,
                color: 0x555555,
                roughness: 0.05,
                metalness: 0.0,
            })
        );
        // this.scene.add(this.floorPlane);
    }

    animate = () => {

        this.animationFrameId = requestAnimationFrame(this.animate);

        if (this.pauseRendering) return;

        if (!this.pathTracingPass.isComplete ) {
            this.controls.update();
            this.tileHighlightPass.uniforms.frame.value = this.pathTracingPass.material.uniforms.frame.value + 1;
            this.tileHighlightPass.uniforms.renderMode.value = this.pathTracingPass.material.uniforms.renderMode.value;
            this.tileHighlightPass.uniforms.tiles.value = this.pathTracingPass.material.uniforms.tiles.value;

            this.composer.render();

            if (this.onStatsUpdate) {
                this.onStatsUpdate({
                    timeElapsed: this.accPass.timeElapsed,
                    samples: this.accPass.iteration
                });
            }
        }

        if (this.pathTracingPass.isComplete && this.pathTracingPass.material.uniforms.frame.value === this.pathTracingPass.material.uniforms.maxFrames.value) {
            this.pathTracingPass.material.uniforms.frame.value++;
            this.denoiser.start();
            this.dispatchEvent({ type: 'RenderComplete' });
        }

    };

    async loadEnvironment(index) {
        const envUrl = `${HDR_FILES[index].url}`;
        const loader = new RGBELoader();
        loader.setDataType(FloatType);
        this.pauseRendering = true;

        try {
            const texture = await loader.loadAsync(envUrl);
            texture.mapping = EquirectangularReflectionMapping;

            this.scene.background = texture;
            this.scene.environment = texture;

            if (this.pathTracingPass) {
                this.pathTracingPass.material.uniforms.environmentIntensity.value = this.scene.environmentIntensity;
                this.pathTracingPass.material.uniforms.environment.value = texture;
                this.pathTracingPass.reset();
            }
            this.pauseRendering = false;
        } catch (error) {
            this.pauseRendering = false;
            console.error("Error loading HDR background:", error);
            throw error;
        }
    }

    async loadModel(index) {
        const modelUrl = `${MODEL_FILES[index].url}`;
        const loader = await this.createGLTFLoader();
        this.pauseRendering = true;

        try {
            const gltf = await loader.loadAsync(modelUrl);
            if (this.targetModel) disposeObjectFromMemory( this.targetModel );
            this.targetModel = gltf.scene;

            this.onModelLoad(this.targetModel);
            this.pauseRendering = false;
            loader.dracoLoader.dispose();
            
        } catch (error) {
            this.pauseRendering = false;
            loader.dracoLoader.dispose();
            console.error("Error loading model:", error);
            throw error;
        }
    }

    async createGLTFLoader() {

		const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderConfig({ type: 'js' });
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

		const loader = new GLTFLoader();
		loader.setDRACOLoader( dracoLoader );
		loader.setMeshoptDecoder( MeshoptDecoder );

		return loader;

	}

    async loadGLBFromArrayBuffer( arrayBuffer ) {

        // const loader = new GLTFLoader().setMeshoptDecoder( MeshoptDecoder );
        const loader = await this.createGLTFLoader();
        loader.parse( arrayBuffer, '', gltf => {
    
            disposeObjectFromMemory( this.targetModel );
            this.targetModel = gltf.scene;
            this.onModelLoad( this.targetModel );
            this.pauseRendering = false;
            loader.dracoLoader.dispose();
    
        }, undefined, ( error ) => {
    
            alert( 'Error loading GLB:', error );
            this.pauseRendering = false;
    
        } );
    
    }

    onModelLoad( model ) {

        this.scene.add(model);

        // Center model and adjust camera
        const box = new Box3().setFromObject(model);
        const center = box.getCenter(new Vector3());
        const size = box.getSize(new Vector3());

        this.controls.target.copy(center);

        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this.camera.fov * (Math.PI / 180);
        const cameraDistance = Math.abs(maxDim / Math.sin(fov / 2) / 2);

        const direction = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
        this.camera.position.copy(direction.multiplyScalar(cameraDistance).add(this.controls.target));

        this.camera.near = maxDim / 100;
        this.camera.far = maxDim * 100;
        this.camera.updateProjectionMatrix();
        this.controls.maxDistance = cameraDistance * 10;

        this.controls.update();

        // Adjust floor plane
        const floorY = box.min.y;
        this.floorPlane.position.y = floorY;
        this.floorPlane.rotation.x = -Math.PI / 2;
        this.floorPlane.scale.setScalar(maxDim * 3);

        // Rebuild path tracing
        this.pathTracingPass.build(this.scene);
        this.pathTracingPass.reset();
        this.pauseRendering = false;
        this.dispatchEvent({ type: 'SceneRebuild' });

    }

    updateResolution( value ) {

        this.renderer.setPixelRatio( value );
        this.composer.setPixelRatio( value );
        this.onResize();
    
    }

    setTemporalBlendFactor(factor) {
        if (this.temporalReprojectionPass) {
            this.temporalReprojectionPass.material.uniforms.blendFactor.value = factor;
        }
    }

    onResize() {

    
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
    
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize( width, height );
        this.composer.setSize( width, height );
        this.denoiser.setSize( width, height );
        if (this.temporalReprojectionPass) {
            this.temporalReprojectionPass.setSize(width, height);
        }
        this.reset();
    
    }

    setOnStatsUpdate(callback) {
        this.onStatsUpdate = callback;
    }

    dispose() {
        cancelAnimationFrame(this.animationFrameId);
        // Dispose of js objects, remove event listeners, etc.
    }
}

export default PathTracerApp;