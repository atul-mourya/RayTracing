/**
 * Lightweight Three.js stubs for unit testing.
 * Only includes what's actually used by tested modules.
 */

export class Vector2 {

	constructor( x = 0, y = 0 ) {

		this.x = x;
		this.y = y;

	}

	copy( v ) {

		this.x = v.x;
		this.y = v.y;
		return this;

	}

	equals( v ) {

		return this.x === v.x && this.y === v.y;

	}

}

export class Vector3 {

	constructor( x = 0, y = 0, z = 0 ) {

		this.x = x;
		this.y = y;
		this.z = z;

	}

	copy( v ) {

		this.x = v.x;
		this.y = v.y;
		this.z = v.z;
		return this;

	}

	equals( v ) {

		return this.x === v.x && this.y === v.y && this.z === v.z;

	}

}

export class Vector4 {

	constructor( x = 0, y = 0, z = 0, w = 0 ) {

		this.x = x;
		this.y = y;
		this.z = z;
		this.w = w;

	}

	copy( v ) {

		this.x = v.x;
		this.y = v.y;
		this.z = v.z;
		this.w = v.w;
		return this;

	}

	equals( v ) {

		return this.x === v.x && this.y === v.y && this.z === v.z && this.w === v.w;

	}

}

export class Matrix4 {

	constructor() {

		this.elements = new Float32Array( [
			1, 0, 0, 0,
			0, 1, 0, 0,
			0, 0, 1, 0,
			0, 0, 0, 1,
		] );

	}

	copy( m ) {

		this.elements.set( m.elements );
		return this;

	}

	equals( m ) {

		for ( let i = 0; i < 16; i ++ ) {

			if ( this.elements[ i ] !== m.elements[ i ] ) return false;

		}

		return true;

	}

}

export class Color {

	constructor( r = 0, g = 0, b = 0 ) {

		this.r = r;
		this.g = g;
		this.b = b;

	}

}

export class Texture {

	constructor() {

		this.image = null;

	}

}

export class EventDispatcher {

	constructor() {

		this._listeners = {};

	}

	addEventListener( type, listener ) {

		if ( ! this._listeners[ type ] ) {

			this._listeners[ type ] = [];

		}

		if ( ! this._listeners[ type ].includes( listener ) ) {

			this._listeners[ type ].push( listener );

		}

	}

	removeEventListener( type, listener ) {

		if ( ! this._listeners[ type ] ) return;
		const idx = this._listeners[ type ].indexOf( listener );
		if ( idx > - 1 ) this._listeners[ type ].splice( idx, 1 );

	}

	hasEventListener( type, listener ) {

		return this._listeners[ type ] !== undefined &&
			this._listeners[ type ].includes( listener );

	}

	dispatchEvent( event ) {

		if ( ! this._listeners[ event.type ] ) return;
		const listeners = this._listeners[ event.type ].slice();
		for ( const listener of listeners ) {

			listener( event );

		}

	}

}

export class ShaderMaterial {

	constructor( params = {} ) {

		Object.assign( this, params );

	}

}

export const GLSL3 = 'GLSL3';
