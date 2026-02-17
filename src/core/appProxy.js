/**
 * App Proxy — Unified Access to the Active Backend
 *
 * Provides a single entry point (`getApp()`) for all store handlers,
 * services, and UI components to access the currently active path
 * tracer app (WebGL or WebGPU) without coupling to
 * `window.pathTracerApp` or knowing the current backend.
 *
 * Usage:
 *   import { getApp, getBackend, supportsFeature } from '@/core/appProxy';
 *
 *   const app = getApp();
 *   if ( app ) app.setMaxBounces( 8 );
 *
 *   if ( supportsFeature( 'bloom' ) ) { ... }
 *
 * @module appProxy
 */

import { getBackendManager, BackendType } from './BackendManager.js';

/**
 * Returns the currently active path tracer app instance, or null.
 *
 * Prefers `BackendManager.getCurrentApp()` when available, with
 * `window.pathTracerApp` as a fallback during early initialization.
 *
 * @returns {import('./IPathTracerApp').IPathTracerApp | null}
 */
export function getApp() {

	const manager = getBackendManager();
	const app = manager.getCurrentApp();

	if ( app && app.isInitialized ) return app;

	// Fallback — during early init the manager may not yet have apps registered
	if ( window.pathTracerApp?.isInitialized ) return window.pathTracerApp;

	return null;

}

/**
 * Returns the current backend type string ('webgl' | 'webgpu').
 * @returns {string}
 */
export function getBackend() {

	return getBackendManager().getBackend();

}

/**
 * Checks whether the *active* backend supports a given feature.
 *
 * @param {string} featureName - Feature key (e.g. 'bloom', 'asvgf', 'lights')
 * @returns {boolean}
 */
export function supportsFeature( featureName ) {

	const app = getApp();
	if ( app && typeof app.supportsFeature === 'function' ) {

		return app.supportsFeature( featureName );

	}

	return false;

}

/**
 * Convenience: is the current backend WebGL?
 * @returns {boolean}
 */
export function isWebGL() {

	return getBackend() === BackendType.WEBGL;

}

/**
 * Convenience: is the current backend WebGPU?
 * @returns {boolean}
 */
export function isWebGPU() {

	return getBackend() === BackendType.WEBGPU;

}
