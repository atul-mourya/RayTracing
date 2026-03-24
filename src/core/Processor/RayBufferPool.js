/**
 * RayBufferPool.js
 *
 * Structure-of-Arrays (SoA) storage buffer manager for wavefront path tracing.
 * Each logical field (ray origin, direction, throughput, etc.) occupies its own
 * contiguous GPU storage buffer, enabling coalesced access patterns.
 *
 * Uses Three.js TSL `attributeArray()` for buffer creation and `.element(idx)`
 * for per-ray access in compute shaders.
 *
 * Buffer sizing: over-allocates ×1.25 rounded to next power-of-2 to avoid
 * shader recompilation on minor resolution changes.
 */

import { attributeArray } from 'three/tsl';

/**
 * Round up to the next power of 2.
 * @param {number} v
 * @returns {number}
 */
function nextPowerOf2( v ) {

	v --;
	v |= v >> 1;
	v |= v >> 2;
	v |= v >> 4;
	v |= v >> 8;
	v |= v >> 16;
	return v + 1;

}

/**
 * Buffer descriptor: defines a single SoA field.
 * @typedef {Object} BufferDescriptor
 * @property {string} name - Logical name (e.g. 'rayOrigin')
 * @property {string} type - TSL type ('float', 'vec2', 'vec3', 'vec4', 'uint', 'uvec4')
 * @property {boolean} [atomic] - Whether this buffer needs atomic access
 */

/**
 * All ray buffer fields. Using vec4 throughout for WGSL alignment safety.
 * Fields marked with a comment show what the .w component stores (if anything).
 */
const RAY_BUFFER_FIELDS = [
	{ name: 'rayOrigin', type: 'vec4' }, // xyz = origin, w = unused
	{ name: 'rayDirection', type: 'vec4' }, // xyz = direction, w = unused
	{ name: 'rayThroughput', type: 'vec4' }, // xyz = throughput, w = unused
	{ name: 'rayRadiance', type: 'vec4' }, // xyz = radiance, w = alpha
	{ name: 'rayPixelIndex', type: 'uint' }, // flat pixel index (y * width + x)
	{ name: 'rayRngState', type: 'uvec4' }, // 4x u32 PCG state for decorrelated streams
	{ name: 'rayBounceFlags', type: 'uint' }, // bits 0-7: bounce, bit 8: active, bit 9: specular, bit 10: inside medium, bits 11-15: ray type
	{ name: 'rayPdf', type: 'float' }, // PDF of last sampled direction (for MIS)
	{ name: 'rayLastNormal', type: 'vec4' }, // xyz = surface normal at last hit, w = unused
];

const HIT_BUFFER_FIELDS = [
	{ name: 'hitDistance', type: 'float' }, // Ray parameter t (1e30 = miss)
	{ name: 'hitTriangleIndex', type: 'uint' }, // Index into triangle data
	{ name: 'hitBarycentrics', type: 'vec2' }, // Barycentric coordinates (u, v)
	{ name: 'hitMaterialMesh', type: 'uvec2' }, // x = materialIndex, y = meshIndex
	{ name: 'hitGeometricNormal', type: 'vec4' }, // xyz = face normal, w = unused
];

const SHADOW_BUFFER_FIELDS = [
	{ name: 'shadowOrigin', type: 'vec4' }, // xyz = origin, w = unused
	{ name: 'shadowDirection', type: 'vec4' }, // xyz = direction, w = unused
	{ name: 'shadowMaxDist', type: 'float' }, // Maximum distance to light
	{ name: 'shadowPendingRadiance', type: 'vec4' }, // xyz = radiance to add if unoccluded, w = unused
	{ name: 'shadowParentRayID', type: 'uint' }, // Links back to parent path
];

const FIRST_HIT_FIELDS = [
	{ name: 'firstHitNormalDepth', type: 'vec4' }, // xyz = normal * 0.5 + 0.5, w = linear depth
	{ name: 'firstHitAlbedo', type: 'vec4' }, // xyz = albedo, w = objectID
];

/**
 * Visibility result per shadow ray (0 = occluded, 1 = visible).
 */
const VISIBILITY_FIELD = [
	{ name: 'shadowVisibility', type: 'uint' },
];

export class RayBufferPool {

	/**
	 * @param {number} maxRays - Maximum number of rays (typically width * height)
	 */
	constructor( maxRays = 0 ) {

		/**
		 * Actual allocated capacity (over-allocated + power-of-2 rounded).
		 * @type {number}
		 */
		this.allocatedCapacity = 0;

		/**
		 * Requested max rays (before over-allocation).
		 * @type {number}
		 */
		this.requestedMaxRays = 0;

		/**
		 * Map of buffer name → { rw: StorageBufferNode, ro: StorageBufferNode }
		 * rw = read-write node (for kernels that write)
		 * ro = read-only node (for kernels that only read)
		 * @type {Map<string, {rw: StorageBufferNode, ro: StorageBufferNode}>}
		 */
		this.buffers = new Map();

		/**
		 * Total allocated bytes for logging.
		 * @type {number}
		 */
		this.totalBytes = 0;

		if ( maxRays > 0 ) {

			this.allocate( maxRays );

		}

	}

	/**
	 * Allocate all SoA buffers for the given ray count.
	 * @param {number} maxRays
	 */
	allocate( maxRays ) {

		this.dispose();

		this.requestedMaxRays = maxRays;

		// Over-allocate ×1.25 and round to next power-of-2
		const capacity = nextPowerOf2( Math.ceil( maxRays * 1.25 ) );
		this.allocatedCapacity = capacity;

		this.totalBytes = 0;

		// Create all buffer groups
		this._createBufferGroup( RAY_BUFFER_FIELDS, capacity );
		this._createBufferGroup( HIT_BUFFER_FIELDS, capacity );
		this._createBufferGroup( SHADOW_BUFFER_FIELDS, capacity );
		this._createBufferGroup( FIRST_HIT_FIELDS, capacity );
		this._createBufferGroup( VISIBILITY_FIELD, capacity );

		console.log(
			`RayBufferPool: Allocated ${this.buffers.size} buffers, ` +
			`capacity=${capacity} rays (requested=${maxRays}), ` +
			`total=${( this.totalBytes / ( 1024 * 1024 ) ).toFixed( 1 )} MB`
		);

	}

	/**
	 * Resize buffers if the new maxRays exceeds current capacity.
	 * Returns true if reallocation occurred (requires shader recompilation).
	 * @param {number} maxRays
	 * @returns {boolean}
	 */
	resize( maxRays ) {

		if ( maxRays <= this.allocatedCapacity && this.allocatedCapacity > 0 ) {

			this.requestedMaxRays = maxRays;
			return false;

		}

		this.allocate( maxRays );
		return true;

	}

	/**
	 * Get the read-write storage buffer node for a field.
	 * @param {string} name - Buffer field name (e.g. 'rayOrigin')
	 * @returns {StorageBufferNode}
	 */
	getRW( name ) {

		const entry = this.buffers.get( name );
		if ( ! entry ) throw new Error( `RayBufferPool: Unknown buffer '${name}'` );
		return entry.rw;

	}

	/**
	 * Get the read-only storage buffer node for a field.
	 * @param {string} name - Buffer field name (e.g. 'rayOrigin')
	 * @returns {StorageBufferNode}
	 */
	getRO( name ) {

		const entry = this.buffers.get( name );
		if ( ! entry ) throw new Error( `RayBufferPool: Unknown buffer '${name}'` );
		return entry.ro;

	}

	/**
	 * Get all ray buffer nodes (both RW and RO) as a flat object.
	 * Useful for passing into TSL kernel builders.
	 * @returns {Object} e.g. { rayOriginRW, rayOriginRO, rayDirectionRW, ... }
	 */
	getAllNodes() {

		const result = {};

		for ( const [ name, entry ] of this.buffers ) {

			result[ name + 'RW' ] = entry.rw;
			result[ name + 'RO' ] = entry.ro;

		}

		return result;

	}

	/**
	 * Get nodes grouped by category.
	 * @returns {{ ray: Object, hit: Object, shadow: Object, firstHit: Object, visibility: Object }}
	 */
	getGroupedNodes() {

		const grouped = { ray: {}, hit: {}, shadow: {}, firstHit: {}, visibility: {} };

		for ( const [ name, entry ] of this.buffers ) {

			let group;
			if ( name.startsWith( 'ray' ) ) group = 'ray';
			else if ( name.startsWith( 'hit' ) ) group = 'hit';
			else if ( name.startsWith( 'shadow' ) ) group = 'shadow';
			else if ( name.startsWith( 'firstHit' ) ) group = 'firstHit';
			else group = 'visibility';

			grouped[ group ][ name + 'RW' ] = entry.rw;
			grouped[ group ][ name + 'RO' ] = entry.ro;

		}

		return grouped;

	}

	/**
	 * @returns {number} Allocated capacity in rays
	 */
	getCapacity() {

		return this.allocatedCapacity;

	}

	dispose() {

		// attributeArray creates StorageBufferAttribute internally.
		// The node itself doesn't have a dispose() but the underlying
		// buffer attribute does via the buffer property.
		this.buffers.clear();
		this.allocatedCapacity = 0;
		this.totalBytes = 0;

	}

	// --- Private ---

	/**
	 * Create storage buffer nodes for a group of field descriptors.
	 * @param {BufferDescriptor[]} fields
	 * @param {number} capacity
	 * @private
	 */
	_createBufferGroup( fields, capacity ) {

		for ( const field of fields ) {

			const rw = attributeArray( capacity, field.type );
			const ro = attributeArray( capacity, field.type ).toReadOnly();

			if ( field.atomic ) {

				rw.toAtomic();

			}

			this.buffers.set( field.name, { rw, ro } );

			// Estimate bytes
			const bytesPerElement = this._getBytesPerElement( field.type );
			this.totalBytes += capacity * bytesPerElement;

		}

	}

	/**
	 * Get bytes per element for a TSL type.
	 * @param {string} type
	 * @returns {number}
	 * @private
	 */
	_getBytesPerElement( type ) {

		switch ( type ) {

			case 'float': return 4;
			case 'uint': return 4;
			case 'int': return 4;
			case 'vec2': return 8;
			case 'uvec2': return 8;
			case 'vec3': return 12;
			case 'vec4': return 16;
			case 'uvec4': return 16;
			default: return 16;

		}

	}

}

// Export field descriptors for external use (e.g. BufferAccess helpers)
export { RAY_BUFFER_FIELDS, HIT_BUFFER_FIELDS, SHADOW_BUFFER_FIELDS, FIRST_HIT_FIELDS, VISIBILITY_FIELD };
