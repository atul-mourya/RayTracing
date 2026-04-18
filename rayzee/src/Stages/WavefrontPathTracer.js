/**
 * WavefrontPathTracer.js
 *
 * Wavefront path tracer stage with decomposed kernel dispatch.
 * Extends PathTracer for sub-manager reuse.
 *
 * Phase 1B kernel pipeline (per bounce):
 *   Extend → Shade → Connect → Accumulate → Compact
 * Bookended by: Generate (once) and FinalWrite (once).
 *
 * Context textures published (identical to PathTracer):
 *   - pathtracer:color, pathtracer:normalDepth, pathtracer:albedo
 */

import { uniform, texture, storage } from 'three/tsl';
import { PathTracer } from './PathTracer.js';
import { PackedRayBuffer } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { WavefrontKernelManager } from '../Processor/WavefrontKernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/wavefront/GenerateKernel.js';
import { buildExtendShadeKernel, EXTENDSHADE_WG_SIZE } from '../TSL/wavefront/ExtendShadeKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/wavefront/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/wavefront/ShadeKernel.js';
import { buildConnectKernel, CONNECT_WG_SIZE } from '../TSL/wavefront/ConnectKernel.js';
import { buildAccumulateKernel, ACCUMULATE_WG_SIZE } from '../TSL/wavefront/AccumulateKernel.js';
import { buildCompactKernel, COMPACT_WG_SIZE } from '../TSL/wavefront/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/wavefront/FinalWriteKernel.js';
import {
	Fn, uint, atomicStore, instanceIndex,
} from 'three/tsl';

export class WavefrontPathTracer extends PathTracer {

	constructor( renderer, scene, camera, options = {} ) {

		super( renderer, scene, camera, options );
		this.name = 'WavefrontPathTracer';

		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._wavefrontReady = false;

		// Wavefront-specific uniforms
		this._wfTileOffsetX = uniform( 0, 'int' );
		this._wfTileOffsetY = uniform( 0, 'int' );
		this._wfRenderWidth = uniform( 1920, 'int' );
		this._wfRenderHeight = uniform( 1080, 'int' );
		this._wfMaxRayCount = uniform( 0, 'uint' );
		this._wfShadowRayCount = uniform( 0, 'uint' );
		this._wfCurrentBounce = uniform( 0, 'int' );

		console.log( 'WavefrontPathTracer: Initialized (Phase 1B — decomposed kernels)' );

	}

	setupMaterial() {

		super.setupMaterial();

		// Only build wavefront kernels when scene has actual data
		// (first setupMaterial call has 0 triangles/materials — skip it)
		if ( this.materialData?.materialCount > 0 ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	render( context, writeBuffer ) {

		if ( ! this.isReady || ! this._wavefrontReady ) {

			super.render( context, writeBuffer );
			return;

		}

		if ( this.isComplete || this.frameCount >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor?.start();

		// Adaptive sampling texture
		if ( context && this.shaderBuilder.adaptiveSamplingTexNode ) {

			const asTex = context.getTexture( 'adaptiveSampling:output' );
			if ( asTex ) this.shaderBuilder.adaptiveSamplingTexNode.value = asTex;

		}

		const frameValue = this.frameCount;
		const renderMode = this.renderMode.value;

		let originalMaxBounces = null;
		let originalSamplesPerPixel = null;

		if ( renderMode === 1 && frameValue === 0 ) {

			originalMaxBounces = this.maxBounces.value;
			originalSamplesPerPixel = this.samplesPerPixel.value;
			this.maxBounces.value = 1;
			this.samplesPerPixel.value = 1;

		}

		this._handleResize();
		this.manageASVGFForRenderMode( renderMode, frameValue );

		const tileInfo = this.tileManager.handleTileRendering(
			this.renderer, renderMode, frameValue, null
		);

		if ( context ) context.setState( 'tileRenderingComplete', tileInfo.isCompleteCycle );

		if ( tileInfo.tileIndex >= 0 ) {

			const tileBounds = this.tileManager.calculateTileBounds(
				tileInfo.tileIndex, this.tileManager.tiles, this.width, this.height
			);
			this.emit( 'tile:changed', { tileIndex: tileInfo.tileIndex, tileBounds, renderMode } );
			this.tileChanged = true;

		}

		this.cameraChanged = this._updateCameraUniforms();
		this.cameraOptimizer?.updateInteractionMode( this.cameraChanged );
		this._updateAccumulationUniforms( frameValue, renderMode );
		this.frame.value = frameValue;

		// Tile dispatch
		if ( tileInfo.tileIndex >= 0 && tileInfo.tileBounds ) {

			this._setWfTileDispatch(
				tileInfo.tileBounds.x, tileInfo.tileBounds.y,
				tileInfo.tileBounds.width, tileInfo.tileBounds.height
			);

		} else {

			this._setWfFullDispatch();

		}

		// Previous-frame textures
		const readTextures = this.storageTextures.getReadTextures();
		if ( this.shaderBuilder.prevColorTexNode ) {

			this.shaderBuilder.prevColorTexNode.value = readTextures.color;
			this.shaderBuilder.prevNormalDepthTexNode.value = readTextures.normalDepth;
			this.shaderBuilder.prevAlbedoTexNode.value = readTextures.albedo;

		}

		// ═══════════════════════════════════════════════════════════
		// WAVEFRONT KERNEL DISPATCH
		// ═══════════════════════════════════════════════════════════

		const km = this._kernelManager;

		// Reset all counters
		km.dispatch( 'resetCounters' );

		// Generate primary rays
		km.dispatch( 'generate' );

		// Initialize active indices (all pixels)
		km.dispatch( 'initActiveIndices' );

		// Bounce loop — fused ExtendShade + deferred shadow pipeline
		const maxBounces = this.maxBounces.value;

		for ( let bounce = 0; bounce <= maxBounces; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			// Separate Extend + Shade (fused kernel has pink tint bug on multi-material scenes)
			km.dispatch( 'extend' );
			km.dispatch( 'shade' );
			// TODO: investigate fused ExtendShadeKernel WGSL codegen issue

			// Stream compaction
			km.dispatch( 'resetActiveCounter' );
			km.dispatch( 'compact' );
			this._queueManager.swap();

		}

		// FinalWrite — temporal accumulation + StorageTexture output
		km.dispatch( 'finalWrite' );

		// ═══════════════════════════════════════════════════════════

		this.storageTextures.copyToReadTargets( this.renderer );

		const readTex = this.storageTextures.getReadTextures();
		if ( context ) this._publishTexturesToContext( context, readTex );

		this._emitStateEvents();
		this.frameCount ++;

		if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;
		if ( originalSamplesPerPixel !== null ) this.samplesPerPixel.value = originalSamplesPerPixel;

		this.performanceMonitor?.end();

	}

	// ═══════════════════════════════════════════════════════════════
	// KERNEL BUILDING
	// ═══════════════════════════════════════════════════════════════

	_buildWavefrontKernels() {

		const texNodes = this.shaderBuilder.getSceneTextureNodes();
		if ( ! texNodes ) return;

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		const maxRays = w * h;

		// Allocate packed buffers
		if ( ! this._packedBuffers ) {

			this._packedBuffers = new PackedRayBuffer( maxRays );

		} else {

			this._packedBuffers.resize( maxRays );

		}

		// Allocate queue manager
		if ( ! this._queueManager ) {

			this._queueManager = new QueueManager( this._packedBuffers.capacity );

		} else {

			this._queueManager.resize( this._packedBuffers.capacity );

		}

		if ( ! this._kernelManager ) {

			this._kernelManager = new WavefrontKernelManager( this.renderer );

		}

		const pb = this._packedBuffers;
		const qm = this._queueManager;

		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._wfMaxRayCount.value = maxRays;

		const prevColor = this.shaderBuilder.prevColorTexNode;
		const prevND = this.shaderBuilder.prevNormalDepthTexNode;
		const prevAlbedo = this.shaderBuilder.prevAlbedoTexNode;
		const adaptiveTex = this.shaderBuilder.adaptiveSamplingTexNode;
		const writeTex = this.storageTextures.getWriteTextures();

		// ── Reset Counters kernel ──
		const counters = qm.getCounters();
		const resetFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );
			atomicStore( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ), uint( 0 ) );
			atomicStore( counters.element( uint( COUNTER.NEW_RAY_COUNT ) ), uint( 0 ) );
			atomicStore( counters.element( uint( COUNTER.TERMINATED_COUNT ) ), uint( 0 ) );

		} );
		this._kernelManager.register( 'resetCounters',
			resetFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// ── Reset Active Counter only ──
		const resetActiveFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );

		} );
		this._kernelManager.register( 'resetActiveCounter',
			resetActiveFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// ── Reset Shadow Counter ──
		const resetShadowFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ), uint( 0 ) );

		} );
		this._kernelManager.register( 'resetShadowCounter',
			resetShadowFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// ── Init Active Indices (fill with sequential IDs) ──
		const activeWriteA = qm.activeIndices.a;
		const initFn = Fn( () => {

			const tid = instanceIndex;
			activeWriteA.element( tid ).assign( tid );

		} );
		this._kernelManager.register( 'initActiveIndices',
			initFn().compute( [ Math.ceil( maxRays / 256 ), 1, 1 ], [ 256, 1, 1 ] )
		);

		// ── Generate ──
		const genFn = buildGenerateKernel( {
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			resolution: this.resolution,
			frame: this.frame,
			samplesPerPixel: this.samplesPerPixel,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			sceneScale: this.sceneScale,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
			tileOffsetX: this._wfTileOffsetX,
			tileOffsetY: this._wfTileOffsetY,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			useAdaptiveSampling: this.useAdaptiveSampling,
			adaptiveSamplingTexture: adaptiveTex,
			adaptiveSamplingMin: this.adaptiveSamplingMin,
			adaptiveSamplingMax: this.adaptiveSamplingMax,
			enableAccumulation: this.enableAccumulation,
			hasPreviousAccumulated: this.hasPreviousAccumulated,
			prevAccumTexture: prevColor,
			prevNormalDepthTexture: prevND,
		} );
		this._kernelManager.register( 'generate',
			genFn().compute(
				[ Math.ceil( w / GENERATE_WG_SIZE ), Math.ceil( h / GENERATE_WG_SIZE ), 1 ],
				[ GENERATE_WG_SIZE, GENERATE_WG_SIZE, 1 ]
			)
		);

		// ── Fused ExtendShade (BVH + material + deferred shadow) ──
		// Create FRESH storage nodes from CURRENT attributes to avoid stale
		// GPU buffer bindings after scene load replaces the attributes.
		// Use the SAME storage nodes the monolithic uses — they reference
		// the current attribute after scene load via .value update
		const freshBvh = this.bvhStorageNode;
		const freshTri = this.triangleStorageNode;
		const freshMat = this.materialData.materialStorageNode;
		const freshMarginal = this.environment.envMarginalStorageNode;
		const freshConditional = this.environment.envConditionalStorageNode;
		// Create INDEPENDENT texture nodes that have never been compiled
		// by any other pipeline. This avoids Three.js TextureNode caching
		// issues between the monolithic and wavefront compute pipelines.
		const _mat = this.materialData;
		const _env = this.environment;
		const _placeholder = texNodes.albedoMapsTex; // dummy fallback
		const freshAlbedoMaps = _mat.albedoMaps ? texture( _mat.albedoMaps ) : _placeholder;
		const freshNormalMaps = _mat.normalMaps ? texture( _mat.normalMaps ) : texNodes.normalMapsTex;
		const freshBumpMaps = _mat.bumpMaps ? texture( _mat.bumpMaps ) : texNodes.bumpMapsTex;
		const freshMetalnessMaps = _mat.metalnessMaps ? texture( _mat.metalnessMaps ) : texNodes.metalnessMapsTex;
		const freshRoughnessMaps = _mat.roughnessMaps ? texture( _mat.roughnessMaps ) : texNodes.roughnessMapsTex;
		const freshEmissiveMaps = _mat.emissiveMaps ? texture( _mat.emissiveMaps ) : texNodes.emissiveMapsTex;
		const freshEnvTex = _env.environmentTexture ? texture( _env.environmentTexture ) : texNodes.envTex;

		const esFn = buildExtendShadeKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envMarginalWeights: freshMarginal,
			envConditionalWeights: freshConditional,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			shadowBufferRW: pb.shadowBuffer.rw,
			counters,
			albedoMaps: freshAlbedoMaps,
			normalMaps: freshNormalMaps,
			bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps,
			roughnessMaps: freshRoughnessMaps,
			emissiveMaps: freshEmissiveMaps,
			envTexture: freshEnvTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			enableEnvironmentLight: this.enableEnvironment,
			useEnvMapIS: this.useEnvMapIS,
			envTotalSum: this.envTotalSum,
			envResolution: this.envResolution,
			directionalLightsBuffer: this.directionalLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			areaLightsBuffer: this.areaLightsBufferNode,
			numAreaLights: this.numAreaLights,
			pointLightsBuffer: this.pointLightsBufferNode,
			numPointLights: this.numPointLights,
			spotLightsBuffer: this.spotLightsBufferNode,
			numSpotLights: this.numSpotLights,
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			showBackground: this.showBackground,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'extendShade',
			esFn().compute(
				[ Math.ceil( maxRays / EXTENDSHADE_WG_SIZE ), 1, 1 ],
				[ EXTENDSHADE_WG_SIZE, 1, 1 ]
			)
		);

		// ── Separate Extend kernel (for testing) ──
		const extFn = buildExtendKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRW: pb.hitBuffer.rw,
			activeIndicesRO: qm.getActiveReadRO(),
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'extend',
			extFn().compute(
				[ Math.ceil( maxRays / EXTEND_WG_SIZE ), 1, 1 ],
				[ EXTEND_WG_SIZE, 1, 1 ]
			)
		);

		// ── Separate Shade kernel ──
		const shadeFn = buildShadeKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envMarginalWeights: freshMarginal,
			envConditionalWeights: freshConditional,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
			shadowBufferRW: pb.shadowBuffer.rw,
			counters,
			activeIndicesRO: qm.getActiveReadRO(),
			albedoMaps: freshAlbedoMaps,
			normalMaps: freshNormalMaps,
			bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps,
			roughnessMaps: freshRoughnessMaps,
			emissiveMaps: freshEmissiveMaps,
			envTexture: freshEnvTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			enableEnvironmentLight: this.enableEnvironment,
			useEnvMapIS: this.useEnvMapIS,
			envTotalSum: this.envTotalSum,
			envResolution: this.envResolution,
			directionalLightsBuffer: this.directionalLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			areaLightsBuffer: this.areaLightsBufferNode,
			numAreaLights: this.numAreaLights,
			pointLightsBuffer: this.pointLightsBufferNode,
			numPointLights: this.numPointLights,
			spotLightsBuffer: this.spotLightsBufferNode,
			numSpotLights: this.numSpotLights,
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'shade',
			shadeFn().compute(
				[ Math.ceil( maxRays / SHADE_WG_SIZE ), 1, 1 ],
				[ SHADE_WG_SIZE, 1, 1 ]
			)
		);

		// ── Connect (shadow ray traversal) ──
		const connectFn = buildConnectKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			shadowBufferRO: pb.shadowBuffer.ro,
			visibilityBufferRW: pb.visibilityBuffer.rw,
			counters,
		} );
		this._kernelManager.register( 'connect',
			connectFn().compute(
				[ Math.ceil( maxRays / CONNECT_WG_SIZE ), 1, 1 ],
				[ CONNECT_WG_SIZE, 1, 1 ]
			)
		);

		// ── Accumulate (apply shadow results) ──
		const accumFn = buildAccumulateKernel( {
			shadowBufferRO: pb.shadowBuffer.ro,
			visibilityBufferRO: pb.visibilityBuffer.ro,
			rayBufferRW: pb.rayBuffer.rw,
			counters,
		} );
		this._kernelManager.register( 'accumulate',
			accumFn().compute(
				[ Math.ceil( maxRays / ACCUMULATE_WG_SIZE ), 1, 1 ],
				[ ACCUMULATE_WG_SIZE, 1, 1 ]
			)
		);

		// ── Compact ──
		const compactFn = buildCompactKernel( {
			rayBufferRO: pb.rayBuffer.ro,
			activeIndicesReadRO: qm.getActiveReadRO(),
			activeIndicesWriteRW: qm.getActiveWrite(),
			counters,
			currentActiveCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'compact',
			compactFn().compute(
				[ Math.ceil( maxRays / COMPACT_WG_SIZE ), 1, 1 ],
				[ COMPACT_WG_SIZE, 1, 1 ]
			)
		);

		// ── FinalWrite ──
		const fwFn = buildFinalWriteKernel( {
			rayBufferRO: pb.rayBuffer.ro,
			writeColorTex: writeTex.color,
			writeNDTex: writeTex.normalDepth,
			writeAlbedoTex: writeTex.albedo,
			resolution: this.resolution,
			frame: this.frame,
			enableAccumulation: this.enableAccumulation,
			hasPreviousAccumulated: this.hasPreviousAccumulated,
			accumulationAlpha: this.accumulationAlpha,
			cameraIsMoving: this.cameraIsMoving,
			transparentBackground: this.transparentBackground,
			prevAccumTexture: prevColor,
			prevNormalDepthTexture: prevND,
			prevAlbedoTexture: prevAlbedo,
			tileOffsetX: this._wfTileOffsetX,
			tileOffsetY: this._wfTileOffsetY,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
		} );
		this._kernelManager.register( 'finalWrite',
			fwFn().compute(
				[ Math.ceil( w / FINALWRITE_WG_SIZE ), Math.ceil( h / FINALWRITE_WG_SIZE ), 1 ],
				[ FINALWRITE_WG_SIZE, FINALWRITE_WG_SIZE, 1 ]
			)
		);

		this._wavefrontReady = true;
		console.log( `WavefrontPathTracer: All kernels built (${w}×${h}, ${maxRays} rays)` );

	}

	// ═══════════════════════════════════════════════════════════════
	// TILE DISPATCH
	// ═══════════════════════════════════════════════════════════════

	_setWfTileDispatch( offsetX, offsetY, tileW, tileH ) {

		this._wfTileOffsetX.value = offsetX;
		this._wfTileOffsetY.value = offsetY;

		this._kernelManager.setDispatchCount( 'generate', [
			Math.ceil( tileW / GENERATE_WG_SIZE ),
			Math.ceil( tileH / GENERATE_WG_SIZE ), 1
		] );
		this._kernelManager.setDispatchCount( 'finalWrite', [
			Math.ceil( tileW / FINALWRITE_WG_SIZE ),
			Math.ceil( tileH / FINALWRITE_WG_SIZE ), 1
		] );

	}

	_setWfFullDispatch() {

		this._wfTileOffsetX.value = 0;
		this._wfTileOffsetY.value = 0;
		const w = this._wfRenderWidth.value;
		const h = this._wfRenderHeight.value;

		this._kernelManager.setDispatchCount( 'generate', [
			Math.ceil( w / GENERATE_WG_SIZE ),
			Math.ceil( h / GENERATE_WG_SIZE ), 1
		] );
		this._kernelManager.setDispatchCount( 'finalWrite', [
			Math.ceil( w / FINALWRITE_WG_SIZE ),
			Math.ceil( h / FINALWRITE_WG_SIZE ), 1
		] );

	}

	reset() {

		super.reset();

	}

	dispose() {

		super.dispose();
		this._packedBuffers?.dispose();
		this._queueManager?.dispose();
		this._kernelManager?.dispose();
		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._wavefrontReady = false;

	}

}
