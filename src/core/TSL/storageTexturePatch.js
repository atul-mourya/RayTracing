/**
 * Monkey-patch for Three.js StorageTexture.setSize() bind group staleness.
 *
 * Bug: StorageTexture.setSize() calls dispose() but never sets needsUpdate = true.
 * The Bindings system tracks texture.version (incremented by needsUpdate setter)
 * to detect when bind groups need recreation. Without the version bump, the bind
 * group keeps referencing the destroyed GPUTextureView → writes silently fail.
 *
 * Three.js issue: https://github.com/mrdoob/three.js/issues/32969
 * Targeted fix: r184+ (2026-03-25)
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
