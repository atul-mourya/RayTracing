/**
 * ShaderComposer.js
 * Owns TSL shader graph construction, texture node management, and material
 * creation for the path tracing pipeline.
 *
 * Texture nodes are created once and updated in-place via .value mutation
 * to preserve compiled shader graph references.
 */

import { Fn, vec4, texture, uv, mrt } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, TextureNode } from 'three/webgpu';
import { LinearFilter, DataArrayTexture } from 'three';
import { pathTracerMain } from '../TSL/PathTracer.js';
import BuildTimer from './BuildTimer.js';

export class ShaderComposer {

	constructor() {

		// Materials and quads
		this.accumMaterial = null;
		this.accumQuad = null;
		this.displayMaterial = null;
		this.displayQuad = null;

		// Texture nodes (for in-place updates)
		this.prevFrameTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;
		this.displayTexNode = null;
		this.adaptiveSamplingTexNode = null;

		// Scene texture nodes cache (for in-place updates on model change)
		this._sceneTextureNodes = null;

	}

	/**
	 * Creates the full shader graph from scratch.
	 * Called once during initial setup. Subsequent calls use updateSceneTextures().
	 *
	 * @param {Object} config
	 * @param {Object} config.stage - PathTracingStage instance (for uniform getters)
	 * @param {Object} config.renderTargets - RenderTargetPool
	 */
	setupMaterial( config ) {

		const { stage, renderTargets } = config;

		const timer = new BuildTimer( 'setupMaterial' );

		timer.start( 'Create texture nodes' );
		const textureNodes = this._createTextureNodes( stage, renderTargets );
		timer.end( 'Create texture nodes' );

		timer.start( 'Create path tracer output (TSL)' );
		const ptOutput = this._createPathTracerOutput( stage, textureNodes );
		timer.end( 'Create path tracer output (TSL)' );

		timer.start( 'Create path trace materials' );
		this._createPathTraceMaterials( ptOutput );
		timer.end( 'Create path trace materials' );

		timer.start( 'Create display material' );
		this._createDisplayMaterial( stage, renderTargets );
		timer.end( 'Create display material' );

		timer.print();

	}

	/**
	 * Updates texture node values in-place after a model change.
	 * Avoids rebuilding the entire TSL shader graph.
	 *
	 * @param {Object} stage - PathTracingStage instance
	 */
	updateSceneTextures( stage ) {

		const nodes = this._sceneTextureNodes;

		// Triangle, BVH, and material storage buffers are already updated
		// in-place by setTriangleData() / setBVHData() / setMaterialData()

		const env = stage.environment;
		const mat = stage.materialData;

		if ( env.environmentTexture && nodes.envTex ) {

			nodes.envTex.value = env.environmentTexture;

		}

		// Update material texture arrays
		if ( mat.albedoMaps && nodes.albedoMapsTex ) nodes.albedoMapsTex.value = mat.albedoMaps;
		if ( mat.normalMaps && nodes.normalMapsTex ) nodes.normalMapsTex.value = mat.normalMaps;
		if ( mat.bumpMaps && nodes.bumpMapsTex ) nodes.bumpMapsTex.value = mat.bumpMaps;
		if ( mat.metalnessMaps && nodes.metalnessMapsTex ) nodes.metalnessMapsTex.value = mat.metalnessMaps;
		if ( mat.roughnessMaps && nodes.roughnessMapsTex ) nodes.roughnessMapsTex.value = mat.roughnessMaps;
		if ( mat.emissiveMaps && nodes.emissiveMapsTex ) nodes.emissiveMapsTex.value = mat.emissiveMaps;
		if ( mat.displacementMaps && nodes.displacementMapsTex ) nodes.displacementMapsTex.value = mat.displacementMaps;

		console.log( 'ShaderComposer: Scene textures updated in-place' );

	}

	/**
	 * Get scene texture nodes (for external access like _applyCDFResults).
	 * @returns {Object|null}
	 */
	getSceneTextureNodes() {

		return this._sceneTextureNodes;

	}

	// ===== PRIVATE: SHADER GRAPH CONSTRUCTION =====

	/**
	 * Create texture nodes for shader.
	 * @param {Object} stage - PathTracingStage instance
	 * @param {Object} renderTargets - RenderTargetPool
	 * @returns {Object} Texture nodes and metadata
	 * @private
	 */
	_createTextureNodes( stage, renderTargets ) {

		// Scene data: all storage buffers (WebGPU native)
		const triStorage = stage.triangleStorageNode;
		const bvhStorage = stage.bvhStorageNode;
		const matStorage = stage.materialData.materialStorageNode;
		const emissiveTriStorage = stage.emissiveTriangleStorageNode;
		const lightBVHStorage = stage.lightBVHStorageNode;

		const envTex = texture( stage.environment.environmentTexture );

		// Previous frame textures for accumulation
		const prevFrameTex = renderTargets.renderTargetA?.texture
			? texture( renderTargets.renderTargetA.texture )
			: new TextureNode();
		this.prevFrameTexNode = prevFrameTex;

		const prevNormalDepthTex = renderTargets.renderTargetA?.textures?.[ 1 ]
			? texture( renderTargets.renderTargetA.textures[ 1 ] )
			: new TextureNode();
		this.prevNormalDepthTexNode = prevNormalDepthTex;

		const prevAlbedoTex = renderTargets.renderTargetA?.textures?.[ 2 ]
			? texture( renderTargets.renderTargetA.textures[ 2 ] )
			: new TextureNode();
		this.prevAlbedoTexNode = prevAlbedoTex;

		// Placeholder texture node for optional textures
		const placeholderTex = new TextureNode();

		// Adaptive sampling texture
		const hasAdaptiveSampling = stage.adaptiveSamplingTexture !== null;
		const adaptiveSamplingTex = hasAdaptiveSampling
			? texture( stage.adaptiveSamplingTexture )
			: new TextureNode();
		this.adaptiveSamplingTexNode = adaptiveSamplingTex;

		// Environment importance sampling CDF (storage buffers)
		const marginalCDFStorage = stage.environment.envMarginalStorageNode;
		const conditionalCDFStorage = stage.environment.envConditionalStorageNode;

		// Material texture arrays (DataArrayTexture → texture node)
		// CRITICAL: Set LinearFilter so isUnfilterable()=false → textureSample instead of textureLoad
		// CRITICAL: Each texture type MUST have its OWN placeholder instance
		const createArrayPlaceholder = () => {

			const dummyTex = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
			dummyTex.minFilter = LinearFilter;
			dummyTex.magFilter = LinearFilter;
			dummyTex.generateMipmaps = false;
			dummyTex.needsUpdate = true;
			return texture( dummyTex );

		};

		const mat = stage.materialData;
		const albedoMapsTex = mat.albedoMaps ? texture( mat.albedoMaps ) : createArrayPlaceholder();
		const normalMapsTex = mat.normalMaps ? texture( mat.normalMaps ) : createArrayPlaceholder();
		const bumpMapsTex = mat.bumpMaps ? texture( mat.bumpMaps ) : createArrayPlaceholder();
		const metalnessMapsTex = mat.metalnessMaps ? texture( mat.metalnessMaps ) : createArrayPlaceholder();
		const roughnessMapsTex = mat.roughnessMaps ? texture( mat.roughnessMaps ) : createArrayPlaceholder();
		const emissiveMapsTex = mat.emissiveMaps ? texture( mat.emissiveMaps ) : createArrayPlaceholder();
		const displacementMapsTex = mat.displacementMaps ? texture( mat.displacementMaps ) : createArrayPlaceholder();

		const result = {
			triStorage,
			bvhStorage,
			matStorage,
			emissiveTriStorage,
			lightBVHStorage,
			envTex,
			prevFrameTex,
			prevNormalDepthTex,
			prevAlbedoTex,
			placeholderTex,
			adaptiveSamplingTex,
			marginalCDFStorage,
			conditionalCDFStorage,
			hasAdaptiveSampling,
			// Texture arrays
			albedoMapsTex,
			normalMapsTex,
			bumpMapsTex,
			metalnessMapsTex,
			roughnessMapsTex,
			emissiveMapsTex,
			displacementMapsTex,
		};

		// Store references for in-place updates on model change
		this._sceneTextureNodes = result;

		return result;

	}

	/**
	 * Create path tracer output by calling pathTracerMain with all uniforms/textures.
	 * @param {Object} stage - PathTracingStage instance
	 * @param {Object} textureNodes
	 * @returns {Object} Path tracer output nodes
	 * @private
	 */
	_createPathTracerOutput( stage, textureNodes ) {

		const {
			triStorage, bvhStorage, matStorage, emissiveTriStorage, lightBVHStorage,
			envTex, prevFrameTex, prevNormalDepthTex, prevAlbedoTex,
			adaptiveSamplingTex, marginalCDFStorage, conditionalCDFStorage,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex,
			displacementMapsTex,
		} = textureNodes;

		return pathTracerMain( {

			// Frame / resolution
			resolution: stage.resolution,
			frame: stage.frame,
			samplesPerPixel: stage.samplesPerPixel,
			visMode: stage.visMode,

			// Camera matrices
			cameraWorldMatrix: stage.cameraWorldMatrix,
			cameraProjectionMatrixInverse: stage.cameraProjectionMatrixInverse,
			cameraViewMatrix: stage.cameraViewMatrix,
			cameraProjectionMatrix: stage.cameraProjectionMatrix,

			// BVH / Scene (all storage buffers)
			bvhBuffer: bvhStorage,
			triangleBuffer: triStorage,
			materialBuffer: matStorage,

			// Texture arrays
			albedoMaps: albedoMapsTex,
			normalMaps: normalMapsTex,
			bumpMaps: bumpMapsTex,
			metalnessMaps: metalnessMapsTex,
			roughnessMaps: roughnessMapsTex,
			emissiveMaps: emissiveMapsTex,
			displacementMaps: displacementMapsTex,

			// Lights
			directionalLightsBuffer: stage.directionalLightsBufferNode,
			numDirectionalLights: stage.numDirectionalLights,
			areaLightsBuffer: stage.areaLightsBufferNode,
			numAreaLights: stage.numAreaLights,
			pointLightsBuffer: stage.pointLightsBufferNode,
			numPointLights: stage.numPointLights,
			spotLightsBuffer: stage.spotLightsBufferNode,
			numSpotLights: stage.numSpotLights,

			// Environment
			envTexture: envTex,
			environmentIntensity: stage.environmentIntensity,
			envMatrix: stage.environmentMatrix,
			envMarginalWeights: marginalCDFStorage,
			envConditionalWeights: conditionalCDFStorage,
			envTotalSum: stage.envTotalSum,
			envResolution: stage.envResolution,
			enableEnvironmentLight: stage.enableEnvironment,
			useEnvMapIS: stage.useEnvMapIS,

			// Rendering parameters
			maxBounceCount: stage.maxBounces,
			transmissiveBounces: stage.transmissiveBounces,
			showBackground: stage.showBackground,
			transparentBackground: stage.transparentBackground,
			backgroundIntensity: stage.backgroundIntensity,
			fireflyThreshold: stage.fireflyThreshold,
			globalIlluminationIntensity: stage.globalIlluminationIntensity,
			totalTriangleCount: stage.totalTriangleCount,
			enableEmissiveTriangleSampling: stage.enableEmissiveTriangleSampling,
			emissiveTriangleBuffer: emissiveTriStorage,
			emissiveTriangleCount: stage.emissiveTriangleCount,
			emissiveTotalPower: stage.emissiveTotalPower,
			emissiveBoost: stage.emissiveBoost,
			lightBVHBuffer: lightBVHStorage,
			lightBVHNodeCount: stage.lightBVHNodeCount,

			// Debug
			debugVisScale: stage.debugVisScale,

			// Accumulation
			enableAccumulation: stage.enableAccumulation,
			hasPreviousAccumulated: stage.hasPreviousAccumulated,
			prevAccumTexture: prevFrameTex,
			prevNormalDepthTexture: prevNormalDepthTex,
			prevAlbedoTexture: prevAlbedoTex,
			accumulationAlpha: stage.accumulationAlpha,
			cameraIsMoving: stage.cameraIsMoving,

			// Adaptive Sampling
			useAdaptiveSampling: stage.useAdaptiveSampling,
			adaptiveSamplingTexture: adaptiveSamplingTex,
			adaptiveSamplingMin: stage.adaptiveSamplingMin,
			adaptiveSamplingMax: stage.adaptiveSamplingMax,

			// DOF / Camera lens
			enableDOF: stage.enableDOF,
			focalLength: stage.focalLength,
			aperture: stage.aperture,
			focusDistance: stage.focusDistance,
			sceneScale: stage.sceneScale,
			apertureScale: stage.apertureScale,
		} );

	}

	/**
	 * Create path trace and accumulation materials.
	 * @param {Object} ptOutput
	 * @private
	 */
	_createPathTraceMaterials( ptOutput ) {

		this.accumMaterial = new MeshBasicNodeMaterial();
		this.accumMaterial.colorNode = ptOutput.get( 'gColor' );

		// Single-pass MRT: write color, normalDepth, and albedo in one render call.
		this.accumMaterial.mrtNode = mrt( {
			gColor: ptOutput.get( 'gColor' ),
			gNormalDepth: ptOutput.get( 'gNormalDepth' ),
			gAlbedo: ptOutput.get( 'gAlbedo' ),
		} );

		this.accumQuad = new QuadMesh( this.accumMaterial );

	}

	/**
	 * Create display material for final output with exposure control.
	 * @param {Object} stage - PathTracingStage instance
	 * @param {Object} renderTargets - RenderTargetPool
	 * @private
	 */
	_createDisplayMaterial( stage, renderTargets ) {

		const displayTex = renderTargets.renderTargetA?.texture
			? texture( renderTargets.renderTargetA.texture )
			: new TextureNode();
		this.displayTexNode = displayTex;

		const exposureUniform = stage.exposure;

		const displayShader = Fn( () => {

			const color = displayTex.sample( uv() );
			const exposedColor = color.xyz.mul( exposureUniform.pow( 4.0 ) );
			return vec4( exposedColor, 1.0 );

		} );

		this.displayMaterial = new MeshBasicNodeMaterial();
		this.displayMaterial.colorNode = displayShader();
		this.displayMaterial.toneMapped = true;
		this.displayQuad = new QuadMesh( this.displayMaterial );

	}

	// ===== DISPOSAL =====

	dispose() {

		this.accumMaterial?.dispose();
		this.displayMaterial?.dispose();

		this.accumMaterial = null;
		this.accumQuad = null;
		this.displayMaterial = null;
		this.displayQuad = null;
		this.prevFrameTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;
		this.displayTexNode = null;
		this.adaptiveSamplingTexNode = null;
		this._sceneTextureNodes = null;

	}

}
