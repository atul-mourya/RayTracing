/**
 * PackedRayBuffer.js
 *
 * AoS (Array-of-Structures) packed buffer manager for wavefront path tracing.
 * Each data category (ray, hit, shadow, etc.) is a SINGLE storage buffer
 * with stride-based element access. This keeps storage buffer bindings per
 * kernel within WebGPU's 8-per-stage limit.
 *
 * The key pattern: one StorageInstancedBufferAttribute creates one GPU buffer,
 * then `storage(attr, ...)` and `storage(attr, ...).toReadOnly()` create
 * separate TSL nodes that bind to the SAME GPU data with different access modes.
 */

import { storage, uintBitsToFloat, floatBitsToUint, vec4 } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';

// ─── Stride constants ───────────────────────────────────────────────────

/** 7 vec4 per ray (6 base + 1 medium stack) */
export const RAY_STRIDE = 7;
/** 2 vec4 per hit */
export const HIT_STRIDE = 2;
/** 3 vec4 per shadow ray */
export const SHADOW_STRIDE = 3;

// ─── Slot offsets within each stride ────────────────────────────────────

/** Ray buffer slot offsets (add to rayID * RAY_STRIDE) */
export const RAY = {
	ORIGIN_PIXEL: 0, // vec4(origin.xyz, uintBitsToFloat(pixelIndex))
	DIR_FLAGS: 1, // vec4(direction.xyz, uintBitsToFloat(bounceFlags))
	THROUGHPUT_PDF: 2, // vec4(throughput.xyz, pdf)
	RADIANCE_ALPHA: 3, // vec4(radiance.xyz, alpha)
	NORMAL_DEPTH: 4, // vec4(encodedNormal.xyz, linearDepth)  [MRT]
	ALBEDO_ID: 5, // vec4(albedo.xyz, objectID)            [MRT]
	MEDIUM_STACK: 6, // vec4(uintBitsToFloat(stackDepth|transTraversals), ior1, ior2, ior3)
};

/** Hit buffer slot offsets (add to rayID * HIT_STRIDE) */
export const HIT = {
	DIST_TRI_BARY: 0, // vec4(distance, uintBitsToFloat(triIndex), bary.u, bary.v)
	NORMAL_MAT: 1, // vec4(geoNormal.xyz, uintBitsToFloat(matIndex | meshIndex<<16))
};

/** Shadow buffer slot offsets (add to shadowID * SHADOW_STRIDE) */
export const SHADOW = {
	ORIGIN_DIST: 0, // vec4(origin.xyz, maxDist)
	DIR_PARENT: 1, // vec4(direction.xyz, uintBitsToFloat(parentRayID))
	RADIANCE: 2, // vec4(pendingRadiance.xyz, 0)
};

// ─── Helper: round up to next power of 2 ───────────────────────────────

function nextPow2( v ) {

	v --;
	v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
	return v + 1;

}

// ─── PackedRayBuffer class ──────────────────────────────────────────────

export class PackedRayBuffer {

	/**
	 * @param {number} maxRays - Maximum rays (typically width * height)
	 */
	constructor( maxRays = 0 ) {

		/** Allocated capacity (power-of-2 rounded) */
		this.capacity = 0;

		/** Underlying StorageInstancedBufferAttributes (one per buffer) */
		this._attrs = {};

		/** TSL storage nodes: { rw: StorageBufferNode, ro: StorageBufferNode } */
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;
		this.shadowBuffer = null;
		this.visibilityBuffer = null;

		if ( maxRays > 0 ) this.allocate( maxRays );

	}

	/**
	 * Allocate all packed buffers.
	 * @param {number} maxRays
	 */
	allocate( maxRays ) {

		this.dispose();

		const capacity = nextPow2( Math.ceil( maxRays * 1.25 ) );
		this.capacity = capacity;

		// ── Ray buffer: 6 vec4 per ray ──
		// CRITICAL: use count=0 so StorageBufferNode.getHash() shares hash
		// via builder.globalCache.getData(attr) — ensures RW and RO nodes
		// bind to the SAME GPU buffer (data written by one kernel is
		// readable by the next). With count>0, each gets a unique UUID → separate buffers.
		const rayCount = capacity * RAY_STRIDE;
		const rayAttr = new StorageInstancedBufferAttribute( new Float32Array( rayCount * 4 ), 4 );
		this._attrs.ray = rayAttr;
		this.rayBuffer = {
			rw: storage( rayAttr, 'vec4' ),
			ro: storage( rayAttr, 'vec4' ).toReadOnly(),
		};

		// ── RNG buffer: 1 uint per ray ──
		const rngAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrs.rng = rngAttr;
		this.rngBuffer = {
			rw: storage( rngAttr, 'uint' ),
			ro: storage( rngAttr, 'uint' ).toReadOnly(),
		};

		// ── Hit buffer: 2 vec4 per hit ──
		const hitCount = capacity * HIT_STRIDE;
		const hitAttr = new StorageInstancedBufferAttribute( new Float32Array( hitCount * 4 ), 4 );
		this._attrs.hit = hitAttr;
		this.hitBuffer = {
			rw: storage( hitAttr, 'vec4' ),
			ro: storage( hitAttr, 'vec4' ).toReadOnly(),
		};

		// ── Shadow buffer: 3 vec4 per shadow ray ──
		const shadowCount = capacity * SHADOW_STRIDE;
		const shadowAttr = new StorageInstancedBufferAttribute( new Float32Array( shadowCount * 4 ), 4 );
		this._attrs.shadow = shadowAttr;
		this.shadowBuffer = {
			rw: storage( shadowAttr, 'vec4' ),
			ro: storage( shadowAttr, 'vec4' ).toReadOnly(),
		};

		// ── Visibility buffer: 1 uint per shadow ray ──
		const visAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrs.vis = visAttr;
		this.visibilityBuffer = {
			rw: storage( visAttr, 'uint' ),
			ro: storage( visAttr, 'uint' ).toReadOnly(),
		};

		const totalMB = (
			rayCount * 16 + capacity * 4 + hitCount * 16 + shadowCount * 16 + capacity * 4
		) / ( 1024 * 1024 );

		console.log(
			`PackedRayBuffer: capacity=${capacity}, total=${totalMB.toFixed( 1 )} MB ` +
			`(ray=${( rayCount * 16 / 1048576 ).toFixed( 0 )}MB hit=${( hitCount * 16 / 1048576 ).toFixed( 0 )}MB shadow=${( shadowCount * 16 / 1048576 ).toFixed( 0 )}MB)`
		);

	}

	/**
	 * Resize if needed. Returns true if reallocation occurred.
	 * @param {number} maxRays
	 * @returns {boolean}
	 */
	resize( maxRays ) {

		const needed = nextPow2( Math.ceil( maxRays * 1.25 ) );
		if ( needed <= this.capacity && this.capacity > 0 ) return false;
		this.allocate( maxRays );
		return true;

	}

	dispose() {

		this._attrs = {};
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;
		this.shadowBuffer = null;
		this.visibilityBuffer = null;
		this.capacity = 0;

	}

}

// ─── TSL Accessor Helpers ───────────────────────────────────────────────
// These are plain functions that return TSL node expressions.
// Call them inside Fn() scopes. They use stride-based element access
// on the packed vec4 buffers.
//
// Convention: `buf` is the StorageBufferNode (.rw or .ro),
//             `id` is a uint TSL node (rayID or shadowID).

// ── Ray read helpers (use with .ro buffer) ──

export const readRayOrigin = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.ORIGIN_PIXEL ) ).xyz;

export const readRayPixelIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( RAY_STRIDE ).add( RAY.ORIGIN_PIXEL ) ).w );

export const readRayDirection = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.DIR_FLAGS ) ).xyz;

export const readRayBounceFlags = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( RAY_STRIDE ).add( RAY.DIR_FLAGS ) ).w );

export const readRayThroughput = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.THROUGHPUT_PDF ) ).xyz;

export const readRayPdf = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.THROUGHPUT_PDF ) ).w;

export const readRayRadiance = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.RADIANCE_ALPHA ) );

export const readRayNormalDepth = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.NORMAL_DEPTH ) );

export const readRayAlbedoID = ( buf, id ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.ALBEDO_ID ) );

// ── Ray write helpers (use with .rw buffer) ──

export const writeRayOriginPixel = ( buf, id, origin, pixelIndex ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.ORIGIN_PIXEL ) )
		.assign( vec4( origin, uintBitsToFloat( pixelIndex ) ) );

export const writeRayDirFlags = ( buf, id, direction, bounceFlags ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.DIR_FLAGS ) )
		.assign( vec4( direction, uintBitsToFloat( bounceFlags ) ) );

export const writeRayThroughputPdf = ( buf, id, throughput, pdf ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.THROUGHPUT_PDF ) )
		.assign( vec4( throughput, pdf ) );

export const writeRayRadiance = ( buf, id, radiance ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.RADIANCE_ALPHA ) )
		.assign( radiance );

export const writeRayNormalDepth = ( buf, id, normalDepth ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.NORMAL_DEPTH ) )
		.assign( normalDepth );

export const writeRayAlbedoID = ( buf, id, albedoID ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.ALBEDO_ID ) )
		.assign( albedoID );

// ── Hit read helpers ──

export const readHitDistance = ( buf, id ) =>
	buf.element( id.mul( HIT_STRIDE ).add( HIT.DIST_TRI_BARY ) ).x;

export const readHitTriangleIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( HIT_STRIDE ).add( HIT.DIST_TRI_BARY ) ).y );

export const readHitBarycentrics = ( buf, id ) =>
	buf.element( id.mul( HIT_STRIDE ).add( HIT.DIST_TRI_BARY ) ).zw;

export const readHitNormal = ( buf, id ) =>
	buf.element( id.mul( HIT_STRIDE ).add( HIT.NORMAL_MAT ) ).xyz;

export const readHitMaterialIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( HIT_STRIDE ).add( HIT.NORMAL_MAT ) ).w ).and( 0xFFFF );

export const readHitMeshIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( HIT_STRIDE ).add( HIT.NORMAL_MAT ) ).w ).shiftRight( 16 );

// ── Hit write helper ──

export const writeHitPacked = ( buf, id, distance, triIndex, baryU, baryV, normal, matIndex, meshIndex ) => {

	buf.element( id.mul( HIT_STRIDE ).add( HIT.DIST_TRI_BARY ) )
		.assign( vec4( distance, uintBitsToFloat( triIndex ), baryU, baryV ) );
	buf.element( id.mul( HIT_STRIDE ).add( HIT.NORMAL_MAT ) )
		.assign( vec4( normal, uintBitsToFloat( matIndex.or( meshIndex.shiftLeft( 16 ) ) ) ) );

};

// ── Shadow read helpers ──

export const readShadowOrigin = ( buf, id ) =>
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) ).xyz;

export const readShadowMaxDist = ( buf, id ) =>
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) ).w;

export const readShadowDirection = ( buf, id ) =>
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) ).xyz;

export const readShadowParentRayID = ( buf, id ) =>
	floatBitsToUint( buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) ).w );

export const readShadowPendingRadiance = ( buf, id ) =>
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.RADIANCE ) ).xyz;

// ── Shadow write helper ──

export const writeShadowPacked = ( buf, id, origin, maxDist, direction, parentRayID, pendingRadiance ) => {

	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) )
		.assign( vec4( origin, maxDist ) );
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) )
		.assign( vec4( direction, uintBitsToFloat( parentRayID ) ) );
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.RADIANCE ) )
		.assign( vec4( pendingRadiance, 0.0 ) );

};

// ── Medium stack read/write helpers ──
// Slot 6: vec4(uintBitsToFloat(stackDepth | transTraversals<<8), ior1, ior2, ior3)

export const readMediumStack = ( buf, id ) => {

	const packed = buf.element( id.mul( RAY_STRIDE ).add( RAY.MEDIUM_STACK ) );
	const packedInt = floatBitsToUint( packed.x );
	return {
		stackDepth: packedInt.and( 0xFF ),
		transTraversals: packedInt.shiftRight( 8 ).and( 0xFF ),
		ior1: packed.y,
		ior2: packed.z,
		ior3: packed.w,
	};

};

export const writeMediumStack = ( buf, id, stackDepth, transTraversals, ior1, ior2, ior3 ) =>
	buf.element( id.mul( RAY_STRIDE ).add( RAY.MEDIUM_STACK ) )
		.assign( vec4( uintBitsToFloat( stackDepth.or( transTraversals.shiftLeft( 8 ) ) ), ior1, ior2, ior3 ) );
