import { TileHelper } from './helpers/TileHelper.js';
import { OutlineHelper } from './helpers/OutlineHelper.js';
import { EngineEvents } from '../EngineEvents.js';

/**
 * OverlayManager — Unified overlay system for visual helpers.
 *
 * Two rendering layers:
 *   1. **HelperScene** — A Three.js Scene rendered on top of the WebGPU backbuffer
 *      (light gizmos, bounding boxes, outlines). Renders at display resolution.
 *   2. **HUDCanvas** — A 2D `<canvas>` element overlaid via CSS for screen-space
 *      elements (tile progress, AF points, debug labels). Completely separate
 *      from the WebGPU canvas, so it is never captured in saved images.
 *
 * Helpers are registered by name and implement a simple interface:
 *   { update?(), render?(ctx, w, h), show(), hide(), dispose(), visible, layer }
 *
 * @example
 *   const overlay = new OverlayManager( renderer, camera );
 *   overlay.register( 'tiles', new TileHelper() );
 *   overlay.show( 'tiles' );
 *   // in animate():
 *   overlay.render();
 */
export class OverlayManager {

	/**
	 * @param {import('three/webgpu').WebGPURenderer} renderer
	 * @param {import('three').PerspectiveCamera} camera
	 */
	constructor( renderer, camera ) {

		this.renderer = renderer;
		this.camera = camera;

		/** @type {Map<string, Object>} */
		this._helpers = new Map();

		// ── HUD Canvas (2D overlay) ──
		this._hudCanvas = document.createElement( 'canvas' );
		this._hudCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
		this._hudCtx = this._hudCanvas.getContext( '2d' );

		// ── HelperScene reference (set via setHelperScene) ──
		this._helperScene = null;

	}

	/**
	 * Sets the SceneHelpers instance used for 3D overlay rendering.
	 * @param {import('../SceneHelpers.js').SceneHelpers} helperScene
	 */
	setHelperScene( helperScene ) {

		this._helperScene = helperScene;

	}

	/**
	 * Returns the HUD canvas element. The app should mount this on top of the
	 * WebGPU canvas (absolute-positioned, pointer-events: none).
	 * @returns {HTMLCanvasElement}
	 */
	getHUDCanvas() {

		return this._hudCanvas;

	}

	// ═══════════════════════════════════════════════════════════════
	// Default helpers setup
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Creates and wires the default overlay helpers (tile progress, outline).
	 * Call once during app init after pipeline and managers are ready.
	 *
	 * @param {Object} config
	 * @param {import('../SceneHelpers.js').SceneHelpers} config.helperScene
	 * @param {import('three').Scene} config.meshScene
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} config.pipeline
	 * @param {import('./DenoisingManager.js').DenoisingManager} config.denoisingManager
	 * @param {import('three').EventDispatcher} config.app - App instance for resize/render-complete events
	 * @param {number} config.renderWidth
	 * @param {number} config.renderHeight
	 */
	setupDefaultHelpers( { helperScene, meshScene, pipeline, denoisingManager, app, renderWidth, renderHeight } ) {

		this.setHelperScene( helperScene );

		// ── Tile helper (shared across path tracer, OIDN, upscaler) ──
		const tileHelper = new TileHelper();
		this.register( 'tiles', tileHelper );

		tileHelper.setRenderSize( renderWidth || 1, renderHeight || 1 );

		app.addEventListener( 'resolution_changed', ( e ) => {

			tileHelper.setRenderSize( e.width, e.height );

		} );

		// Path tracer tile events
		pipeline.eventBus.on( 'tile:changed', ( e ) => {

			if ( e.renderMode === 1 && e.tileBounds ) {

				tileHelper.setActiveTile( e.tileBounds );
				tileHelper.show();

			}

		} );

		pipeline.eventBus.on( 'pipeline:reset', () => tileHelper.hide() );
		app.addEventListener( EngineEvents.RENDER_COMPLETE, () => tileHelper.hide() );

		// OIDN/upscaler tile events
		this._wireDenoiserTileEvents( tileHelper, denoisingManager );

		// ── Outline helper ──
		const outlineHelper = new OutlineHelper( this.renderer, meshScene, this.camera );
		this.register( 'outline', outlineHelper );

	}

	/**
	 * Wires denoiser/upscaler tile progress events to the tile helper.
	 * These fire while the animation loop is stopped, so we trigger manual HUD redraws.
	 */
	_wireDenoiserTileEvents( tileHelper, denoisingManager ) {

		const sources = [ denoisingManager?.denoiser, denoisingManager?.upscaler ];

		for ( const source of sources ) {

			if ( ! source ) continue;

			source.addEventListener( 'tileProgress', ( e ) => {

				if ( e.tile ) {

					tileHelper.setRenderSize( e.imageWidth, e.imageHeight );
					tileHelper.setActiveTile( e.tile );
					tileHelper.show();
					this.refreshHUD();

				}

			} );

			source.addEventListener( 'end', () => {

				tileHelper.hide();
				this.refreshHUD();

			} );

		}

	}

	// ═══════════════════════════════════════════════════════════════
	// Helper registration
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Registers a named helper.
	 * @param {string} name
	 * @param {Object} helper — must implement at least { show(), hide(), dispose() }
	 */
	register( name, helper ) {

		if ( this._helpers.has( name ) ) {

			console.warn( `OverlayManager: helper "${name}" already registered — replacing.` );
			this._helpers.get( name ).dispose?.();

		}

		this._helpers.set( name, helper );

	}

	/**
	 * Unregisters and disposes a named helper.
	 * @param {string} name
	 */
	unregister( name ) {

		const helper = this._helpers.get( name );
		if ( ! helper ) return;

		helper.dispose?.();
		this._helpers.delete( name );

	}

	// ═══════════════════════════════════════════════════════════════
	// Visibility API
	// ═══════════════════════════════════════════════════════════════

	show( name ) {

		this._helpers.get( name )?.show();

	}

	hide( name ) {

		this._helpers.get( name )?.hide();

	}

	toggle( name ) {

		const helper = this._helpers.get( name );
		if ( ! helper ) return;

		if ( helper.visible ) {

			helper.hide();

		} else {

			helper.show();

		}

	}

	getHelper( name ) {

		return this._helpers.get( name ) ?? null;

	}

	isVisible( name ) {

		return this._helpers.get( name )?.visible ?? false;

	}

	showAll() {

		for ( const helper of this._helpers.values() ) helper.show();

	}

	hideAll() {

		for ( const helper of this._helpers.values() ) helper.hide();

	}

	// ═══════════════════════════════════════════════════════════════
	// Per-frame rendering
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Renders all visible overlays. Call once per frame after the main pipeline.
	 */
	render() {

		// 1. Render 3D HelperScene overlay (light gizmos, etc.)
		if ( this._helperScene ) {

			this._helperScene.render( this.renderer, this.camera );

		}

		// 2. Render scene-layer helpers (outline, etc.)
		for ( const helper of this._helpers.values() ) {

			if ( helper.visible && helper.layer === 'scene' && helper.render ) {

				helper.render( this.renderer, this.camera );

			}

		}

		// 3. Draw HUD canvas (2D helpers)
		this.refreshHUD();

	}

	/**
	 * Forwards display dimensions to helpers that need resize.
	 * @param {number} width - Display width in pixels
	 * @param {number} height - Display height in pixels
	 */
	setSize( width, height ) {

		for ( const helper of this._helpers.values() ) {

			helper.setSize?.( width, height );

		}

	}

	/**
	 * Redraws the HUD canvas. Safe to call outside the animation loop
	 * (e.g. during async OIDN tile progress).
	 */
	refreshHUD() {

		const canvas = this._hudCanvas;
		const ctx = this._hudCtx;

		// Fast path: skip all canvas work when nothing is visible
		let hasVisibleHUD = false;
		for ( const helper of this._helpers.values() ) {

			if ( helper.visible && helper.layer === 'hud' && helper.render ) {

				hasVisibleHUD = true;
				break;

			}

		}

		if ( ! hasVisibleHUD ) {

			if ( canvas.style.display !== 'none' ) canvas.style.display = 'none';
			return;

		}

		const dpr = window.devicePixelRatio || 1;
		const displayW = canvas.clientWidth;
		const displayH = canvas.clientHeight;
		const pixelW = Math.round( displayW * dpr );
		const pixelH = Math.round( displayH * dpr );

		if ( canvas.width !== pixelW || canvas.height !== pixelH ) {

			canvas.width = pixelW;
			canvas.height = pixelH;

		}

		ctx.clearRect( 0, 0, pixelW, pixelH );
		ctx.save();
		ctx.scale( dpr, dpr );

		for ( const helper of this._helpers.values() ) {

			if ( helper.visible && helper.layer === 'hud' && helper.render ) {

				helper.render( ctx, displayW, displayH );

			}

		}

		ctx.restore();
		if ( canvas.style.display !== '' ) canvas.style.display = '';

	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	dispose() {

		for ( const helper of this._helpers.values() ) {

			helper.dispose?.();

		}

		this._helpers.clear();

		if ( this._hudCanvas.parentElement ) {

			this._hudCanvas.parentElement.removeChild( this._hudCanvas );

		}

	}

}
