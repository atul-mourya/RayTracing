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
const _listeners = new Set();

/**
 * Registers the app instance and notifies subscribers.
 * @param {object} app - The path tracer app
 */
export function setApp( app ) {

	_app = app;
	_listeners.forEach( fn => fn( getApp() ) );

}

/**
 * Subscribe to app changes. Returns an unsubscribe function.
 * @param {function} fn - Callback receiving the app instance (or null)
 * @returns {function} Unsubscribe function
 */
export function subscribeApp( fn ) {

	_listeners.add( fn );
	return () => _listeners.delete( fn );

}

/**
 * Returns the path tracer app instance, or null.
 * @returns {object | null}
 */
export function getApp() {

	if ( _app?.isInitialized ) return _app;

	return null;

}
