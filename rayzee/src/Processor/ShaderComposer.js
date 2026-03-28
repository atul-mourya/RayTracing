/**
 * ShaderComposer.js
 * Owns TSL shader graph construction and compute node management
 * for the path tracing pipeline.
 *
 * "Copy approach": Single compute node writes to 3 write-only StorageTextures.
 * Previous-frame reads use texture() sampling from a MRT RenderTarget
 * (populated by copyTextureToTexture after each dispatch).
 *
 * Texture nodes are created once and updated in-place via .value mutation
 * to preserve compiled shader graph references.
 */

import { Fn, texture, vec2, float, int, uniform, If,
	localId, workgroupId } from 'three/tsl';
import { TextureNode } from 'three/webgpu';
import { LinearFilter, DataArrayTexture } from 'three';
import { pathTracerMain } from '../TSL/PathTracer.js';
import BuildTimer from './BuildTimer.js';

const WG_SIZE = 8;

export class ShaderComposer {

	constructor() {

		// Single compute node (no dual ping-pong — copy approach)
		this.computeNode = null;

		// Previous-frame texture nodes (sample from MRT RenderTarget)
		this.prevColorTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;

		// Adaptive sampling texture (updated per-frame from context)
		this.adaptiveSamplingTexNode = null;

		// Tile offset uniforms — pixel origin of the active tile region
		// Dispatch covers only tile-sized workgroups; offset maps them to image space
		this.tileOffsetX = uniform( 0, 'int' );
		this.tileOffsetY = uniform( 0, 'int' );

		// Render dimensions for edge-workgroup bounds checking
		this.renderWidth = uniform( 1920, 'int' );
		this.renderHeight = uniform( 1080, 'int' );

		// Dispatch dimensions
		this._dispatchX = 0;
		this._dispatchY = 0;

		// Scene texture nodes cache (for in-place updates on model change)
		this._sceneTextureNodes = null;

	}

	/**
	 * Creates the full compute shader graph from scratch.
	 *
	 * @param {Object} config
	 * @param {Object} config.stage - PathTracingStage instance
	 * @param {Object} config.storageTextures - StorageTexturePool
	 */
	setupCompute( config ) {

		const { stage, storageTextures } = config;

		const timer = new BuildTimer( 'setupCompute' );

		timer.start( 'Create texture nodes' );
		const textureNodes = this._createTextureNodes( stage, storageTextures );
		timer.end( 'Create texture nodes' );

		timer.start( 'Build compute node (TSL)' );

		const width = storageTextures.renderWidth;
		const height = storageTextures.renderHeight;
		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );

		this.renderWidth.value = width;
		this.renderHeight.value = height;

		const writeTex = storageTextures.getWriteTextures();

		this.computeNode = this._buildComputeNode(
			stage, textureNodes,
			writeTex.color, writeTex.normalDepth, writeTex.albedo
		);

		timer.end( 'Build compute node (TSL)' );

		timer.print();

	}

	updateSceneTextures( stage ) {

		const nodes = this._sceneTextureNodes;

		const env = stage.environment;
		const mat = stage.materialData;

		if ( env.environmentTexture && nodes.envTex ) {

			nodes.envTex.value = env.environmentTexture;

		}

		if ( mat.albedoMaps && nodes.albedoMapsTex ) nodes.albedoMapsTex.value = mat.albedoMaps;
		if ( mat.normalMaps && nodes.normalMapsTex ) nodes.normalMapsTex.value = mat.normalMaps;
		if ( mat.bumpMaps && nodes.bumpMapsTex ) nodes.bumpMapsTex.value = mat.bumpMaps;
		if ( mat.metalnessMaps && nodes.metalnessMapsTex ) nodes.metalnessMapsTex.value = mat.metalnessMaps;
		if ( mat.roughnessMaps && nodes.roughnessMapsTex ) nodes.roughnessMapsTex.value = mat.roughnessMaps;
		if ( mat.emissiveMaps && nodes.emissiveMapsTex ) nodes.emissiveMapsTex.value = mat.emissiveMaps;
		if ( mat.displacementMaps && nodes.displacementMapsTex ) nodes.displacementMapsTex.value = mat.displacementMaps;

		console.log( 'ShaderComposer: Scene textures updated in-place' );

	}

	getSceneTextureNodes() {

		return this._sceneTextureNodes;

	}

	setSize( width, height ) {

		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );

		if ( this.computeNode ) this.computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

		this.renderWidth.value = width;
		this.renderHeight.value = height;

		// Reset tile offset (full-screen)
		this.tileOffsetX.value = 0;
		this.tileOffsetY.value = 0;

	}

	/**
	 * Set dispatch to cover only the active tile region.
	 * Adjusts dispatch count and tile offset so threads map directly to tile pixels.
	 * @param {number} offsetX - Tile origin X in pixels
	 * @param {number} offsetY - Tile origin Y in pixels
	 * @param {number} tileWidth - Tile width in pixels
	 * @param {number} tileHeight - Tile height in pixels
	 */
	setTileDispatch( offsetX, offsetY, tileWidth, tileHeight ) {

		this.tileOffsetX.value = offsetX;
		this.tileOffsetY.value = offsetY;

		const dispatchX = Math.ceil( tileWidth / WG_SIZE );
		const dispatchY = Math.ceil( tileHeight / WG_SIZE );

		if ( this.computeNode ) this.computeNode.setCount( [ dispatchX, dispatchY, 1 ] );

	}

	/**
	 * Reset dispatch to full-screen (no tiling).
	 */
	setFullScreenDispatch() {

		this.tileOffsetX.value = 0;
		this.tileOffsetY.value = 0;

		if ( this.computeNode ) this.computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	forceCompile() {

		// No-op — compilation happens on first renderer.compute() call.

	}

	// ===== PRIVATE =====

	_createTextureNodes( stage, storageTextures ) {

		const triStorage = stage.triangleStorageNode;
		const bvhStorage = stage.bvhStorageNode;
		const matStorage = stage.materialData.materialStorageNode;
		const emissiveTriStorage = stage.emissiveTriangleStorageNode;
		const lightBVHStorage = stage.lightBVHStorageNode;

		const envTex = texture( stage.environment.environmentTexture );

		// Adaptive sampling texture
		const adaptiveSamplingTex = new TextureNode();
		this.adaptiveSamplingTexNode = adaptiveSamplingTex;

		// Environment importance sampling CDF (storage buffers)
		const marginalCDFStorage = stage.environment.envMarginalStorageNode;
		const conditionalCDFStorage = stage.environment.envConditionalStorageNode;

		// Previous-frame texture nodes — initialized from readTarget textures
		const readTextures = storageTextures.getReadTextures();
		this.prevColorTexNode = texture( readTextures.color );
		this.prevNormalDepthTexNode = texture( readTextures.normalDepth );
		this.prevAlbedoTexNode = texture( readTextures.albedo );

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
			triStorage, bvhStorage, matStorage, emissiveTriStorage, lightBVHStorage,
			envTex, adaptiveSamplingTex, marginalCDFStorage, conditionalCDFStorage,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex, displacementMapsTex,
		};

		this._sceneTextureNodes = result;
		return result;

	}

	/**
	 * Build a single compute node.
	 * Previous-frame reads use texture() nodes bound to MRT RenderTarget textures.
	 */
	_buildComputeNode( stage, textureNodes,
		writeColorTex, writeNDTex, writeAlbedoTex ) {

		const {
			triStorage, bvhStorage, matStorage, emissiveTriStorage, lightBVHStorage,
			envTex, adaptiveSamplingTex, marginalCDFStorage, conditionalCDFStorage,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex, displacementMapsTex,
		} = textureNodes;

		const tileOffsetX = this.tileOffsetX;
		const tileOffsetY = this.tileOffsetY;
		const renderWidth = this.renderWidth;
		const renderHeight = this.renderHeight;

		const prevColorTexNode = this.prevColorTexNode;
		const prevNormalDepthTexNode = this.prevNormalDepthTexNode;
		const prevAlbedoTexNode = this.prevAlbedoTexNode;

		const computeFn = Fn( () => {

			// Map thread to image-space pixel via tile offset
			const gx = tileOffsetX.add( int( workgroupId.x ).mul( WG_SIZE ) ).add( int( localId.x ) );
			const gy = tileOffsetY.add( int( workgroupId.y ).mul( WG_SIZE ) ).add( int( localId.y ) );

			// Bounds check only needed for edge workgroups that overshoot render dimensions
			If( gx.lessThan( renderWidth ).and( gy.lessThan( renderHeight ) ), () => {

				const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );

				pathTracerMain( {
					pixelCoord,
					writeColorTex, writeNDTex, writeAlbedoTex,
					// Previous-frame textures from MRT RenderTarget (sampled via texture())
					prevAccumTexture: prevColorTexNode,
					prevNormalDepthTexture: prevNormalDepthTexNode,
					prevAlbedoTexture: prevAlbedoTexNode,
					resolution: stage.resolution,
					frame: stage.frame,
					samplesPerPixel: stage.samplesPerPixel,
					visMode: stage.visMode,
					cameraWorldMatrix: stage.cameraWorldMatrix,
					cameraProjectionMatrixInverse: stage.cameraProjectionMatrixInverse,
					cameraViewMatrix: stage.cameraViewMatrix,
					cameraProjectionMatrix: stage.cameraProjectionMatrix,
					bvhBuffer: bvhStorage,
					triangleBuffer: triStorage,
					materialBuffer: matStorage,
					albedoMaps: albedoMapsTex,
					normalMaps: normalMapsTex,
					bumpMaps: bumpMapsTex,
					metalnessMaps: metalnessMapsTex,
					roughnessMaps: roughnessMapsTex,
					emissiveMaps: emissiveMapsTex,
					displacementMaps: displacementMapsTex,
					directionalLightsBuffer: stage.directionalLightsBufferNode,
					numDirectionalLights: stage.numDirectionalLights,
					areaLightsBuffer: stage.areaLightsBufferNode,
					numAreaLights: stage.numAreaLights,
					pointLightsBuffer: stage.pointLightsBufferNode,
					numPointLights: stage.numPointLights,
					spotLightsBuffer: stage.spotLightsBufferNode,
					numSpotLights: stage.numSpotLights,
					envTexture: envTex,
					environmentIntensity: stage.environmentIntensity,
					envMatrix: stage.environmentMatrix,
					envMarginalWeights: marginalCDFStorage,
					envConditionalWeights: conditionalCDFStorage,
					envTotalSum: stage.envTotalSum,
					envResolution: stage.envResolution,
					enableEnvironmentLight: stage.enableEnvironment,
					useEnvMapIS: stage.useEnvMapIS,
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
					debugVisScale: stage.debugVisScale,
					enableAccumulation: stage.enableAccumulation,
					hasPreviousAccumulated: stage.hasPreviousAccumulated,
					accumulationAlpha: stage.accumulationAlpha,
					cameraIsMoving: stage.cameraIsMoving,
					useAdaptiveSampling: stage.useAdaptiveSampling,
					adaptiveSamplingTexture: adaptiveSamplingTex,
					adaptiveSamplingMin: stage.adaptiveSamplingMin,
					adaptiveSamplingMax: stage.adaptiveSamplingMax,
					enableDOF: stage.enableDOF,
					focalLength: stage.focalLength,
					aperture: stage.aperture,
					focusDistance: stage.focusDistance,
					sceneScale: stage.sceneScale,
					apertureScale: stage.apertureScale,
				} );

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	dispose() {

		this.computeNode?.dispose();

		this.computeNode = null;
		this.prevColorTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;
		this.adaptiveSamplingTexNode = null;
		this._sceneTextureNodes = null;

	}

}
