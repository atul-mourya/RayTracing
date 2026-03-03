/**
 * App Proxy — Unified Access to the Path Tracer App
 *
 * Provides a single entry point (`getApp()`) for all store handlers,
 * services, and UI components to access the path tracer app.
 *
 * Usage:
 *   import { getApp } from '@/core/appProxy';
 *
 *   const app = getApp();
 *   if ( app ) app.setMaxBounces( 8 );
 *
 * @module appProxy
 */

let _app = null;

/**
 * Registers the app instance.
 * @param {object} app - The path tracer app
 */
export function setApp( app ) {

	_app = app;

}

/**
 * Returns the path tracer app instance, or null.
 * @returns {object | null}
 */
export function getApp() {

	if ( _app?.isInitialized ) return _app;

	return null;

}
