import { EventDispatcher } from 'three';
import { OIDNDenoiser } from '../Passes/OIDNDenoiser.js';
import { AIUpscaler } from '../Passes/AIUpscaler.js';
import { EngineEvents } from '../EngineEvents.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, ASVGF_QUALITY_PRESETS } from '../EngineDefaults.js';

/**
 * Orchestrates all denoising, post-processing, and AI upscaling:
 *   - Real-time denoiser strategy switching (ASVGF / SSRC / EdgeAware / None)
 *   - OIDN (offline denoise on render completion)
 *   - AI Upscaler
 *   - Auto-exposure coordination
 *   - Adaptive sampling coordination
 *   - Render-completion chain (denoise → upscale)
 *
 * Extracted from PathTracerApp to keep the facade slim.
 */
export class DenoisingManager extends EventDispatcher {

	/**
	 * @param {Object} params
	 * @param {import('three/webgpu').WebGPURenderer} params.renderer
	 * @param {HTMLCanvasElement}                      params.mainCanvas  - The primary rendering canvas
	 * @param {import('three').Scene}                  params.scene
	 * @param {import('three').PerspectiveCamera}      params.camera
	 * @param {Object}                                 params.stages     - Named references to pipeline stages
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} params.pipeline
	 * @param {Function}                               params.getExposure       - () => current exposure value
	 * @param {Function}                               params.getSaturation     - () => current saturation value
	 * @param {Function}                               params.getTransparentBg  - () => boolean
	 */
	constructor( { renderer, mainCanvas, scene, camera, stages, pipeline, getExposure, getSaturation, getTransparentBg } ) {

		super();

		this.renderer = renderer;
		this.mainCanvas = mainCanvas;
		this.denoiserCanvas = this._createDenoiserCanvas( mainCanvas );
		this.scene = scene;
		this.camera = camera;
		this.pipeline = pipeline;

		// Stage references — only used internally for orchestration
		this._stages = stages; // { pathTracer, asvgf, variance, bilateralFilter, adaptiveSampling, edgeFilter, ssrc, autoExposure, display }

		this._getExposure = getExposure;
		this._getSaturation = getSaturation;
		this._getTransparentBg = getTransparentBg;

		this.denoiser = null;
		this.upscaler = null;

		// Resolution tracking — used for canvas restoration on reset
		this._lastRenderWidth = 0;
		this._lastRenderHeight = 0;

	}

	_createDenoiserCanvas( mainCanvas ) {

		const parent = mainCanvas.parentNode;
		if ( ! parent ) return null;

		const dc = document.createElement( 'canvas' );
		dc.width = mainCanvas.width;
		dc.height = mainCanvas.height;
		dc.style.position = 'absolute';
		dc.style.inset = '0';
		dc.style.width = '100%';
		dc.style.height = '100%';

		parent.insertBefore( dc, mainCanvas );
		return dc;

	}

	/**
	 * Updates the render resolution and propagates to denoiser/upscaler.
	 * @param {number} width
	 * @param {number} height
	 */
	setRenderSize( width, height ) {

		this._lastRenderWidth = width;
		this._lastRenderHeight = height;
		this.denoiser?.setSize( width, height );
		this.upscaler?.setBaseSize( width, height );

	}


	/**
	 * Restores the denoiser canvas to base render resolution after upscaling.
	 * @returns {boolean} true if the canvas was resized
	 */
	restoreBaseResolution() {

		if ( ! this.denoiserCanvas || ! this._lastRenderWidth || ! this._lastRenderHeight ) return false;

		const wasResized = this.denoiserCanvas.width !== this._lastRenderWidth
			|| this.denoiserCanvas.height !== this._lastRenderHeight;

		this.denoiserCanvas.width = this._lastRenderWidth;
		this.denoiserCanvas.height = this._lastRenderHeight;

		return wasResized;

	}

	/**
	 * Initialises the OIDN denoiser for the WebGPU backend.
	 */
	setupDenoiser() {

		if ( ! this.denoiserCanvas ) return;

		const pt = this._stages.pathTracer;

		this.denoiser = new OIDNDenoiser( this.denoiserCanvas, this.renderer, this.scene, this.camera, {
			...DEFAULT_STATE,

			backendParams: () => ( {
				device: this.renderer.backend.device,
				adapterInfo: null
			} ),

			getGPUTextures: () => {

				if ( ! pt?.storageTextures?.readTarget ) return null;
				const readTextures = pt.storageTextures.getReadTextures();
				const { backend } = this.renderer;
				return {
					color: backend.get( readTextures.color ).texture,
					normal: backend.get( readTextures.normalDepth ).texture,
					albedo: backend.get( readTextures.albedo ).texture
				};

			},

			getExposure: () => this._getEffectiveExposure(),
			getToneMapping: () => this._getToneMapping(),
			getSaturation: () => this._getSaturation(),
			getTransparentBackground: () => this._getTransparentBg(),
			getMRTRenderTarget: () => pt?.storageTextures?.readTarget ?? null,
		} );

		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Forward lifecycle events
		this.denoiser.addEventListener( 'start', () =>
			this.dispatchEvent( { type: EngineEvents.DENOISING_START } ) );
		this.denoiser.addEventListener( 'end', () =>
			this.dispatchEvent( { type: EngineEvents.DENOISING_END } ) );

	}

	/**
	 * Initialises the AI upscaler for post-render super-resolution.
	 */
	setupUpscaler() {

		if ( ! this.denoiserCanvas ) return;

		const pt = this._stages.pathTracer;

		this.upscaler = new AIUpscaler( this.denoiserCanvas, this.renderer, {
			scaleFactor: DEFAULT_STATE.upscalerScale || 2,
			quality: DEFAULT_STATE.upscalerQuality || 'fast',

			getSourceCanvas: () => {

				if ( this.denoiser?.enabled ) return null;
				return this.renderer.domElement;

			},

			getGPUTextures: () => {

				if ( ! pt?.storageTextures?.readTarget ) return null;
				const readTextures = pt.storageTextures.getReadTextures();
				return { color: this.renderer.backend.get( readTextures.color ).texture };

			},

			getExposure: () => this._getEffectiveExposure(),
			getToneMapping: () => this._getToneMapping(),
			getSaturation: () => this._getSaturation(),
		} );

		this.upscaler.enabled = DEFAULT_STATE.enableUpscaler || false;

		// Forward lifecycle events
		this.upscaler.addEventListener( 'resolution_changed', ( e ) =>
			this.dispatchEvent( { type: 'resolution_changed', width: e.width, height: e.height } ) );
		this.upscaler.addEventListener( 'start', () =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_START } ) );
		this.upscaler.addEventListener( 'progress', ( e ) =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_PROGRESS, progress: e.progress } ) );
		this.upscaler.addEventListener( 'end', () =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_END } ) );

	}

	// ── Denoiser Strategy ─────────────────────────────────────────

	/**
	 * Switches the real-time denoiser strategy.
	 * @param {string} strategy   - 'none' | 'asvgf' | 'ssrc' | 'edgeaware'
	 * @param {string} [asvgfPreset] - ASVGF quality preset when strategy is 'asvgf'
	 */
	setDenoiserStrategy( strategy, asvgfPreset ) {

		const s = this._stages;

		// Disable all real-time denoisers first
		if ( s.asvgf ) s.asvgf.enabled = false;
		if ( s.variance && ! this._isAdaptiveSamplingActive() ) s.variance.enabled = false;
		if ( s.bilateralFilter ) s.bilateralFilter.enabled = false;
		if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( false );
		if ( s.ssrc ) s.ssrc.enabled = false;

		this._clearDenoiserTextures();

		switch ( strategy ) {

			case 'asvgf':
				s.asvgf.enabled = true;
				if ( s.variance ) s.variance.enabled = true;
				if ( s.bilateralFilter ) s.bilateralFilter.enabled = true;
				s.asvgf.setTemporalEnabled?.( true );
				this._applyASVGFPreset( asvgfPreset || 'medium' );
				break;

			case 'ssrc':
				if ( s.ssrc ) s.ssrc.enabled = true;
				break;

			case 'edgeaware':
				if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( true );
				break;

		}

	}

	/**
	 * Enables/disables ASVGF denoising with coordination of related stages.
	 * @param {boolean} enabled
	 * @param {string}  [qualityPreset]
	 */
	setASVGFEnabled( enabled, qualityPreset ) {

		const s = this._stages;
		if ( s.asvgf ) s.asvgf.enabled = enabled;
		if ( s.variance ) s.variance.enabled = enabled;
		if ( s.bilateralFilter ) s.bilateralFilter.enabled = enabled;

		if ( enabled ) {

			s.asvgf?.setTemporalEnabled?.( true );
			this._applyASVGFPreset( qualityPreset || 'medium' );

		}

		// Coordinate with EdgeAware filtering
		if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( ! enabled );

	}

	/**
	 * Applies an ASVGF quality preset.
	 * @param {string} presetName - 'low' | 'medium' | 'high'
	 */
	applyASVGFPreset( presetName ) {

		this._applyASVGFPreset( presetName );

	}

	/**
	 * Enables/disables auto-exposure with proper exposure stacking management.
	 * @param {boolean} enabled
	 * @param {number}  manualExposure - The manual exposure value to restore when disabling
	 */
	setAutoExposureEnabled( enabled, manualExposure ) {

		const s = this._stages;
		if ( ! s.autoExposure ) return;

		s.autoExposure.enabled = enabled;

		if ( enabled ) {

			// Neutralize Display manual exposure to avoid stacking
			s.display?.setExposure( 1.0 );

		} else {

			s.display?.setExposure( manualExposure );
			if ( s.display && this.renderer ) {

				this.renderer.toneMappingExposure = 1.0;

			}

		}

	}

	/**
	 * Enables/disables adaptive sampling with proper stage and context cleanup.
	 * @param {boolean} enabled
	 */
	setAdaptiveSamplingEnabled( enabled ) {

		const s = this._stages;

		if ( s.adaptiveSampling ) {

			s.adaptiveSampling.enabled = enabled;
			s.adaptiveSampling.toggleHelper( false );

		}

		// Variance stage is shared by both ASVGF and adaptive sampling
		if ( enabled ) {

			if ( s.variance ) s.variance.enabled = true;

		} else if ( ! s.asvgf?.enabled ) {

			if ( s.variance ) s.variance.enabled = false;

		}

		// Clean up stale variance context when disabling
		if ( ! enabled && this.pipeline?.context && ! s.asvgf?.enabled ) {

			this.pipeline.context.removeTexture( 'variance:output' );

		}

	}

	// ── Render Completion Chain ───────────────────────────────────

	/**
	 * Called when the path tracer render is complete.
	 * Triggers the denoise → upscale chain.
	 *
	 * @param {Object} params
	 * @param {HTMLCanvasElement} params.canvas           - Main renderer canvas
	 * @param {Function}         params.isStillComplete   - () => boolean, guard for async race
	 * @param {import('../Pipeline/PipelineContext.js').PipelineContext} params.context
	 */
	onRenderComplete( { isStillComplete, context } ) {

		// Show post-process canvas if any post-process is enabled
		if ( ( this.denoiser?.enabled || this.upscaler?.enabled ) && this.denoiserCanvas ) {

			this.denoiserCanvas.style.display = 'block';

		}

		// Chain: denoise first (if enabled), then upscale (if enabled)
		const startUpscaler = () => {

			if ( ! isStillComplete() ) return;

			if ( this.upscaler?.enabled ) {

				this.upscaler.start();

			}

		};

		if ( this.denoiser?.enabled ) {

			this.denoiser.addEventListener( 'end', startUpscaler, { once: true } );
			this.denoiser.start();

		} else {

			// Re-render display stage so WebGPU canvas has valid content
			if ( this.upscaler?.enabled && this._stages.display && context ) {

				this._stages.display.render( context );

			}

			startUpscaler();

		}

	}

	/**
	 * Aborts any in-progress denoising/upscaling (called on reset).
	 * @param {HTMLCanvasElement} canvas
	 */
	abort( mainCanvas ) {

		if ( mainCanvas ) mainCanvas.style.opacity = '1';

		if ( this.upscaler ) this.upscaler.abort();

		if ( this.denoiser ) {

			if ( this.denoiser.enabled ) this.denoiser.abort();
			if ( this.denoiser.output ) this.denoiser.output.style.display = 'none';

		}

	}

	dispose() {

		if ( this.denoiser ) {

			this.denoiser.dispose();
			this.denoiser = null;

		}

		if ( this.upscaler ) {

			this.upscaler.dispose();
			this.upscaler = null;

		}

		if ( this.denoiserCanvas?.parentNode ) {

			this.denoiserCanvas.parentNode.removeChild( this.denoiserCanvas );
			this.denoiserCanvas = null;

		}

	}

	// ── Injected Dependencies (set after construction) ───────────

	/** @param {import('./OverlayManager.js').OverlayManager} overlayManager */
	setOverlayManager( overlayManager ) {

		this._overlayManager = overlayManager;

	}

	/** @param {Function} fn - () => void, triggers accumulation reset */
	setResetCallback( fn ) {

		this._onReset = fn;

	}

	/** @param {import('../RenderSettings.js').RenderSettings} settings */
	setSettings( settings ) {

		this._settings = settings;

	}

	// ── Stage Parameter Forwarding ───────────────────────────────
	// These methods match the DenoisingAPI surface so call sites need
	// zero or minimal changes after facade removal.

	/** Updates ASVGF stage parameters. */
	setASVGFParams( params ) {

		this._stages.asvgf?.updateParameters( params );

	}

	/** Toggles the ASVGF heatmap debug overlay. */
	toggleASVGFHeatmap( enabled ) {

		this._stages.asvgf?.toggleHeatmap?.( enabled );

	}

	/**
	 * Configures ASVGF for a specific render mode (multi-stage coordination).
	 * @param {Object} config - { enabled, temporalAlpha, atrousIterations, ... }
	 */
	configureASVGFForMode( config ) {

		if ( ! this._stages.asvgf ) return;

		this._stages.asvgf.enabled = config.enabled;
		if ( this._stages.variance ) this._stages.variance.enabled = config.enabled;
		if ( this._stages.bilateralFilter ) this._stages.bilateralFilter.enabled = config.enabled;

		if ( config.enabled ) {

			this._stages.asvgf.updateParameters( config );

		}

	}

	/** Updates SSRC stage parameters. */
	setSSRCParams( params ) {

		this._stages.ssrc?.updateParameters( params );

	}

	/** Updates edge-aware filtering parameters. */
	setEdgeAwareParams( params ) {

		this._stages.edgeFilter?.updateUniforms( params );

	}

	/** Updates auto-exposure stage parameters. */
	setAutoExposureParams( params ) {

		this._stages.autoExposure?.updateParameters( params );

	}

	/**
	 * Updates adaptive sampling parameters (with settings bridge).
	 * @param {Object} params
	 */
	setAdaptiveSamplingParams( params ) {

		if ( params.min !== undefined ) this._stages.pathTracer?.setAdaptiveSamplingMin( params.min );
		if ( params.adaptiveSamplingMax !== undefined ) this._settings?.set( 'adaptiveSamplingMax', params.adaptiveSamplingMax );
		this._stages.adaptiveSampling?.setAdaptiveSamplingParameters( params );

	}

	/** Toggles the adaptive sampling debug helper. */
	toggleAdaptiveSamplingHelper( enabled ) {

		this._stages.adaptiveSampling?.toggleHelper( enabled );

	}

	// ── OIDN ─────────────────────────────────────────────────────

	/** Enables or disables Intel OIDN denoiser. */
	setOIDNEnabled( enabled ) {

		if ( this.denoiser ) this.denoiser.enabled = enabled;

	}

	/** Sets OIDN denoiser quality. */
	setOIDNQuality( quality ) {

		this.denoiser?.updateQuality( quality );

	}

	/** Enables or disables the OIDN tile helper overlay. */
	setOIDNTileHelper( enabled ) {

		this._setTileHelper( enabled );

	}

	/** Enables or disables the tile helper overlay. */
	setTileHelperEnabled( enabled ) {

		this._setTileHelper( enabled );

	}

	/** Enables or disables tile highlight. */
	setTileHighlightEnabled( enabled ) {

		this._setTileHelper( enabled );

	}

	// ── AI Upscaler ──────────────────────────────────────────────

	/** Enables or disables the AI upscaler. */
	setUpscalerEnabled( enabled ) {

		if ( this.upscaler ) this.upscaler.enabled = enabled;

	}

	/** Sets the upscaler scale factor. */
	setUpscalerScaleFactor( factor ) {

		this.upscaler?.setScaleFactor( factor );

	}

	/** Sets the upscaler quality level. */
	setUpscalerQuality( quality ) {

		this.upscaler?.setQuality( quality );

	}

	// ── Convenience (match DenoisingAPI names with reset) ────────

	/**
	 * Enables or disables auto-exposure (convenience wrapper).
	 * @param {boolean} enabled
	 */
	setAutoExposure( enabled ) {

		this.setAutoExposureEnabled( enabled, this._getExposure() );
		this._onReset?.();

	}

	/**
	 * Enables or disables adaptive sampling (convenience wrapper with settings bridge).
	 * @param {boolean} enabled
	 */
	setAdaptiveSampling( enabled ) {

		this._settings?.set( 'useAdaptiveSampling', enabled );
		this.setAdaptiveSamplingEnabled( enabled );

	}

	/**
	 * Switches strategy with automatic reset (convenience wrapper).
	 * @param {'none'|'asvgf'|'ssrc'|'edgeaware'} strategy
	 * @param {string} [asvgfPreset]
	 */
	setStrategy( strategy, asvgfPreset ) {

		this.setDenoiserStrategy( strategy, asvgfPreset );
		this._onReset?.();

	}

	// ── Private ───────────────────────────────────────────────────

	_setTileHelper( enabled ) {

		const tileHelper = this._overlayManager?.getHelper( 'tiles' );
		if ( tileHelper ) {

			tileHelper.enabled = enabled;
			if ( ! enabled ) tileHelper.hide();

		}

	}


	_getEffectiveExposure() {

		return this._stages.autoExposure?.enabled
			? this.renderer.toneMappingExposure
			: this._getExposure();

	}

	_getToneMapping() {

		return this.renderer.toneMapping;

	}

	_isAdaptiveSamplingActive() {

		return this._stages.adaptiveSampling?.enabled ?? false;

	}

	_clearDenoiserTextures() {

		const ctx = this.pipeline?.context;
		if ( ! ctx ) return;

		const keys = [
			'asvgf:output', 'asvgf:temporalColor', 'asvgf:variance',
			'variance:output', 'bilateralFiltering:output',
			'edgeFiltering:output', 'ssrc:output',
		];
		keys.forEach( k => ctx.removeTexture( k ) );

	}

	_applyASVGFPreset( presetName ) {

		const preset = ASVGF_QUALITY_PRESETS[ presetName ];
		if ( preset ) this._stages.asvgf?.updateParameters( preset );

	}

}
