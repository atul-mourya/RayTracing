/**
 * Wavefront path tracer — decomposed kernel dispatch (Extend → [Sort] → Shade → Compact per
 * bounce, bookended by Generate + FinalWrite; DebugKernel for visMode). Extends PathTracerStage
 * for shared engine/scene infrastructure (managers, uniforms, camera, lights, BVH, accumulation).
 */

import { uniform, texture, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute, TextureNode } from 'three/webgpu';
import { PathTracerStage } from './PathTracerStage.js';
import { PackedRayBuffer, GBUFFER_STRIDE } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { VRAMTracker } from '../Processor/VRAMTracker.js';
import { KernelManager } from '../Processor/KernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/ShadeKernel.js';
import { buildCompactKernel, buildCompactSubgroupKernel, COMPACT_WG_SIZE } from '../TSL/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/FinalWriteKernel.js';
import { buildDebugKernel, DEBUG_WG_SIZE } from '../TSL/DebugKernel.js';
import { buildRestirCaptureKernel, RESTIR_CAPTURE_WG_SIZE } from '../TSL/ReSTIRCaptureKernel.js';
import { GI_PRIMARY_HIT_SLOTS } from '../Processor/ReSTIRLayout.js';
import { buildRestirInitialKernel, RESTIR_INITIAL_WG_SIZE } from '../TSL/ReSTIRInitialKernel.js';
import { buildRestirTemporalKernel, RESTIR_TEMPORAL_WG_SIZE } from '../TSL/ReSTIRTemporalKernel.js';
import { buildRestirSpatialKernel, RESTIR_SPATIAL_WG_SIZE } from '../TSL/ReSTIRSpatialKernel.js';
import { buildRestirResolveKernel, RESTIR_RESOLVE_WG_SIZE } from '../TSL/ReSTIRResolveKernel.js';
import { buildRestirGIInitialKernel, RESTIR_GI_INITIAL_WG_SIZE } from '../TSL/ReSTIRGIInitialKernel.js';
import { buildRestirGITemporalKernel, RESTIR_GI_TEMPORAL_WG_SIZE } from '../TSL/ReSTIRGITemporalKernel.js';
import { buildRestirGISpatialKernel, RESTIR_GI_SPATIAL_WG_SIZE } from '../TSL/ReSTIRGISpatialKernel.js';
import { buildRestirGIResolveKernel, RESTIR_GI_RESOLVE_WG_SIZE } from '../TSL/ReSTIRGIResolveKernel.js';
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

		// CPU sizes per-bounce kernels from last frame's survivor curve; kernels bound on ENTERING_COUNT so over-sizing is safe. (indirect dispatch not viable — three.js doesn't sync compute-written indirect buffers across submissions)
		this._useDynamicDispatch = true;

		// Flag-gated off: perf-neutral vs atomic-append and adds a 'subgroups' feature dependency.
		this._useSubgroupCompact = false;

		// Multi-sample pool: S=samplesPerPixel primary rays/pixel/frame (interactive-only, ≤ the pixel cap; else S=1). FinalWrite averages the S slots. Baked into kernels; _ensureSamplesPerPass() rebuilds on change.
		this._multiSampleMaxPixels = ENGINE_DEFAULTS.wavefrontMultiSampleMaxPixels ?? 589824; // 768²
		this._samplesPerPass = 1;

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

		// ReSTIR temporal reprojection source — the (1-frame-stale) motion vector RenderTarget published
		// by the MotionVector stage to the pipeline context. Bare node; .value repointed in render() from
		// context.getTexture('motionVector:screenSpace') (ASVGF pattern). Null until the first frame.
		this._restirMotionTexNode = new TextureNode();

		// VRAM accounting — providers are thunks reading CURRENT live resources,
		// so they survive buffer/texture reallocation (resize, scene/material reload).
		this.vramTracker = new VRAMTracker();
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
				qm._attrA, qm._attrB,
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
				m.albedoMaps, m.emissiveMaps, m.normalMaps, m.bumpMaps,
				m.roughnessMaps, m.metalnessMaps, m.displacementMaps,
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
		let originalSamplesPerPixel = null;

		if ( renderMode === 1 && frameValue === 0 ) {

			originalMaxBounces = this.maxBounces.value;
			originalSamplesPerPixel = this.samplesPerPixel.value;
			this.maxBounces.value = 1;
			this.samplesPerPixel.value = 1;

		}

		this._handleResize();
		this._ensureSamplesPerPass();
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
			this.shaderBuilder.prevNormalDepthTexNode.value = readTextures.normalDepth;
			this.shaderBuilder.prevAlbedoTexNode.value = readTextures.albedo;

		}

		// Wavefront's texture nodes are independent; monolithic's updateSceneTextures doesn't reach them.
		this._refreshWfTextureNodes();

		// ReSTIR DI (interactive-only) active gate. The 3 passes run only at bounce 0 when the flag is on,
		// in interactive mode, with the pool allocated. Repoint the temporal motion-vector node from the
		// (1-frame-stale) context texture (ASVGF pattern); null on frame 0 — the disocclusion gate handles it.
		const restirActive = renderMode === 0
			&& !! this.enableReSTIR?.value
			&& !! this.restirPool?.isActivated?.();
		// ReSTIR GI active gate. DI and GI may run together (RT-4): both own disjoint bounce-0 terms
		// (DI=direct@x0, GI=indirect@x0), composed additively by their resolves. No exclusion clause.
		const restirGIActive = renderMode === 0
			&& !! this.enableReSTIRGI?.value
			&& !! this.restirGIPool?.isActivated?.();
		if ( ( restirActive || restirGIActive ) && context ) {

			const motionTex = context.getTexture( 'motionVector:screenSpace' );
			if ( motionTex && this._restirMotionTexNode.value !== motionTex ) {

				// Point the temporal kernel's motion node at the live screen-space target. A TextureNode
				// .value swap does NOT rebind an already-built compute bind group (project_wavefront_resize_
				// norebuild), so flag a one-time rebuild below — else the disocclusion gate samples the empty
				// init texture, the gate fails, and temporal reuse never engages (reservoir M stuck at 8).
				this._restirMotionTexNode.value = motionTex;
				this._restirMotionTexBound = false;

			}

			if ( motionTex && this._restirMotionTexBound !== true && this._wavefrontReady ) {

				this._wavefrontReady = false;
				this._buildWavefrontKernels();
				this._restirMotionTexBound = true;

			}

		}

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
			if ( originalSamplesPerPixel !== null ) this.samplesPerPixel.value = originalSamplesPerPixel;

			this.performanceMonitor?.end();
			return;

		}

		// Couple Shade's ReSTIR kills to the ACTUAL dispatch decision. Shade reads enableReSTIR /
		// enableReSTIRGI to suppress bounce-0 discrete NEE (DI) and kill the indirect continuation (GI),
		// but the resolves only run when restir{,GI}Active (flag AND pool activated AND renderMode 0).
		// If a flag is set while its pool is still a stub, the kill would fire with no resolve to re-inject
		// the term → silent drop. Force the uniforms to the active gates for this frame's dispatch, then
		// restore user intent after the swaps (so next frame re-derives correctly once the pool activates).
		const _userEnableReSTIR = this.enableReSTIR?.value;
		const _userEnableReSTIRGI = this.enableReSTIRGI?.value;
		if ( this.enableReSTIR ) this.enableReSTIR.value = restirActive ? 1 : 0;
		if ( this.enableReSTIRGI ) this.enableReSTIRGI.value = restirGIActive ? 1 : 0;

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

			// ReSTIR DI: capture the EXACT bounce-0 hit point from the actual jittered ray BEFORE Shade
			// overwrites the ray buffer with the bounce-1 continuation (initial/temporal/resolve read it
			// instead of reconstructing from the pixel centre — the center-vs-sub-pixel-average dark bias).
			if ( bounce === 0 && restirActive ) km.dispatch( 'restirCapture' );
			if ( bounce === 0 && restirGIActive ) km.dispatch( 'restirGICapture' );

			km.dispatch( 'shade' );

			// ReSTIR DI (Phase 1): after bounce-0 Shade (HIT + material resolved), before stream compaction.
			// initial → temporal → resolve. The bounce-0 discrete-light NEE term is gated OFF in Shade when
			// restirActive, so resolve's add REPLACES it (env/emissive/BRDF-MIS/indirect untouched). §4.2.
			if ( bounce === 0 && restirActive ) {

				// Frame-count gate on spatial reuse. Measured: spatial fold HELPS per-pixel RMSE only while the
				// reservoirs are under-converged (≈ first 8 accumulated frames, −51% RMSE @spp4); past the
				// crossover (~spp10) its inter-pixel sample-sharing correlation RAISES per-pixel RMSE (+33% @spp12)
				// even though the mean stays unbiased. So run K folds early, then fall to K=0 (S→cur passthrough =
				// temporal-only) for the converging tail. restirSpatial ALWAYS dispatches (it owns the cur write).
				this._restirSpatialK.value = this.frameCount < this._restirSpatialFrameLimit
					? this._restirSpatialKConfig : 0;

				km.dispatch( 'restirInitial' ); // canonical RIS → cur slot[P]
				km.dispatch( 'restirTemporal' ); // reads cur + prev → writes SNAPSHOT slot S
				km.dispatch( 'restirSpatial' ); // reads S (self + K neighbors) → writes FINAL → cur slot[P]
				km.dispatch( 'restirResolve' ); // reads cur slot[P] → shadow + add f·NoL·Le·V·W

			}

			// ReSTIR GI/PT: after bounce-0 Shade (which killed the indirect continuation at reconnectable
			// hits), canonical RIS over full-path candidates (PT-1 suffix walk) → temporal/spatial path reuse
			// → resolve re-injects gi·f·cos·L_o·V·W. Composes additively with DI (disjoint bounce-0 terms).
			if ( bounce === 0 && restirGIActive ) {

				km.dispatch( 'restirGIInitial' ); // canonical RIS → cur slot[P]
				if ( this._giReuseEnabled !== false ) {

					// SPATIAL is the progressive-mode variance lever; frame-gate its K (helps at low spp, its
					// inter-pixel correlation hurts the converged tail). temporal→S, spatial reads S (self+K
					// neighbors)→cur. K=0 ⇒ spatial copies S→cur (temporal-only). _giReuseEnabled=false ⇒ initial-only.
					this._restirGISpatialK.value = this.frameCount < this._restirGISpatialFrameLimit
						? this._restirGISpatialKConfig : 0;
					km.dispatch( 'restirGITemporal' ); // reproject prev + disocclusion + cross-eval → snapshot slot S
					km.dispatch( 'restirGISpatial' ); // gather K neighbors from S + Jacobian combine → cur slot[P]

				}

				km.dispatch( 'restirGIResolve' ); // reads cur slot[P] → visibility + add gi·f·cos·L_o·V·W

			}

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

		// Flip the reservoir ping-pong parity ONCE per frame, after finalWrite: this frame's cur becomes
		// next frame's prev (the temporal feedback chain). Net-new mechanism, not a mirror of the SoA
		// buffers (which don't swap). §2.3.
		if ( restirActive ) this.restirPool.swap();
		if ( restirGIActive ) this.restirGIPool.swap();

		// Restore user-intent flags (forced to the active gates for the dispatch above).
		if ( this.enableReSTIR ) this.enableReSTIR.value = _userEnableReSTIR;
		if ( this.enableReSTIRGI ) this.enableReSTIRGI.value = _userEnableReSTIRGI;

		this._maybeReadbackCounters();

		this.storageTextures.copyToReadTargets( this.renderer );

		const readTex = this.storageTextures.getReadTextures();
		if ( context ) this._publishTexturesToContext( context, readTex );

		this._emitStateEvents();
		// Don't count interaction-mode (1-SPP feedback) frames toward completion (megakernel parity Stages/PathTracer.js:1240) — else a continuous orbit "completes" on noise.
		if ( ! this.cameraOptimizer?.isInInteractionMode() ) this.frameCount ++;

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
	// ReSTIR (DI Phase 1 OR GI Phase 2) forces S=1: reservoirs are per-pixel and the resolves write only
	// sub-sample 0, so S>1 would dilute the ReSTIR term by 1/S in FinalWrite's average. ReSTIR ⊥ the
	// multi-sample pool.
	_resolveSamplesPerPass( w, h ) {

		const interactive = this.renderMode.value === 0;
		if ( interactive && ( this.enableReSTIR?.value || this.enableReSTIRGI?.value ) ) return 1;
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

		// A survivor curve from the old resolution mis-sizes the per-bounce dispatch at the new one
		// (row-major active list → under-coverage of the lower rows → GI band). Force full coverage
		// until the readback re-measures at the new size; bump the generation so any readback already
		// in flight (carrying the old-resolution counts) is discarded when it resolves.
		this._lastBounceCounts = null;
		this._lastBounceCountsBudget = - 1;
		this._readbackFrameCounter = 0;
		this._readbackGeneration ++;

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
		this.restirPool?.setSize( w, h ); // keep the bounds-cull resolution uniform current on in-place resize
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

		// Per-pixel G-buffer (first-hit MRT: ND + albedo), 1 uvec4/pixel — half-precision packed (pack2x16).
		// uint (not f32) buffer: packed lanes can hit the NaN exponent range (e.g. snorm 1.0 → 0x7FFF), which a
		// GPU may canonicalize through f32 storage; u32 stores the bits verbatim. Separate from RAY — it's
		// per-pixel (not per-ray×S), written by Generate/Shade bounce-0 and read only by FinalWrite.
		// 1.25× margin (same as the per-ray buffers) so it survives the in-place-resize range.
		const gBufferVec4s = PackedRayBuffer.requiredCapacity( maxRaysPerSample ) * GBUFFER_STRIDE;
		this._gBufferAttr = new StorageInstancedBufferAttribute( new Uint32Array( gBufferVec4s * 4 ), 4 );
		const gBufferRW = storage( this._gBufferAttr, 'uvec4' );
		const gBufferRO = storage( this._gBufferAttr, 'uvec4' ).toReadOnly();

		if ( ! this._queueManager ) {

			this._queueManager = new QueueManager( this._packedBuffers.capacity );

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

		// Keep the ReSTIR pool's resolution uniform in sync for the per-pixel bounds-cull (never reallocates).
		this.restirPool?.setSize( w, h );

		const prevColor = this.shaderBuilder.prevColorTexNode;
		const prevND = this.shaderBuilder.prevNormalDepthTexNode;
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
			samplesPerPass: S,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
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
		const freshEnvCDF = texture( this.environment.envCDFTexture ); // independent CDF texture node; refreshed in _refreshWfTextureNodes
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
			envCDFTex: freshEnvCDF,
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
			activeIndicesRO: qm.getActiveReadRO(),
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
			groundProjectionEnabled: this.groundProjectionEnabled,
			groundProjectionRadius: this.groundProjectionRadius,
			groundProjectionHeight: this.groundProjectionHeight,
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
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
			// Phase-1 ReSTIR DI gate (int 0/1). When on, Shade suppresses the bounce-0 discrete-analytic
			// NEE term — restirResolve adds it instead. Always bound so the graph reference is stable.
			enableReSTIR: this.enableReSTIR,
			// Phase-2 ReSTIR GI gate (int 0/1) + shared x0 reconnectability roughness threshold. When on, Shade
			// kills the bounce-0 indirect continuation at reconnectable hits — restirGIResolve re-injects it.
			enableReSTIRGI: this.enableReSTIRGI,
			restirGIRoughnessTau: this.restirGIRoughnessTau,
		} );
		this._kernelManager.register( 'shade',
			shadeFn().compute(
				[ Math.ceil( maxRays / SHADE_WG_SIZE ), 1, 1 ],
				[ SHADE_WG_SIZE, 1, 1 ]
			)
		);

		// ── ReSTIR DI Phase 1 (interactive-only, per-pixel 16×16) ──
		// Always REGISTERED (so the compiled graph references the pool node), but DISPATCHED only when
		// bounce===0 && enableReSTIR && renderMode===0 && pool.isActivated() (render(); §4.2). In production
		// the pool is a 16-B stub and these passes never run ⇒ zero GPU cost. Per-pixel grid (NOT ×S — ReSTIR
		// forces S=1). reservoirPoolRW/RO are two node-views over ONE buffer (PackedRayBuffer .rw/.ro pattern).
		this._buildRestirKernels( pb, freshBvh, freshTri, freshMat, w, h, {
			albedoMaps: freshAlbedoMaps, normalMaps: freshNormalMaps, bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps, roughnessMaps: freshRoughnessMaps, emissiveMaps: freshEmissiveMaps,
		}, { envTexture: freshEnvTex, envCDFTexture: freshEnvCDF } );

		// ── ReSTIR GI Phase 2 (interactive-only, per-pixel 16×16) ── same registration discipline as DI:
		// always registered (stub when inactive), dispatched only when bounce===0 && enableReSTIRGI &&
		// renderMode===0 && giPool.isActivated() (render()). Separate pool/kernels (3 vec4/slot, *9 stride).
		this._buildRestirGIKernels( pb, freshBvh, freshTri, freshMat, w, h, {
			albedoMaps: freshAlbedoMaps, normalMaps: freshNormalMaps, bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps, roughnessMaps: freshRoughnessMaps, emissiveMaps: freshEmissiveMaps,
		}, { envTexture: freshEnvTex, envCDFTexture: freshEnvCDF } );

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
			prevNormalDepthTexture: prevND,
			prevAlbedoTexture: prevAlbedo,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			samplesPerPass: S,
			visMode: this.visMode,
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
			samplesPerPass: this._samplesPerPass,
			albedoMaps: freshAlbedoMaps,
			normalMaps: freshNormalMaps,
			bumpMaps: freshBumpMaps,
			metalnessMaps: freshMetalnessMaps,
			roughnessMaps: freshRoughnessMaps,
			emissiveMaps: freshEmissiveMaps,
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

	// Register the 3 ReSTIR DI passes (per-pixel 16×16). Pool nodes are stable across stub↔full swaps;
	// configureForMode forces a rebuild here when the pool's activation state flips so the bindings stick.
	_buildRestirKernels( pb, freshBvh, freshTri, freshMat, w, h, maps, env = {} ) {

		const pool = this.restirPool;
		const km = this._kernelManager;
		const reservoirRW = pool.getStorageNode();
		const reservoirRO = pool.getReadOnlyNode();
		const primaryHitRW = pool.primaryHitNode;
		const primaryHitRO = pool.primaryHitNodeRO;
		const frameParityUniform = pool.frameParityUniform;
		const resolutionUniform = pool.resolutionUniform;

		const lightArgs = {
			directionalLightsBuffer: this.directionalLightsBufferNode,
			areaLightsBuffer: this.areaLightsBufferNode,
			pointLightsBuffer: this.pointLightsBufferNode,
			spotLightsBuffer: this.spotLightsBufferNode,
		};

		// Env in the DI reservoir (textures/uniforms — 0 SB). Initial SAMPLES via the CDF (needs full set);
		// Temporal/Spatial/Resolve only RE-DERIVE Le along the stored direction (lookup set only).
		const envSampleArgs = {
			environmentTex: env.envTexture,
			envCDFTexture: env.envCDFTexture,
			envMatrix: this.environmentMatrix,
			environmentIntensity: this.environmentIntensity,
			enableEnvironmentLight: this.enableEnvironment,
			envTotalSum: this.envTotalSum,
			envCompensationDelta: this.envCompensationDelta,
			envResolution: this.envResolution,
		};
		const envLeArgs = {
			environmentTex: env.envTexture,
			envMatrix: this.environmentMatrix,
			environmentIntensity: this.environmentIntensity,
			enableEnvironmentLight: this.enableEnvironment,
		};
		// Resolve also needs the env pdf (envTotalSum/delta/resolution) for the strategy-A MIS weight.
		const envResolveArgs = {
			...envLeArgs,
			envTotalSum: this.envTotalSum,
			envCompensationDelta: this.envCompensationDelta,
			envResolution: this.envResolution,
		};
		// Emissive triangles in the DI reservoir (type 5). deriveAnalyticLe reads the cached emission from the
		// packed light buffer + the triangle geo-normal (front-face gate) — needs lightBuffer + triangleBuffer
		// (+2 SB on Initial/Temporal/Spatial; Resolve already binds tri). Initial also SAMPLES emissive tris.
		const emissiveLeArgs = {
			lightBuffer: this.lightStorageNode,
			emissiveVec4Offset: this.emissiveVec4Offset,
			triangleBuffer: freshTri, // for the geo-normal front-face fetch (Resolve already binds it)
			emissiveBoost: this.emissiveBoost,
			emissiveTotalPower: this.emissiveTotalPower, // for the powerHeuristic MIS weight (restirMISWeight)
		};
		const emissiveSampleArgs = {
			...emissiveLeArgs,
			emissiveTriangleCount: this.emissiveTriangleCount,
			enableEmissiveTriangleSampling: this.enableEmissiveTriangleSampling,
		};

		// restirCapture — store the EXACT bounce-0 hit point (from the actual jittered ray, before Shade
		// overwrites it) so the reuse passes evaluate where NEE does. 3 SB: rayRO/hitRO/primaryHitRW.
		const captureFn = buildRestirCaptureKernel( {
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRO: pb.hitBuffer.ro,
			primaryHitRW,
			resolutionUniform,
		} );
		km.register( 'restirCapture',
			captureFn().compute(
				[ Math.ceil( w / RESTIR_CAPTURE_WG_SIZE ), Math.ceil( h / RESTIR_CAPTURE_WG_SIZE ), 1 ],
				[ RESTIR_CAPTURE_WG_SIZE, RESTIR_CAPTURE_WG_SIZE, 1 ]
			)
		);

		// restirInitial — canonical RIS (5 SB: hit/rng/mat/reservoirRW/primaryHitRO; P = exact captured hit).
		const initFn = buildRestirInitialKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			rngBufferRW: pb.rngBuffer.rw,
			materialBuffer: freshMat,
			reservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			...lightArgs,
			numDirectionalLights: this.numDirectionalLights,
			numAreaLights: this.numAreaLights,
			numPointLights: this.numPointLights,
			numSpotLights: this.numSpotLights,
			...maps,
			...envSampleArgs,
			...emissiveSampleArgs,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			frameParityUniform, resolutionUniform,
		} );
		km.register( 'restirInitial',
			initFn().compute(
				[ Math.ceil( w / RESTIR_INITIAL_WG_SIZE ), Math.ceil( h / RESTIR_INITIAL_WG_SIZE ), 1 ],
				[ RESTIR_INITIAL_WG_SIZE, RESTIR_INITIAL_WG_SIZE, 1 ]
			)
		);

		// restirTemporal — reproject + disocclusion gate + GRIS combine (4 SB: hit/rng/mat/reservoirRW).
		// ONE rw node reads prev slot + r/w cur slot; never bind the .ro view too (rw+ro aliasing of one
		// buffer in a compute pass is a WebGPU validation error).
		const tempFn = buildRestirTemporalKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			rngBufferRW: pb.rngBuffer.rw,
			materialBuffer: freshMat,
			reservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			motionVectorTex: this._restirMotionTexNode,
			prevNormalDepthTex: this.shaderBuilder.prevNormalDepthTexNode,
			...lightArgs,
			...maps,
			...envResolveArgs,
			...emissiveLeArgs,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraViewMatrix: this.cameraViewMatrix,
			frameParityUniform, resolutionUniform,
		} );
		km.register( 'restirTemporal',
			tempFn().compute(
				[ Math.ceil( w / RESTIR_TEMPORAL_WG_SIZE ), Math.ceil( h / RESTIR_TEMPORAL_WG_SIZE ), 1 ],
				[ RESTIR_TEMPORAL_WG_SIZE, RESTIR_TEMPORAL_WG_SIZE, 1 ]
			)
		);

		// restirSpatial — gather K neighbors from snapshot slot S + unbiased cross-evaluated combine → cur slot
		// (5 SB: reservoirRW/hit/mat/primaryHit/rng). Bind the reservoir rw node ONLY (reads S+neighbors + writes
		// cur are disjoint slots; rw+ro of one buffer in a pass is a WebGPU error). Visibility is deferred to
		// resolve (unshadowed p̂, same as BF NEE) — no bvh/tri. Effective K is driven per-frame by the frame-count
		// gate in render() (spatial helps only at low spp; its inter-pixel correlation hurts once converged).
		const spatialFn = buildRestirSpatialKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			rngBufferRW: pb.rngBuffer.rw,
			materialBuffer: freshMat,
			reservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			...lightArgs,
			...maps,
			...envResolveArgs,
			...emissiveLeArgs,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			frameParityUniform, resolutionUniform,
			restirSpatialK: this._restirSpatialK,
			restirSpatialRadius: this._restirSpatialRadius,
		} );
		km.register( 'restirSpatial',
			spatialFn().compute(
				[ Math.ceil( w / RESTIR_SPATIAL_WG_SIZE ), Math.ceil( h / RESTIR_SPATIAL_WG_SIZE ), 1 ],
				[ RESTIR_SPATIAL_WG_SIZE, RESTIR_SPATIAL_WG_SIZE, 1 ]
			)
		);

		// restirResolve — shadow test + add into RADIANCE_ALPHA (6 SB: bvh/tri/mat/hit/rayRW/reservoirRO).
		const resolveFn = buildRestirResolveKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			hitBufferRO: pb.hitBuffer.ro,
			rayBufferRW: pb.rayBuffer.rw,
			reservoirPoolRO: reservoirRO,
			primaryHitBuffer: primaryHitRO,
			...lightArgs,
			...maps,
			...envResolveArgs,
			...emissiveLeArgs,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			frameParityUniform, resolutionUniform,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
		} );
		km.register( 'restirResolve',
			resolveFn().compute(
				[ Math.ceil( w / RESTIR_RESOLVE_WG_SIZE ), Math.ceil( h / RESTIR_RESOLVE_WG_SIZE ), 1 ],
				[ RESTIR_RESOLVE_WG_SIZE, RESTIR_RESOLVE_WG_SIZE, 1 ]
			)
		);

	}

	// Register the ReSTIR GI Phase-2 passes (per-pixel 16×16) against the GI pool (3 vec4/slot). giCapture
	// reuses the DI capture kernel pointed at the GI pool's primaryHit buffer. Always registered (stub when
	// inactive); dispatched only under restirGIActive. env nodes (freshEnvTex/freshEnvCDF) come from the caller.
	_buildRestirGIKernels( pb, freshBvh, freshTri, freshMat, w, h, maps, env ) {

		const pool = this.restirGIPool;
		const km = this._kernelManager;
		const reservoirRW = pool.getStorageNode();
		const reservoirRO = pool.getReadOnlyNode();
		const primaryHitRW = pool.primaryHitNode;
		const primaryHitRO = pool.primaryHitNodeRO;
		const frameParityUniform = pool.frameParityUniform;
		const resolutionUniform = pool.resolutionUniform;

		const lightArgs = {
			directionalLightsBuffer: this.directionalLightsBufferNode,
			areaLightsBuffer: this.areaLightsBufferNode,
			pointLightsBuffer: this.pointLightsBufferNode,
			spotLightsBuffer: this.spotLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			numAreaLights: this.numAreaLights,
			numPointLights: this.numPointLights,
			numSpotLights: this.numSpotLights,
		};
		const envArgs = {
			envTexture: env.envTexture,
			envCDFTexture: env.envCDFTexture,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			envTotalSum: this.envTotalSum,
			envCompensationDelta: this.envCompensationDelta,
			envResolution: this.envResolution,
			enableEnvironmentLight: this.enableEnvironment,
			useEnvMapIS: this.useEnvMapIS,
		};

		// giCapture — the DI capture kernel pointed at the GI pool's primaryHit buffer (3 SB), PT-2b
		// parity-strided (2 slots/pixel) so gi-temporal can read the TRUE previous-frame jittered x0.
		const captureFn = buildRestirCaptureKernel( {
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRO: pb.hitBuffer.ro,
			primaryHitRW,
			resolutionUniform,
			primaryHitSlots: GI_PRIMARY_HIT_SLOTS,
			frameParityUniform,
		} );
		km.register( 'restirGICapture',
			captureFn().compute(
				[ Math.ceil( w / RESTIR_CAPTURE_WG_SIZE ), Math.ceil( h / RESTIR_CAPTURE_WG_SIZE ), 1 ],
				[ RESTIR_CAPTURE_WG_SIZE, RESTIR_CAPTURE_WG_SIZE, 1 ]
			)
		);

		// giInitial — canonical RIS (PT-1): BSDF-sample ω0 (clearcoat-aware), then the SUFFIX WALKER traces
		// the full multi-bounce path from x0 → L_o(x1→x0) carries all suffix transport (NEE + emissive MIS +
		// env per vertex, RR, depth budget = maxBounces). 9 SB: bvh/tri/mat/hit/rayRW/rng/giReservoirRW/
		// primaryHitRO/lightStorage (rayRW = PT-3c glossy-prefix radiance add); lights + emissive set are
		// uniforms, env/maps are textures (0 SB).
		const initFn = buildRestirGIInitialKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			hitBufferRO: pb.hitBuffer.ro,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			giReservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			lightBuffer: this.lightStorageNode,
			emissiveVec4Offset: this.emissiveVec4Offset,
			emissiveTriangleCount: this.emissiveTriangleCount,
			emissiveTotalPower: this.emissiveTotalPower,
			emissiveBoost: this.emissiveBoost,
			enableEmissiveTriangleSampling: this.enableEmissiveTriangleSampling,
			lightBVHNodeCount: this.lightBVHNodeCount,
			...lightArgs,
			...maps,
			...envArgs,
			cameraWorldMatrix: this.cameraWorldMatrix,
			frameParityUniform, resolutionUniform,
			restirGIRoughnessTau: this.restirGIRoughnessTau,
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			enableAlphaShadows: this.uniforms.get( 'enableAlphaShadows' ),
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
		} );
		km.register( 'restirGIInitial',
			initFn().compute(
				[ Math.ceil( w / RESTIR_GI_INITIAL_WG_SIZE ), Math.ceil( h / RESTIR_GI_INITIAL_WG_SIZE ), 1 ],
				[ RESTIR_GI_INITIAL_WG_SIZE, RESTIR_GI_INITIAL_WG_SIZE, 1 ]
			)
		);

		// giTemporal — reproject prev GI reservoir + disocclusion gate + cross-eval combine (7 SB: hit/rng/mat/
		// tri/giReservoirRW/primaryHit/bvh — bvh = the PT-3c-2 k>1 prefix replay). Motion vector + prev
		// normalDepth are sampled textures (0 SB).
		const giTempFn = buildRestirGITemporalKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			rngBufferRW: pb.rngBuffer.rw,
			materialBuffer: freshMat,
			triangleBuffer: freshTri, // PT-2: per-domain emissive-pdf re-derivation in evalLo (6th SB)
			bvhBuffer: freshBvh, // PT-3c-2: k>1 cross-target replay (7th SB)
			giReservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			motionVectorTex: this._restirMotionTexNode,
			prevNormalDepthTex: this.shaderBuilder.prevNormalDepthTexNode,
			...maps,
			emissiveTotalPower: this.emissiveTotalPower,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraViewMatrix: this.cameraViewMatrix,
			frameParityUniform, resolutionUniform,
			// PT-3c-2 prefix replay (k>1 cross-targets)
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			restirGIRoughnessTau: this.restirGIRoughnessTau,
			enableAlphaShadows: this.uniforms.get( 'enableAlphaShadows' ),
		} );
		km.register( 'restirGITemporal',
			giTempFn().compute(
				[ Math.ceil( w / RESTIR_GI_TEMPORAL_WG_SIZE ), Math.ceil( h / RESTIR_GI_TEMPORAL_WG_SIZE ), 1 ],
				[ RESTIR_GI_TEMPORAL_WG_SIZE, RESTIR_GI_TEMPORAL_WG_SIZE, 1 ]
			)
		);

		// giSpatial — gather K neighbors from snapshot slot S + cross-eval combine with the reconnection Jacobian
		// → cur slot (7 SB: giReservoirRW/hit/mat/tri/primaryHit/rng/bvh — bvh = the PT-3c-2 k>1 prefix replay).
		// The genuine progressive-mode variance lever (independent spatial samples). Effective K is frame-gated
		// in render(). Always dispatches (K=0 ⇒ S→cur).
		const giSpatialFn = buildRestirGISpatialKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			rngBufferRW: pb.rngBuffer.rw,
			materialBuffer: freshMat,
			triangleBuffer: freshTri, // PT-2: per-domain emissive-pdf re-derivation in evalLo (6th SB)
			bvhBuffer: freshBvh, // PT-3c-2: k>1 cross-target replay (7th SB)
			giReservoirPoolRW: reservoirRW,
			primaryHitBuffer: primaryHitRO,
			...maps,
			emissiveTotalPower: this.emissiveTotalPower,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			frameParityUniform, resolutionUniform,
			restirGISpatialK: this._restirGISpatialK,
			restirGISpatialRadius: this._restirGISpatialRadius,
			// PT-3c-2 prefix replay (k>1 cross-targets)
			maxBounceCount: this.maxBounces,
			transmissiveBounces: this.transmissiveBounces,
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			restirGIRoughnessTau: this.restirGIRoughnessTau,
			enableAlphaShadows: this.uniforms.get( 'enableAlphaShadows' ),
		} );
		km.register( 'restirGISpatial',
			giSpatialFn().compute(
				[ Math.ceil( w / RESTIR_GI_SPATIAL_WG_SIZE ), Math.ceil( h / RESTIR_GI_SPATIAL_WG_SIZE ), 1 ],
				[ RESTIR_GI_SPATIAL_WG_SIZE, RESTIR_GI_SPATIAL_WG_SIZE, 1 ]
			)
		);

		// giResolve — one visibility ray x0↔x1 + add gi·f·cos·L_o·V·W into RADIANCE_ALPHA (pathLength=1).
		// (7 SB: bvh/tri/mat/hit/rayRW/giReservoirRO/primaryHitRO).
		const resolveFn = buildRestirGIResolveKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			hitBufferRO: pb.hitBuffer.ro,
			rayBufferRW: pb.rayBuffer.rw,
			giReservoirPoolRO: reservoirRO,
			primaryHitBuffer: primaryHitRO,
			...maps,
			cameraWorldMatrix: this.cameraWorldMatrix,
			frameParityUniform, resolutionUniform,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			fireflyThreshold: this.fireflyThreshold,
			frame: this.frame,
			maxBounceCount: this.maxBounces,
			// PT-3c prefix replay (k>1 re-anchoring)
			transmissiveBounces: this.transmissiveBounces,
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			restirGIRoughnessTau: this.restirGIRoughnessTau,
			enableAlphaShadows: this.uniforms.get( 'enableAlphaShadows' ),
			emissiveTotalPower: this.emissiveTotalPower,
		} );
		km.register( 'restirGIResolve',
			resolveFn().compute(
				[ Math.ceil( w / RESTIR_GI_RESOLVE_WG_SIZE ), Math.ceil( h / RESTIR_GI_RESOLVE_WG_SIZE ), 1 ],
				[ RESTIR_GI_RESOLVE_WG_SIZE, RESTIR_GI_RESOLVE_WG_SIZE, 1 ]
			)
		);

	}

	_setWfDispatch() {

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
		this._kernelManager.setDispatchCount( 'debug', [
			Math.ceil( w / DEBUG_WG_SIZE ),
			Math.ceil( h / DEBUG_WG_SIZE ), 1
		] );

		// ReSTIR passes are per-pixel (w×h); keep their grids current across in-place resize (registered
		// every rebuild, dispatched only when restirActive — updating the count when inactive is harmless).
		if ( this._kernelManager.has?.( 'restirInitial' ) ) {

			this._kernelManager.setDispatchCount( 'restirCapture', [
				Math.ceil( w / RESTIR_CAPTURE_WG_SIZE ), Math.ceil( h / RESTIR_CAPTURE_WG_SIZE ), 1
			] );
			this._kernelManager.setDispatchCount( 'restirInitial', [
				Math.ceil( w / RESTIR_INITIAL_WG_SIZE ), Math.ceil( h / RESTIR_INITIAL_WG_SIZE ), 1
			] );
			this._kernelManager.setDispatchCount( 'restirTemporal', [
				Math.ceil( w / RESTIR_TEMPORAL_WG_SIZE ), Math.ceil( h / RESTIR_TEMPORAL_WG_SIZE ), 1
			] );
			this._kernelManager.setDispatchCount( 'restirSpatial', [
				Math.ceil( w / RESTIR_SPATIAL_WG_SIZE ), Math.ceil( h / RESTIR_SPATIAL_WG_SIZE ), 1
			] );
			this._kernelManager.setDispatchCount( 'restirResolve', [
				Math.ceil( w / RESTIR_RESOLVE_WG_SIZE ), Math.ceil( h / RESTIR_RESOLVE_WG_SIZE ), 1
			] );

		}

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
