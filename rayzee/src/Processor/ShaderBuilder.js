/**
 * ShaderBuilder.js
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
import { setShadowAlbedoMaps, setAlphaShadowsUniform } from '../TSL/LightsDirect.js';
import { BuildTimer } from './BuildTimer.js';

const WG_SIZE = 8;

export class ShaderBuilder {

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

		// Reused per-frame dispatchSize array — avoids GC pressure from
		// allocating [x,y,z] on every setFullScreenDispatch/setTileDispatch call.
		// WebGPUBackend only reads indices 0..2 of this array during compute dispatch.
		this._dispatchSize = [ 0, 0, 1 ];

		// Scene texture nodes cache (for in-place updates on model change)
		this._sceneTextureNodes = null;

		// Whether the GPU compute pipeline has been compiled (via a real dispatch).
		// Reset on setupCompute() rebuilds and on dispose().
		this._compiled = false;

	}

	/**
	 * Creates the full compute shader graph from scratch.
	 *
	 * @param {Object} config
	 * @param {Object} config.stage - PathTracer instance
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

		// New compute node → needs a fresh GPU pipeline compile
		this._compiled = false;

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

		console.log( 'ShaderBuilder: Scene textures updated in-place' );

	}

	getSceneTextureNodes() {

		return this._sceneTextureNodes;

	}

	setSize( width, height ) {

		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );

		if ( this.computeNode ) {

			this._dispatchSize[ 0 ] = this._dispatchX;
			this._dispatchSize[ 1 ] = this._dispatchY;
			this.computeNode.dispatchSize = this._dispatchSize;

		}

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

		if ( this.computeNode ) {

			this._dispatchSize[ 0 ] = dispatchX;
			this._dispatchSize[ 1 ] = dispatchY;
			this.computeNode.dispatchSize = this._dispatchSize;

		}

	}

	/**
	 * Reset dispatch to full-screen (no tiling).
	 */
	setFullScreenDispatch() {

		this.tileOffsetX.value = 0;
		this.tileOffsetY.value = 0;

		if ( this.computeNode ) {

			this._dispatchSize[ 0 ] = this._dispatchX;
			this._dispatchSize[ 1 ] = this._dispatchY;
			this.computeNode.dispatchSize = this._dispatchSize;

		}

	}

	/**
	 * Front-load GPU compute pipeline creation via a single dispatch.
	 *
	 * Three.js WebGPU has no `createComputePipelineAsync` path — compute
	 * pipelines always compile synchronously on first `renderer.compute(node)`.
	 * Calling this at build time (while a "Compiling shaders…" status is
	 * already visible) moves the stall off the first animate frame.
	 *
	 * The dispatch writes to ping-pong storage textures whose contents are
	 * discarded by the subsequent `reset()` (frame counter back to 0 →
	 * `hasPreviousAccumulated = 0` → prev textures are not read).
	 *
	 * @param {object} renderer - WebGPURenderer
	 */
	forceCompile( renderer ) {

		if ( this._compiled || ! this.computeNode || ! renderer ) return;

		this._compiled = true;
		renderer.compute( this.computeNode );

	}

	// ===== PRIVATE =====

	_createTextureNodes( stage, storageTextures ) {

		const triStorage = stage.triangleStorageNode;
		const bvhStorage = stage.bvhStorageNode;
		const matStorage = stage.materialData.materialStorageNode;
		// Packed light buffer — [lightBVH | emissive triangles]. One node fed to both
		// TSL params; emissive reads offset by stage.emissiveVec4Offset.
		const lightBufferStorage = stage.lightStorageNode;

		// Set alpha-shadow uniform (module-level in LightsDirect.js, read at runtime)
		setAlphaShadowsUniform( stage.uniforms.get( 'enableAlphaShadows' ) );

		const envTex = texture( stage.environment.environmentTexture );

		// Adaptive sampling texture
		const adaptiveSamplingTex = new TextureNode();
		this.adaptiveSamplingTexNode = adaptiveSamplingTex;

		// Environment importance sampling CDF — packed storage buffer
		// Layout: [marginal (envResolution.y floats) | conditional (envResolution.x * envResolution.y floats)]
		const envCDFStorage = stage.environment.envCDFStorageNode;

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

		// Set albedo texture array for alpha-aware shadow rays (module-level in LightsDirect.js).
		// Always pass the texture node (real or placeholder) so alpha-cutout code is emitted
		// into the shader at graph construction time. Runtime albedoMapIndex >= 0 guards sampling.
		setShadowAlbedoMaps( albedoMapsTex );

		// SHaRC atomic buffers (Phase 2 — path tracer writes radiance contributions
		// at hits past the primary). The SHaRC stage owns the storage nodes; we
		// share the same nodes here so atomicAdd / atomicMax / atomicStore from
		// the path tracer compute graph operate on the same GPU buffers the
		// SHaRC stage's resolve pass reads. The nodes are already `.toAtomic()`.
		const sharcStage = stage.sharcStage;
		const sharcKeyLo = sharcStage ? sharcStage._hashKeyLo : null;
		const sharcKeyHi = sharcStage ? sharcStage._hashKeyHi : null;
		const sharcCell = sharcStage ? sharcStage._cellData : null;

		const result = {
			triStorage, bvhStorage, matStorage, lightBufferStorage,
			envTex, adaptiveSamplingTex, envCDFStorage,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex, displacementMapsTex,
			sharcKeyLo, sharcKeyHi, sharcCell,
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
			triStorage, bvhStorage, matStorage, lightBufferStorage,
			envTex, adaptiveSamplingTex, envCDFStorage,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex, displacementMapsTex,
			sharcKeyLo, sharcKeyHi, sharcCell,
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
					envCDFBuffer: envCDFStorage,
					envTotalSum: stage.envTotalSum,
					envCompensationDelta: stage.envCompensationDelta,
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
					emissiveTriangleBuffer: lightBufferStorage,
					emissiveTriangleCount: stage.emissiveTriangleCount,
					emissiveTotalPower: stage.emissiveTotalPower,
					emissiveBoost: stage.emissiveBoost,
					emissiveVec4Offset: stage.emissiveVec4Offset,
					lightBVHBuffer: lightBufferStorage,
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
					anamorphicRatio: stage.anamorphicRatio,
					// SHaRC (Phases 2/3 — Update + Query path-tracer integration)
					// accum + resolved packed into single cellBuf (8 u32/cell) to
					// fit under WebGPU's 8-bindings-per-stage limit.
					sharcKeyLoBuf: sharcKeyLo,
					sharcKeyHiBuf: sharcKeyHi,
					sharcCellBuf: sharcCell,
					sharcUpdateEnabled: stage.sharcUpdateEnabled,
					sharcQueryEnabled: stage.sharcQueryEnabled,
					sharcSceneScale: stage.sharcSceneScale,
					sharcLevelBias: stage.sharcLevelBias,
					sharcRadianceScale: stage.sharcRadianceScale,
					sharcCapacity: stage.sharcCapacity,
					sharcUpdateStride: stage.sharcUpdateStride,
					sharcSampleThreshold: stage.sharcSampleThreshold,
					cameraPos: stage.cameraPos,
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
		this._compiled = false;

	}

}
