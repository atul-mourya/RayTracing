/**
 * Packed buffer manager for wavefront path tracing — one storage buffer per data category.
 * RAY/HIT are SoA-within-a-buffer (field `slot` of element `id` lives at `id + slot*_cap`).
 */

import {
	storage, uintBitsToFloat, floatBitsToUint, vec2, vec3, vec4, uvec4, uint, int,
	packSnorm2x16, packUnorm2x16, unpackSnorm2x16, unpackUnorm2x16,
} from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';

export const RAY_STRIDE = 7;
export const HIT_STRIDE = 2;
// Per-pixel G-buffer (first-hit MRT staging): 2 uvec4/pixel (AoS, element p*GBUFFER_STRIDE + lane).
//   lane 0 — half-packed normal/depth/albedo (pack2x16, no f32 bitcast); read by FinalWrite:
//     .x=packSnorm2x16(normal.xy)  .y=packSnorm2x16(normal.z, depth)  .z=packUnorm2x16(albedo.rg)  .w=packUnorm2x16(albedo.b, 0)
//   lane 1 — primary-hit surface ID for A-SVGF correlated-gradient re-projection (Tier 1); written at the
//     bounce-0 hit, valid=0 on miss (Generate inits): .x=triIndex .y=meshIndex .z=packUnorm2x16(bary.u,bary.v) .w=valid
// Separate buffer from RAY (per-pixel, not per-ray×S) — written by Generate/Shade bounce-0.
export const GBUFFER_STRIDE = 2;

export const RAY = {
	ORIGIN_META: 0, // vec4(origin.xyz, uintBitsToFloat(perRayBounces | sssSteps<<8)); pixelIndex+sampleIndex derived from rayID
	DIR_FLAGS: 1, // vec4(direction.xyz, uintBitsToFloat(bounceFlags))
	THROUGHPUT_PDF: 2, // vec4(throughput.xyz, pdf)
	RADIANCE_ALPHA: 3, // vec4(radiance.xyz, alpha)
	MEDIUM_STACK: 4, // vec4(uintBitsToFloat(stackDepth|transTraversals<<8|wavelength<<16), ior1, ior2, ior3)
	MEDIUM_SIGMA_A: 5, // vec4(sigmaA.xyz, _) — Beer-Lambert absorption coeff of the active medium (KHR_materials_volume + SSS)
	SSS_SIGMA_S: 6, // vec4(sigmaS.xyz, g) — SSS scattering coeff + Henyey-Greenstein anisotropy (sigmaS==0 ⇒ glass)
};

export const HIT = {
	DIST_TRI_BARY: 0, // vec4(distance, uintBitsToFloat(triIndex), bary.u, bary.v)
	NORMAL_MAT: 1, // vec4(geoNormal.xyz, uintBitsToFloat(matIndex | meshIndex<<16))
};

// SoA region stride, baked into the shader graph at build time; single instance, rebuilt on resize.
let _cap = 0;

const soa = ( id, slot ) => ( slot === 0 ? id : id.add( slot * _cap ) );

export class PackedRayBuffer {

	// Capacity maxRays would allocate (mirrors allocate()/resize()). 1.25× headroom, NO pow2 rounding —
	// the pow2 jump nearly doubled VRAM (e.g. 2048²: 5.24M→8.39M) for no realloc benefit: the app's
	// discrete resolution presets always exceed the 1.25× margin on a tier change, so they rebuild anyway.
	static requiredCapacity( maxRays ) {

		return Math.ceil( maxRays * 1.25 );

	}

	constructor( maxRays = 0 ) {

		this.capacity = 0;
		this._attrs = {};

		// Each: { rw: StorageBufferNode, ro: StorageBufferNode } over one shared GPU buffer.
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;

		if ( maxRays > 0 ) this.allocate( maxRays );

	}

	allocate( maxRays ) {

		this.dispose();

		const capacity = Math.ceil( maxRays * 1.25 );
		this.capacity = capacity;
		_cap = capacity;

		// count=0 so StorageBufferNode.getHash() shares the buffer → RW and RO nodes bind the same GPU data.
		const rayCount = capacity * RAY_STRIDE;
		const rayAttr = new StorageInstancedBufferAttribute( new Float32Array( rayCount * 4 ), 4 );
		this._attrs.ray = rayAttr;
		this.rayBuffer = {
			rw: storage( rayAttr, 'vec4' ),
			ro: storage( rayAttr, 'vec4' ).toReadOnly(),
		};

		const rngAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrs.rng = rngAttr;
		this.rngBuffer = {
			rw: storage( rngAttr, 'uint' ),
			ro: storage( rngAttr, 'uint' ).toReadOnly(),
		};

		const hitCount = capacity * HIT_STRIDE;
		const hitAttr = new StorageInstancedBufferAttribute( new Float32Array( hitCount * 4 ), 4 );
		this._attrs.hit = hitAttr;
		this.hitBuffer = {
			rw: storage( hitAttr, 'vec4' ),
			ro: storage( hitAttr, 'vec4' ).toReadOnly(),
		};

		const totalMB = (
			rayCount * 16 + capacity * 4 + hitCount * 16
		) / ( 1024 * 1024 );

		console.log(
			`PackedRayBuffer: capacity=${capacity}, total=${totalMB.toFixed( 1 )} MB ` +
			`(ray=${( rayCount * 16 / 1048576 ).toFixed( 0 )}MB hit=${( hitCount * 16 / 1048576 ).toFixed( 0 )}MB) [SoA ray/hit]`
		);

	}

	// Reallocates only if maxRays needs more capacity; returns true if it did.
	resize( maxRays ) {

		const needed = Math.ceil( maxRays * 1.25 );
		if ( needed <= this.capacity && this.capacity > 0 ) return false;
		this.allocate( maxRays );
		return true;

	}

	dispose() {

		this._attrs = {};
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;
		this.capacity = 0;

	}

}

// TSL accessor helpers — call inside Fn() scopes. `buf` is the .rw/.ro StorageBufferNode, `id` a uint node.

export const readRayOrigin = ( buf, id ) =>
	buf.element( soa( id, RAY.ORIGIN_META ) ).xyz;

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

// ── Per-pixel G-buffer (first-hit MRT). 2 uvec4/pixel (AoS), pack2x16 lanes. ──
// normal: raw unit vec3; depth: linear [0,1]; albedo: vec3 [0,1]. Packed values live in u32 lanes
// verbatim (no f32 bitcast) so NaN-range bit patterns (snorm ±1 → 0x7FFF) survive store/load intact.
// gbLane resolves the AoS slot for a pixel (lane 0 = MRT, lane 1 = surface ID).
const gbLane = ( pixelIndex, lane ) => {

	const base = uint( pixelIndex ).mul( GBUFFER_STRIDE );
	return lane === 0 ? base : base.add( lane );

};

export const writeGBuffer = ( buf, pixelIndex, normal, depth, albedo ) =>
	buf.element( gbLane( pixelIndex, 0 ) ).assign( uvec4(
		packSnorm2x16( vec2( normal.x, normal.y ) ),
		packSnorm2x16( vec2( normal.z, depth ) ),
		packUnorm2x16( vec2( albedo.x, albedo.y ) ),
		packUnorm2x16( vec2( albedo.z, 0.0 ) ),
	) );
export const readGBuffer = ( buf, pixelIndex ) => buf.element( gbLane( pixelIndex, 0 ) );

// Lane 1 — primary-hit surface ID for A-SVGF correlated gradient re-projection (Tier 1).
// valid=0 marks a miss (no primary surface); bary packed unorm (both in [0,1]).
export const writeGBufferSurfaceID = ( buf, pixelIndex, triIndex, meshIndex, baryU, baryV, valid ) =>
	buf.element( gbLane( pixelIndex, 1 ) ).assign( uvec4(
		uint( triIndex ), uint( meshIndex ), packUnorm2x16( vec2( baryU, baryV ) ), uint( valid ),
	) );
export const readGBufferSurfaceID = ( buf, pixelIndex ) => {

	const p = buf.element( gbLane( pixelIndex, 1 ) );
	const bary = unpackUnorm2x16( p.z );
	return { triIndex: p.x, meshIndex: p.y, baryU: bary.x, baryV: bary.y, valid: p.w };

};

// Decode for FinalWrite. normalDepth.xyz matches the prior path (normal*0.5+0.5), .w = raw depth.
export const gbDecodeNormalDepth = ( packed ) => {

	const nxy = unpackSnorm2x16( packed.x );
	const nzd = unpackSnorm2x16( packed.y );
	return vec4( vec3( nxy.x, nxy.y, nzd.x ).mul( 0.5 ).add( 0.5 ), nzd.y );

};

export const gbDecodeAlbedo = ( packed ) =>
	vec3( unpackUnorm2x16( packed.z ), unpackUnorm2x16( packed.w ).x );

// .w packs per-ray bounce state: perRayBounces (bits 0-7) | sssSteps (bits 8-15). pixelIndex +
// sampleIndex are NOT stored — derived from rayID (= subSample*w*h + pixelIndex) in-kernel.
export const writeRayOriginMeta = ( buf, id, origin, bounces, sssSteps ) =>
	buf.element( soa( id, RAY.ORIGIN_META ) )
		.assign( vec4( origin, uintBitsToFloat(
			uint( bounces ).bitOr( uint( sssSteps ).shiftLeft( 8 ) )
		) ) );

export const writeRayDirFlags = ( buf, id, direction, bounceFlags ) =>
	buf.element( soa( id, RAY.DIR_FLAGS ) )
		.assign( vec4( direction, uintBitsToFloat( bounceFlags ) ) );

export const writeRayThroughputPdf = ( buf, id, throughput, pdf ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) )
		.assign( vec4( throughput, pdf ) );

export const writeRayRadiance = ( buf, id, radiance ) =>
	buf.element( soa( id, RAY.RADIANCE_ALPHA ) )
		.assign( radiance );

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

export const writeHitPacked = ( buf, id, distance, triIndex, baryU, baryV, normal, matIndex, meshIndex ) => {

	buf.element( soa( id, HIT.DIST_TRI_BARY ) )
		.assign( vec4( distance, uintBitsToFloat( triIndex ), baryU, baryV ) );
	buf.element( soa( id, HIT.NORMAL_MAT ) )
		.assign( vec4( normal, uintBitsToFloat( matIndex.bitOr( meshIndex.shiftLeft( 16 ) ) ) ) );

};

// Region 6 word packs stackDepth | transTraversals<<8 | wavelength<<16 (nm, 0=achromatic).
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

// Region 7: Beer-Lambert sigmaA of the active medium; single-slot, absorption gated on stackDepth>0.
export const readMediumSigmaA = ( buf, id ) => buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).xyz;

export const writeMediumSigmaA = ( buf, id, sigmaA ) =>
	buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).assign( vec4( sigmaA, 0.0 ) );

// Per-ray bounce state packed into ORIGIN_META.w (written by writeRayOriginMeta alongside the origin):
//   perRayBounces = bits 0-7 (camera-bounce depth; the loop index can't track it once free bounces decouple it)
//   sssSteps      = bits 8-15 (SSS random-walk step counter)
// sampleIndex (the multi-sample sub-sample 0..S-1) is derived in-kernel from rayID, not stored.
export const readPathBounces = ( buf, id ) =>
	int( floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_META ) ).w ).bitAnd( 0xFF ) );
export const readSssSteps = ( buf, id ) =>
	int( floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_META ) ).w ).shiftRight( 8 ).bitAnd( 0xFF ) );

// Region 9: SSS sigmaS + Henyey-Greenstein g. sigmaS==0 marks glass (Beer-Lambert path, not random walk).
export const readSSSMedium = ( buf, id ) => {

	const v = buf.element( soa( id, RAY.SSS_SIGMA_S ) );
	return { sigmaS: v.xyz, g: v.w };

};

export const writeSSSMedium = ( buf, id, sigmaS, g ) =>
	buf.element( soa( id, RAY.SSS_SIGMA_S ) ).assign( vec4( sigmaS, g ) );
