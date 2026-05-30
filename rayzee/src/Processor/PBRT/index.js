/**
 * PBRT-v4 scene loader.
 *
 * Orchestrates: virtual filesystem (from a zip) → tokenize/parse the entry
 * .pbrt (following Include/Import) → build a THREE scene graph. Geometry,
 * image, and HDR decoding are injected by the host (AssetLoader owns the
 * three/examples loaders) so this module stays dependency-light.
 *
 * Usage (from AssetLoader):
 *   const { group, environment, warnings } = await loadPBRTScene({
 *     vfs, entryPath, plyParser, imageFromBytes, envFromBytes
 *   });
 *   scene.environment = environment?.texture ?? scene.environment;
 *   await loadObject3D(group);
 */

import { PBRTParser } from './PBRTParser.js';
import { PBRTSceneBuilder } from './PBRTSceneBuilder.js';

export { PBRTParser } from './PBRTParser.js';
export { PBRTSceneBuilder } from './PBRTSceneBuilder.js';
export { tokenize } from './PBRTTokenizer.js';

const decoder = new TextDecoder();

/** Normalize a path: forward slashes, collapse "./" and "../". */
function normalizePath( p ) {

	const parts = p.replace( /\\/g, '/' ).split( '/' );
	const out = [];
	for ( const part of parts ) {

		if ( part === '' || part === '.' ) continue;
		if ( part === '..' ) out.pop();
		else out.push( part );

	}

	return out.join( '/' );

}

/** Join a base directory with a relative path. */
function joinPath( dir, rel ) {

	if ( ! dir ) return normalizePath( rel );
	if ( rel.startsWith( '/' ) ) return normalizePath( rel );
	return normalizePath( `${dir}/${rel}` );

}

/**
 * Wraps the zip contents with tolerant, case-insensitive lookup that falls back
 * to a basename match — pbrt scenes are inconsistent about path roots.
 */
class VirtualFS {

	constructor( entries ) {

		// entries: { path: Uint8Array }
		this.byPath = new Map(); // normalized lowercase -> { norm, bytes }
		this.byBase = new Map(); // basename lowercase -> [ { norm, bytes } ] (insertion order)
		for ( const key in entries ) {

			const norm = normalizePath( key ).toLowerCase();
			const rec = { norm, bytes: entries[ key ] };
			this.byPath.set( norm, rec );
			const base = norm.split( '/' ).pop();
			const bucket = this.byBase.get( base );
			if ( bucket ) bucket.push( rec );
			else this.byBase.set( base, [ rec ] );

		}

	}

	find( path ) {

		const norm = normalizePath( path ).toLowerCase();
		if ( this.byPath.has( norm ) ) return this.byPath.get( norm ).bytes;

		// Resolve by basename (O(1)); among collisions prefer a path-suffix match,
		// else fall back to the first entry with that name. pbrt scenes are
		// inconsistent about path roots, so this tolerates relative/absolute drift.
		const bucket = this.byBase.get( norm.split( '/' ).pop() );
		if ( ! bucket ) return null;
		const suffixHit = bucket.find( rec => rec.norm.endsWith( '/' + norm ) );
		return ( suffixHit || bucket[ 0 ] ).bytes;

	}

}

/** Pick the top-level .pbrt entry: shallowest path, preferring scene/main names. */
export function pickEntryPath( entries ) {

	const pbrts = Object.keys( entries ).filter( k => k.toLowerCase().endsWith( '.pbrt' ) );
	if ( pbrts.length === 0 ) return null;

	const preferred = pbrts.filter( k => /(^|\/)(scene|main)\.pbrt$/i.test( k ) );
	const pool = preferred.length ? preferred : pbrts;

	// Shallowest (fewest path segments), then shortest name.
	pool.sort( ( a, b ) => {

		const da = a.split( '/' ).length, db = b.split( '/' ).length;
		return da !== db ? da - db : a.length - b.length;

	} );

	return pool[ 0 ];

}

/**
 * @param {object} args
 * @param {Object<string,Uint8Array>} args.vfs - zip entries (path → bytes)
 * @param {string} [args.entryPath] - top .pbrt; auto-detected if omitted
 * @param {(buf:ArrayBuffer)=>import('three').BufferGeometry} args.plyParser
 * @param {(bytes:Uint8Array, filename:string)=>Promise<import('three').Texture>} args.imageFromBytes
 * @param {(bytes:Uint8Array, filename:string)=>Promise<import('three').Texture>} [args.envFromBytes]
 * @param {boolean} [args.convertHandedness=true]
 * @returns {Promise<{group, camera, environment, warnings, entryPath}>}
 */
export async function loadPBRTScene( args ) {

	const { vfs: rawEntries, plyParser, imageFromBytes, envFromBytes, convertHandedness } = args;
	const vfs = new VirtualFS( rawEntries );

	const entryPath = args.entryPath || pickEntryPath( rawEntries );
	if ( ! entryPath ) throw new Error( 'PBRT loader: no .pbrt file found in archive' );

	const entryBytes = vfs.find( entryPath );
	if ( ! entryBytes ) throw new Error( `PBRT loader: entry "${entryPath}" not readable` );

	const baseDir = entryPath.includes( '/' ) ? entryPath.slice( 0, entryPath.lastIndexOf( '/' ) ) : '';

	// Parse (with Include resolution)
	const parser = new PBRTParser( {
		resolveInclude: ( path, currentDir ) => {

			const bytes = vfs.find( joinPath( currentDir, path ) ) || vfs.find( path );
			return bytes ? decoder.decode( bytes ) : null;

		}
	} );
	const ir = parser.parse( decoder.decode( entryBytes ), baseDir );

	// Build scene graph
	const sliceBuf = ( bytes ) => bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
	const builder = new PBRTSceneBuilder( {
		convertHandedness,
		resolvePLY: async ( filename ) => {

			const bytes = vfs.find( filename );
			if ( ! bytes ) return null;
			return plyParser( sliceBuf( bytes ) );

		},
		resolveImage: async ( filename ) => {

			const bytes = vfs.find( filename );
			if ( ! bytes ) return null;
			return imageFromBytes( bytes, filename );

		},
		resolveEnvironment: async ( filename ) => {

			const bytes = vfs.find( filename );
			if ( ! bytes ) return null;
			return ( envFromBytes || imageFromBytes )( bytes, filename );

		}
	} );

	const result = await builder.build( ir );
	return { ...result, entryPath };

}
