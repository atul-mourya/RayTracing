/**
 * Wavefront path tracer — decomposed kernel dispatch (Extend → [Sort] → Shade → Compact per
 * bounce, bookended by Generate + FinalWrite; DebugKernel for visMode). Extends PathTracerStage
 * for shared engine/scene infrastructure (managers, uniforms, camera, lights, BVH, accumulation).
 */

import { uniform, texture, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { PathTracerStage } from './PathTracerStage.js';
import { PackedRayBuffer, GBUFFER_STRIDE, freeStorageAttribute } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { VRAMTracker } from '../Processor/VRAMTracker.js';
import { KernelManager } from '../Processor/KernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/ShadeKernel.js';
import { buildCompactKernel, buildCompactSubgroupKernel, COMPACT_WG_SIZE } from '../TSL/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/FinalWriteKernel.js';
import { buildDebugKernel, DEBUG_WG_SIZE } from '../TSL/DebugKernel.js';
import { setMaterialBucketTextures, buildBucketTextureNodes, refreshBucketTextureNodes } from '../TSL/TextureSampling.js';
import { setShadowAlbedoMaps } from '../TSL/LightsDirect.js';
import {
	buildResetGlobalHistKernel, buildGlobalHistKernel, buildGlobalPrefixKernel, buildGlobalScatterKernel,
	SORT_GLOBAL_WG_SIZE, SORT_GLOBAL_MAX_BINS,
} from '../TSL/SortGlobalKernels.js';
import { ENGINE_DEFAULTS } from '../EngineDefaults.js';
import {
	Fn, uint, atomicStore, atomicLoad, instanceIndex, If, Return,
} from 'three/tsl';

export class PathTracer extends PathTracerStage {

	constructor( renderer, scene, camera, options = {} ) {

		super( renderer, scene, camera, options );
		this.name = 'PathTracer';

		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._gBufferAttr = null; // per-pixel first-hit MRT (ND + albedo); see _buildWavefrontKernels
		this._wavefrontReady = false;

		// Aux MRT (normalDepth + albedo) feeds only the denoiser/OIDN. When no denoiser is active the
		// wavefront skips those writes (Generate/Shade G-buffer + FinalWrite stores). Gated by a live
		// uniform — NOT baked — so DenoisingManager can toggle it without a (UI-freezing) kernel rebuild.
		this._auxGBufferEnabled = false;
		this._auxGBufferUniform = uniform( 0, 'uint' );

		// CPU sizes per-bounce kernels from last frame's survivor curve; kernels bound on ENTERING_COUNT so over-sizing is safe. (indirect dispatch not viable — three.js doesn't sync compute-written indirect buffers across submissions)
		this._useDynamicDispatch = true;

		// Global material-coherence sort: set per-build from ENGINE_DEFAULTS + material count (>8).
		// Reorders entering rays into material-pure workgroups before Shade; runs under dynamic dispatch
		// (compact reads the unsorted active list, so the survivor set is unchanged). Measured −8% at 1024²/8b.
		this._sortMaterials = false;

		// Flag-gated off: perf-neutral vs atomic-append and adds a 'subgroups' feature dependency.
		this._useSubgroupCompact = false;

		this._lastBounceCounts = null;
		// maxBounces the curve was measured at; the curve is ignored once this no longer matches (-1 = none).
		this._lastBounceCountsBudget = - 1;
		this._readbackPending = false;
		this._readbackEveryNFrames = 4;
		this._readbackFrameCounter = 0;
		// Bumped on resolution change; a readback that resolves with a stale generation is dropped.
		this._readbackGeneration = 0;
		// 0.1% of primary ray count, floored at 100; -1 to disable. Updated per-scene in _buildWavefrontKernels.
		this._bounceEarlyExitThreshold = 100;

		this._wfRenderWidth = uniform( 1920, 'int' );
		this._wfRenderHeight = uniform( 1080, 'int' );
		this._wfMaxRayCount = uniform( 0, 'uint' );
		this._wfCurrentBounce = uniform( 0, 'int' );

		// VRAM accounting — providers are thunks reading CURRENT live resources,
		// so they survive buffer/texture reallocation (resize, scene/material reload).
		this.vramTracker = new VRAMTracker( this.renderer );
		this._registerVRAMProviders();

		console.log( 'PathTracer: initialized (wavefront)' );

	}

	_registerVRAMProviders() {

		const t = this.vramTracker;

		// Wavefront ray-state SoA buffers (rw/ro nodes share one GPU buffer per attr)
		t.register( 'rays', () => {

			const a = this._packedBuffers?._attrs;
			return a ? [ a.ray, a.rng, a.hit ] : null;

		} );

		// Queue indices + atomic counters
		t.register( 'queues', () => {

			const qm = this._queueManager;
			if ( ! qm ) return null;
			return [
				qm._countersAttr, qm._bounceCountsAttr,
				qm._attrA, qm._attrB, qm._sortAttr,
			];

		} );

		// Per-pixel first-hit G-buffer (normal/depth + albedo)
		t.register( 'gbuffer', () => this._gBufferAttr ? [ this._gBufferAttr ] : null );

		// Accumulation pool: 3 write StorageTextures (2048²) + readable MRT RenderTarget
		t.register( 'accum', () => {

			const sp = this.storageTextures;
			return sp ? [ sp.writeColor, sp.writeNormalDepth, sp.writeAlbedo, sp.readTarget ] : null;

		} );

		// Scene geometry (triangle data, two-level BVH, light BVH + emissive)
		t.register( 'geometry', () => [ this.triangleStorageAttr, this.bvhStorageAttr, this.lightStorageAttr ] );

		// Material storage buffer + per-property texture arrays
		t.register( 'materials', () => {

			const m = this.materialData;
			if ( ! m ) return null;
			return [
				m.materialStorageAttr,
				...( m.srgbBuckets || [] ).filter( Boolean ),
				...( m.linearBuckets || [] ).filter( Boolean ),
			];

		} );

		// Environment map + importance-sampling CDF
		t.register( 'environment', () => {

			const e = this.environment;
			return e ? [ e.environmentTexture, e.envCDFTexture ] : null;

		} );

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

	render( context ) {

		// Kernels not built yet (first frame / mid-resize) — skip until ready.
		if ( ! this.isReady || ! this._wavefrontReady ) return;

		if ( this.isComplete || this.frameCount >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor?.start();

		const frameValue = this.frameCount;
		const renderMode = this.renderMode.value;

		let originalMaxBounces = null;

		if ( renderMode === 1 && frameValue === 0 ) {

			originalMaxBounces = this.maxBounces.value;
			this.maxBounces.value = 1;

		}

		this._handleResize();
		this.manageASVGFForRenderMode( renderMode );

		// Full-frame render is always a complete cycle (PER_CYCLE stages gate on this).
		if ( context ) context.setState( 'tileRenderingComplete', true );

		this.cameraChanged = this._updateCameraUniforms();
		this.cameraOptimizer?.updateInteractionMode( this.cameraChanged );
		this._updateAccumulationUniforms( frameValue, renderMode );
		this.frame.value = frameValue;

		this._setWfDispatch();

		const readTextures = this.storageTextures.getReadTextures();
		if ( this.shaderBuilder.prevColorTexNode ) {

			this.shaderBuilder.prevColorTexNode.value = readTextures.color;
			this.shaderBuilder.prevAlbedoTexNode.value = readTextures.albedo;

		}

		// Wavefront's texture nodes are independent; monolithic's updateSceneTextures doesn't reach them.
		this._refreshWfTextureNodes();

		const km = this._kernelManager;

		// Debug visualization (visMode 1-10): single-pass primary-ray kernel — no bounce loop or
		// accumulation. Mode 11 (NaN/Inf) flows through the normal pipeline below; FinalWrite flags it.
		if ( ( this.visMode?.value | 0 ) > 0 && this.visMode.value !== 11 ) {

			km.dispatch( 'debug' );

			this.storageTextures.copyToReadTargets( this.renderer );
			const dbgReadTex = this.storageTextures.getReadTextures();
			if ( context ) this._publishTexturesToContext( context, dbgReadTex );

			this._emitStateEvents();
			// Don't count interaction-mode (1-SPP feedback) frames toward completion (megakernel parity Stages/PathTracer.js:1240) — else a continuous orbit "completes" on noise.
			if ( ! this.cameraOptimizer?.isInInteractionMode() ) this.frameCount ++;

			if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;

			this.performanceMonitor?.end();
			return;

		}

		km.dispatch( 'resetCounters' );
		km.dispatch( 'generate' );
		// Generate traces every pixel; seed ENTERING_COUNT from the full identity active list.
		km.dispatch( 'initActiveIndices' );

		const maxBounces = this.maxBounces.value;
		// Transmissive/SSS steps consume iterations without advancing camera-bounce depth, so the loop must run far enough for deep glass/subsurface walks (mirror PathTracerCore); the survivor curve + early-exit break it early on non-SSS scenes.
		const loopBound = maxBounces + this.transmissiveBounces.value + this.maxSubsurfaceSteps.value;
		const maxRays = this._wfMaxRayCount.value;

		// The survivor curve survives a maxBounces change (reset() preserves it), and is reusable
		// across one: for loop iterations below BOTH the old and new camera-bounce caps, no ray has
		// been killed by either cap, so the counts are cap-independent. Trust the curve up to that
		// cutoff — the whole curve when same-budget or decreasing (old counts only over-estimate, so
		// sizing over-sizes and early-exit fires later — both safe); only the overlap [0, oldBudget)
		// when increasing (beyond it the old cap already culled rays → under-estimate → would drop
		// rays). Past the cutoff, full dispatch + no early-exit. Avoids the full-work spike (a visible
		// hitch) on every bounce-count change while a fresh curve is read back. budget=-1 (no curve,
		// e.g. cold start / post-resize) → cutoff 0 → full dispatch everywhere, matching prior behavior.
		const curve = this._lastBounceCounts;
		const curveReliableUpto = curve
			? ( maxBounces <= this._lastBounceCountsBudget ? loopBound + 1 : this._lastBounceCountsBudget )
			: 0;

		for ( let bounce = 0; bounce <= loopBound; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			// Functional-compaction path (dynamic dispatch): copyback keeps the read buffer dense, kernels sized to live survivors. Dynamic-off uses the full path (ENTERING=maxRays, identity buffer).
			// Material sort is compatible: shade reads sortedIndices while compact still reads the UNSORTED active list (getActiveReadRO), so the survivor set is unchanged.
			const useFunctionalCompaction = this._useDynamicDispatch;
			if ( useFunctionalCompaction ) {

				// ENTERING_COUNT already set (bounce 0 by initActiveIndices, N>0 by snapshotBounceCount); size from last frame's survivor curve with a 1.5×+1024 margin.
				let entering = maxRays;
				if ( bounce > 0 ) {

					const idx = bounce - 1;
					let prev;
					if ( idx < curveReliableUpto && curve[ idx ] !== undefined ) {

						prev = curve[ idx ]; // trusted exact count

					} else if ( curveReliableUpto > 0 ) {

						// Untrusted tail after a maxBounces increase: survivor counts are monotonically
						// non-increasing across bounces (rays only terminate), so the last trusted count is
						// a safe upper bound — far below maxRays, so no full-dispatch spike. Safe even if it
						// reads low: a count <= threshold would have tripped the early-exit before this bounce.
						prev = curve[ curveReliableUpto - 1 ];

					}

					entering = prev > 0 ? prev : maxRays;

				}

				const sized = Math.min( maxRays, Math.ceil( entering * 1.5 ) + 1024 );
				const wg = [ Math.ceil( sized / 256 ), 1, 1 ];
				km.setDispatchCount( 'extend', wg );
				km.setDispatchCount( 'shade', wg );
				km.setDispatchCount( 'globalHist', wg );
				km.setDispatchCount( 'globalScatter', wg );
				km.setDispatchCount( 'compact', wg );
				km.setDispatchCount( 'compactCopyback', wg );

			} else {

				km.dispatch( 'enterFull' );
				const full = [ Math.ceil( maxRays / 256 ), 1, 1 ];
				km.setDispatchCount( 'extend', full );
				km.setDispatchCount( 'shade', full );
				km.setDispatchCount( 'compact', full );
				km.setDispatchCount( 'globalHist', full );
				km.setDispatchCount( 'globalScatter', full );

			}

			// Extend/Shade kept separate (not fused): a fused kernel's register pressure drops occupancy more than fusion saves.
			km.dispatch( 'extend' );
			if ( this._sortMaterials ) {

				// Global material counting sort (material-pure workgroups): reset, histogram, prefix-sum, scatter.
				km.dispatch( 'resetGlobalHist' );
				km.dispatch( 'globalHist' );
				km.dispatch( 'globalPrefix' );
				km.dispatch( 'globalScatter' );

			}

			km.dispatch( 'shade' );

			km.dispatch( 'resetActiveCounter' );
			km.dispatch( 'compact' );
			if ( useFunctionalCompaction ) km.dispatch( 'compactCopyback' );
			km.dispatch( 'snapshotBounceCount' );
			// No swap: pingPong stays 0 (kernels are build-time-bound to buffer A).

			// Early-exit on last frame's per-bounce snapshot (stale via async readback, fine for a heuristic).
			if (
				bounce < curveReliableUpto
				&& bounce < loopBound
				&& curve[ bounce ] !== undefined
				&& curve[ bounce ] <= this._bounceEarlyExitThreshold
			) {

				break;

			}

		}

		km.dispatch( 'finalWrite' );

		this._maybeReadbackCounters();

		// Skip the normalDepth/albedo copies when aux is off — the wavefront didn't write them and
		// no stage reads them; saves two full-res GPU copies/frame in the default interactive path.
		this.storageTextures.copyToReadTargets( this.renderer, this._auxGBufferEnabled );

		const readTex = this.storageTextures.getReadTextures();
		if ( context ) this._publishTexturesToContext( context, readTex );

		this._emitStateEvents();
		// Don't count interaction-mode (1-SPP feedback) frames toward completion (megakernel parity Stages/PathTracer.js:1240) — else a continuous orbit "completes" on noise.
		if ( ! this.cameraOptimizer?.isInInteractionMode() ) this.frameCount ++;

		if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;

		this.performanceMonitor?.end();

	}

	// Parent resizes storageTextures/shaderBuilder; wavefront also needs its buffers/uniforms/kernels rebuilt.
	_handleResize() {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super._handleResize();

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// Aux MRT (normalDepth/albedo) is needed only by the denoiser/OIDN; DenoisingManager calls this to
	// turn the wavefront's aux writes on/off. It's a live uniform, so toggling is just a value flip +
	// accumulation reset — no kernel rebuild, no UI freeze.
	setAuxGBufferEnabled( enabled ) {

		enabled = !! enabled;
		if ( this._auxGBufferEnabled === enabled ) return;
		this._auxGBufferEnabled = enabled;
		this._auxGBufferUniform.value = enabled ? 1 : 0;
		this.reset();

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
		const gen = this._readbackGeneration;
		const budget = this.maxBounces.value;
		this.renderer.getArrayBufferAsync( attr ).then( ( buf ) => {

			// Drop counts measured at a now-stale resolution (a resize happened mid-flight).
			if ( gen === this._readbackGeneration ) {

				this._lastBounceCounts = new Uint32Array( buf.slice( 0 ) );
				this._lastBounceCountsBudget = budget;

			}

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
		// CDF texture is replaced (new DataTexture) on each HDRI/env build — repoint the node.
		if ( this.environment?.envCDFTexture && t.envCDFTex ) t.envCDFTex.value = this.environment.envCDFTexture;

		const mat = this.materialData;
		if ( ! mat ) return;
		refreshBucketTextureNodes( t.srgbBuckets, mat.srgbBuckets );
		refreshBucketTextureNodes( t.linearBuckets, mat.linearBuckets );

	}

	_rebuildKernelsIfResized( oldW, oldH ) {

		const newW = this.storageTextures.renderWidth;
		const newH = this.storageTextures.renderHeight;
		if ( ( newW === oldW && newH === oldH ) || ! ( this.materialData?.materialCount > 0 ) ) return;

		// A survivor curve from the old resolution mis-sizes the per-bounce dispatch at the new one
		// (row-major active list → under-coverage of the lower rows → GI band). Force full coverage
		// until the readback re-measures at the new size; bump the generation so any readback already
		// in flight (carrying the old-resolution counts) is discarded when it resolves.
		this._lastBounceCounts = null;
		this._lastBounceCountsBudget = - 1;
		this._readbackFrameCounter = 0;
		this._readbackGeneration ++;

		// Recompile only when buffers reallocate (capacity grows); otherwise resize uniforms in place.
		const neededCap = PackedRayBuffer.requiredCapacity( newW * newH );
		const mustRebuild = ! this._packedBuffers
			|| neededCap > this._packedBuffers.capacity;

		if ( mustRebuild ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		} else {

			this._resizeWavefrontInPlace( newW, newH );

		}

	}

	// Same-capacity resize: update render-size uniforms + early-exit threshold, no recompile.
	_resizeWavefrontInPlace( w, h ) {

		const maxRays = w * h;
		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._wfMaxRayCount.value = maxRays;
		// initActiveIndices is dispatched bare (not re-sized per frame); its grid must cover the grown range or the identity buffer is left unseeded over [oldMaxRays, maxRays).
		this._kernelManager?.setDispatchCount( 'initActiveIndices', [ Math.ceil( maxRays / 256 ), 1, 1 ] );
		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( maxRays / 1000 ) );

		}

	}

	_buildWavefrontKernels() {

		const texNodes = this.shaderBuilder.getSceneTextureNodes();
		if ( ! texNodes ) return;

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		const maxRays = w * h;

		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( maxRays / 1000 ) );

		}

		if ( ! this._packedBuffers ) {

			this._packedBuffers = new PackedRayBuffer( maxRays, this.renderer );

		} else {

			this._packedBuffers.resize( maxRays );

		}

		// Per-pixel G-buffer (first-hit MRT: ND + albedo), 1 uvec4/pixel — half-precision packed (pack2x16).
		// uint (not f32) buffer: packed lanes can hit the NaN exponent range (e.g. snorm 1.0 → 0x7FFF), which a
		// GPU may canonicalize through f32 storage; u32 stores the bits verbatim. Separate from RAY — it's
		// per-pixel, written by Generate/Shade bounce-0 and read only by FinalWrite.
		// 1.25× margin (same as the per-ray buffers) so it survives the in-place-resize range.
		const gBufferVec4s = PackedRayBuffer.requiredCapacity( maxRays ) * GBUFFER_STRIDE;
		freeStorageAttribute( this.renderer, this._gBufferAttr ); // free the outgoing G-buffer on capacity growth
		this._gBufferAttr = new StorageInstancedBufferAttribute( new Uint32Array( gBufferVec4s * 4 ), 4 );
		const gBufferRW = storage( this._gBufferAttr, 'uvec4' );
		const gBufferRO = storage( this._gBufferAttr, 'uvec4' ).toReadOnly();

		if ( ! this._queueManager ) {

			this._queueManager = new QueueManager( this._packedBuffers.capacity, this.renderer );

		} else {

			this._queueManager.resize( this._packedBuffers.capacity );

		}

		if ( ! this._kernelManager ) {

			this._kernelManager = new KernelManager( this.renderer );

		}

		const pb = this._packedBuffers;
		const qm = this._queueManager;

		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._wfMaxRayCount.value = maxRays;

		const prevColor = this.shaderBuilder.prevColorTexNode;
		const prevAlbedo = this.shaderBuilder.prevAlbedoTexNode;
		const writeTex = this.storageTextures.getWriteTextures();

		const counters = qm.getCounters();
		const resetFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );

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

		// Copy ACTIVE_RAY_COUNT into bounceCounts[currentBounce] for the readback survivor curve.
		const bounceCountsBuf = qm.getBounceCounts();
		const wfCurrentBounce = this._wfCurrentBounce;
		const snapshotFn = Fn( () => {

			const cnt = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( qm.MAX_BOUNCE_SNAPSHOTS - 1 ) );
			bounceCountsBuf.element( slot ).assign( cnt );
			// Also set ENTERING_COUNT for the next bounce; the full-dispatch path's enterFull overrides it.
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
			gBufferRW,
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
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
			auxGBufferEnabled: this._auxGBufferUniform,
		} );
		this._kernelManager.register( 'generate',
			genFn().compute(
				[ Math.ceil( w / GENERATE_WG_SIZE ), Math.ceil( h / GENERATE_WG_SIZE ), 1 ],
				[ GENERATE_WG_SIZE, GENERATE_WG_SIZE, 1 ]
			)
		);

		const freshBvh = this.bvhStorageNode;
		const freshTri = this.triangleStorageNode;
		const freshMat = this.materialData.materialStorageNode;
		const freshEnvCDF = texture( this.environment.envCDFTexture ); // independent CDF texture node; refreshed in _refreshWfTextureNodes
		const freshLight = this.lightStorageNode;
		// Independent texture nodes (never compiled elsewhere) avoid Three.js TextureNode caching across pipelines; refreshed via _refreshWfTextureNodes.
		const _mat = this.materialData;
		const _env = this.environment;
		// Consolidated size-bucket nodes (K sRGB + K linear). Empty buckets get placeholders so
		// every runtime branch references a valid node. Published to the sampling module before
		// the Shade/Debug graphs are built so they bake in these (per-pipeline) nodes.
		const freshSrgbBuckets = buildBucketTextureNodes( _mat.srgbBuckets );
		const freshLinearBuckets = buildBucketTextureNodes( _mat.linearBuckets );
		setMaterialBucketTextures( freshSrgbBuckets, freshLinearBuckets );
		// Alpha-cutout shadow rays sample albedo (sRGB pool) — emitted into the shade graph now.
		setShadowAlbedoMaps( freshSrgbBuckets );
		const freshEnvTex = _env.environmentTexture ? texture( _env.environmentTexture ) : texNodes.envTex;

		this._wfTexNodes = {
			envTex: freshEnvTex,
			envCDFTex: freshEnvCDF,
			srgbBuckets: freshSrgbBuckets,
			linearBuckets: freshLinearBuckets,
		};

		// Material-coherence sort gate (experiment): only worthwhile above a few materials.
		this._sortMaterials = ( ENGINE_DEFAULTS.wavefrontSortMaterials ?? false )
			&& ( this.materialData?.materialCount ?? 0 ) > 8;

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

		// Material-coherence sort: reorder the entering-ray indices by material between
		// Extend and Shade. Histogram is workgroup-shared (patches.js §4); Shade reads the output.
		if ( this._sortMaterials ) {

			const sgHist = qm.getSortGlobalHistogram();
			const sortBins = Math.min( SORT_GLOBAL_MAX_BINS, this.materialData?.materialCount ?? SORT_GLOBAL_MAX_BINS );
			this._kernelManager.register( 'resetGlobalHist',
				buildResetGlobalHistKernel( { sortGlobalHistogram: sgHist, bins: sortBins } )().compute(
					[ 1, 1, 1 ], [ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalHist',
				buildGlobalHistKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortGlobalHistogram: sgHist,
					counters,
					bins: sortBins,
				} )().compute(
					[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
					[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalPrefix',
				buildGlobalPrefixKernel( { sortGlobalHistogram: sgHist, bins: sortBins } )().compute(
					[ 1, 1, 1 ], [ 1, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalScatter',
				buildGlobalScatterKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortedIndicesRW: qm.getSortedRW(),
					sortGlobalHistogram: sgHist,
					counters,
					bins: sortBins,
				} )().compute(
					[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
					[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);

		}

		const shadeFn = buildShadeKernel( {
			gBufferRW,
			envCompensationDelta: this.envCompensationDelta,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envCDFTexture: freshEnvCDF,
			lightBuffer: freshLight,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
			counters,
			activeIndicesRO: this._sortMaterials ? qm.getSortedRO() : qm.getActiveReadRO(),
			envTexture: freshEnvTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			enableEnvironmentLight: this.enableEnvironment,
			useEnvMapIS: this.useEnvMapIS,
			groundProjectionEnabled: this.groundProjectionEnabled,
			groundProjectionRadius: this.groundProjectionRadius,
			groundProjectionHeight: this.groundProjectionHeight,
			groundProjectionLevel: this.groundProjectionLevel,
			enableGroundCatcher: this.enableGroundCatcher,
			groundCatcherHeight: this.groundCatcherHeight,
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
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			backgroundColor: this.backgroundColor,
			backgroundBlurriness: this.backgroundBlurriness,
			backgroundBlurSamples: this.backgroundBlurSamples,
			showBackground: this.showBackground,
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
			reverseMapVec4Offset: this.reverseMapVec4Offset,
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
			auxGBufferEnabled: this._auxGBufferUniform,
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

		// Storage nodes bind buffer A at build time, so compactCopyback copies the dense survivor list B→A for the next bounce.
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
			gBufferRO,
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
			prevAlbedoTexture: prevAlbedo,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			visMode: this.visMode,
			auxGBufferEnabled: this._auxGBufferUniform,
		} );
		this._kernelManager.register( 'finalWrite',
			// Per-pixel (w×h) — kernel averages the S sample-slots internally.
			fwFn().compute(
				[ Math.ceil( w / FINALWRITE_WG_SIZE ), Math.ceil( h / FINALWRITE_WG_SIZE ), 1 ],
				[ FINALWRITE_WG_SIZE, FINALWRITE_WG_SIZE, 1 ]
			)
		);

		// Debug visualization (visMode 1-10): single-pass primary-ray kernel. Reuses the same fresh*
		// scene nodes so _refreshWfTextureNodes keeps it current; mode 11 (NaN/Inf) is FinalWrite's branch.
		const debugFn = buildDebugKernel( {
			writeColorTex: writeTex.color,
			writeNDTex: writeTex.normalDepth,
			writeAlbedoTex: writeTex.albedo,
			resolution: this.resolution,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			sceneScale: this.sceneScale,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envTexture: freshEnvTex,
			environmentMatrix: this.environmentMatrix,
			environmentIntensity: this.environmentIntensity,
			enableEnvironmentLight: this.enableEnvironment,
			visMode: this.visMode,
			debugVisScale: this.debugVisScale,
			frame: this.frame,
		} );
		this._kernelManager.register( 'debug',
			debugFn().compute(
				[ Math.ceil( w / DEBUG_WG_SIZE ), Math.ceil( h / DEBUG_WG_SIZE ), 1 ],
				[ DEBUG_WG_SIZE, DEBUG_WG_SIZE, 1 ]
			)
		);

		this._wavefrontReady = true;
		console.log( `PathTracer: all wavefront kernels built (${w}×${h}, ${maxRays} rays)` );

	}

	_setWfDispatch() {

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
		this._kernelManager.setDispatchCount( 'debug', [
			Math.ceil( w / DEBUG_WG_SIZE ),
			Math.ceil( h / DEBUG_WG_SIZE ), 1
		] );

	}

	dispose() {

		super.dispose();
		this._packedBuffers?.dispose();
		this._queueManager?.dispose();
		this._kernelManager?.dispose();
		this._gBufferAttr?.dispose?.();
		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._gBufferAttr = null;
		this._wavefrontReady = false;

	}

}
