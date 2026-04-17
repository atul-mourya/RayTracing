/**
 * Monkey-patch for Three.js StorageTexture.setSize() bind group staleness.
 *
 * Bug: StorageTexture.setSize() calls dispose() but never sets needsUpdate = true.
 * The Bindings system tracks texture.version (incremented by needsUpdate setter)
 * to detect when bind groups need recreation. Without the version bump, the bind
 * group keeps referencing the destroyed GPUTextureView → writes silently fail.
 *
 * Three.js issue: https://github.com/mrdoob/three.js/issues/32969
 * Upstream fix: PR #33028 landed in r184 — invalidates bind-group cache on
 * StorageTexture dispose. This monkey-patch is kept as defense-in-depth since
 * StorageTexturePool still relies on pre-allocation (issue #33061 — TSL compute
 * re-compile zeros — is deferred to r185).
 *
 * Import this module once at app startup (side-effect only).
 */

import { StorageTexture } from 'three/webgpu';

const _origSetSize = StorageTexture.prototype.setSize;

StorageTexture.prototype.setSize = function ( width, height ) {

	const wasChanged = this.image.width !== width || this.image.height !== height;

	_origSetSize.call( this, width, height );

	if ( wasChanged ) {

		this.needsUpdate = true;

	}

};
