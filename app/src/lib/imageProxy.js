const PROXY_ENDPOINT = 'https://serveproxy.com/?url=';

// Routes external image URLs through serveproxy.com for CORS bypass + AVIF/WebP optimization.
// Skips: empty values, data:/blob: URIs, relative paths, same-origin URLs, non-image extensions,
// and URLs already pointing at the proxy.
export function proxyImage( url ) {

	if ( ! url || typeof url !== 'string' ) return url;
	if ( url.startsWith( 'data:' ) || url.startsWith( 'blob:' ) ) return url;
	if ( url.startsWith( PROXY_ENDPOINT ) ) return url;

	// Relative URLs (same-origin static assets like /gobos/*.png) — no proxy needed.
	if ( ! /^https?:\/\//i.test( url ) ) return url;

	// Same-origin absolute URLs — no CORS concern.
	if ( typeof window !== 'undefined' && url.startsWith( window.location.origin ) ) return url;

	// Strip query string for extension test, then guard against non-image assets
	// (HDR/EXR/GLB exceed the proxy's 5MB cap and are not images).
	const pathOnly = url.split( '?' )[ 0 ].toLowerCase();
	if ( /\.(hdr|exr|glb|gltf|bin|ktx2?|dds)$/.test( pathOnly ) ) return url;

	return PROXY_ENDPOINT + encodeURIComponent( url );

}
