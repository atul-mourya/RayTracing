// __APP_VERSION__ is injected at build time by Vite (see vite.config.js).
// It reads from VITE_APP_VERSION env var if set, otherwise from root package.json.
// This ensures consistent version display regardless of deployment source.

/* global __APP_VERSION__ */
export const appVersion = __APP_VERSION__ === '0.0.0' ? 'dev' : __APP_VERSION__;

export function logVersion() {

	console.log( `Application version: ${appVersion}` );

}

export function isVersionSet() {

	return __APP_VERSION__ !== '0.0.0';

}
