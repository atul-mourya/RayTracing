/**
 * WavefrontPathTracerStage.js
 *
 * Wavefront path tracer stage with decomposed kernel dispatch.
 * Extends PathTracingStage for sub-manager reuse.
 *
 * Phase 1B kernel pipeline (per bounce):
 *   Extend → Shade → Connect → Accumulate → Compact
 * Bookended by: Generate (once) and FinalWrite (once).
 *
 * Context textures published (identical to PathTracingStage):
 *   - pathtracer:color, pathtracer:normalDepth, pathtracer:albedo
 */

import { uniform } from 'three/tsl';
import { PathTracingStage } from './PathTracingStage.js';
import { PackedRayBuffer } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { WavefrontKernelManager } from '../Processor/WavefrontKernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/wavefront/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/wavefront/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/wavefront/ShadeKernel.js';
import { buildConnectKernel, CONNECT_WG_SIZE } from '../TSL/wavefront/ConnectKernel.js';
import { buildAccumulateKernel, ACCUMULATE_WG_SIZE } from '../TSL/wavefront/AccumulateKernel.js';
import { buildSortKernel, SORT_WG_SIZE } from '../TSL/wavefront/SortKernel.js';
import { buildCompactKernel, COMPACT_WG_SIZE } from '../TSL/wavefront/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/wavefront/FinalWriteKernel.js';
import {
	Fn, uint, atomicStore, instanceIndex,
} from 'three/tsl';

export class WavefrontPathTracerStage extends PathTracingStage {

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

		console.log( 'WavefrontPathTracerStage: Initialized (Phase 1B — decomposed kernels)' );

	}

	setupMaterial() {

		super.setupMaterial();
		this._buildWavefrontKernels();

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
		if ( context && this.shaderComposer.adaptiveSamplingTexNode ) {

			const asTex = context.getTexture( 'adaptiveSampling:output' );
			if ( asTex ) this.shaderComposer.adaptiveSamplingTexNode.value = asTex;

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
		if ( this.shaderComposer.prevColorTexNode ) {

			this.shaderComposer.prevColorTexNode.value = readTextures.color;
			this.shaderComposer.prevNormalDepthTexNode.value = readTextures.normalDepth;
			this.shaderComposer.prevAlbedoTexNode.value = readTextures.albedo;

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

		// Bounce loop (CPU-driven, fixed count)
		const maxBounces = this.maxBounces.value;

		for ( let bounce = 0; bounce <= maxBounces; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			km.dispatch( 'extend' );

			// Material sort for subgroup coherence (skip bounce 0 — primary hits are screen-coherent)
			if ( bounce > 0 ) km.dispatch( 'sort' );

			km.dispatch( 'resetShadowCounter' );
			km.dispatch( 'shade' );
			km.dispatch( 'connect' );
			km.dispatch( 'accumulate' );

			// Reset active counter before compaction
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

		const texNodes = this.shaderComposer.getSceneTextureNodes();
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

		const prevColor = this.shaderComposer.prevColorTexNode;
		const prevND = this.shaderComposer.prevNormalDepthTexNode;
		const prevAlbedo = this.shaderComposer.prevAlbedoTexNode;
		const adaptiveTex = this.shaderComposer.adaptiveSamplingTexNode;
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

		// ── Extend ──
		const extFn = buildExtendKernel( {
			bvhBuffer: texNodes.bvhStorage,
			triangleBuffer: texNodes.triStorage,
			materialBuffer: texNodes.matStorage,
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

		// ── Shade ──
		const shadeFn = buildShadeKernel( {
			materialBuffer: texNodes.matStorage,
			envMarginalWeights: texNodes.marginalCDFStorage,
			envConditionalWeights: texNodes.conditionalCDFStorage,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
			shadowBufferRW: pb.shadowBuffer.rw,
			counters,
			// activeIndicesRO removed — Shade uses instanceIndex as rayID to stay at 8 bindings
			albedoMaps: texNodes.albedoMapsTex,
			normalMaps: texNodes.normalMapsTex,
			bumpMaps: texNodes.bumpMapsTex,
			metalnessMaps: texNodes.metalnessMapsTex,
			roughnessMaps: texNodes.roughnessMapsTex,
			emissiveMaps: texNodes.emissiveMapsTex,
			envTexture: texNodes.envTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			enableEnvironmentLight: this.enableEnvironment,
			useEnvMapIS: this.useEnvMapIS,
			envTotalSum: this.envTotalSum,
			envResolution: this.envResolution,
			// Light uniform arrays (NOT storage buffers)
			directionalLightsBuffer: this.directionalLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			pointLightsBuffer: this.pointLightsBufferNode,
			numPointLights: this.numPointLights,
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

		// ── Sort (material sorting for subgroup coherence) ──
		const sortFn = buildSortKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			activeIndicesReadRO: qm.getActiveReadRO(),
			sortedIndicesRW: qm.getSortedRW(),
			counters,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'sort',
			sortFn().compute(
				[ Math.ceil( maxRays / SORT_WG_SIZE ), 1, 1 ],
				[ SORT_WG_SIZE, 1, 1 ]
			)
		);

		// ── Connect (shadow ray traversal) ──
		const connectFn = buildConnectKernel( {
			bvhBuffer: texNodes.bvhStorage,
			triangleBuffer: texNodes.triStorage,
			materialBuffer: texNodes.matStorage,
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
		console.log( `WavefrontPathTracerStage: All kernels built (${w}×${h}, ${maxRays} rays)` );

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
