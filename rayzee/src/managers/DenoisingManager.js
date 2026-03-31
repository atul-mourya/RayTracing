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
	 * @param {HTMLCanvasElement|null}                 params.denoiserCanvas
	 * @param {import('three').Scene}                  params.scene
	 * @param {import('three').PerspectiveCamera}      params.camera
	 * @param {Object}                                 params.stages     - Named references to pipeline stages
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} params.pipeline
	 * @param {Function}                               params.getExposure       - () => current exposure value
	 * @param {Function}                               params.getSaturation     - () => current saturation value
	 * @param {Function}                               params.getTransparentBg  - () => boolean
	 */
	constructor( { renderer, denoiserCanvas, scene, camera, stages, pipeline, getExposure, getSaturation, getTransparentBg } ) {

		super();

		this.renderer = renderer;
		this.denoiserCanvas = denoiserCanvas;
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

	}

	// ── Private ───────────────────────────────────────────────────

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
