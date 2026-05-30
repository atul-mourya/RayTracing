import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname( fileURLToPath( import.meta.url ) );
const bundlePath = resolve( here, '..', 'dist', 'rayzee.es.js' );
const readmes = [
	resolve( here, '..', 'README.md' ),
	resolve( here, '..', '..', 'README.md' ),
];

const gzipped = gzipSync( readFileSync( bundlePath ) ).length;
const kb = ( gzipped / 1024 ).toFixed( 1 ).replace( /\.0$/, '' );

// Matches: https://img.shields.io/badge/minzipped-<anything>-blue
const badgeRe = /(https:\/\/img\.shields\.io\/badge\/minzipped-)[^-)\s]+(-blue)/g;
const replacement = `$1${ kb }%20KB$2`;

let updated = 0;
for ( const path of readmes ) {

	const src = readFileSync( path, 'utf8' );
	const next = src.replace( badgeRe, replacement );
	if ( next !== src ) {

		writeFileSync( path, next );
		updated ++;

	}

}

console.log( `[size-badge] ${ kb } KB gzipped — patched ${ updated } README(s)` );
