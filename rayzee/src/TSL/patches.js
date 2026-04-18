/**
 * Rayzee patches for Three.js / TSL.
 *
 * Side-effect on import: installs `WebGPUBackend.createNodeBuilder` override
 * (restores r183 function-scoped `var` emission for compute shaders — prevents
 * a register-allocation regression in the path tracer's hot loop).
 *
 * Export: `struct()` — drop-in replacement for TSL's `struct()` returning
 * a proxy factory that supports GLSL-style dot-notation field access.
 */

import { WebGPUBackend } from 'three/webgpu';
import { struct as _struct } from 'three/tsl';

// ---------------------------------------------------------------------------
// 1. WGSL global-variable promotion patch (compute-only)
// ---------------------------------------------------------------------------
// Three.js r184 introduced `WGSLNodeBuilder.allowGlobalVariables = true`, which
// emits `.toVar()` declarations at WGSL module scope as `var<private> name : T`
// instead of function-local `var name : T` inside `fn main()` (as r183 did).
//
// For compute shaders with hundreds of `.toVar()` calls in loops (e.g. the BVH
// traversal + BRDF path tracer), `var<private>` increases GPU register pressure
// because the Dawn/Chromium WGSL compiler cannot aggressively register-allocate
// variables with a stable per-invocation memory address. We measured a ~8% fps
// regression (120 → 110) on the path tracer after upgrading r183 → r184 that
// traced entirely to GPU execution, not CPU.
//
// `allowGlobalVariables` is ONLY consumed by the compute template
// (`_getWGSLComputeCode`). The vertex/fragment templates always emit
// `shaderData.vars` at module scope and REQUIRE `allowGlobalVariables=true`
// (emitting function-local `var` at module scope is invalid WGSL and crashes
// pipeline creation with "Invalid ShaderModule"). We install a per-instance
// accessor that returns `false` only when the builder is for a compute node
// (material === null) and `true` otherwise, so render pipelines keep r184
// behavior untouched.
//
// Relevant upstream lines:
//  - `node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js:247`
//    (`this.allowGlobalVariables = true`)
//  - `...WGSLNodeBuilder.js:2458` (module-scope vars block)
//  - `...WGSLNodeBuilder.js:2467` (function-body vars block)
//
// Revisit if upstream adds an official opt-out or fixes register pressure.

const _origCreateNodeBuilder = WebGPUBackend.prototype.createNodeBuilder;

WebGPUBackend.prototype.createNodeBuilder = function ( object, renderer ) {

	const builder = _origCreateNodeBuilder.call( this, object, renderer );

	Object.defineProperty( builder, 'allowGlobalVariables', {
		get() {

			return this.material !== null;

		},
		set() { /* ignore — the value is derived from material presence */ },
		configurable: true,
	} );

	return builder;

};

// ---------------------------------------------------------------------------
// 2. TSL struct proxy — enables GLSL-style dot-notation field access
// ---------------------------------------------------------------------------
// TSL structs require `.get('fieldName')` for member access, but GLSL-style
// dot notation (`.fieldName`) is more natural and matches ported code.
//
// This wraps TSL's `struct()` so that:
//  - Direct construction: `MyStruct({...}).toVar('x')` → `.fieldName` works
//  - Fn return values:    `MyStruct.wrap(someFn(...))` → `.fieldName` works
//
// Property access for known struct member names is redirected to `.get('name')`.
// Swizzle properties (x, y, z, w, etc.), Node methods (.add, .assign, etc.), and
// other standard properties pass through to the underlying node unmodified.

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
 *  - Creates struct nodes where `.toVar()` results support dot-notation field access
 *  - Has `.wrap(node)` method to proxy-wrap Fn return values for field access
 *  - Has `.layout` and `.isStruct` matching the original TSL struct API
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
