/**
 * Monkey-patch to disable WGSL global-variable promotion for compute shaders.
 *
 * Three.js r184 introduced `WGSLNodeBuilder.allowGlobalVariables = true` which
 * emits `.toVar()` declarations at WGSL module scope as `var<private> name : T`
 * instead of function-local `var name : T` inside `fn main()` (as r183 did).
 *
 * For shaders with hundreds of `.toVar()` calls inside loops (e.g. our BVH
 * traversal + BRDF path tracer), `var<private>` increases GPU register pressure
 * because the Dawn/Chromium WGSL compiler cannot aggressively register-allocate
 * variables with a stable per-invocation memory address. We measured a ~8% fps
 * regression (120 → 110) on the path tracer after upgrading r183 → r184 that
 * traced entirely to GPU execution, not CPU.
 *
 * This patch wraps `WebGPUBackend.createNodeBuilder` so every newly constructed
 * node builder reports `allowGlobalVariables = false`, restoring r183's
 * function-scoped `var` emission inside `fn main()`. No behavior change —
 * WGSL spec guarantees `var<private>` and function-local `var` are semantically
 * equivalent for per-invocation storage; only the compiler's register-allocation
 * latitude differs.
 *
 * Relevant upstream lines:
 *  - `node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js:247`
 *    (`this.allowGlobalVariables = true`)
 *  - `...WGSLNodeBuilder.js:2458` (module-scope vars block)
 *  - `...WGSLNodeBuilder.js:2467` (function-body vars block)
 *
 * Revisit if upstream adds an official opt-out or fixes register pressure.
 * Import this module once at app startup (side-effect only).
 */

import { WebGPUBackend } from 'three/webgpu';

const _origCreateNodeBuilder = WebGPUBackend.prototype.createNodeBuilder;

// WGSLNodeBuilder's `allowGlobalVariables` switch is ONLY consumed by the
// compute-shader template (see `_getWGSLComputeCode`). The vertex/fragment
// templates always emit `shaderData.vars` at module scope and therefore
// REQUIRE `allowGlobalVariables=true` (emitting function-local `var` at
// module scope is invalid WGSL and crashes pipeline creation with
// "Invalid ShaderModule"). We install a per-instance accessor that returns
// `false` only when the builder is for a compute node (material === null)
// and `true` otherwise, so render pipelines keep r184 behavior untouched.
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
