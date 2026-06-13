/**
 * ReSTIRReservoirPool.js — per-pixel reservoir storage for UNBIASED ReSTIR DI / GI (interactive-only).
 *
 * Spec: docs/specs/restir-di-phase01.md §2.5 (DI), docs/specs/restir-gi-phase02.md §2 (GI). One
 * StorageBuffer holding SLOTS_PER_PIXEL(3) slots/pixel, each `vec4sPerSlot` vec4s. The slot count is
 * a constructor arg so the same class backs both layouts: DI = 2 vec4/slot (core+aux, 32 B/slot), GI
 * = 3 vec4/slot (core+sample+radiance, 48 B/slot). Read-write node + a read-only view over the SAME
 * attribute (the PackedRayBuffer.js:77-78 pattern) so resolve can bind read-only.
 *
 * The reservoir slot stride in the kernels (ReSTIRCore.reservoirSlotIndex *6 for DI;
 * ReSTIRGICore.reservoirSlotIndexGI *9 for GI) MUST stay in lockstep with vec4sPerSlot × SLOTS_PER_PIXEL
 * — the documented corruption footgun (asserted by the stride-parity unit tests).
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

// Slot layout is the single source of truth in ReSTIRLayout.js (pure JS) so the node stride-parity test can
// import the exact shipping constants. DI: 96 B/pixel, 384 MB @2048². GI: 144 B/pixel, 576 MB @2048².
import { SLOTS_PER_PIXEL, DI_VEC4S_PER_SLOT } from './ReSTIRLayout.js';

const FLOATS_PER_VEC4 = 4;
const STUB_VEC4S = 1;

export class ReSTIRReservoirPool {

	// vec4sPerSlot: 2 for DI (core+aux), 6 for GI/PT-2. primaryHitSlots: 1 (DI) or 2 (GI/PT-2b — the
	// primaryHit buffer ping-pongs cur/prev so gi-temporal evaluates the history arm at the TRUE
	// previous-frame jittered x0). SLOTS_PER_PIXEL (3) is shared.
	constructor( vec4sPerSlot = DI_VEC4S_PER_SLOT, primaryHitSlots = 1 ) {

		this.vec4sPerSlot = vec4sPerSlot;
		this.primaryHitSlots = primaryHitSlots;
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

		const vec4Count = maxDim * maxDim * this.vec4sPerSlot * SLOTS_PER_PIXEL;
		this.attr = new StorageInstancedBufferAttribute( new Float32Array( vec4Count * FLOATS_PER_VEC4 ), FLOATS_PER_VEC4 );

		// Swap value+bufferCount in place to preserve the compiled node references.
		this.node.value = this.attr;
		this.node.bufferCount = vec4Count;
		this.nodeRO.value = this.attr;
		this.nodeRO.bufferCount = vec4Count;

		// Primary-hit buffer: primaryHitSlots vec4/pixel (GI/PT-2b ping-pongs cur/prev by frame parity).
		const primaryVec4Count = maxDim * maxDim * this.primaryHitSlots;
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
			? this.width * this.height * this.vec4sPerSlot * SLOTS_PER_PIXEL
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
