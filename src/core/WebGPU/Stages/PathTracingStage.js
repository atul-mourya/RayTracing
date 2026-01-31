import { Fn, vec4, texture, uv, uniform, bool } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Vector2, Matrix4, Vector3 } from 'three';

import { pathTracerMain } from '../TSL/PathTracer.js';

/**
 * Data layout constants
 */
const BVH_VEC4_PER_NODE = 3;
const TRI_VEC4_PER_TRIANGLE = 8;
const PIXELS_PER_MATERIAL = 27;

/**
 * Default render target options
 */
const DEFAULT_RT_OPTIONS = {
	type: HalfFloatType,
	format: RGBAFormat,
	minFilter: NearestFilter,
	magFilter: NearestFilter,
	depthBuffer: false,
	stencilBuffer: false
};

/**
 * Path Tracing Stage for WebGPU.
 *
 * Implements multi-bounce Monte Carlo path tracing with:
 * - BVH-accelerated ray traversal
 * - GGX/Diffuse BSDF sampling
 * - Environment lighting
 * - Progressive accumulation
 * - MRT outputs for denoising (normal/depth, albedo)
 */
export class PathTracingStage {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {PerspectiveCamera} camera - Three.js camera
	 */
	constructor( renderer, camera ) {

		this.renderer = renderer;
		this.camera = camera;

		this._initDataTextures();
		this._initRenderTargets();
		this._initUniforms();
		this._initRenderingState();

	}

	/**
	 * Initialize data texture references and metadata
	 */
	_initDataTextures() {

		// Triangle data
		this.triangleTexture = null;
		this.triangleTexSize = new Vector2();
		this.triangleCount = 0;

		// BVH data
		this.bvhTexture = null;
		this.bvhTexSize = new Vector2();
		this.bvhNodeCount = 0;

		// Material data
		this.materialTexture = null;
		this.materialTexSize = new Vector2();
		this.materialCount = 0;

		// Environment map
		this.environmentTexture = null;
		this.envTexSize = new Vector2();

		// Environment importance sampling
		this.envMarginalWeights = null;
		this.envConditionalWeights = null;

		// Lights
		this.directionalLights = null;
		this.pointLights = null;
		this.spotLights = null;
		this.areaLights = null;

		// Blue noise
		this.blueNoiseTexture = null;

		// Emissive triangles
		this.emissiveTriangleTexture = null;

		// Adaptive sampling
		this.adaptiveSamplingTexture = null;

		// Material texture arrays
		this.albedoMaps = null;
		this.emissiveMaps = null;
		this.normalMaps = null;
		this.bumpMaps = null;
		this.roughnessMaps = null;
		this.metalnessMaps = null;
		this.displacementMaps = null;

		// Spheres
		this.spheres = [];

	}

	/**
	 * Initialize render target state
	 */
	_initRenderTargets() {

		// Ping-pong accumulation targets
		this.renderTargetA = null;
		this.renderTargetB = null;
		this.currentTarget = 0;
		this.renderWidth = 0;
		this.renderHeight = 0;

		// MRT targets for denoising
		this.normalDepthTarget = null;
		this.albedoTarget = null;
		this.enableMRT = true;

	}

	/**
	 * Initialize all uniforms grouped by category
	 */
	_initUniforms() {

		// Frame and sampling
		this.frame = uniform( 0 ).toUint();
		this.maxBounces = uniform( 4 );
		this.samplesPerPixel = uniform( 1 );
		this.maxSamples = uniform( 2048 );
		this.transmissiveBounces = uniform( 10 );
		this.visMode = uniform( 0 );
		this.debugVisScale = uniform( 1.0 );

		// Accumulation
		this.enableAccumulation = uniform( 1 );
		this.accumulationAlpha = uniform( 0.0 );
		this.cameraIsMoving = uniform( 0 );
		this.hasPreviousAccumulated = uniform( 0 );

		// Environment
		this.environmentIntensity = uniform( 1.0 );
		this.backgroundIntensity = uniform( 1.0 );
		this.showBackground = uniform( 1 );
		this.enableEnvironment = uniform( 1 );
		this.environmentMatrix = uniform( new Matrix4() );
		this.useEnvMapIS = uniform( 1 );
		this.envTotalSum = uniform( 0.0 );
		this.envResolution = uniform( new Vector2( 1, 1 ) );

		// Sun parameters
		this.sunDirection = uniform( new Vector3( 0, 1, 0 ) );
		this.sunAngularSize = uniform( 0.0087 );
		this.hasSun = uniform( 0 );

		// Lighting
		this.globalIlluminationIntensity = uniform( 1.0 );
		this.exposure = uniform( 1.0 );

		// Camera matrices
		this.cameraWorldMatrix = uniform( new Matrix4() );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4() );
		this.cameraViewMatrix = uniform( new Matrix4() );
		this.cameraProjectionMatrix = uniform( new Matrix4() );

		// DOF
		this.enableDOF = uniform( 0 );
		this.focusDistance = uniform( 5.0 );
		this.focalLength = uniform( 50.0 );
		this.aperture = uniform( 0.0 );
		this.apertureScale = uniform( 1.0 );
		this.sceneScale = uniform( 1.0 );

		// Sampling
		this.samplingTechnique = uniform( 0 );
		this.useAdaptiveSampling = uniform( 0 );
		this.adaptiveSamplingMax = uniform( 32 );
		this.fireflyThreshold = uniform( 10.0 );

		// Emissive
		this.enableEmissiveTriangleSampling = uniform( 1 );
		this.emissiveBoost = uniform( 1.0 );
		this.emissiveTriangleTexSize = uniform( new Vector2() );
		this.emissiveTriangleCount = uniform( 0 );

		// Render mode
		this.renderMode = uniform( 0 );

		// Resolution (for RNG seeding)
		this.resolution = uniform( new Vector2( 1920, 1080 ) );

		// Texture size uniforms
		this.triangleTexSizeUniform = uniform( new Vector2( 1, 1 ) );
		this.bvhTexSizeUniform = uniform( new Vector2( 1, 1 ) );
		this.materialTexSizeUniform = uniform( new Vector2( 1, 1 ) );

		// Scene data
		this.totalTriangleCount = uniform( 0 );

		// Blue noise
		this.blueNoiseTextureSize = uniform( new Vector2() );

	}

	/**
	 * Initialize rendering state
	 */
	_initRenderingState() {

		// Materials and quads
		this.pathTraceMaterial = null;
		this.accumMaterial = null;
		this.displayMaterial = null;
		this.normalDepthMaterial = null;
		this.albedoMaterial = null;

		this.pathTraceQuad = null;
		this.accumQuad = null;
		this.displayQuad = null;
		this.normalDepthQuad = null;
		this.albedoQuad = null;

		// Texture nodes (for dynamic updates)
		this.prevFrameTexNode = null;
		this.displayTexNode = null;

		// State flags
		this.isReady = false;
		this.frameCount = 0;

	}

	/**
	 * Sets the triangle data texture.
	 * @param {DataTexture} triangleTex
	 */
	setTriangleTexture( triangleTex ) {

		if ( ! triangleTex ) return;

		this.triangleTexture = triangleTex;

		const { width, height } = triangleTex.image;
		this.triangleTexSize.set( width, height );
		this.triangleTexSizeUniform.value.set( width, height );

		const totalVec4s = width * height;
		this.triangleCount = Math.floor( totalVec4s / TRI_VEC4_PER_TRIANGLE );

		console.log( `PathTracingStage: ${this.triangleCount} triangles` );

	}

	/**
	 * Sets the BVH data texture.
	 * @param {DataTexture} bvhTex
	 */
	setBVHTexture( bvhTex ) {

		if ( ! bvhTex ) return;

		this.bvhTexture = bvhTex;

		const { width, height } = bvhTex.image;
		this.bvhTexSize.set( width, height );
		this.bvhTexSizeUniform.value.set( width, height );

		const totalVec4s = width * height;
		this.bvhNodeCount = Math.floor( totalVec4s / BVH_VEC4_PER_NODE );

		console.log( `PathTracingStage: ${this.bvhNodeCount} BVH nodes` );

	}

	/**
	 * Sets the material data texture.
	 * @param {DataTexture} materialTex
	 */
	setMaterialTexture( materialTex ) {

		if ( ! materialTex ) return;

		this.materialTexture = materialTex;

		const { width, height } = materialTex.image;
		this.materialTexSize.set( width, height );
		this.materialTexSizeUniform.value.set( width, height );

		const totalPixels = width * height;
		this.materialCount = Math.floor( totalPixels / PIXELS_PER_MATERIAL );

		console.log( `PathTracingStage: ${this.materialCount} materials (${width}x${height})` );

		this._logFirstMaterialDebug( materialTex );

	}

	/**
	 * Debug log for first material's data
	 * @param {DataTexture} materialTex
	 */
	_logFirstMaterialDebug( materialTex ) {

		const data = materialTex.image?.data;
		if ( ! data || this.materialCount === 0 ) return;

		// First pixel: color.rgb, metalness
		const r = data[ 0 ];
		const g = data[ 1 ];
		const b = data[ 2 ];
		const metalness = data[ 3 ];

		// Second pixel: emissive.rgb, roughness
		const roughness = data[ 7 ];

		console.log( `  Material 0: color=(${r.toFixed( 3 )}, ${g.toFixed( 3 )}, ${b.toFixed( 3 )}), metalness=${metalness.toFixed( 3 )}, roughness=${roughness.toFixed( 3 )}` );

	}

	/**
	 * Sets the environment map texture.
	 * @param {Texture} envTex
	 */
	setEnvironmentTexture( envTex ) {

		if ( ! envTex ) return;

		this.environmentTexture = envTex;
		this.envTexSize.set( envTex.image.width, envTex.image.height );

		console.log( `PathTracingStage: Environment map ${envTex.image.width}x${envTex.image.height}` );

	}

	/**
	 * Creates render targets for accumulation.
	 * @param {number} width
	 * @param {number} height
	 */
	createRenderTargets( width, height ) {

		this._disposeRenderTargets();

		this.renderWidth = width;
		this.renderHeight = height;

		// Accumulation targets
		this.renderTargetA = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
		this.renderTargetB = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );

		// MRT targets for denoising
		if ( this.enableMRT ) {

			this.normalDepthTarget = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
			this.albedoTarget = new RenderTarget( width, height, DEFAULT_RT_OPTIONS );
			console.log( `PathTracingStage: Created MRT targets (normalDepth, albedo)` );

		}

		// Update resolution uniform for RNG seeding
		this.resolution.value.set( width, height );

		console.log( `PathTracingStage: Created ${width}x${height} render targets` );

	}

	/**
	 * Dispose existing render targets
	 */
	_disposeRenderTargets() {

		this.renderTargetA?.dispose();
		this.renderTargetB?.dispose();
		this.normalDepthTarget?.dispose();
		this.albedoTarget?.dispose();

		this.renderTargetA = null;
		this.renderTargetB = null;
		this.normalDepthTarget = null;
		this.albedoTarget = null;

	}

	/**
	 * Creates the path tracing material and quad.
	 */
	setupMaterial() {

		if ( ! this.triangleTexture ) {

			console.error( 'PathTracingStage: Triangle data required' );
			return;

		}

		if ( ! this.bvhTexture ) {

			console.error( 'PathTracingStage: BVH data required' );
			return;

		}

		this._ensureRenderTargets();

		const textureNodes = this._createTextureNodes();
		const ptOutput = this._createPathTracerOutput( textureNodes );

		this._createPathTraceMaterials( ptOutput );
		this._createDisplayMaterial();

		if ( this.enableMRT ) {

			this._createMRTMaterials( ptOutput );

		}

		this.isReady = true;
		console.log( 'PathTracingStage: Material setup complete' );

	}

	/**
	 * Ensure render targets exist at correct size
	 */
	_ensureRenderTargets() {

		const canvas = this.renderer.domElement;
		const width = Math.max( 1, canvas.width || 800 );
		const height = Math.max( 1, canvas.height || 600 );

		if ( this.renderWidth !== width || this.renderHeight !== height || ! this.renderTargetA ) {

			this.createRenderTargets( width, height );

		}

	}

	/**
	 * Create texture nodes for shader
	 * @returns {Object} Texture nodes and metadata
	 */
	_createTextureNodes() {

		const triTex = texture( this.triangleTexture );
		const bvhTex = texture( this.bvhTexture );

		const hasMaterials = this.materialTexture !== null;
		const matTex = hasMaterials ? texture( this.materialTexture ) : triTex;
		const matTexSize = hasMaterials ? this.materialTexSizeUniform : this.triangleTexSizeUniform;

		const hasEnv = this.environmentTexture !== null;
		const envTex = hasEnv ? texture( this.environmentTexture ) : triTex;

		// Previous frame texture for accumulation
		const prevFrameTex = texture( this.renderTargetA.texture );
		this.prevFrameTexNode = prevFrameTex;

		return {
			triTex,
			bvhTex,
			matTex,
			matTexSize,
			envTex,
			prevFrameTex,
			hasMaterials,
			hasEnv
		};

	}

	/**
	 * Create path tracer output
	 * @param {Object} textureNodes
	 * @returns {Object} Path tracer output nodes
	 */
	_createPathTracerOutput( textureNodes ) {

		const { triTex, bvhTex, matTex, matTexSize, envTex, prevFrameTex, hasMaterials, hasEnv } = textureNodes;

		// Note on types:
		// - Uniforms (this.xxx) are already TSL nodes with correct types from uniform()
		// - Texture nodes (triTex, etc.) are already typed from texture()
		// - JS primitives (hasMaterials, hasEnv) need explicit bool() conversion

		return pathTracerMain(
			// Derived values
			uv().mul( this.resolution ).toVar( 'fragCoord' ),

			// Uniforms - already typed, just need .toVar() for naming
			this.resolution.toVar( 'resolution' ),
			this.frame.toVar( 'frame' ),
			this.samplesPerPixel.toVar( 'samplesPerPixel' ),
			this.visMode.toVar( 'visMode' ),

			// Camera matrices
			this.cameraWorldMatrix.toVar( 'cameraWorldMatrix' ),
			this.cameraProjectionMatrixInverse.toVar( 'cameraProjectionMatrixInverse' ),
			this.cameraViewMatrix.toVar( 'cameraViewMatrix' ),
			this.cameraProjectionMatrix.toVar( 'cameraProjectionMatrix' ),

			// BVH data
			bvhTex, //.toVar( 'bvhTex' ),
			this.bvhTexSizeUniform.toVar( 'bvhTexSize' ),

			// Triangle data
			triTex, //.toVar( 'triTex' ),
			this.triangleTexSizeUniform.toVar( 'triTexSize' ),

			// Material data
			matTex, //.toVar( 'matTex' ),
			matTexSize.toVar( 'matTexSize' ),

			// Environment
			envTex, //.toVar( 'envTex' ),

			// JS booleans - need explicit bool() conversion
			bool( hasMaterials ).toVar( 'hasMaterials' ),
			bool( hasEnv ).toVar( 'hasEnv' ),

			// More uniforms
			this.environmentIntensity.toVar( 'envIntensity' ),
			this.environmentMatrix.toVar( 'environmentMatrix' ),
			this.maxBounces.toVar( 'maxBounces' ),
			this.totalTriangleCount.toVar( 'totalTriangleCount' ),

			// Accumulation
			this.enableAccumulation.toVar( 'enableAccumulation' ),
			this.hasPreviousAccumulated.toVar( 'hasPreviousAccumulated' ),
			prevFrameTex, //.toVar( 'previousFrameTex' ),
			this.accumulationAlpha.toVar( 'accumulationAlpha' ),
			this.cameraIsMoving.toVar( 'cameraIsMoving' )
		);

	}

	/**
	 * Create path trace and accumulation materials
	 * @param {Object} ptOutput
	 */
	_createPathTraceMaterials( ptOutput ) {

		this.pathTraceMaterial = new MeshBasicNodeMaterial();
		this.pathTraceMaterial.colorNode = ptOutput.get( 'gColor' );
		this.pathTraceQuad = new QuadMesh( this.pathTraceMaterial );

		this.accumMaterial = new MeshBasicNodeMaterial();
		this.accumMaterial.colorNode = ptOutput.get( 'gColor' );
		this.accumQuad = new QuadMesh( this.accumMaterial );

	}

	/**
	 * Create display material for final output
	 */
	_createDisplayMaterial() {

		const displayTex = texture( this.renderTargetA.texture );
		this.displayTexNode = displayTex;

		const displayShader = Fn( () => {

			const color = displayTex.sample( uv() );
			return vec4( color.xyz, 1.0 );

		} );

		this.displayMaterial = new MeshBasicNodeMaterial();
		this.displayMaterial.colorNode = displayShader();
		this.displayQuad = new QuadMesh( this.displayMaterial );

	}

	/**
	 * Create MRT materials for denoising G-buffer
	 * @param {Object} ptOutput
	 */
	_createMRTMaterials( ptOutput ) {

		this.normalDepthMaterial = new MeshBasicNodeMaterial();
		this.normalDepthMaterial.colorNode = ptOutput.gNormalDepth;
		this.normalDepthQuad = new QuadMesh( this.normalDepthMaterial );

		this.albedoMaterial = new MeshBasicNodeMaterial();
		this.albedoMaterial.colorNode = ptOutput.gAlbedo;
		this.albedoQuad = new QuadMesh( this.albedoMaterial );

		console.log( 'PathTracingStage: MRT shaders created' );

	}

	/**
	 * Renders the path tracing pass with accumulation.
	 */
	render() {

		if ( ! this.isReady ) return;

		this._handleResize();
		this._updateCameraUniforms();

		this.frame.value = this.frameCount;

		const { readTarget, writeTarget } = this._getTargets();

		// Update previous frame texture
		if ( this.prevFrameTexNode ) {

			this.prevFrameTexNode.value = readTarget.texture;

		}

		// Render accumulation pass
		this.renderer.setRenderTarget( writeTarget );
		this.accumQuad.render( this.renderer );

		// Render MRT passes on first frame
		if ( this.enableMRT && this.frameCount === 0 ) {

			this._renderMRTPasses();

		}

		// Update display texture and render to screen
		if ( this.displayTexNode ) {

			this.displayTexNode.value = writeTarget.texture;

		}

		this.renderer.setRenderTarget( null );
		this.displayQuad.render( this.renderer );

		// Swap targets
		this.currentTarget = 1 - this.currentTarget;
		this.frameCount ++;

	}

	/**
	 * Handle canvas resize
	 */
	_handleResize() {

		const canvas = this.renderer.domElement;
		const { width, height } = canvas;

		if ( width !== this.renderWidth || height !== this.renderHeight ) {

			this.createRenderTargets( width, height );
			this.frameCount = 0;

		}

		this.resolution.value.set( width, height );

	}

	/**
	 * Update camera uniforms
	 */
	_updateCameraUniforms() {

		this.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
		this.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

	}

	/**
	 * Get read and write targets for ping-pong
	 * @returns {Object} { readTarget, writeTarget }
	 */
	_getTargets() {

		const readTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;
		const writeTarget = this.currentTarget === 0 ? this.renderTargetB : this.renderTargetA;

		return { readTarget, writeTarget };

	}

	/**
	 * Render MRT passes for G-buffer
	 */
	_renderMRTPasses() {

		if ( ! this.normalDepthTarget || ! this.albedoTarget ) return;

		this.renderer.setRenderTarget( this.normalDepthTarget );
		this.normalDepthQuad.render( this.renderer );

		this.renderer.setRenderTarget( this.albedoTarget );
		this.albedoQuad.render( this.renderer );

	}

	/**
	 * Gets the MRT textures for denoising stages.
	 * @returns {Object} { color, normalDepth, albedo }
	 */
	getMRTTextures() {

		const currentTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;

		return {
			color: currentTarget?.texture ?? null,
			normalDepth: this.normalDepthTarget?.texture ?? null,
			albedo: this.albedoTarget?.texture ?? null
		};

	}

	/**
	 * Resets the accumulation.
	 */
	reset() {

		this.frameCount = 0;
		this.currentTarget = 0;

		if ( ! this.renderTargetA || ! this.renderTargetB || ! this.renderer ) return;

		const currentRT = this.renderer.getRenderTarget();

		this.renderer.setRenderTarget( this.renderTargetA );
		this.renderer.clear( true, false, false );

		this.renderer.setRenderTarget( this.renderTargetB );
		this.renderer.clear( true, false, false );

		this.renderer.setRenderTarget( currentRT );

	}

	// ============ Uniform Setters ============

	setMaxBounces( bounces ) {

		this.maxBounces.value = bounces;

	}

	setSamplesPerPixel( samples ) {

		this.samplesPerPixel.value = samples;

	}

	setMaxSamples( samples ) {

		this.maxSamples.value = samples;

	}

	setTransmissiveBounces( bounces ) {

		this.transmissiveBounces.value = bounces;

	}

	setEnvironmentIntensity( intensity ) {

		this.environmentIntensity.value = intensity;

	}

	setBackgroundIntensity( intensity ) {

		this.backgroundIntensity.value = intensity;

	}

	setShowBackground( show ) {

		this.showBackground.value = show ? 1 : 0;

	}

	setEnableEnvironment( enable ) {

		this.enableEnvironment.value = enable ? 1 : 0;

	}

	setGlobalIlluminationIntensity( intensity ) {

		this.globalIlluminationIntensity.value = intensity;

	}

	setExposure( exposure ) {

		this.exposure.value = exposure;

	}

	setEnvironmentMatrix( matrix ) {

		this.environmentMatrix.value.copy( matrix );

	}

	setEnableAccumulation( enable ) {

		this.enableAccumulation.value = enable ? 1 : 0;

	}

	setAccumulationAlpha( alpha ) {

		this.accumulationAlpha.value = alpha;

	}

	setCameraIsMoving( moving ) {

		this.cameraIsMoving.value = moving ? 1 : 0;

	}

	setHasPreviousAccumulated( has ) {

		this.hasPreviousAccumulated.value = has ? 1 : 0;

	}

	setTotalTriangleCount( count ) {

		this.totalTriangleCount.value = count;

	}

	setVisMode( mode ) {

		this.visMode.value = mode;

	}

	setDebugVisScale( scale ) {

		this.debugVisScale.value = scale;

	}

	// DOF setters

	setEnableDOF( enable ) {

		this.enableDOF.value = enable ? 1 : 0;

	}

	setFocusDistance( distance ) {

		this.focusDistance.value = distance;

	}

	setFocalLength( length ) {

		this.focalLength.value = length;

	}

	setAperture( aperture ) {

		this.aperture.value = aperture;

	}

	setApertureScale( scale ) {

		this.apertureScale.value = scale;

	}

	setSceneScale( scale ) {

		this.sceneScale.value = scale;

	}

	// Sampling setters

	setSamplingTechnique( technique ) {

		this.samplingTechnique.value = technique;

	}

	setUseAdaptiveSampling( use ) {

		this.useAdaptiveSampling.value = use ? 1 : 0;

	}

	setAdaptiveSamplingMax( max ) {

		this.adaptiveSamplingMax.value = max;

	}

	setFireflyThreshold( threshold ) {

		this.fireflyThreshold.value = threshold;

	}

	// Emissive setters

	setEnableEmissiveTriangleSampling( enable ) {

		this.enableEmissiveTriangleSampling.value = enable ? 1 : 0;

	}

	setEmissiveBoost( boost ) {

		this.emissiveBoost.value = boost;

	}

	setEmissiveTriangleCount( count ) {

		this.emissiveTriangleCount.value = count;

	}

	// Environment importance sampling setters

	setUseEnvMapIS( use ) {

		this.useEnvMapIS.value = use ? 1 : 0;

	}

	setEnvMarginalWeights( tex ) {

		this.envMarginalWeights = tex;

	}

	setEnvConditionalWeights( tex ) {

		this.envConditionalWeights = tex;

	}

	setEnvTotalSum( sum ) {

		this.envTotalSum.value = sum;

	}

	setEnvResolution( width, height ) {

		this.envResolution.value.set( width, height );

	}

	// Sun setters

	setSunDirection( direction ) {

		this.sunDirection.value.copy( direction );

	}

	setSunAngularSize( size ) {

		this.sunAngularSize.value = size;

	}

	setHasSun( hasSun ) {

		this.hasSun.value = hasSun ? 1 : 0;

	}

	// Light setters

	setDirectionalLights( lights ) {

		this.directionalLights = lights;

	}

	setPointLights( lights ) {

		this.pointLights = lights;

	}

	setSpotLights( lights ) {

		this.spotLights = lights;

	}

	setAreaLights( lights ) {

		this.areaLights = lights;

	}

	// Texture setters

	setBlueNoiseTexture( tex ) {

		this.blueNoiseTexture = tex;
		if ( tex?.image ) {

			this.blueNoiseTextureSize.value.set( tex.image.width, tex.image.height );

		}

	}

	setEmissiveTriangleTexture( tex ) {

		this.emissiveTriangleTexture = tex;
		if ( tex?.image ) {

			this.emissiveTriangleTexSize.value.set( tex.image.width, tex.image.height );

		}

	}

	setAdaptiveSamplingTexture( tex ) {

		this.adaptiveSamplingTexture = tex;

	}

	setMaterialTextures( textures ) {

		if ( textures.albedoMaps ) this.albedoMaps = textures.albedoMaps;
		if ( textures.emissiveMaps ) this.emissiveMaps = textures.emissiveMaps;
		if ( textures.normalMaps ) this.normalMaps = textures.normalMaps;
		if ( textures.bumpMaps ) this.bumpMaps = textures.bumpMaps;
		if ( textures.roughnessMaps ) this.roughnessMaps = textures.roughnessMaps;
		if ( textures.metalnessMaps ) this.metalnessMaps = textures.metalnessMaps;
		if ( textures.displacementMaps ) this.displacementMaps = textures.displacementMaps;

	}

	// Render mode

	setRenderMode( mode ) {

		this.renderMode.value = mode;

	}

	// Spheres

	setSpheres( spheres ) {

		this.spheres = spheres;

	}

	/**
	 * Disposes of GPU resources.
	 */
	dispose() {

		// Dispose materials
		this.pathTraceMaterial?.dispose();
		this.accumMaterial?.dispose();
		this.displayMaterial?.dispose();
		this.normalDepthMaterial?.dispose();
		this.albedoMaterial?.dispose();

		// Dispose render targets
		this._disposeRenderTargets();

		// Clear texture references
		this.triangleTexture = null;
		this.bvhTexture = null;
		this.materialTexture = null;
		this.environmentTexture = null;

		// Clear texture nodes
		this.prevFrameTexNode = null;
		this.displayTexNode = null;

		this.isReady = false;

	}

}
