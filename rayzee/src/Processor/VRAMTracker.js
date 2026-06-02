/**
 * VRAMTracker.js — current/peak GPU memory accounting.
 *
 * Measures ACTUAL live bytes (attribute.array.byteLength, texture dims × format/type)
 * rather than re-deriving allocation formulas, so it never drifts when strides,
 * capacity rounding, or layouts change. Providers are thunks that read current state,
 * so they survive reallocation (resize, scene/material/env reload). A per-pass WeakSet
 * dedupes by resource identity, so overlapping registrations never double-count.
 */

import {
	RGBAFormat, RGBFormat, RGFormat, RedFormat,
	FloatType, HalfFloatType, UnsignedByteType, ByteType,
	UnsignedShortType, ShortType, UnsignedIntType, IntType,
} from 'three';

const CHANNELS = { [ RGBAFormat ]: 4, [ RGBFormat ]: 3, [ RGFormat ]: 2, [ RedFormat ]: 1 };
const TYPE_BYTES = {
	[ FloatType ]: 4, [ HalfFloatType ]: 2,
	[ UnsignedByteType ]: 1, [ ByteType ]: 1,
	[ UnsignedShortType ]: 2, [ ShortType ]: 2,
	[ UnsignedIntType ]: 4, [ IntType ]: 4,
};

function texelBytes( tex ) {

	return ( CHANNELS[ tex.format ] ?? 4 ) * ( TYPE_BYTES[ tex.type ] ?? 4 );

}

/** Exact byte size of a storage/buffer attribute's backing typed array. */
export function bufferBytes( attr ) {

	return attr?.array?.byteLength || 0;

}

/** Estimated GPU byte size of a Texture/StorageTexture/DataArrayTexture/RenderTarget. */
export function textureBytes( tex ) {

	if ( ! tex ) return 0;

	if ( tex.isRenderTarget ) {

		const list = tex.textures?.length ? tex.textures : [ tex.texture ];
		const w = tex.width || 0, h = tex.height || 0, d = tex.depth || 1;
		let sum = 0;
		for ( const t of list ) if ( t ) sum += w * h * d * texelBytes( t );
		return sum;

	}

	const img = tex.image || {};
	const w = img.width ?? tex.width ?? 0;
	const h = img.height ?? tex.height ?? 0;
	const d = img.depth ?? 1;
	return w * h * d * texelBytes( tex );

}

export class VRAMTracker {

	constructor() {

		this._providers = [];
		this.current = 0;
		this.peak = 0;
		this.byCategory = {};

	}

	/**
	 * @param {string} category - grouping label in the report
	 * @param {Function} fn - returns a resource or array of resources: buffer
	 *   attributes (`.array`), textures/render targets (`.isTexture`/`.isRenderTarget`),
	 *   or synthetic `{ bytes }` for sizes with no inspectable object. Return falsy to skip.
	 */
	register( category, fn ) {

		this._providers.push( { category, fn } );

	}

	measure() {

		const seen = new WeakSet();
		const byCategory = {};
		let total = 0;

		for ( const { category, fn } of this._providers ) {

			let resources;
			try {

				resources = fn();

			} catch {

				resources = null;

			}

			if ( ! resources ) continue;

			let bytes = 0;
			for ( const r of ( Array.isArray( resources ) ? resources : [ resources ] ) ) {

				bytes += this._resourceBytes( r, seen );

			}

			byCategory[ category ] = ( byCategory[ category ] || 0 ) + bytes;
			total += bytes;

		}

		this.byCategory = byCategory;
		this.current = total;
		if ( total > this.peak ) this.peak = total;

		return { current: total, peak: this.peak, byCategory };

	}

	_resourceBytes( r, seen ) {

		if ( ! r ) return 0;

		// synthetic { bytes } (e.g. attributeArray-backed histograms)
		if ( typeof r.bytes === 'number' && ! r.isTexture && ! r.isRenderTarget ) return r.bytes;

		// buffer attribute — dedupe by backing array (rw/ro nodes share one buffer)
		if ( r.array && r.array.byteLength != null ) {

			if ( seen.has( r.array ) ) return 0;
			seen.add( r.array );
			return r.array.byteLength;

		}

		// texture / render target — dedupe by object identity
		if ( r.isRenderTarget || r.isTexture ) {

			if ( seen.has( r ) ) return 0;
			seen.add( r );
			return textureBytes( r );

		}

		return 0;

	}

	/** Drop the high-water mark to the current value (call when a new render begins). */
	resetPeak() {

		this.peak = this.current;

	}

	getReport() {

		const mb = ( b ) => ( b / 1048576 ).toFixed( 1 );
		const parts = Object.entries( this.byCategory ).map( ( [ k, v ] ) => `${k}=${mb( v )}` );
		return `VRAM current=${mb( this.current )}MB peak=${mb( this.peak )}MB [${parts.join( ' ' )}]`;

	}

}
