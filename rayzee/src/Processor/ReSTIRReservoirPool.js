/**
 * ReSTIRReservoirPool.js
 *
 * Owns the per-pixel reservoir storage for ReSTIR DI. One large StorageBuffer
 * holding two ping-pong slots per pixel — frame N reads from the slot parity
 * opposite to the one it writes. Single-buffer layout keeps the storage-buffer
 * binding count to 1 on the main compute kernel.
 *
 * Layout per pixel (2 vec4 slots = 32 bytes):
 *   slot 0 at offset (pixelIdx * 2):     current or previous (based on frameParity)
 *   slot 1 at offset (pixelIdx * 2 + 1): the other
 * Each slot encodes: .x = lightSampleId, .y = reservoirWeight, .z = sumOfWeights,
 * .w = packed(M, visibility, frameAge).
 *
 * Frame parity (0|1) is an int uniform. Shader reads slot (parity ^ 1), writes slot parity.
 *
 * Lazy allocation: a 1-vec4 stub is created up-front so the TSL storage node exists
 * at shader-compile time. activate(width, height) upgrades to the full-size allocation
 * (~63 MB at 1920x1080). Kept as a stub while the enableReSTIR flag is false so VRAM
 * isn't spent on an unused feature.
 *
 * Lifecycle is non-RenderStage: this is a pure buffer manager like StorageTexturePool.
 * The owning stage (PathTracer) calls setSize/activate/swap/clear.
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage, uniform } from 'three/tsl';
import { Vector2 } from 'three';

// Each slot = 2 vec4s: core (lightSampleId/W/sumW/M) + aux (visibility/frameAge/pad/pad).
const VEC4S_PER_SLOT = 2;
const SLOTS_PER_PIXEL = 2;
const FLOATS_PER_VEC4 = 4;

export class ReSTIRReservoirPool {

	constructor( width = 0, height = 0 ) {

		this.width = 0;
		this.height = 0;
		this.attr = null;
		this.node = null;

		this._activated = false;
		this._frameParity = 0;

		// Uniforms the shader reads. Pool owns these so the graph binding is stable.
		this.frameParityUniform = uniform( 0, 'int' );
		this.resolutionUniform = uniform( new Vector2( 0, 0 ), 'vec2' );

		// Allocate the stub at construction so storage() has a valid attribute
		// to reference. Real-size allocation is deferred to activate().
		this._createStub();

		if ( width > 0 && height > 0 ) {

			this.setSize( width, height );

		}

	}

	_createStub() {

		const array = new Float32Array( FLOATS_PER_VEC4 );
		this.attr = new StorageInstancedBufferAttribute( array, FLOATS_PER_VEC4 );
		this.node = storage( this.attr, 'vec4', 1 );

	}

	/**
	 * Record the render size. If the pool is already activated, reallocate
	 * immediately. Otherwise the size is remembered and applied on first activate().
	 */
	setSize( width, height ) {

		if ( this.width === width && this.height === height ) return;

		this.width = width;
		this.height = height;
		this.resolutionUniform.value.set( width, height );

		if ( this._activated ) {

			this._allocateFullSize();

		}

	}

	/**
	 * Upgrade the stub to a real-size allocation (~63 MB at 1080p). Call this
	 * when ReSTIR is being turned on. Idempotent — subsequent calls no-op
	 * unless the size changed.
	 */
	activate() {

		if ( this._activated && this.attr && this.attr.array.length > FLOATS_PER_VEC4 ) {

			return;

		}

		if ( this.width === 0 || this.height === 0 ) {

			console.warn( 'ReSTIRReservoirPool.activate called before setSize — deferring.' );
			this._activated = true;
			return;

		}

		this._allocateFullSize();
		this._activated = true;

	}

	_allocateFullSize() {

		const vec4Count = this.width * this.height * VEC4S_PER_SLOT * SLOTS_PER_PIXEL;
		const array = new Float32Array( vec4Count * FLOATS_PER_VEC4 );
		this.attr = new StorageInstancedBufferAttribute( array, FLOATS_PER_VEC4 );

		// Preserve shader-graph node reference — point it at the new attribute.
		this.node.value = this.attr;
		this.node.bufferCount = vec4Count;

	}

	/**
	 * Toggle ping-pong parity. Call once per frame, after the compute dispatch.
	 */
	swap() {

		this._frameParity = 1 - this._frameParity;
		this.frameParityUniform.value = this._frameParity;

	}

	/**
	 * Reset reservoir contents to zero — called on pipeline:reset (camera move,
	 * light edit, material edit). Parity is NOT reset; it's independent bookkeeping.
	 */
	clear() {

		if ( ! this.attr ) return;
		this.attr.array.fill( 0 );
		this.attr.needsUpdate = true;

	}

	/**
	 * Get the TSL storage node for shader-graph binding. Stable reference across
	 * frames and across stub-to-full reallocation (node.value is updated in place).
	 */
	getStorageNode() {

		return this.node;

	}

	getFrameParity() {

		return this._frameParity;

	}

	isActivated() {

		return this._activated;

	}

	getStats() {

		return {
			activated: this._activated,
			width: this.width,
			height: this.height,
			bytes: this._activated
				? this.width * this.height * VEC4S_PER_SLOT * SLOTS_PER_PIXEL * FLOATS_PER_VEC4 * 4
				: FLOATS_PER_VEC4 * 4,
		};

	}

	dispose() {

		this.attr = null;
		this.node = null;
		this._activated = false;

	}

}
