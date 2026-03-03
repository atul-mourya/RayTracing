/**
 * Proxy-enhanced struct factory for TSL.
 *
 * TSL structs require `.get('fieldName')` for member access, but GLSL-style
 * dot notation (`.fieldName`) is more natural and matches the ported code.
 *
 * This utility wraps TSL's `struct()` so that:
 * - Direct construction: `MyStruct({...}).toVar('x')` → `.fieldName` works automatically
 * - Fn return values: `MyStruct.wrap(someFn(...))` → `.fieldName` works automatically
 *
 * Internally, property access for known struct member names is redirected to `.get('name')`.
 * Swizzle properties (x, y, z, w, etc.), Node methods (.add, .assign, etc.), and other
 * standard properties pass through to the underlying node unmodified.
 */

import { struct as _struct } from 'three/tsl';

/**
 * Creates a Proxy around a TSL node that redirects struct member access to `.get('name')`.
 * Also intercepts `.toVar()` to ensure the resulting VarNode is also proxy-wrapped.
 */
function createStructProxy( node, memberSet ) {

	return new Proxy( node, {

		get( target, prop, receiver ) {

			// Intercept known struct member names
			if ( typeof prop === 'string' && memberSet.has( prop ) ) {

				return target.get( prop );

			}

			const val = Reflect.get( target, prop, receiver );

			// Intercept .toVar() to proxy-wrap the result
			if ( prop === 'toVar' && typeof val === 'function' ) {

				return ( ...args ) => createStructProxy( val.apply( target, args ), memberSet );

			}

			return val;

		}

	} );

}

/**
 * Drop-in replacement for TSL's `struct()` that returns a proxy-enhanced factory.
 *
 * The returned factory:
 * - Creates struct nodes where `.toVar()` results support dot-notation field access
 * - Has `.wrap(node)` method to proxy-wrap Fn return values for field access
 * - Has `.layout` and `.isStruct` matching the original TSL struct API
 *
 * @param {Object} members - Struct member layout (e.g., { didHit: 'bool', dst: 'float' })
 * @param {string|null} name - Optional struct name
 * @returns {Function} Enhanced struct factory
 */
export function struct( members, name = null ) {

	const factory = _struct( members, name );
	const memberSet = new Set( Object.keys( members ) );

	const wrappedFactory = ( ...args ) => {

		const node = factory( ...args );
		return createStructProxy( node, memberSet );

	};

	wrappedFactory.layout = factory.layout;
	wrappedFactory.isStruct = true;

	/**
	 * Wrap an existing node (e.g., Fn return value) with struct field access proxy.
	 * Usage: `const hit = HitInfo.wrap(traverseBVH(...).toVar('hit'));`
	 */
	wrappedFactory.wrap = ( node ) => createStructProxy( node, memberSet );

	return wrappedFactory;

}
