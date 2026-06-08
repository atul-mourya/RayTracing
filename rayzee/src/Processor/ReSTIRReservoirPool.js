/**
 * ReSTIRReservoirPool.js — per-pixel reservoir storage for UNBIASED ReSTIR DI (interactive-only).
 *
 * Spec: docs/specs/restir-di-phase01.md §2.5. One StorageBuffer holding 2 ping-pong slots/pixel
 * (core+aux vec4 each = 32 B/slot, 64 B/pixel). Read-write node + a read-only view over the SAME
 * attribute (the PackedRayBuffer.js:77-78 pattern) so resolve can bind read-only.
 *
 * Lifecycle — the verified resize footgun (project_wavefront_resize_norebuild): a StorageBuffer
 * .value-swap only "sticks" at idle, so we PRE-ALLOCATE AT MAX (2048²) once and NEVER realloc on
 * resize. A 1-vec4 stub exists at construction so the TSL node compiles while the feature is OFF
 * (production VRAM = 16 B). activateAtMax/deactivate swap value+bufferCount in place, ONLY at idle
 * mode-toggles (coincident with a kernel rebuild). setSize just updates the resolution uniform;
 * pixels ≥ current w×h are never addressed (bounds-cull in the kernels).
 *
 * Pure buffer manager (not a RenderStage). The owning stage drives setSize/activateAtMax/swap/clear.
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage, uniform } from 'three/tsl';
import { Vector2 } from 'three';

const VEC4S_PER_SLOT = 2; // core (lightSampleId/wSum/W/M) + aux (samplePos.xyz/pHatOwn)
// 3 slots/pixel = 2 ping-pong (0,1: cur/prev — hold the FINAL post-spatial reservoir) + 1 fixed snapshot
// (slot 2: this frame's post-TEMPORAL reservoir, a stable read-only source for the spatial neighbor gather).
// MUST stay in lockstep with reservoirSlotIndex's stride (ReSTIRCore.js: pixelIdx*6) — moving one without
// the other under-allocates and corrupts. 96 B/pixel; 384 MB @2048² (within the ~1 GB baseline headroom).
const SLOTS_PER_PIXEL = 3;
const FLOATS_PER_VEC4 = 4;
const STUB_VEC4S = 1;

export class ReSTIRReservoirPool {

	constructor() {

		this.width = 0;
		this.height = 0;
		this.attr = null;
		this.node = null; // read-write view
		this.nodeRO = null; // read-only view over the SAME attribute

		// Exact bounce-0 primary-hit world point (1 vec4/pixel: P.xyz). Written by restirCapture from the
		// ACTUAL jittered primary ray (before ShadeKernel overwrites it), read by initial/temporal/resolve
		// so they evaluate at the same sub-pixel point ShadeKernel/NEE uses — reconstructPrimaryHit used the
		// pixel CENTER (no AA jitter), which under-sampled sub-pixel lighting variation (~−5-7% dark bias).
		this.primaryHitAttr = null;
		this.primaryHitNode = null; // read-write view (restirCapture)
		this.primaryHitNodeRO = null; // read-only view (initial/temporal/resolve)

		this._activated = false;
		this._frameParity = 0;

		// Pool owns these so the graph bindings are stable across stub→full swaps.
		this.frameParityUniform = uniform( 0, 'int' );
		this.resolutionUniform = uniform( new Vector2( 0, 0 ), 'vec2' );

		this._createStub();

	}

	_createStub() {

		this.attr = new StorageInstancedBufferAttribute( new Float32Array( STUB_VEC4S * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );
		this.node = storage( this.attr, 'vec4' );
		this.nodeRO = storage( this.attr, 'vec4' ).toReadOnly();

		this.primaryHitAttr = new StorageInstancedBufferAttribute( new Float32Array( STUB_VEC4S * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );
		this.primaryHitNode = storage( this.primaryHitAttr, 'vec4' );
		this.primaryHitNodeRO = storage( this.primaryHitAttr, 'vec4' ).toReadOnly();

		this._activated = false;

	}

	/**
	 * Record the render size. Never reallocates (pre-allocated at max); resolution rides the
	 * uniform + per-kernel bounds-cull. Safe to call every frame / on resize.
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.resolutionUniform.value.set( width, height );

	}

	/**
	 * One-shot full allocation at MAX resolution (call with MAX_STORAGE_TEXTURE_SIZE). Idempotent.
	 * MUST be called at an idle mode-toggle (interactive + enableReSTIR) where kernels rebuild —
	 * a mid-frame .value swap does not rebind reliably.
	 */
	activateAtMax( maxDim ) {

		if ( this._activated ) return;

		const vec4Count = maxDim * maxDim * VEC4S_PER_SLOT * SLOTS_PER_PIXEL;
		this.attr = new StorageInstancedBufferAttribute( new Float32Array( vec4Count * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );

		// Swap value+bufferCount in place to preserve the compiled node references.
		this.node.value = this.attr;
		this.node.bufferCount = vec4Count;
		this.nodeRO.value = this.attr;
		this.nodeRO.bufferCount = vec4Count;

		// Primary-hit buffer: 1 vec4/pixel (no ping-pong, no slots).
		const primaryVec4Count = maxDim * maxDim;
		this.primaryHitAttr = new StorageInstancedBufferAttribute( new Float32Array( primaryVec4Count * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );
		this.primaryHitNode.value = this.primaryHitAttr;
		this.primaryHitNode.bufferCount = primaryVec4Count;
		this.primaryHitNodeRO.value = this.primaryHitAttr;
		this.primaryHitNodeRO.bufferCount = primaryVec4Count;

		this._activated = true;

	}

	/**
	 * Reclaim VRAM (256 MB @2048² → 16 B) by swapping back to the stub. Production / flag-off.
	 * Idle-only, same rebind constraint as activateAtMax.
	 */
	deactivate() {

		if ( ! this._activated ) return;

		this.attr = new StorageInstancedBufferAttribute( new Float32Array( STUB_VEC4S * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );
		this.node.value = this.attr;
		this.node.bufferCount = STUB_VEC4S;
		this.nodeRO.value = this.attr;
		this.nodeRO.bufferCount = STUB_VEC4S;

		this.primaryHitAttr = new StorageInstancedBufferAttribute( new Float32Array( STUB_VEC4S * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );
		this.primaryHitNode.value = this.primaryHitAttr;
		this.primaryHitNode.bufferCount = STUB_VEC4S;
		this.primaryHitNodeRO.value = this.primaryHitAttr;
		this.primaryHitNodeRO.bufferCount = STUB_VEC4S;

		this._activated = false;

	}

	/** Flip ping-pong parity. Call once per frame, after finalWrite. Net-new (SoA buffers don't swap). */
	swap() {

		this._frameParity ^= 1;
		this.frameParityUniform.value = this._frameParity;

	}

	/** Zero all reservoirs — on pipeline:reset (camera/light/material edit). Parity is independent. */
	clear() {

		if ( ! this.attr ) return;
		this.attr.array.fill( 0 );
		this.attr.needsUpdate = true;

	}

	getStorageNode() {

		return this.node;

	}

	getReadOnlyNode() {

		return this.nodeRO;

	}

	getFrameParity() {

		return this._frameParity;

	}

	isActivated() {

		return this._activated;

	}

	getStats() {

		const vec4s = this._activated
			? this.width * this.height * VEC4S_PER_SLOT * SLOTS_PER_PIXEL
			: STUB_VEC4S;
		return {
			activated: this._activated,
			width: this.width,
			height: this.height,
			bytes: vec4s * FLOATS_PER_VEC4 * 4,
		};

	}

	dispose() {

		this.attr = null;
		this.node = null;
		this.nodeRO = null;
		this._activated = false;

	}

}
