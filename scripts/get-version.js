import { execSync } from 'child_process';

function getVersionFromGit() {

	try {

		// Get the most recent tag
		const tag = execSync( 'git describe --tags --abbrev=0' ).toString().trim();
		// Remove 'v' prefix if it exists
		return tag.startsWith( 'v' ) ? tag.slice( 1 ) : tag;

	} catch ( error ) {

		console.warn( 'Could not determine version from git tags:', error );
		return '0.0.0';

	}

}

export default getVersionFromGit;
