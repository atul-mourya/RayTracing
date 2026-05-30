/**
 * Wavefront path tracer stage — decomposed kernel dispatch (Extend → [Sort] → Shade → Compact per
 * bounce, bookended by Generate + FinalWrite). Extends PathTracer for sub-manager reuse.
 */

import { uniform, texture } from 'three/tsl';
import { PathTracer } from './PathTracer.js';
import { PackedRayBuffer } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { WavefrontKernelManager } from '../Processor/WavefrontKernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/wavefront/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/wavefront/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/wavefront/ShadeKernel.js';
import { buildCompactKernel, buildCompactSubgroupKernel, COMPACT_WG_SIZE } from '../TSL/wavefront/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/wavefront/FinalWriteKernel.js';
import { buildSortKernel, SORT_WG_SIZE } from '../TSL/wavefront/SortKernel.js';
import {
	buildSortGlobalHistogramKernel,
	buildSortGlobalPrefixSumKernel,
	buildSortGlobalScatterKernel,
	SORT_GLOBAL_WG_SIZE,
} from '../TSL/wavefront/SortGlobalKernels.js';
import { ENGINE_DEFAULTS } from '../EngineDefaults.js';
import {
	Fn, uint, atomicStore, atomicLoad, instanceIndex, If, Return,
} from 'three/tsl';

export class WavefrontPathTracer extends PathTracer {

	constructor( renderer, scene, camera, options = {} ) {

		super( renderer, scene, camera, options );
		this.name = 'WavefrontPathTracer';

		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._wavefrontReady = false;

		// CPU sizes per-bounce kernels from last frame's survivor curve; kernels bound on ENTERING_COUNT so over-sizing is safe. (indirect dispatch not viable — three.js doesn't sync compute-written indirect buffers across submissions)
		this._useDynamicDispatch = true;

		// Flag-gated off: perf-neutral vs atomic-append and adds a 'subgroups' feature dependency.
		this._useSubgroupCompact = false;

		// Multi-sample pool: S=samplesPerPixel primary rays/pixel/frame (interactive-only, ≤ the pixel cap; else S=1). FinalWrite averages the S slots. Baked into kernels; _ensureSamplesPerPass() rebuilds on change.
		this._multiSampleMaxPixels = ENGINE_DEFAULTS.wavefrontMultiSampleMaxPixels ?? 589824; // 768²
		this._samplesPerPass = 1;

		this._lastBounceCounts = null;
		this._readbackPending = false;
		this._readbackEveryNFrames = 4;
		this._readbackFrameCounter = 0;
		// 0.1% of primary ray count, floored at 100; -1 to disable. Updated per-scene in _buildWavefrontKernels.
		this._bounceEarlyExitThreshold = 100;

		this._wfTileOffsetX = uniform( 0, 'int' );
		this._wfTileOffsetY = uniform( 0, 'int' );
		this._wfRenderWidth = uniform( 1920, 'int' );
		this._wfRenderHeight = uniform( 1080, 'int' );
		this._wfMaxRayCount = uniform( 0, 'uint' );
		this._wfShadowRayCount = uniform( 0, 'uint' );
		this._wfCurrentBounce = uniform( 0, 'int' );

		console.log( 'WavefrontPathTracer: initialized' );

	}

	setupMaterial() {

		super.setupMaterial();

		// First setupMaterial call has 0 triangles/materials — skip it.
		if ( this.materialData?.materialCount > 0 ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	render( context, writeBuffer ) {

		// Wavefront kernels have no debug branch; delegate debug viz to the monolithic path.
		if ( this.visMode?.value > 0 ) {

			super.render( context, writeBuffer );
			return;

		}

		if ( ! this.isReady || ! this._wavefrontReady ) {

			super.render( context, writeBuffer );
			return;

		}

		if ( this.isComplete || this.frameCount >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor?.start();

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
		this._ensureSamplesPerPass();
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

		if ( tileInfo.tileIndex >= 0 && tileInfo.tileBounds ) {

			this._setWfTileDispatch(
				tileInfo.tileBounds.x, tileInfo.tileBounds.y,
				tileInfo.tileBounds.width, tileInfo.tileBounds.height
			);

		} else {

			this._setWfFullDispatch();

		}

		const readTextures = this.storageTextures.getReadTextures();
		if ( this.shaderBuilder.prevColorTexNode ) {

			this.shaderBuilder.prevColorTexNode.value = readTextures.color;
			this.shaderBuilder.prevNormalDepthTexNode.value = readTextures.normalDepth;
			this.shaderBuilder.prevAlbedoTexNode.value = readTextures.albedo;

		}

		// Wavefront's texture nodes are independent; monolithic's updateSceneTextures doesn't reach them.
		this._refreshWfTextureNodes();

		const km = this._kernelManager;

		km.dispatch( 'resetCounters' );
		km.dispatch( 'generate' );
		km.dispatch( 'initActiveIndices' );

		const maxBounces = this.maxBounces.value;
		// Transmissive/SSS steps consume iterations without advancing camera-bounce depth, so the loop must run far enough for deep glass/subsurface walks (mirror PathTracerCore); the survivor curve + early-exit break it early on non-SSS scenes.
		const loopBound = maxBounces + this.transmissiveBounces.value + this.maxSubsurfaceSteps.value;
		const maxRays = this._wfMaxRayCount.value;

		for ( let bounce = 0; bounce <= loopBound; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			// Functional-compaction path (dynamic + sort-off): copyback keeps the read buffer dense, kernels sized to live survivors. Sort-on/dynamic-off use the full path (ENTERING=maxRays, identity buffer) — survivor accounting diverges under sort.
			const useFunctionalCompaction = this._useDynamicDispatch && ! this._sortMaterials;
			if ( useFunctionalCompaction ) {

				// ENTERING_COUNT already set (bounce 0 by initActiveIndices, N>0 by snapshotBounceCount); size from last frame's survivor curve with a 1.5×+1024 margin.
				let entering = maxRays;
				if ( bounce > 0 ) {

					const lc = this._lastBounceCounts;
					const prev = lc && lc[ bounce - 1 ] !== undefined ? lc[ bounce - 1 ] : maxRays;
					entering = prev > 0 ? prev : maxRays;

				}

				const sized = Math.min( maxRays, Math.ceil( entering * 1.5 ) + 1024 );
				const wg = [ Math.ceil( sized / 256 ), 1, 1 ];
				km.setDispatchCount( 'extend', wg );
				km.setDispatchCount( 'shade', wg );
				km.setDispatchCount( 'compact', wg );
				km.setDispatchCount( 'compactCopyback', wg );

			} else {

				km.dispatch( 'enterFull' );
				const full = [ Math.ceil( maxRays / 256 ), 1, 1 ];
				km.setDispatchCount( 'extend', full );
				km.setDispatchCount( 'shade', full );
				km.setDispatchCount( 'compact', full );

			}

			// Extend/Shade kept separate (not fused): a fused kernel's register pressure drops occupancy more than fusion saves.
			km.dispatch( 'extend' );
			if ( this._sortGlobal ) {

				km.dispatch( 'resetSortGlobalHistogram' );
				km.dispatch( 'sortGlobalHist' );
				km.dispatch( 'sortGlobalPrefix' );
				km.dispatch( 'sortGlobalScatter' );

			} else if ( this._sortMaterials ) {

				km.dispatch( 'resetSortHistogram' );
				km.dispatch( 'sort' );

			}

			km.dispatch( 'shade' );

			km.dispatch( 'resetActiveCounter' );
			km.dispatch( 'compact' );
			if ( useFunctionalCompaction ) km.dispatch( 'compactCopyback' );
			km.dispatch( 'snapshotBounceCount' );
			// No swap: pingPong stays 0 (kernels are build-time-bound to buffer A).

			// Early-exit on last frame's per-bounce snapshot (stale via async readback, fine for a heuristic).
			if (
				this._lastBounceCounts
				&& bounce < loopBound
				&& this._lastBounceCounts[ bounce ] !== undefined
				&& this._lastBounceCounts[ bounce ] <= this._bounceEarlyExitThreshold
			) {

				break;

			}

		}

		km.dispatch( 'finalWrite' );

		this._maybeReadbackCounters();

		this.storageTextures.copyToReadTargets( this.renderer );

		const readTex = this.storageTextures.getReadTextures();
		if ( context ) this._publishTexturesToContext( context, readTex );

		this._emitStateEvents();
		this.frameCount ++;

		if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;
		if ( originalSamplesPerPixel !== null ) this.samplesPerPixel.value = originalSamplesPerPixel;

		this.performanceMonitor?.end();

	}

	// Parent resizes storageTextures/shaderBuilder; wavefront also needs its buffers/uniforms/kernels rebuilt.
	_handleResize() {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super._handleResize();

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// S=samplesPerPixel for interactive within the pixel cap; production/tiled and high-res get S=1.
	_resolveSamplesPerPass( w, h ) {

		const interactive = this.renderMode.value === 0;
		const within = ( w * h ) <= this._multiSampleMaxPixels;
		return ( interactive && within ) ? Math.max( 1, this.samplesPerPixel.value | 0 ) : 1;

	}

	// S is baked at build but samplesPerPixel/mode can change without a resize; rebuild when the implied S differs.
	_ensureSamplesPerPass() {

		if ( ! this._wavefrontReady ) return;
		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		if ( this._resolveSamplesPerPass( w, h ) !== this._samplesPerPass ) {

			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	// UI-driven resize (Resolution dropdown) — parent bypasses _handleResize(), so hook here too.
	setSize( width, height ) {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super.setSize( width, height );

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// Async readback of the per-bounce snapshot every N frames; never awaited, so the early-exit uses past-frame data.
	_maybeReadbackCounters() {

		if ( this._readbackPending ) return;

		this._readbackFrameCounter ++;
		if ( this._readbackFrameCounter < this._readbackEveryNFrames ) return;
		this._readbackFrameCounter = 0;

		const attr = this._queueManager?.getBounceCountsAttribute();
		if ( ! attr ) return;

		this._readbackPending = true;
		this.renderer.getArrayBufferAsync( attr ).then( ( buf ) => {

			this._lastBounceCounts = new Uint32Array( buf.slice( 0 ) );
			this._readbackPending = false;

		} ).catch( ( e ) => {

			console.warn( 'Wavefront bounceCounts readback failed:', e );
			this._readbackPending = false;

		} );

	}

	// Sync wavefront's texture nodes with current env/material textures; only a changed ref triggers GPU rebind.
	_refreshWfTextureNodes() {

		const t = this._wfTexNodes;
		if ( ! t ) return;

		const env = this.environment?.environmentTexture;
		if ( env && t.envTex ) t.envTex.value = env;

		const mat = this.materialData;
		if ( ! mat ) return;
		if ( mat.albedoMaps && t.albedoMaps ) t.albedoMaps.value = mat.albedoMaps;
		if ( mat.normalMaps && t.normalMaps ) t.normalMaps.value = mat.normalMaps;
		if ( mat.bumpMaps && t.bumpMaps ) t.bumpMaps.value = mat.bumpMaps;
		if ( mat.metalnessMaps && t.metalnessMaps ) t.metalnessMaps.value = mat.metalnessMaps;
		if ( mat.roughnessMaps && t.roughnessMaps ) t.roughnessMaps.value = mat.roughnessMaps;
		if ( mat.emissiveMaps && t.emissiveMaps ) t.emissiveMaps.value = mat.emissiveMaps;
		if ( mat.displacementMaps && t.displacementMaps ) t.displacementMaps.value = mat.displacementMaps;

	}

	_rebuildKernelsIfResized( oldW, oldH ) {

		const newW = this.storageTextures.renderWidth;
		const newH = this.storageTextures.renderHeight;
		if ( ( newW === oldW && newH === oldH ) || ! ( this.materialData?.materialCount > 0 ) ) return;

		// Recompile only when buffers reallocate (capacity grows) or S changes; otherwise resize uniforms in place.
		const newS = this._resolveSamplesPerPass( newW, newH );
		const neededCap = PackedRayBuffer.requiredCapacity( newW * newH * newS );
		const mustRebuild = ! this._packedBuffers
			|| neededCap > this._packedBuffers.capacity
			|| newS !== this._samplesPerPass;

		if ( mustRebuild ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		} else {

			this._resizeWavefrontInPlace( newW, newH );

		}

	}

	// Same-capacity, same-S resize: update render-size uniforms + early-exit threshold, no recompile.
	_resizeWavefrontInPlace( w, h ) {

		const maxRays = w * h * this._samplesPerPass;
		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._wfMaxRayCount.value = maxRays;
		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( maxRays / 1000 ) );

		}

	}

	_buildWavefrontKernels() {

		const texNodes = this.shaderBuilder.getSceneTextureNodes();
		if ( ! texNodes ) return;

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		// maxRays = pool capacity (pixels × S); all downstream sizing scales off it, so S propagates for free.
		this._samplesPerPass = this._resolveSamplesPerPass( w, h );
		const S = this._samplesPerPass | 0;
		const maxRaysPerSample = w * h;
		const maxRays = maxRaysPerSample * S;

		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( maxRays / 1000 ) );

		}

		if ( ! this._packedBuffers ) {

			this._packedBuffers = new PackedRayBuffer( maxRays );

		} else {

			this._packedBuffers.resize( maxRays );

		}

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

		// Sort regresses on low material diversity; only enable above this count.
		const SORT_MIN_MATERIALS = 8;
		const matCount = this.materialData?.materialCount ?? 0;
		this._sortMaterials = ( ENGINE_DEFAULTS.wavefrontSortMaterials ?? false )
			&& matCount > SORT_MIN_MATERIALS;
		this._sortGlobal = this._sortMaterials && ( ENGINE_DEFAULTS.wavefrontSortGlobal ?? false );

		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._wfMaxRayCount.value = maxRays;

		const prevColor = this.shaderBuilder.prevColorTexNode;
		const prevND = this.shaderBuilder.prevNormalDepthTexNode;
		const prevAlbedo = this.shaderBuilder.prevAlbedoTexNode;
		const adaptiveTex = this.shaderBuilder.adaptiveSamplingTexNode;
		const writeTex = this.storageTextures.getWriteTextures();

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

		const resetActiveFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );

		} );
		this._kernelManager.register( 'resetActiveCounter',
			resetActiveFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const resetShadowFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.SHADOW_RAY_COUNT ) ), uint( 0 ) );

		} );
		this._kernelManager.register( 'resetShadowCounter',
			resetShadowFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// Copy ACTIVE_RAY_COUNT into bounceCounts[currentBounce] for the readback survivor curve.
		const bounceCountsBuf = qm.getBounceCounts();
		const wfCurrentBounce = this._wfCurrentBounce;
		const snapshotFn = Fn( () => {

			const cnt = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( qm.MAX_BOUNCE_SNAPSHOTS - 1 ) );
			bounceCountsBuf.element( slot ).assign( cnt );
			// Also set ENTERING_COUNT for the next bounce (folds in snapshotEntering); full path's enterFull overrides it.
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), cnt );

		} );
		this._kernelManager.register( 'snapshotBounceCount',
			snapshotFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const activeWriteA = qm.activeIndices.a;
		const initFn = Fn( () => {

			const tid = instanceIndex;
			activeWriteA.element( tid ).assign( tid );
			// Seed ACTIVE_RAY_COUNT + ENTERING_COUNT from the _wfMaxRayCount uniform (not a literal) so in-place resize works.
			If( tid.equal( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), this._wfMaxRayCount );
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), this._wfMaxRayCount );

			} );

		} );
		this._kernelManager.register( 'initActiveIndices',
			initFn().compute( [ Math.ceil( maxRays / 256 ), 1, 1 ], [ 256, 1, 1 ] )
		);

		const genFn = buildGenerateKernel( {
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			resolution: this.resolution,
			frame: this.frame,
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
			samplesPerPass: S,
			maxRaysPerSample,
		} );
		this._kernelManager.register( 'generate',
			genFn().compute(
				// Multi-sample: dispatch covers h·S rows (each sub-sample is a row band).
				[ Math.ceil( w / GENERATE_WG_SIZE ), Math.ceil( ( h * S ) / GENERATE_WG_SIZE ), 1 ],
				[ GENERATE_WG_SIZE, GENERATE_WG_SIZE, 1 ]
			)
		);

		const freshBvh = this.bvhStorageNode;
		const freshTri = this.triangleStorageNode;
		const freshMat = this.materialData.materialStorageNode;
		const freshEnvCDF = this.environment.envCDFStorageNode;
		const freshLight = this.lightStorageNode;
		// Independent texture nodes (never compiled elsewhere) avoid Three.js TextureNode caching across pipelines; refreshed via _refreshWfTextureNodes.
		const _mat = this.materialData;
		const _env = this.environment;
		const _placeholder = texNodes.albedoMapsTex;
		const freshAlbedoMaps = _mat.albedoMaps ? texture( _mat.albedoMaps ) : _placeholder;
		const freshNormalMaps = _mat.normalMaps ? texture( _mat.normalMaps ) : texNodes.normalMapsTex;
		const freshBumpMaps = _mat.bumpMaps ? texture( _mat.bumpMaps ) : texNodes.bumpMapsTex;
		const freshMetalnessMaps = _mat.metalnessMaps ? texture( _mat.metalnessMaps ) : texNodes.metalnessMapsTex;
		const freshRoughnessMaps = _mat.roughnessMaps ? texture( _mat.roughnessMaps ) : texNodes.roughnessMapsTex;
		const freshEmissiveMaps = _mat.emissiveMaps ? texture( _mat.emissiveMaps ) : texNodes.emissiveMapsTex;
		const freshDisplacementMaps = _mat.displacementMaps ? texture( _mat.displacementMaps ) : texNodes.displacementMapsTex;
		const freshEnvTex = _env.environmentTexture ? texture( _env.environmentTexture ) : texNodes.envTex;

		this._wfTexNodes = {
			envTex: freshEnvTex,
			albedoMaps: freshAlbedoMaps,
			normalMaps: freshNormalMaps,
			bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps,
			roughnessMaps: freshRoughnessMaps,
			emissiveMaps: freshEmissiveMaps,
			displacementMaps: freshDisplacementMaps,
		};

		const extFn = buildExtendKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRW: pb.hitBuffer.rw,
			activeIndicesRO: qm.getActiveReadRO(),
			counters,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'extend',
			extFn().compute(
				[ Math.ceil( maxRays / EXTEND_WG_SIZE ), 1, 1 ],
				[ EXTEND_WG_SIZE, 1, 1 ]
			)
		);

		// Material-index counting sort for subgroup coherence.
		if ( this._sortMaterials ) {

			// Reset histogram before each dispatch (atomicAdd accumulates).
			const histogram = qm.getSortHistogram();
			const histogramSize = qm.getSortHistogramSize();
			const resetHistFn = Fn( () => {

				const tid = instanceIndex;
				If( tid.lessThan( uint( histogramSize ) ), () => {

					atomicStore( histogram.element( tid ), uint( 0 ) );

				} );

			} );
			this._kernelManager.register( 'resetSortHistogram',
				resetHistFn().compute(
					[ Math.ceil( histogramSize / 256 ), 1, 1 ],
					[ 256, 1, 1 ]
				)
			);

			const sortFn = buildSortKernel( {
				hitBufferRO: pb.hitBuffer.ro,
				activeIndicesReadRO: qm.getActiveReadRO(),
				sortedIndicesRW: qm.getSortedRW(),
				sortHistogram: histogram,
				counters,
				materialBinRemap: this.materialData?.materialBinRemapNode,
			} );
			this._kernelManager.register( 'sort',
				sortFn().compute(
					[ Math.ceil( maxRays / SORT_WG_SIZE ), 1, 1 ],
					[ SORT_WG_SIZE, 1, 1 ]
				)
			);

			// Global sort kernels built alongside per-WG sort so the dispatch path can pick at runtime.
			if ( this._sortGlobal ) {

				const globalHist = qm.getSortGlobalHistogram();
				const sortBins = ENGINE_DEFAULTS.wavefrontSortBins ?? 16;

				const resetGlobalHistFn = Fn( () => {

					If( instanceIndex.lessThan( uint( sortBins ) ), () => {

						atomicStore( globalHist.element( instanceIndex ), uint( 0 ) );

					} );

				} );
				this._kernelManager.register( 'resetSortGlobalHistogram',
					resetGlobalHistFn().compute( [ 1, 1, 1 ], [ sortBins, 1, 1 ] )
				);

				const globalHistFn = buildSortGlobalHistogramKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortGlobalHistogram: globalHist,
					counters,
					materialBinRemap: this.materialData?.materialBinRemapNode,
				} );
				this._kernelManager.register( 'sortGlobalHist',
					globalHistFn().compute(
						[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
						[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
					)
				);

				const globalPrefixFn = buildSortGlobalPrefixSumKernel( {
					sortGlobalHistogram: globalHist,
				} );
				this._kernelManager.register( 'sortGlobalPrefix',
					globalPrefixFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
				);

				const globalScatterFn = buildSortGlobalScatterKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortedIndicesRW: qm.getSortedRW(),
					sortGlobalHistogram: globalHist,
					counters,
					materialBinRemap: this.materialData?.materialBinRemapNode,
				} );
				this._kernelManager.register( 'sortGlobalScatter',
					globalScatterFn().compute(
						[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
						[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
					)
				);

			}

		}

		const shadeFn = buildShadeKernel( {
			envCompensationDelta: this.envCompensationDelta,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envCDFBuffer: freshEnvCDF,
			lightBuffer: freshLight,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
			shadowBufferRW: pb.shadowBuffer.rw,
			counters,
			activeIndicesRO: this._sortMaterials ? qm.getSortedRO() : qm.getActiveReadRO(),
			albedoMaps: freshAlbedoMaps,
			normalMaps: freshNormalMaps,
			bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps,
			roughnessMaps: freshRoughnessMaps,
			emissiveMaps: freshEmissiveMaps,
			displacementMaps: freshDisplacementMaps,
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
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
			resolution: this.resolution,
			emissiveTriangleCount: this.emissiveTriangleCount,
			emissiveVec4Offset: this.emissiveVec4Offset,
			emissiveTotalPower: this.emissiveTotalPower,
			emissiveBoost: this.emissiveBoost,
			totalTriangleCount: this.totalTriangleCount,
			enableEmissiveTriangleSampling: this.enableEmissiveTriangleSampling,
			lightBVHNodeCount: this.lightBVHNodeCount,
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'shade',
			shadeFn().compute(
				[ Math.ceil( maxRays / SHADE_WG_SIZE ), 1, 1 ],
				[ SHADE_WG_SIZE, 1, 1 ]
			)
		);

		// Subgroup prefix-sum variant when supported.
		const subgroupsOK = this._useSubgroupCompact
			&& ( this.renderer.hasFeature ? this.renderer.hasFeature( 'subgroups' ) : false );
		this._compactIsSubgroup = subgroupsOK;
		const compactBuilder = subgroupsOK ? buildCompactSubgroupKernel : buildCompactKernel;
		const compactFn = compactBuilder( {
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

		// Storage nodes bind buffer A at build time, so compactCopyback must copy the dense survivor list B→A for the next bounce; snapshotEntering bounds the kernels to its length.
		const enterFn = Fn( () => {

			const c = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), c );

		} );
		this._kernelManager.register( 'snapshotEntering',
			enterFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// Full-dispatch path: ENTERING_COUNT = maxRays, kernels read the identity buffer over [0,maxRays).
		const enterFullFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), this._wfMaxRayCount );

		} );
		this._kernelManager.register( 'enterFull',
			enterFullFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const copyReadB = qm.activeIndicesRO.b; // compact writes B (pingPong fixed at 0)
		const copyWriteA = qm.activeIndices.a;
		const copyFn = Fn( () => {

			const tid = instanceIndex;
			If( tid.greaterThanEqual( atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) ) ), () => {

				Return();

			} );
			copyWriteA.element( tid ).assign( copyReadB.element( tid ) );

		} );
		this._kernelManager.register( 'compactCopyback',
			copyFn().compute( [ Math.ceil( maxRays / 256 ), 1, 1 ], [ 256, 1, 1 ] )
		);

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
			samplesPerPass: S,
			maxRaysPerSample,
		} );
		this._kernelManager.register( 'finalWrite',
			// Per-pixel (w×h) — kernel averages the S sample-slots internally.
			fwFn().compute(
				[ Math.ceil( w / FINALWRITE_WG_SIZE ), Math.ceil( h / FINALWRITE_WG_SIZE ), 1 ],
				[ FINALWRITE_WG_SIZE, FINALWRITE_WG_SIZE, 1 ]
			)
		);

		this._wavefrontReady = true;
		console.log( `WavefrontPathTracer: All kernels built (${w}×${h}, ${maxRays} rays)` );

	}

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
		const S = this._samplesPerPass | 0;

		this._kernelManager.setDispatchCount( 'generate', [
			Math.ceil( w / GENERATE_WG_SIZE ),
			Math.ceil( ( h * S ) / GENERATE_WG_SIZE ), 1
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
