/**
 * PackedRayBuffer.js
 *
 * Packed buffer manager for wavefront path tracing. Each data category (ray,
 * hit, shadow, etc.) is a SINGLE storage buffer. This keeps storage buffer
 * bindings per kernel within WebGPU's 8-per-stage limit.
 *
 * LAYOUT (Phase 0 / v2): the RAY and HIT buffers use **SoA-within-a-buffer** —
 * each field occupies a contiguous region of `capacity` vec4s, so lane `i` reads
 * `field[fieldBase + i]` from coalesced cache lines instead of a strided
 * `i*stride + slot` gather. SHADOW stays AoS (it is small and, in the current
 * inline-NEE path, written-but-unread). The element index for ray/hit field
 * `slot` is `id + slot*_cap`; for shadow it remains `id*SHADOW_STRIDE + slot`.
 *
 * The key binding pattern is unchanged: one StorageInstancedBufferAttribute
 * creates one GPU buffer, then `storage(attr, ...)` and `.toReadOnly()` create
 * separate TSL nodes that bind to the SAME GPU data with different access modes
 * (count omitted so StorageBufferNode.getHash() shares the buffer).
 */

import { storage, uintBitsToFloat, floatBitsToUint, vec4, uint } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';

// ─── Stride constants (per-buffer field counts) ────────────────────────

/** 8 vec4 per ray (6 base + 1 medium-stack meta + 1 medium absorption coeff) */
export const RAY_STRIDE = 8;
/** 2 vec4 per hit */
export const HIT_STRIDE = 2;
/** 3 vec4 per shadow ray */
export const SHADOW_STRIDE = 3;

// ─── Field indices within each buffer ──────────────────────────────────
// For RAY/HIT these are SoA region indices (region base = index * _cap).
// For SHADOW they remain AoS slot offsets (index added to id*SHADOW_STRIDE).

/** Ray buffer field indices */
export const RAY = {
	ORIGIN_PIXEL: 0, // vec4(origin.xyz, uintBitsToFloat(pixelIndex))
	DIR_FLAGS: 1, // vec4(direction.xyz, uintBitsToFloat(bounceFlags))
	THROUGHPUT_PDF: 2, // vec4(throughput.xyz, pdf)
	RADIANCE_ALPHA: 3, // vec4(radiance.xyz, alpha)
	NORMAL_DEPTH: 4, // vec4(encodedNormal.xyz, linearDepth)  [MRT]
	ALBEDO_ID: 5, // vec4(albedo.xyz, objectID)            [MRT]
	MEDIUM_STACK: 6, // vec4(uintBitsToFloat(stackDepth|transTraversals<<8|wavelength<<16), ior1, ior2, ior3)
	MEDIUM_SIGMA_A: 7, // vec4(sigmaA.xyz, _) — Beer-Lambert absorption coeff of the active medium (KHR_materials_volume)
};

/** Hit buffer field indices */
export const HIT = {
	DIST_TRI_BARY: 0, // vec4(distance, uintBitsToFloat(triIndex), bary.u, bary.v)
	NORMAL_MAT: 1, // vec4(geoNormal.xyz, uintBitsToFloat(matIndex | meshIndex<<16))
};

/** Shadow buffer slot offsets (AoS — add to shadowID * SHADOW_STRIDE) */
export const SHADOW = {
	ORIGIN_DIST: 0, // vec4(origin.xyz, maxDist)
	DIR_PARENT: 1, // vec4(direction.xyz, uintBitsToFloat(parentRayID))
	RADIANCE: 2, // vec4(pendingRadiance.xyz, 0)
};

// ─── SoA capacity (module-level) ────────────────────────────────────────
// Set by PackedRayBuffer.allocate() before kernels are (re)built. Accessors
// read it at build time to bake per-field region offsets into the shader graph.
// Single-instance assumption (one PackedRayBuffer per app); rebuilt on resize.
let _cap = 0;

/** SoA element index for ray/hit field `slot` of element `id`: id + slot*_cap */
const soa = ( id, slot ) => ( slot === 0 ? id : id.add( slot * _cap ) );

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
		// Publish capacity for SoA accessors (region stride = capacity vec4s).
		_cap = capacity;

		// ── Ray buffer: RAY_STRIDE vec4 per ray (SoA regions) ──
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

		// ── Hit buffer: HIT_STRIDE vec4 per hit (SoA regions) ──
		const hitCount = capacity * HIT_STRIDE;
		const hitAttr = new StorageInstancedBufferAttribute( new Float32Array( hitCount * 4 ), 4 );
		this._attrs.hit = hitAttr;
		this.hitBuffer = {
			rw: storage( hitAttr, 'vec4' ),
			ro: storage( hitAttr, 'vec4' ).toReadOnly(),
		};

		// ── Shadow buffer: SHADOW_STRIDE vec4 per shadow ray (AoS) ──
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
			`(ray=${( rayCount * 16 / 1048576 ).toFixed( 0 )}MB hit=${( hitCount * 16 / 1048576 ).toFixed( 0 )}MB shadow=${( shadowCount * 16 / 1048576 ).toFixed( 0 )}MB) [SoA ray/hit]`
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
// Plain functions returning TSL node expressions. Call them inside Fn() scopes.
// RAY/HIT use SoA region indexing (soa()); SHADOW uses AoS stride indexing.
//
// Convention: `buf` is the StorageBufferNode (.rw or .ro),
//             `id` is a uint TSL node (rayID or shadowID).

// ── Ray read helpers (use with .ro buffer) ──

export const readRayOrigin = ( buf, id ) =>
	buf.element( soa( id, RAY.ORIGIN_PIXEL ) ).xyz;

export const readRayPixelIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_PIXEL ) ).w );

export const readRayDirection = ( buf, id ) =>
	buf.element( soa( id, RAY.DIR_FLAGS ) ).xyz;

export const readRayBounceFlags = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, RAY.DIR_FLAGS ) ).w );

export const readRayThroughput = ( buf, id ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) ).xyz;

export const readRayPdf = ( buf, id ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) ).w;

export const readRayRadiance = ( buf, id ) =>
	buf.element( soa( id, RAY.RADIANCE_ALPHA ) );

export const readRayNormalDepth = ( buf, id ) =>
	buf.element( soa( id, RAY.NORMAL_DEPTH ) );

export const readRayAlbedoID = ( buf, id ) =>
	buf.element( soa( id, RAY.ALBEDO_ID ) );

// ── Ray write helpers (use with .rw buffer) ──

export const writeRayOriginPixel = ( buf, id, origin, pixelIndex ) =>
	buf.element( soa( id, RAY.ORIGIN_PIXEL ) )
		.assign( vec4( origin, uintBitsToFloat( pixelIndex ) ) );

export const writeRayDirFlags = ( buf, id, direction, bounceFlags ) =>
	buf.element( soa( id, RAY.DIR_FLAGS ) )
		.assign( vec4( direction, uintBitsToFloat( bounceFlags ) ) );

export const writeRayThroughputPdf = ( buf, id, throughput, pdf ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) )
		.assign( vec4( throughput, pdf ) );

export const writeRayRadiance = ( buf, id, radiance ) =>
	buf.element( soa( id, RAY.RADIANCE_ALPHA ) )
		.assign( radiance );

export const writeRayNormalDepth = ( buf, id, normalDepth ) =>
	buf.element( soa( id, RAY.NORMAL_DEPTH ) )
		.assign( normalDepth );

export const writeRayAlbedoID = ( buf, id, albedoID ) =>
	buf.element( soa( id, RAY.ALBEDO_ID ) )
		.assign( albedoID );

// ── Hit read helpers ──

export const readHitDistance = ( buf, id ) =>
	buf.element( soa( id, HIT.DIST_TRI_BARY ) ).x;

export const readHitTriangleIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, HIT.DIST_TRI_BARY ) ).y );

export const readHitBarycentrics = ( buf, id ) =>
	buf.element( soa( id, HIT.DIST_TRI_BARY ) ).zw;

export const readHitNormal = ( buf, id ) =>
	buf.element( soa( id, HIT.NORMAL_MAT ) ).xyz;

export const readHitMaterialIndex = ( buf, id ) =>
	uint( floatBitsToUint( buf.element( soa( id, HIT.NORMAL_MAT ) ).w ).bitAnd( 0xFFFF ) );

export const readHitMeshIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, HIT.NORMAL_MAT ) ).w ).shiftRight( 16 );

// ── Hit write helper ──

export const writeHitPacked = ( buf, id, distance, triIndex, baryU, baryV, normal, matIndex, meshIndex ) => {

	buf.element( soa( id, HIT.DIST_TRI_BARY ) )
		.assign( vec4( distance, uintBitsToFloat( triIndex ), baryU, baryV ) );
	buf.element( soa( id, HIT.NORMAL_MAT ) )
		.assign( vec4( normal, uintBitsToFloat( matIndex.bitOr( meshIndex.shiftLeft( 16 ) ) ) ) );

};

// ── Shadow read helpers (AoS) ──

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

// ── Shadow write helper (AoS) ──

export const writeShadowPacked = ( buf, id, origin, maxDist, direction, parentRayID, pendingRadiance ) => {

	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.ORIGIN_DIST ) )
		.assign( vec4( origin, maxDist ) );
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.DIR_PARENT ) )
		.assign( vec4( direction, uintBitsToFloat( parentRayID ) ) );
	buf.element( id.mul( SHADOW_STRIDE ).add( SHADOW.RADIANCE ) )
		.assign( vec4( pendingRadiance, 0.0 ) );

};

// ── Medium stack read/write helpers (RAY region 6, SoA) ──
// Region 6: vec4(uintBitsToFloat(stackDepth | transTraversals<<8 | wavelength<<16), ior1, ior2, ior3)
// Dispersion: the locked path wavelength (nm, 0=achromatic) rides bits 16-31 of the packed word —
// 16 bits cover 380-700 nm at ~1 nm precision (negligible for the smooth Cauchy n(λ) fit), so no
// extra RAY-buffer slot is needed. `wavelength` is optional: callers that don't thread dispersion
// (GenerateKernel init, the inert ExtendShadeKernel) leave it 0.
export const readMediumStack = ( buf, id ) => {

	const packed = buf.element( soa( id, RAY.MEDIUM_STACK ) );
	const packedInt = floatBitsToUint( packed.x );
	return {
		stackDepth: packedInt.bitAnd( 0xFF ),
		transTraversals: packedInt.shiftRight( 8 ).bitAnd( 0xFF ),
		wavelength: packedInt.shiftRight( 16 ).bitAnd( 0xFFFF ),
		ior1: packed.y,
		ior2: packed.z,
		ior3: packed.w,
	};

};

export const writeMediumStack = ( buf, id, stackDepth, transTraversals, ior1, ior2, ior3, wavelength = uint( 0 ) ) =>
	buf.element( soa( id, RAY.MEDIUM_STACK ) )
		.assign( vec4( uintBitsToFloat(
			stackDepth.bitOr( transTraversals.shiftLeft( 8 ) ).bitOr( wavelength.shiftLeft( 16 ) )
		), ior1, ior2, ior3 ) );

// ── Medium absorption coefficient (RAY region 7, SoA) ──
// Beer-Lambert sigmaA (precomputed -log(attColor)/attDist) of the medium the ray is currently
// inside, for KHR_materials_volume. Single-slot: stored on each transmissive enter; absorption is
// gated on stackDepth>0. Nested glass (depth ≥2) reuses the most-recently-entered medium's coeff
// (documented limitation — full per-slot storage is deferred to the SSS layout extension).
export const readMediumSigmaA = ( buf, id ) => buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).xyz;

export const writeMediumSigmaA = ( buf, id, sigmaA ) =>
	buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).assign( vec4( sigmaA, 0.0 ) );
