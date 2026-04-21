import { Fn, int, uint, uvec2, vec4, uniform, If, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, StorageTexture } from 'three/webgpu';
import { FloatType, RGBAFormat, NearestFilter } from 'three';
import { getReSTIRDebugColor } from '../TSL/LightsSampling.js';
import { createRenderTargetHelper } from '../Processor/createRenderTargetHelper.js';

const WG_SIZE = 8;

/**
 * ReSTIRHeatmap — floating debug overlay for inspecting reservoir state.
 *
 * Mirrors the ASVGF heatmap pattern: a dedicated compute dispatch reads the
 * reservoir buffer (via the `getReSTIRDebugColor` TSL Fn, which pulls from
 * the module-level buffer handle set up by ShaderBuilder), writes per-pixel
 * colors into a FloatType StorageTexture, copies into a RenderTarget for
 * JS-side readback, and routes through `createRenderTargetHelper` as a
 * draggable floating window.
 *
 * Orthogonal to the main path tracer — toggling the overlay on/off has zero
 * effect on the accumulation buffer or the reservoir writes themselves.
 *
 * Debug modes exposed (match the getReSTIRDebugColor branches):
 *   20 — Visibility cache
 *   21 — Frame age
 *   22 — Light type
 *   23 — W magnitude
 *   24 — M count
 */
export class ReSTIRHeatmap {

	constructor( renderer, { debugContainer = null } = {} ) {

		this.renderer = renderer;
		this.debugContainer = debugContainer;
		this.width = 0;
		this.height = 0;
		this.enabled = false;

		// Uniforms consumed by the compute shader.
		this.modeUniform = uniform( 20, 'int' );
		this.widthUniform = uniform( 1, 'int' );
		this.heightUniform = uniform( 1, 'int' );

		this._storageTex = null;
		this._renderTarget = null;
		this._computeNode = null;
		this._helper = null;
		this._dispatchX = 0;
		this._dispatchY = 0;
		this._allocated = false;

	}

	_buildComputeNode() {

		const storageTex = this._storageTex;
		const mode = this.modeUniform;
		const widthU = this.widthUniform;
		const heightU = this.heightUniform;

		const fn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( widthU ).and( gy.lessThan( heightU ) ), () => {

				const color = getReSTIRDebugColor( gx, gy, widthU, mode );
				textureStore(
					storageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( color, 1.0 )
				).toWriteOnly();

			} );

		} );

		return fn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	_allocate() {

		const { width, height } = this;

		this._storageTex = new StorageTexture( width, height );
		this._storageTex.type = FloatType;
		this._storageTex.format = RGBAFormat;
		this._storageTex.minFilter = NearestFilter;
		this._storageTex.magFilter = NearestFilter;

		this._renderTarget = new RenderTarget( width, height, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false,
		} );
		this._renderTarget.texture.name = 'ReSTIR Debug';

		this.widthUniform.value = width;
		this.heightUniform.value = height;
		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );

		this._computeNode = this._buildComputeNode();

		this._helper = createRenderTargetHelper( this.renderer, this._renderTarget, {
			width: 320,
			height: 320,
			position: 'bottom-right',
			theme: 'dark',
			title: 'ReSTIR Debug',
			autoUpdate: false,
		} );
		this._helper.hide();
		( this.debugContainer || document.body ).appendChild( this._helper );

		this._allocated = true;

	}

	setSize( width, height ) {

		if ( this.width === width && this.height === height ) return;
		this.width = width;
		this.height = height;

		if ( ! this._allocated ) return;

		this._storageTex.setSize( width, height );
		this._renderTarget.setSize( width, height );
		this._renderTarget.texture.needsUpdate = true;
		this.widthUniform.value = width;
		this.heightUniform.value = height;
		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );
		if ( this._computeNode ) {

			this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

	}

	toggle( enabled ) {

		this.enabled = !! enabled;

		if ( this.enabled ) {

			if ( ! this._allocated && this.width > 0 && this.height > 0 ) {

				this._allocate();

			}

			this._helper?.show();
			// Force a dispatch so the overlay paints immediately — the main
			// path tracer's per-frame render() loop stops ticking once
			// accumulation completes, so without this the helper stays black
			// until the user moves the camera.
			this._scheduleRender();

		} else {

			this._helper?.hide();

		}

	}

	setMode( mode ) {

		this.modeUniform.value = mode | 0;
		// Same rationale as toggle() — refresh now in case the main loop is idle.
		if ( this.enabled ) this._scheduleRender();

	}

	render() {

		if ( ! this.enabled || ! this._computeNode ) return;
		this.renderer.compute( this._computeNode );
		this.renderer.copyTextureToTexture( this._storageTex, this._renderTarget.texture );
		this._helper?.update();

	}

	/**
	 * Dispatch + update, retrying on next animation frame if the helper's
	 * previous readback was still in flight. Use this from state-change
	 * entry points (toggle/setMode) so the user-facing canvas converges to
	 * the newest compute output even when the main render loop is idle —
	 * the helper's update() silently skips its readback while `pendingRead`
	 * is true, so a single dispatch during a rapid toggle+setMode sequence
	 * can lose the later paint otherwise.
	 */
	_scheduleRender() {

		this.render();
		// Second pass on the next frame guarantees a fresh readback once the
		// prior one settles (the helper clears pendingRead inside its async
		// .then, which resolves in a subsequent microtask).
		if ( typeof requestAnimationFrame === 'function' ) {

			requestAnimationFrame( () => this.render() );

		}

	}

	dispose() {

		this._computeNode?.dispose?.();
		this._storageTex?.dispose?.();
		this._renderTarget?.dispose?.();
		this._helper?.dispose?.();
		this._allocated = false;

	}

}
