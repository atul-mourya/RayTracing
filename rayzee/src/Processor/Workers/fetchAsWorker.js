/**
 * Cross-origin Worker fallback.
 *
 * Browsers enforce same-origin policy on `new Worker(url)`.  When the
 * library's JS is served from a CDN (different origin to the page),
 * the standard constructor throws `SecurityError`.
 *
 * This helper fetches the script over the network (CORS-allowed) and
 * re-hosts it as a same-origin Blob URL.
 *
 * The Blob URL is intentionally **not** revoked — workers may reference
 * `self.location.href` to spawn sub-workers (e.g. BVHWorker).
 *
 * @param {URL|string} url  Worker script URL (may be cross-origin)
 * @returns {Promise<Worker>}
 */
export async function fetchAsWorker( url ) {

	const href = url instanceof URL ? url.href : url;
	const response = await fetch( href );
	if ( ! response.ok ) {

		throw new Error( `Failed to fetch worker script: ${response.status}` );

	}

	const blob = new Blob( [ await response.text() ], { type: 'application/javascript' } );
	return new Worker( URL.createObjectURL( blob ) );

}
