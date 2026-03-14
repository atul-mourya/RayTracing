/**
 * RenderTargetPool.js
 * Manages ping-pong MRT render targets for WebGPU path tracing accumulation.
 */

import { RenderTarget } from 'three/webgpu';
import { RGBAFormat, NearestFilter, FloatType } from 'three';

/**
 * Default render target options
 */
const DEFAULT_RT_OPTIONS = {
	type: FloatType,
	format: RGBAFormat,
	minFilter: NearestFilter,
	magFilter: NearestFilter,
	depthBuffer: false,
	stencilBuffer: false
};

export class RenderTargetPool {

	/**
	 * @param {number} width - Initial render width
	 * @param {number} height - Initial render height
	 * @param {number} mrtCount - Number of MRT color attachments (default 3: color, normalDepth, albedo)
	 */
	constructor( width, height, mrtCount = 3 ) {

		this.renderTargetA = null;
		this.renderTargetB = null;
		this.currentTarget = 0;
		this.renderWidth = 0;
		this.renderHeight = 0;
		this.mrtCount = mrtCount;

		if ( width > 0 && height > 0 ) {

			this.create( width, height );

		}

	}

	/**
	 * Creates MRT render targets for accumulation.
	 * @param {number} width
	 * @param {number} height
	 */
	create( width, height ) {

		this.dispose();

		this.renderWidth = width;
		this.renderHeight = height;

		const mrtOptions = { ...DEFAULT_RT_OPTIONS, count: this.mrtCount };

		this.renderTargetA = new RenderTarget( width, height, mrtOptions );
		this.renderTargetB = new RenderTarget( width, height, mrtOptions );

		// Name textures — MRTNode.setup() maps mrt() keys to texture indices via these names
		for ( const rt of [ this.renderTargetA, this.renderTargetB ] ) {

			rt.textures[ 0 ].name = 'gColor';
			rt.textures[ 1 ].name = 'gNormalDepth';
			rt.textures[ 2 ].name = 'gAlbedo';

		}

		console.log( `RenderTargetPool: Created ${width}x${height} MRT render targets (count: ${this.mrtCount})` );

	}

	/**
	 * Ensure render targets exist at the correct size, recreating if needed.
	 * @param {number} width
	 * @param {number} height
	 * @returns {boolean} True if targets were (re)created
	 */
	ensureSize( width, height ) {

		if ( this.renderWidth !== width || this.renderHeight !== height || ! this.renderTargetA ) {

			this.create( width, height );
			return true;

		}

		return false;

	}

	/**
	 * Get read and write targets for ping-pong rendering.
	 * @returns {{ readTarget: RenderTarget, writeTarget: RenderTarget }}
	 */
	getTargets() {

		const readTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;
		const writeTarget = this.currentTarget === 0 ? this.renderTargetB : this.renderTargetA;

		return { readTarget, writeTarget };

	}

	/**
	 * Swap ping-pong targets after rendering.
	 */
	swap() {

		this.currentTarget = 1 - this.currentTarget;

	}

	/**
	 * Get MRT textures from the current accumulation target.
	 * @returns {{ color: Texture|null, normalDepth: Texture|null, albedo: Texture|null }}
	 */
	getMRTTextures() {

		const currentTarget = this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;

		return {
			color: currentTarget?.textures?.[ 0 ] ?? null,
			normalDepth: currentTarget?.textures?.[ 1 ] ?? null,
			albedo: currentTarget?.textures?.[ 2 ] ?? null
		};

	}

	/**
	 * Get the current accumulation render target (the last-written MRT target).
	 * @returns {RenderTarget|null}
	 */
	getCurrentAccumulation() {

		return this.currentTarget === 0 ? this.renderTargetA : this.renderTargetB;

	}

	/**
	 * Clear both render targets.
	 * @param {WebGPURenderer} renderer
	 */
	clear( renderer ) {

		if ( ! this.renderTargetA || ! this.renderTargetB || ! renderer ) return;

		const currentRT = renderer.getRenderTarget();

		renderer.setRenderTarget( this.renderTargetA );
		renderer.clear( true, false, false );

		renderer.setRenderTarget( this.renderTargetB );
		renderer.clear( true, false, false );

		renderer.setRenderTarget( currentRT );

	}

	/**
	 * Dispose all render targets.
	 */
	dispose() {

		this.renderTargetA?.dispose();
		this.renderTargetB?.dispose();

		this.renderTargetA = null;
		this.renderTargetB = null;

	}

}
