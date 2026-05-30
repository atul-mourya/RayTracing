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

import { uniform, texture } from 'three/tsl';
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

		// Async counter readback for dynamic dispatch (item 26).
		// After each bounce's compact, a 1-thread snapshot kernel copies
		// ACTIVE_RAY_COUNT into a per-bounce buffer. We async-read it each frame;
		// the stale per-bounce curve informs this frame's early-exit heuristic.
		// v2 Phase 0 dynamic dispatch: CPU sizes extend/shade/compact/copyback from the
		// previous frame's per-bounce survivor curve (reused async readback) with a 1.5×
		// margin. Safe because kernels bound exactly on ENTERING_COUNT (surplus threads
		// return without dropping/duplicating). Requires the functional compaction
		// (snapshotEntering + compactCopyback) so the read buffer holds a dense list.
		// NOTE: GPU-driven indirect dispatch (dispatchWorkgroupsIndirect) was tried and
		// abandoned — a compute-written buffer used as the indirect source is not reliably
		// synchronized to the indirect read across three.js 0.184's per-compute() queue
		// submissions (the dispatch reads a stale workgroup count → late-bounce truncation).
		this._useDynamicDispatch = true;

		// Phase 2a: subgroup prefix-sum compaction (one global atomic per subgroup instead of
		// per surviving ray; auto-disabled without the 'subgroups' feature). IMPLEMENTED +
		// VERIFIED CORRECT, but measured PERFORMANCE-NEUTRAL on this HW (Camera/Pagani 1024/8b:
		// subgroup 1621/3082 ms vs atomic-append 1630/3083 ms) — confirms compaction atomics are
		// not the bottleneck. Kept flag-gated OFF (atomic-append is simpler, no feature dep).
		this._useSubgroupCompact = false;

		// Phase 3: multi-sample pool — S primary rays per pixel per frame, packed into one
		// pool of size w*h*S so a single bounce loop processes all S samples. Amortizes the
		// per-frame fixed cost (denoiser + the 4 non-bounce passes + launch/barrier overhead)
		// over S samples, and fills the vsync slack the under-saturated GPU leaves at low res.
		// FinalWrite averages the S sample-slots per pixel before the temporal blend.
		// MEASURED at 512² (the default interactive resolution): convergence to a fixed sample
		// budget is 20% (S=2) / 29% (S=4) faster in wall-clock, 10% / 15% in raw GPU compute.
		//
		// AUTO-ENABLED for interactive only. `_resolveSamplesPerPass()` returns S>1 ONLY when
		// renderMode===0 (interactive — never tiled, see TileManager) AND pixels ≤ the memory
		// bound. Production (renderMode===1, tiled) forces S=1: the tiled path generates only the
		// tile's rows, so slots 1..S-1 would stay stale and FinalWrite would average garbage.
		// S is baked into the compiled kernels at build, so a render-mode switch is caught by
		// `_ensureSamplesPerPass()` in render() which rebuilds with the correct S. Pool memory
		// scales linearly with S (RAY buffer is 7 vec4/ray; e.g. 512² S=2 ≈ 117 MB).
		this._multiSampleInteractive = ENGINE_DEFAULTS.wavefrontMultiSampleInteractive ?? true;
		this._interactiveSamplesPerPass = ENGINE_DEFAULTS.wavefrontInteractiveSamplesPerPass ?? 2;
		this._multiSampleMaxPixels = ENGINE_DEFAULTS.wavefrontMultiSampleMaxPixels ?? 589824; // 768²
		this._samplesPerPass = 1; // resolved per build by _resolveSamplesPerPass(w,h)

		this._lastBounceCounts = null; // Uint32Array snapshot from past frame
		this._readbackPending = false;
		this._readbackEveryNFrames = 4; // limit readback cadence; stale is fine
		this._readbackFrameCounter = 0;
		// Bounce-early-exit threshold — updated per-scene in _buildWavefrontKernels.
		// Target: 0.1% of primary ray count, floored at 100 for tiny resolutions.
		// At 0.1% the surviving rays' contribution is statistically invisible
		// (~1 pixel per 1000 affected by truncation). Set to -1 to disable entirely.
		this._bounceEarlyExitThreshold = 100;

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

		// Refresh fresh-texture-node values — env/material texture arrays can
		// change between frames (environment swap, material texture array rebuild)
		// and the monolithic pipeline's updateSceneTextures path doesn't reach
		// wavefront's independent texture nodes.
		this._refreshWfTextureNodes();

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
		// Active-set upper bound the kernels are bounded by (= w*h, set at build).
		const maxRays = this._wfMaxRayCount.value;

		for ( let bounce = 0; bounce <= maxBounces; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			// Two dispatch paths:
			//  • Functional-compaction (dynamic + sort-off): ENTERING=ACTIVE; compactCopyback
			//    keeps the read buffer dense; kernels sized to the live survivor count.
			//  • Full (sort-on OR dynamic-off): ENTERING=maxRays, identity read buffer, no
			//    copyback, full dispatch — i.e. v1+SoA, so sort-heavy/diverse scenes don't pay
			//    the copyback pass.
			// NOTE: dynamic dispatch for the per-WG sort path was tried (2026-05-30) and
			// reverted — it gave 0% perf delta on Pagani 512/3b AND the per-bounce survivor
			// curve diverged from the full path (functional-compaction vs identity-buffer
			// active-ray accounting disagree under sort). Unverified correctness + no benefit
			// → keep sort-on on the trusted v1+SoA full path. Revisit with the ping-pong
			// kernel-variant compaction (Phase 2) which has cleaner active-list semantics.
			const useFunctionalCompaction = this._useDynamicDispatch && ! this._sortMaterials;
			if ( useFunctionalCompaction ) {

				// ENTERING_COUNT for this bounce is already set: bounce 0 by initActiveIndices
				// (=maxRays), bounce N>0 by the previous bounce's snapshotBounceCount (=ACTIVE).
				// No separate snapshotEntering pass needed (one fewer barrier/bounce).
				// Size from the previous frame's per-bounce survivor curve with a 1.5× +
				// 1024 margin. Over-sizing is safe (kernels bound exactly on ENTERING_COUNT).
				// Bounce 0 is always full (identity primary-ray list).
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

			// Separate Extend + optional Sort + Shade. The fused ExtendShade kernel
			// is visually correct but regresses ~15% on complex scenes (Bistro bench
			// 2026-04-19) — register pressure drops occupancy more than fusion saves
			// in kernel-boundary I/O. Keep the separate path as production default.
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

			// Stream compaction (+ copyback only in the functional-compaction path).
			km.dispatch( 'resetActiveCounter' );
			km.dispatch( 'compact' );
			if ( useFunctionalCompaction ) km.dispatch( 'compactCopyback' );
			km.dispatch( 'snapshotBounceCount' );
			// No swap: pingPong stays 0 (kernels are build-time-bound to buffer A).

			// Item 26: early-exit based on last frame's per-bounce snapshot.
			// If last frame this bounce had <= threshold rays, remaining bounces
			// contribute negligible light — skip them. Uses stale (1-2 frame old)
			// data via async readback, acceptable for heuristic.
			if (
				this._lastBounceCounts
				&& bounce < maxBounces
				&& this._lastBounceCounts[ bounce ] !== undefined
				&& this._lastBounceCounts[ bounce ] <= this._bounceEarlyExitThreshold
			) {

				break;

			}

		}

		// FinalWrite — temporal accumulation + StorageTexture output
		km.dispatch( 'finalWrite' );

		// ═══════════════════════════════════════════════════════════

		// Async readback of atomic counters (item 26). Runs every N frames; result
		// resolves 1-2 frames later and feeds the bounce-loop early-exit heuristic
		// on subsequent frames. Cheap (16 bytes) and async — no GPU stall.
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

	/**
	 * Override resize to rebuild wavefront kernels when canvas size changes.
	 * Parent only resizes storageTextures/shaderBuilder; wavefront also needs
	 * _wfRenderWidth/Height/MaxRayCount uniforms, _packedBuffers, _queueManager,
	 * and kernel dispatch counts updated.
	 */
	_handleResize() {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super._handleResize();

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	/**
	 * Phase 3: the multi-sample count for the CURRENT mode + resolution. S>1 only for
	 * interactive (renderMode 0, never tiled — see TileManager.handleTileRendering) and only
	 * within the memory bound; production/tiled and high-res get S=1. Single source of truth
	 * for both _buildWavefrontKernels (bakes it) and _ensureSamplesPerPass (the rebuild guard).
	 */
	_resolveSamplesPerPass( w, h ) {

		const interactive = this.renderMode.value === 0;
		const within = ( w * h ) <= this._multiSampleMaxPixels;
		return ( this._multiSampleInteractive && interactive && within )
			? ( this._interactiveSamplesPerPass | 0 ) : 1;

	}

	/**
	 * Phase 3 safety guard: S is baked into the compiled kernels at build time, but render mode
	 * can switch without a resize (preview ↔ final). If the mode/resolution now implies a
	 * different S than what is baked, rebuild — this is what keeps the tiled production path at
	 * S=1 (a stale S>1 in tiling would make FinalWrite average uninitialized sample slots).
	 * No-op (one comparison) in steady state.
	 */
	_ensureSamplesPerPass() {

		if ( ! this._wavefrontReady ) return;
		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		if ( this._resolveSamplesPerPass( w, h ) !== this._samplesPerPass ) {

			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	/**
	 * setSize() is the UI-driven resize path (Resolution dropdown). Parent
	 * calls createStorageTextures() directly without going through
	 * _handleResize(), so we must hook here too.
	 */
	setSize( width, height ) {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super.setSize( width, height );

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	/**
	 * Async readback of the per-bounce snapshot buffer (item 26). Fires every N
	 * frames; result updates `this._lastBounceCounts` when it resolves. Never
	 * awaited in render() — readback completes 1-2 frames later, so the bounce
	 * loop uses data from a past frame as a heuristic for early-exit.
	 */
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

	/**
	 * Sync the wavefront's independent texture nodes with the current
	 * environment/material textures. Cheap: TextureNode `.value = sameRef` is
	 * a no-op; only a changed reference triggers GPU rebinding next frame.
	 */
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

		if ( ( newW !== oldW || newH !== oldH ) && this.materialData?.materialCount > 0 ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	// ═══════════════════════════════════════════════════════════════
	// KERNEL BUILDING
	// ═══════════════════════════════════════════════════════════════

	_buildWavefrontKernels() {

		const texNodes = this.shaderBuilder.getSceneTextureNodes();
		if ( ! texNodes ) return;

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;
		// Phase 3: resolve S from mode+resolution (S>1 only for interactive ≤ memory bound).
		// maxRaysPerSample = pixels; the pool holds S of them (S=1 → unchanged). `maxRays` is the
		// pool capacity — every downstream sizing (buffers, init fill, bounce dispatch bounds,
		// _wfMaxRayCount) scales off it, so S propagates for free below.
		this._samplesPerPass = this._resolveSamplesPerPass( w, h );
		const S = this._samplesPerPass | 0;
		const maxRaysPerSample = w * h;
		const maxRays = maxRaysPerSample * S;

		// Item 26: scale the early-exit threshold with resolution. 0.1% of primary
		// rays is below the per-pixel-noise floor for image impact. Overrideable
		// per-instance (set to -1 to disable). Scene-agnostic — bounceCounts from
		// readback stay aligned with ray count since primary-count = w*h.
		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( maxRays / 1000 ) );

		}

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

		// Sort is a net loss on scenes with trivial material diversity (Ferrari/Helmet
		// with ~5 materials regressed 2–7% with no coherence win — item 38). Only
		// enable sort when materialCount is high enough that coherence is plausibly
		// valuable. Threshold picked from the 512/3b warm benchmark (scenes with
		// ≤8 materials never benefited).
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

		// ── Snapshot Bounce Active Count (item 26) ──
		// Copies current ACTIVE_RAY_COUNT into bounceCounts[currentBounce] so CPU
		// readback can see the ray-death curve across bounces. Single-thread kernel.
		const bounceCountsBuf = qm.getBounceCounts();
		const wfCurrentBounce = this._wfCurrentBounce;
		const snapshotFn = Fn( () => {

			const cnt = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( qm.MAX_BOUNCE_SNAPSHOTS - 1 ) );
			bounceCountsBuf.element( slot ).assign( cnt );
			// Fold snapshotEntering into this end-of-bounce pass: set ENTERING_COUNT to this
			// bounce's dense survivor count so the NEXT bounce's extend/shade/compact bound
			// on it (one fewer compute pass/bounce than a separate snapshotEntering). The
			// full path's enterFull overrides this to maxRays at its bounce start, so this is
			// harmless there.
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), cnt );

		} );
		this._kernelManager.register( 'snapshotBounceCount',
			snapshotFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// ── Init Active Indices (fill with sequential IDs) ──
		const activeWriteA = qm.activeIndices.a;
		const initFn = Fn( () => {

			const tid = instanceIndex;
			activeWriteA.element( tid ).assign( tid );
			// Seed the atomic active-ray counter so Sort (which reads it) has a valid bound on
			// bounce 0; also seed ENTERING_COUNT=maxRays so bounce 0 (functional path) bounds
			// full without a separate snapshotEntering pass.
			If( tid.equal( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( maxRays ) );
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), uint( maxRays ) );

			} );

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

		// ── Fused ExtendShade (BVH + material + deferred shadow) ──
		// Create FRESH storage nodes from CURRENT attributes to avoid stale
		// GPU buffer bindings after scene load replaces the attributes.
		// Use the SAME storage nodes the monolithic uses — they reference
		// the current attribute after scene load via .value update
		const freshBvh = this.bvhStorageNode;
		const freshTri = this.triangleStorageNode;
		const freshMat = this.materialData.materialStorageNode;
		// Packed env CDF (1 binding replaces old marginal+conditional pair — main commit d8e0bf4)
		const freshEnvCDF = this.environment.envCDFStorageNode;
		// Packed light buffer (1 binding carrying both lightBVH nodes + emissive tris)
		const freshLight = this.lightStorageNode;
		// Create INDEPENDENT texture nodes that have never been compiled
		// by any other pipeline. This avoids Three.js TextureNode caching
		// issues between the monolithic and wavefront compute pipelines.
		// Node references are saved on `this` so render() can refresh their
		// `.value` when the underlying texture is swapped (env change,
		// material texture array replacement, etc.) without rebuilding kernels.
		const _mat = this.materialData;
		const _env = this.environment;
		const _placeholder = texNodes.albedoMapsTex; // dummy fallback
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

		const esFn = buildExtendShadeKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envCDFBuffer: freshEnvCDF,
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
			counters,
			maxRayCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'extend',
			extFn().compute(
				[ Math.ceil( maxRays / EXTEND_WG_SIZE ), 1, 1 ],
				[ EXTEND_WG_SIZE, 1, 1 ]
			)
		);

		// ── Sort kernel (material-index counting sort for subgroup coherence) ──
		if ( this._sortMaterials ) {

			// Reset histogram to zero before each Sort dispatch (atomicAdd accumulates).
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

			// ── Global sort kernels (item 34) — built alongside per-WG sort so the
			// dispatch path can pick at runtime without a full kernel rebuild.
			if ( this._sortGlobal ) {

				const globalHist = qm.getSortGlobalHistogram();
				const sortBins = ENGINE_DEFAULTS.wavefrontSortBins ?? 16;

				// Reset the 16-slot global histogram before each dispatch.
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

		// ── Separate Shade kernel ──
		const shadeFn = buildShadeKernel( {
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
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
			// Emissive triangle NEE (item 13)
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

		// ── Compact ── (subgroup prefix-sum variant when supported — Phase 2a)
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

		// ── Functional compaction + entering-count snapshot (v2 Phase 0) ──
		// v1's ping-pong was vestigial: TSL storage nodes bind their buffer at BUILD
		// time, so extend/shade/compact stay wired to buffer A (the identity list from
		// initActiveIndices). The compacted survivor list (written to B) was never read,
		// so thread index mapped directly to ray slot (= pixelIndex) and any reduced
		// dispatch dropped the high-pixelIndex tail. Two small kernels fix this:
		//
		//   snapshotEntering — ENTERING_COUNT = ACTIVE_RAY_COUNT at each bounce start
		//     (before resetActiveCounter), giving extend/shade/compact an exact bound on
		//     the dense active-list length. Over-sized (margin) dispatches are then safe.
		//   compactCopyback  — copy the dense survivor list B[0,ACTIVE) back into the read
		//     buffer A, so the NEXT bounce reads a dense, compacted list rather than the
		//     stale identity. This is what makes reduced dispatch correct.
		const enterFn = Fn( () => {

			const c = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), c );

		} );
		this._kernelManager.register( 'snapshotEntering',
			enterFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// enterFull: ENTERING_COUNT = maxRays. Used by the full-dispatch path (sort-on or
		// dynamic-off), where kernels read the identity buffer A over [0,maxRays) like v1
		// (no copyback). This keeps sort-on / material-diverse scenes at v1+SoA cost — they
		// neither benefit from dynamic sizing nor pay the copyback's extra pass/bounce.
		const maxRaysConst = maxRays;
		const enterFullFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), uint( maxRaysConst ) );

		} );
		this._kernelManager.register( 'enterFull',
			enterFullFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const copyReadB = qm.activeIndicesRO.b; // compact writes B (pingPong fixed at 0)
		const copyWriteA = qm.activeIndices.a; // read buffer all kernels consume
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
