/**
 * Cross-origin Worker utility.
 *
 * Browsers block `new Worker(url)` when the script is cross-origin (e.g. CDN).
 * The workaround: create a same-origin blob that re-exports via dynamic import().
 * This preserves the original URL as the module base for relative imports inside
 * the worker script.
 */

function crossOriginWorker( url, options ) {

	const blob = new Blob(
		[ `import ${JSON.stringify( url.toString() )};` ],
		{ type: 'application/javascript' }
	);
	return new Worker( URL.createObjectURL( blob ), { ...options, type: 'module' } );

}

/**
 * Creates a Worker, falling back to a blob-based proxy for cross-origin scripts.
 * @param {URL} url - Worker script URL
 * @param {WorkerOptions} [options] - Worker options (e.g. { type: 'module' })
 * @returns {Worker}
 */
export function createWorker( url, options = {} ) {

	try {

		return new Worker( url, options );

	} catch ( e ) {

		if ( e.name !== 'SecurityError' ) throw e;
		return crossOriginWorker( url, options );

	}

}
