// Import package.json to access the version
import packageJson from '../../package.json';

// Export the version for use throughout the application
export const appVersion = packageJson.version === '0.0.0' ? 'dev' : packageJson.version;

// Function to log the version to console
export function logVersion() {

	console.log( `Application version: ${appVersion}` );
	console.log( `Raw package.json version: ${packageJson.version}` );

}

// Function to check if version is the default unset version
export function isVersionSet() {

	return packageJson.version !== '0.0.0';

}
