// __APP_VERSION__ is injected at build time by Vite (see vite.config.js).
// CI: set via VITE_APP_VERSION from semantic-release-export-data plugin.
// Local dev / fallback: read from rayzee/package.json.

/* global __APP_VERSION__ */
export const appVersion = __APP_VERSION__;

export function logVersion() {

	console.log( `Application version: ${appVersion}` );

}
