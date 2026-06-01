/**
 * QueueManager.js — wavefront ray queues: active indices (ping-pong), sorted indices, atomic counters.
 */

import { attributeArray, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from 'three/webgpu';
import { ENGINE_DEFAULTS } from '../EngineDefaults.js';

/** Counter indices — must match ResetCounters kernel */
export const COUNTER = {
	ACTIVE_RAY_COUNT: 0,
	SHADOW_RAY_COUNT: 1,
	NEW_RAY_COUNT: 2,
	TERMINATED_COUNT: 3,
	// rays entering current bounce; snapshotted before ACTIVE_RAY_COUNT reset so over-sized dispatch is safe.
	ENTERING_COUNT: 4,
	COUNT: 5,
};

/** Ray flag bits packed into rayBounceFlags (uint) */
export const RAY_FLAG = {
	BOUNCE_MASK: 0xFF, // bits 0-7: bounce count (0-255)
	ACTIVE: 1 << 8, // bit 8: ray is alive
	SPECULAR: 1 << 9, // bit 9: last bounce was specular
	INSIDE_MEDIUM: 1 << 10, // bit 10: ray is inside a transmissive medium
	// bits 11-15: ray type
	RAY_TYPE_SHIFT: 11,
	RAY_TYPE_MASK: 0x1F << 11,
	// bits 16-31: spare per-ray state carried across bounces
	HAS_HIT_OPAQUE: 1 << 16, // bit 16: ray chain has hit non-transmissive geometry (transparent-bg alpha; megakernel hasHitOpaqueSurface)
	AUX_LOCKED: 1 << 17, // bit 17: OIDN aux (normal/albedo) locked onto first non-specular hit (megakernel auxLocked)
};

export class QueueManager {

	/**
	 * @param {number} maxRays - Maximum number of rays (typically width * height)
	 */
	constructor( maxRays = 0 ) {

		this.capacity = 0;
		this.counters = null;
		// A/B alternate: one read by current bounce, other written by compaction
		this.activeIndices = null;
		this.activeIndicesRO = null;
		this.sortedIndices = null;
		this.sortedIndicesRO = null;
		this.pingPong = 0; // 0 = read A / write B, 1 = read B / write A

		if ( maxRays > 0 ) {

			this.allocate( maxRays );

		}

	}

	// capacity must match RayBufferPool.allocatedCapacity
	allocate( capacity ) {

		this.dispose();
		this.capacity = capacity;

		// explicit attribute (not attributeArray) so it can be referenced for async readback
		this._countersAttr = new StorageInstancedBufferAttribute( new Uint32Array( COUNTER.COUNT ), 1 );
		this.counters = storage( this._countersAttr, 'uint' ).toAtomic();

		// per-bounce ACTIVE_RAY_COUNT snapshots; read back async to size/skip late bounces next frame
		this.MAX_BOUNCE_SNAPSHOTS = 32;
		this._bounceCountsAttr = new StorageInstancedBufferAttribute(
			new Uint32Array( this.MAX_BOUNCE_SNAPSHOTS ), 1,
		);
		this.bounceCounts = storage( this._bounceCountsAttr, 'uint' );

		// GPU-driven indirect dispatch args [wgX,wgY,wgZ]; IndirectStorageBufferAttribute is both kernel-writable and a valid dispatch source
		this._bounceDispatchAttr = new IndirectStorageBufferAttribute( new Uint32Array( [ 1, 1, 1 ] ), 1 );
		this.bounceDispatchArgs = storage( this._bounceDispatchAttr, 'uint' );

		const attrA = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		const attrB = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrA = attrA;
		this._attrB = attrB;

		this.activeIndices = {
			a: storage( attrA, 'uint' ),
			b: storage( attrB, 'uint' ),
		};

		// RO reuses the same attribute so RW/RO share one GPU buffer
		this.activeIndicesRO = {
			a: storage( attrA, 'uint' ).toReadOnly(),
			b: storage( attrB, 'uint' ).toReadOnly(),
		};

		const sortAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._sortAttr = sortAttr;
		this.sortedIndices = storage( sortAttr, 'uint' );
		this.sortedIndicesRO = storage( sortAttr, 'uint' ).toReadOnly();

		// histogram in storage (not workgroup) since TSL lacks atomic workgroup storage; each workgroup owns 16 slots
		const SORT_WG_SIZE = 256;
		const SORT_BINS = ENGINE_DEFAULTS.wavefrontSortBins ?? 16;
		const numWorkgroups = Math.ceil( capacity / SORT_WG_SIZE );
		const sortHistogramSize = numWorkgroups * SORT_BINS;
		this._sortHistogramSize = sortHistogramSize;
		this.sortHistogram = attributeArray( sortHistogramSize, 'uint' ).toAtomic();

		// global counting-sort histogram: 16 atomic u32 shared across all workgroups
		this.sortGlobalHistogram = attributeArray( SORT_BINS, 'uint' ).toAtomic();

		this.pingPong = 0;

		const totalBytes = (
			COUNTER.COUNT * 4 +
			capacity * 4 * 2 +
			capacity * 4 +
			sortHistogramSize * 4
		);

		console.log(
			`QueueManager: Allocated capacity=${capacity}, ` +
			`total=${( totalBytes / ( 1024 * 1024 ) ).toFixed( 1 )} MB`
		);

	}

	// returns true if reallocation occurred
	resize( capacity ) {

		if ( capacity <= this.capacity && this.capacity > 0 ) return false;
		this.allocate( capacity );
		return true;

	}

	getCounters() {

		return this.counters;

	}

	getActiveReadRO() {

		return this.pingPong === 0 ? this.activeIndicesRO.a : this.activeIndicesRO.b;

	}

	// RW version for compaction input
	getActiveRead() {

		return this.pingPong === 0 ? this.activeIndices.a : this.activeIndices.b;

	}

	getActiveWrite() {

		return this.pingPong === 0 ? this.activeIndices.b : this.activeIndices.a;

	}

	getSortedRW() {

		return this.sortedIndices;

	}

	getSortHistogram() {

		return this.sortHistogram;

	}

	getSortHistogramSize() {

		return this._sortHistogramSize;

	}

	getSortGlobalHistogram() {

		return this.sortGlobalHistogram;

	}

	// raw attribute for `renderer.getArrayBufferAsync(...)` readback
	getCountersAttribute() {

		return this._countersAttr;

	}

	getBounceCounts() {

		return this.bounceCounts;

	}

	getBounceCountsAttribute() {

		return this._bounceCountsAttr;

	}

	getSortedRO() {

		return this.sortedIndicesRO;

	}

	// assign as `computeNode.dispatchSize` (or 2nd arg to renderer.compute) to dispatch indirect
	getBounceDispatchAttr() {

		return this._bounceDispatchAttr;

	}

	getBounceDispatchArgs() {

		return this.bounceDispatchArgs;

	}

	swap() {

		this.pingPong = 1 - this.pingPong;

	}

	resetPingPong() {

		this.pingPong = 0;

	}

	dispose() {

		this.counters = null;
		this.activeIndices = null;
		this.activeIndicesRO = null;
		this.sortedIndices = null;
		this.sortedIndicesRO = null;
		this.capacity = 0;

	}

}
