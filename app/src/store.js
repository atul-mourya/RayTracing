import { create } from 'zustand';
import * as THREE from 'three';
import { DEFAULT_STATE, CAMERA_PRESETS, ASVGF_QUALITY_PRESETS, SKY_PRESETS, computeCanvasDimensions } from '@/Constants';
import { ENGINE_DEFAULTS, FINAL_RENDER_CONFIG, PREVIEW_RENDER_CONFIG, VideoRenderManager } from 'rayzee';
import { getApp } from '@/lib/appProxy';
import { VideoEncoderPipeline, checkCodecSupport } from '@/lib/VideoEncoder';

/**
 * Debounce utility - delays function execution until after wait time has elapsed
 * since the last time it was invoked
 */
const debounce = ( func, wait ) => {

	let timeout;
	return function executedFunction( ...args ) {

		const later = () => {

			clearTimeout( timeout );
			func( ...args );

		};

		clearTimeout( timeout );
		timeout = setTimeout( later, wait );

	};

};

const handleChange = ( setter, appUpdater, needsReset = true ) => val => {

	if ( typeof setter !== 'function' ) {

		console.error( "Invalid setter function passed to handleChange:", setter );
		return;

	}

	setter( val );
	const app = getApp();
	if ( app ) {

		appUpdater( val, app );
		needsReset && app.reset();

	}

};

// Main store
const useStore = create( set => ( {
	selectedObject: null,
	setSelectedObject: obj => set( { selectedObject: obj } ),

	// Transform controls
	transformMode: 'translate',
	transformSpace: 'world',
	isTransforming: false,
	setIsTransforming: val => set( { isTransforming: val } ),
	handleTransformModeChange: handleChange(
		val => set( { transformMode: val } ),
		( val, app ) => app.transformManager.setMode( val ),
		false
	),
	handleTransformSpaceChange: handleChange(
		val => set( { transformSpace: val } ),
		( val, app ) => app.transformManager.setSpace( val ),
		false
	),

	loading: { isLoading: false, progress: 0, title: '', status: '' },
	setLoading: state => set( s => ( { loading: { ...s.loading, ...state } } ) ),
	stats: { samples: 0, timeElapsed: 0 },
	setStats: stats => set( { stats } ),
	isDenoising: false,
	setIsDenoising: val => set( { isDenoising: val } ),
	isUpscaling: false,
	setIsUpscaling: val => set( { isUpscaling: val } ),
	upscalingProgress: 0,
	setUpscalingProgress: val => set( { upscalingProgress: val } ),
	isRenderComplete: false,
	setIsRenderComplete: val => set( { isRenderComplete: val } ),
	isRendering: true,
	setIsRendering: val => set( { isRendering: val } ),
	resetLoading: () => set( { loading: { isLoading: false, progress: 0, title: '', status: '' } } ),
	appMode: 'preview',
	setAppMode: mode => set( { appMode: mode } ),
	activeTab: 'pathtracer',
	setActiveTab: tab => set( { activeTab: tab } ),
	layers: [],
	setLayers: layers => set( { layers } ),
	selectedResult: null,
	setSelectedResult: imageData => set( { selectedResult: imageData } ),
	resultsViewportRef: null,
	setResultsViewportRef: ref => set( { resultsViewportRef: ref } ),
	imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 0 },
	setImageProcessingParam: ( param, val ) => set( s => ( { imageProcessing: { ...s.imageProcessing, [ param ]: val } } ) ),
	resetImageProcessing: () => set( { imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 } } ),

	// Enhanced reset function that also triggers immediate update
	handleResetImageProcessing: () => {

		const resetValues = { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 };

		// Update store state
		useStore.setState( { imageProcessing: resetValues } );

		// Apply immediate processing if image processor is available
		const resultsViewport = useStore.getState().resultsViewportRef?.current;
		if ( resultsViewport?.getImageProcessor ) {

			const processor = resultsViewport.getImageProcessor();
			if ( processor ) {

				processor.setParameters( resetValues );
				processor.render();

			}

		}

	},

	// Real-time color correction handlers for immediate visual feedback
	handleImageProcessingParamChange: ( param ) => ( val ) => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;

		// Update store state immediately
		useStore.setState( s => ( {
			imageProcessing: { ...s.imageProcessing, [ param ]: value }
		} ) );

		// Apply immediate processing if image processor is available
		const resultsViewport = useStore.getState().resultsViewportRef?.current;
		if ( resultsViewport?.getImageProcessor ) {

			const processor = resultsViewport.getImageProcessor();
			if ( processor ) {

				// Get current state to ensure we have latest values
				const currentState = useStore.getState().imageProcessing;
				const updatedState = { ...currentState, [ param ]: value };

				// Apply changes immediately without debouncing
				processor.setParameters( updatedState );
				processor.render();

			}

		}

	},
	toggleMeshVisibility: uuid => {

		const app = getApp();
		if ( ! app ) return;

		const scene = app.meshScene || app.scene;
		const object = scene.getObjectByProperty( 'uuid', uuid );
		if ( ! object ) return;

		object.visible = ! object.visible;

		// Update per-mesh visibility buffer (handles parent-chain resolution internally)
		app.updateAllMeshVisibility();

		window.dispatchEvent( new CustomEvent( 'meshVisibilityChanged', {
			detail: { uuid, visible: object.visible }
		} ) );

	},
	setMeshVisibility: ( uuid, visible ) => {

		const app = getApp();
		if ( ! app ) return;

		const scene = app.meshScene || app.scene;
		const object = scene.getObjectByProperty( 'uuid', uuid );
		if ( ! object ) return;

		object.visible = visible;

		// Update per-mesh visibility buffer (handles parent-chain resolution internally)
		app.updateAllMeshVisibility();

		window.dispatchEvent( new CustomEvent( 'meshVisibilityChanged', {
			detail: { uuid, visible }
		} ) );

	},
} ) );

// Assets store
const useAssetsStore = create( set => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [],
	selectedMaterial: null,
	selectedEnvironmentIndex: null,

	// PolyHaven-specific state
	polyHavenMaterials: [],
	polyHavenLoading: false,
	polyHavenResolution: '2k',
	materialsSource: 'current', // 'current' or 'polyhaven'

	// Traditional setters
	setMaterials: materials => set( { materials } ),
	setSelectedMaterial: idx => set( { selectedMaterial: idx } ),
	setActiveTab: tab => set( { activeTab: tab } ),
	setModel: model => set( { model } ),
	setEnvironment: env => set( s => {

		const envStore = useEnvironmentStore.getState();
		const envs = envStore.environments || [];
		const idx = envs.findIndex( e => e.id === env.id );
		return { environment: env, selectedEnvironmentIndex: idx >= 0 ? idx : null };

	} ),
	setSelectedEnvironmentIndex: idx => set( { selectedEnvironmentIndex: idx } ),
	setDebugModel: model => set( { debugModel: model } ),

	// PolyHaven setters
	setPolyHavenMaterials: materials => set( { polyHavenMaterials: materials } ),
	setPolyHavenLoading: loading => set( { polyHavenLoading: loading } ),
	setPolyHavenResolution: resolution => set( { polyHavenResolution: resolution } ),
	setMaterialsSource: source => set( { materialsSource: source } ),
} ) );

// Environment store
const useEnvironmentStore = create( set => ( {
	apiData: null,
	environments: [],
	isLoading: true,
	error: null,
	selectedResolution: '1k',
	setApiData: data => set( { apiData: data } ),
	setEnvironments: envs => set( { environments: envs } ),
	setIsLoading: loading => set( { isLoading: loading } ),
	setError: err => set( { error: err } ),
	setSelectedResolution: res => set( { selectedResolution: res } ),
} ) );

// Path tracer store with handlers
//
// RENDERING MODE ARCHITECTURE:
// This application has a two-level rendering optimization system:
//
// 1. GLOBAL RENDERING MODES (Store Level):
//    - PREVIEW_STATE: Fast preview rendering for interactive scene exploration
//    - FINAL_RENDER_STATE: High-quality rendering for final output
//    - Results mode: View completed renders
//
// 2. DYNAMIC CAMERA OPTIMIZATION (CameraOptimizer Level):
//    - Temporarily reduces quality during camera movement within any global mode
//    - Automatically restores quality when camera movement stops
//    - Provides smooth interaction without interrupting the global rendering quality
//
// MODE VALUES:
//    - 'preview': Uses PREVIEW_STATE configuration
//    - 'final-render': Uses FINAL_RENDER_STATE configuration
//    - 'results': Pauses rendering for viewing completed images
//
// This clean separation eliminates naming confusion and provides clear,
// self-documenting code for the rendering pipeline.

// Aliases for store spreading (single source of truth in EngineDefaults.js)
const FINAL_RENDER_STATE = FINAL_RENDER_CONFIG;
const PREVIEW_STATE = PREVIEW_RENDER_CONFIG;

// Debounced procedural sky texture generation (300ms delay)
// This prevents expensive texture regeneration on every slider movement
const debouncedGenerateProceduralSkyTexture = debounce( () => {

	const app = getApp();
	if ( app ) {

		app.environmentManager.generateProcedural();

	}

}, 10 );

const usePathTracerStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	backgroundIntensity: DEFAULT_STATE.backgroundIntensity,
	performanceModeAdaptive: 'medium',

	adaptiveSamplingMaterialBias: 1.2,
	adaptiveSamplingConvergenceSpeed: 2.0,
	adaptiveSamplingQualityPreset: 'balanced',

	showInspector: false,

	// Auto-exposure computed values (updated in real-time by AutoExposure)
	currentAutoExposure: null,
	currentAvgLuminance: null,

	// Simple setters
	setMaxSamples: val => set( { maxSamples: val } ),
	setEnablePathTracer: val => set( { enablePathTracer: val } ),
	setEnableAccumulation: val => set( { enableAccumulation: val } ),
	setBounces: val => set( { bounces: val } ),
	setSamplesPerPixel: val => set( { samplesPerPixel: val } ),
	setEnableEmissiveTriangleSampling: val => set( { enableEmissiveTriangleSampling: val } ),
	setEmissiveBoost: val => set( { emissiveBoost: val } ),
	setAdaptiveSampling: val => set( { adaptiveSampling: val } ),
	setPerformanceModeAdaptive: val => set( { performanceModeAdaptive: val } ),
	setAdaptiveSamplingMin: val => set( { adaptiveSamplingMin: val } ),
	setAdaptiveSamplingMax: val => set( { adaptiveSamplingMax: val } ),
	setAdaptiveSamplingVarianceThreshold: val => set( { adaptiveSamplingVarianceThreshold: val } ),
	setAdaptiveSamplingMaterialBias: val => set( { adaptiveSamplingMaterialBias: val } ),
	setAdaptiveSamplingEdgeBias: val => set( { adaptiveSamplingEdgeBias: val } ),
	setAdaptiveSamplingConvergenceSpeed: val => set( { adaptiveSamplingConvergenceSpeed: val } ),
	setAdaptiveSamplingQualityPreset: val => set( { adaptiveSamplingQualityPreset: val } ),
	setShowAdaptiveSamplingHelper: val => set( { showAdaptiveSamplingHelper: val } ),
	setShowInspector: val => set( { showInspector: val } ),
	setFireflyThreshold: val => set( { fireflyThreshold: val } ),
	setRenderMode: val => set( { renderMode: val } ),
	setTiles: val => set( { tiles: val } ),
	setTilesHelper: val => set( { tilesHelper: val } ),
	setResolution: val => set( { resolution: parseInt( val, 10 ) } ),
	setOrientation: val => set( { orientation: val } ),
	setFinalRenderResolution: val => set( { finalRenderResolution: parseInt( val, 10 ) } ),
	setEnableOIDN: val => set( { enableOIDN: val } ),
	setRenderLimitMode: val => set( { renderLimitMode: val } ),
	setRenderTimeLimit: val => set( { renderTimeLimit: val } ),
	setDebugMode: val => set( { debugMode: val } ),
	setDebugThreshold: val => set( { debugThreshold: val } ),
	setOidnQuality: val => set( { oidnQuality: val } ),
	setEnableUpscaler: val => set( { enableUpscaler: val } ),
	setUpscalerScale: val => set( { upscalerScale: val } ),
	setUpscalerQuality: val => set( { upscalerQuality: val } ),
	setUpscalerHdr: val => set( { upscalerHdr: val } ),
	setExposure: val => set( { exposure: val } ),
	setSaturation: val => set( { saturation: val } ),
	setEnableEnvironment: val => set( { enableEnvironment: val } ),
	setShowBackground: val => set( { showBackground: val } ),
	setBackgroundIntensity: val => set( { backgroundIntensity: val } ),
	setEnvironmentIntensity: val => set( { environmentIntensity: val } ),
	setEnvironmentRotation: val => set( { environmentRotation: val } ),
	setGIIntensity: val => set( { GIIntensity: val } ),
	setToneMapping: val => set( { toneMapping: val } ),

	// Environment Mode (HDRI, Procedural Sky, Gradient, Color)
	setEnvironmentMode: val => set( { environmentMode: val } ),

	// Gradient Sky
	setGradientZenithColor: val => set( { gradientZenithColor: val } ),
	setGradientHorizonColor: val => set( { gradientHorizonColor: val } ),
	setGradientGroundColor: val => set( { gradientGroundColor: val } ),

	// Solid Color Sky
	setSolidSkyColor: val => set( { solidSkyColor: val } ),

	// Procedural Sky (Preetham Model)
	setSkySunAzimuth: val => set( { skySunAzimuth: val } ),
	setSkySunElevation: val => set( { skySunElevation: val } ),
	setSkySunIntensity: val => set( { skySunIntensity: val } ),
	setSkyRayleighDensity: val => set( { skyRayleighDensity: val } ),
	setSkyTurbidity: val => set( { skyTurbidity: val } ),
	setSkyMieAnisotropy: val => set( { skyMieAnisotropy: val } ),

	setInteractionModeEnabled: val => set( { interactionModeEnabled: val } ),
	setEnableASVGF: val => set( { enableASVGF: val } ),
	setShowAsvgfHeatmap: val => set( { showAsvgfHeatmap: val } ),
	setAsvgfTemporalAlpha: val => set( { asvgfTemporalAlpha: val } ),
	setAsvgfVarianceClip: val => set( { asvgfVarianceClip: val } ),
	setAsvgfMomentClip: val => set( { asvgfMomentClip: val } ),
	setAsvgfPhiColor: val => set( { asvgfPhiColor: val } ),
	setAsvgfPhiNormal: val => set( { asvgfPhiNormal: val } ),
	setAsvgfPhiDepth: val => set( { asvgfPhiDepth: val } ),
	setAsvgfPhiLuminance: val => set( { asvgfPhiLuminance: val } ),
	setAsvgfAtrousIterations: val => set( { asvgfAtrousIterations: val } ),
	setAsvgfFilterSize: val => set( { asvgfFilterSize: val } ),
	setAsvgfVarianceBoost: val => set( { asvgfVarianceBoost: val } ),
	setAsvgfMaxAccumFrames: val => set( { asvgfMaxAccumFrames: val } ),
	setAsvgfDebugMode: val => set( { asvgfDebugMode: val } ),
	setAsvgfPreset: val => set( { asvgfQualityPreset: val } ),

	// Auto-exposure setters
	setAutoExposure: val => set( { autoExposure: val } ),
	setAutoExposureKeyValue: val => set( { autoExposureKeyValue: val } ),
	setAutoExposureMinExposure: val => set( { autoExposureMinExposure: val } ),
	setAutoExposureMaxExposure: val => set( { autoExposureMaxExposure: val } ),
	setAutoExposureAdaptSpeedBright: val => set( { autoExposureAdaptSpeedBright: val } ),
	setAutoExposureAdaptSpeedDark: val => set( { autoExposureAdaptSpeedDark: val } ),
	setCurrentAutoExposure: val => set( { currentAutoExposure: val } ),
	setCurrentAvgLuminance: val => set( { currentAvgLuminance: val } ),

	// Canvas dimension setters
	setAspectRatioPreset: val => set( { aspectRatioPreset: val } ),

	// Denoiser strategy and EdgeAware filter setters
	setDenoiserStrategy: val => set( { denoiserStrategy: val } ),
	setFilterStrength: val => set( { filterStrength: val } ),
	setStrengthDecaySpeed: val => set( { strengthDecaySpeed: val } ),
	setEdgeThreshold: val => set( { edgeThreshold: val } ),

	handleAsvgfQualityPresetChange: handleChange(
		val => set( { asvgfQualityPreset: val } ),
		( val, app ) => {

			const preset = ASVGF_QUALITY_PRESETS[ val ];
			if ( preset && app ) {

				const store = get();

				// Update store state
				Object.entries( preset ).forEach( ( [ key, value ] ) => {

					const setter = `setAsvgf${key.charAt( 0 ).toUpperCase()}${key.slice( 1 )}`;
					if ( store[ setter ] ) {

						store[ setter ]( value );

					}

				} );

				app.denoisingManager.setASVGFParams( preset );
				app.reset();

			}

		}
	),

	handleAsvgfDebugModeChange: handleChange(
		val => set( { asvgfDebugMode: val } ),
		( val, app ) => {

			app.denoisingManager.setASVGFParams( {
				debugMode: parseInt( val ),
				enableDebug: parseInt( val ) > 0
			} );

		},
		false
	),

	// Smart ASVGF configuration based on render mode
	handleConfigureASVGFForMode: ( mode ) => {

		const app = getApp();
		if ( ! app ) return;

		const configs = {
			preview: {
				enabled: false,
				temporalAlpha: 0.5
			},
			progressive: {
				enabled: true,
				temporalAlpha: 0.1,
				atrousIterations: 4
			},
			'final-render': {
				enabled: true,
				temporalAlpha: 0.05,
				atrousIterations: 6
			}
		};

		const config = configs[ mode ];
		if ( config ) {

			app.denoisingManager.configureASVGFForMode( config );

		}

	},

	applyAdaptiveSamplingQualityPreset( app, preset ) {

		const presets = {
			performance: {
				adaptiveSamplingMin: 1,
				adaptiveSamplingMax: 4,
				adaptiveSamplingVarianceThreshold: 0.2,
				adaptiveSamplingMaterialBias: 1.0,
				adaptiveSamplingConvergenceSpeed: 3.0 // aggressive convergence (scales threshold up)
			},
			balanced: {
				adaptiveSamplingMin: 2,
				adaptiveSamplingMax: 8,
				adaptiveSamplingVarianceThreshold: 0.1,
				adaptiveSamplingMaterialBias: 1.2,
				adaptiveSamplingConvergenceSpeed: 2.0
			},
			quality: {
				adaptiveSamplingMin: 4,
				adaptiveSamplingMax: 16,
				adaptiveSamplingVarianceThreshold: 0.05,
				adaptiveSamplingMaterialBias: 1.5,
				adaptiveSamplingConvergenceSpeed: 1.0 // conservative convergence
			}
		};

		const settings = presets[ preset ];
		if ( settings && app ) {

			// Update store state
			Object.entries( settings ).forEach( ( [ key, value ] ) => {

				const setter = `set${key.charAt( 0 ).toUpperCase()}${key.slice( 1 )}`;
				if ( get()[ setter ] ) {

					get()[ setter ]( value );

				}

			} );

			// Sync with engine
			app.settings.set( 'adaptiveSamplingMax', settings.adaptiveSamplingMax );
			app.denoisingManager.setAdaptiveSamplingParams( { min: settings.adaptiveSamplingMin } );
			app.denoisingManager.setAdaptiveSamplingParams( {
				threshold: settings.adaptiveSamplingVarianceThreshold,
				materialBias: settings.adaptiveSamplingMaterialBias,
				convergenceSpeedUp: settings.adaptiveSamplingConvergenceSpeed,
			} );

		}

	},

	// Handlers
	handlePathTracerChange: handleChange(
		val => set( { enablePathTracer: val } ),
		( val, app ) => {

			app.pathTracerEnabled = val;

		}
	),

	handleAccumulationChange: handleChange(
		val => set( { enableAccumulation: val } ),
		( val, app ) => app.stages.pathTracer?.setAccumulationEnabled( val )
	),

	handleBouncesChange: val => {

		set( { bounces: val } );
		getApp()?.settings.set( 'maxBounces', val );

	},

	handleSamplesPerPixelChange: val => {

		set( { samplesPerPixel: val } );
		getApp()?.settings.set( 'samplesPerPixel', val );

	},

	handleTransmissiveBouncesChange: val => {

		set( { transmissiveBounces: val } );
		getApp()?.settings.set( 'transmissiveBounces', val );

	},

	handleEnableEmissiveTriangleSamplingChange: val => {

		set( { enableEmissiveTriangleSampling: val } );
		getApp()?.settings.set( 'enableEmissiveTriangleSampling', val );

	},

	handleEmissiveBoostChange: val => {

		set( { emissiveBoost: val } );
		getApp()?.settings.set( 'emissiveBoost', val );

	},

	// --- Output dimension handlers (resolution + aspect ratio + orientation) ---

	// Helper: recompute canvas dims from current state and apply to app
	_applyCanvasDimensions: ( overrides = {} ) => {

		const state = { ...get(), ...overrides };
		const res = state.appMode === 'final-render' ? state.finalRenderResolution : state.resolution;
		const { width, height } = computeCanvasDimensions( res, state.aspectRatioPreset, state.orientation );

		set( { ...overrides, canvasWidth: width, canvasHeight: height } );

		const app = getApp();
		if ( app ) {

			app.setCanvasSize( width, height );
			app.reset();

		}

	},

	handleResolutionChange: ( val ) => {

		const resolution = parseInt( val, 10 );
		get()._applyCanvasDimensions( { resolution } );

	},

	handleAspectPresetChange: ( preset ) => {

		get()._applyCanvasDimensions( { aspectRatioPreset: preset } );

	},

	handleOrientationToggle: () => {

		const current = get().orientation;
		get()._applyCanvasDimensions( { orientation: current === 'landscape' ? 'portrait' : 'landscape' } );

	},

	handleFinalRenderResolutionChange: ( val ) => {

		const finalRes = parseInt( val, 10 );
		const state = get();
		const { width, height } = computeCanvasDimensions( finalRes, state.aspectRatioPreset, state.orientation );

		set( { finalRenderResolution: finalRes, canvasWidth: width, canvasHeight: height } );

		const app = getApp();
		if ( app ) {

			app.setCanvasSize( width, height );
			app.reset();

		}

	},

	handleAdaptiveSamplingChange: handleChange(
		val => set( { adaptiveSampling: val } ),
		( val, app ) => app.denoisingManager.setAdaptiveSampling( val ),
		false // engine method handles reset internally
	),

	handleAdaptiveSamplingMinChange: handleChange(
		val => set( { adaptiveSamplingMin: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAdaptiveSamplingParams( { min: v } );

		}
	),

	handleAdaptiveSamplingMaxChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { adaptiveSamplingMax: v } );
		getApp()?.settings.set( 'adaptiveSamplingMax', v );

	},

	handleAdaptiveSamplingVarianceThresholdChange: handleChange(
		val => set( { adaptiveSamplingVarianceThreshold: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAdaptiveSamplingParams( { varianceThreshold: v } );

		}
	),

	handleAdaptiveSamplingHelperToggle: handleChange(
		val => set( { showAdaptiveSamplingHelper: val } ),
		( val, app ) => app.denoisingManager.toggleAdaptiveSamplingHelper( val )
	),

	handleInspectorToggle: async val => {

		set( { showInspector: val } );
		const app = getApp();
		if ( ! app ) return;

		if ( val && ! app._inspector ) {

			const { Inspector } = await import( 'three/addons/inspector/Inspector.js' );
			const inspector = new Inspector();
			// Vite dev server serves index.html (not JSON) for raw fetches of files
			// under node_modules, which breaks the Inspector's extensions probe.
			inspector.settings._getExtensions = async () => [];
			// Mount to <body> so the profiler panel escapes the viewport wrapper's
			// `transform: scale()` (which re-parents `position: fixed` children).
			document.body.appendChild( inspector.domElement );
			app.renderer.inspector = inspector;
			app._inspector = inspector;

		}

		// Toggle DOM visibility directly — Inspector.show()/.hide() in r184 call
		// Profiler.show(tab) which requires a tab argument and throws otherwise.
		if ( app._inspector ) {

			app._inspector.domElement.style.display = val ? '' : 'none';

		}

	},

	handleAdaptiveSamplingMaterialBiasChange: handleChange(
		val => set( { adaptiveSamplingMaterialBias: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAdaptiveSamplingParams( { materialBias: v } );

		}
	),

	handleAdaptiveSamplingEdgeBiasChange: handleChange(
		val => set( { adaptiveSamplingEdgeBias: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAdaptiveSamplingParams( { edgeBias: v } );

		}
	),

	handleAdaptiveSamplingConvergenceSpeedChange: handleChange(
		val => set( { adaptiveSamplingConvergenceSpeed: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAdaptiveSamplingParams( { convergenceSpeed: v } );

		}
	),

	handleAdaptiveSamplingQualityPresetChange: handleChange(
		val => set( { adaptiveSamplingQualityPreset: val } ),
		( val, app ) => {

			get().applyAdaptiveSamplingQualityPreset( app, val );

		}
	),

	handleFireflyThresholdChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { fireflyThreshold: v } );
		getApp()?.settings.set( 'fireflyThreshold', v );

	},

	handleEnableAlphaShadowsChange: val => {

		set( { enableAlphaShadows: val } );
		getApp()?.settings.set( 'enableAlphaShadows', val );

	},

	handleRenderModeChange: handleChange(
		val => set( { renderMode: val } ),
		( val, app ) => {

			app.stages.pathTracer?.setUniform( 'renderMode', parseInt( val ) );

			const { tilesHelper } = get();
			if ( parseInt( val ) === 1 && tilesHelper ) {

				app.denoisingManager.setTileHelperEnabled( true );

			} else if ( parseInt( val ) !== 1 ) {

				app.denoisingManager.setTileHelperEnabled( false );

			}

		}
	),

	handleTileUpdate: handleChange(
		val => set( { tiles: val } ),
		( val, app ) => {

			const tileCount = val[ 0 ];

			// Validate tile count before applying
			if ( tileCount < 1 || tileCount > 10 ) {

				console.warn( `Store: Tile count ${tileCount} is outside recommended range (1-10)` );

			}

			app.stages.pathTracer?.tileManager?.setTileCount( tileCount );

		},
		false
	),

	handleTileHelperToggle: handleChange(
		val => set( { tilesHelper: val } ),
		( val, app ) => {

			app.denoisingManager.setTileHelperEnabled( val );

		},
		false
	),

	handleEnableOIDNChange: handleChange(
		val => set( { enableOIDN: val } ),
		( val, app ) => app.denoisingManager.setOIDNEnabled( val ),
		false
	),

	handleOidnQualityChange: handleChange(
		val => set( { oidnQuality: val } ),
		( val, app ) => app.denoisingManager.setOIDNQuality( val ),
		false
	),

	handleEnableUpscalerChange: handleChange(
		val => set( { enableUpscaler: val } ),
		( val, app ) => app.denoisingManager.setUpscalerEnabled( val ),
		false
	),

	handleUpscalerScaleChange: handleChange(
		val => set( { upscalerScale: Number( val ) } ),
		( val, app ) => app.denoisingManager.setUpscalerScaleFactor( Number( val ) ),
		false
	),

	handleUpscalerQualityChange: handleChange(
		val => set( { upscalerQuality: val } ),
		( val, app ) => app.denoisingManager.setUpscalerQuality( val ),
		false
	),

	// Denoiser strategy and EdgeAware filter handlers
	handleDenoiserStrategyChange: handleChange(
		val => set( { denoiserStrategy: val, enableASVGF: val === 'asvgf' } ),
		( val, app ) => app.denoisingManager.setStrategy( val, get().asvgfQualityPreset ),
		false // engine method handles reset internally
	),

	handleFilterStrengthChange: handleChange(
		val => set( { filterStrength: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setEdgeAwareParams( { filterStrength: value } );

		},
		true
	),

	handleStrengthDecaySpeedChange: handleChange(
		val => set( { strengthDecaySpeed: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setEdgeAwareParams( { strengthDecaySpeed: value } );

		},
		true
	),

	handleEdgeThresholdChange: handleChange(
		val => set( { edgeThreshold: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setEdgeAwareParams( { edgeThreshold: value } );

		},
		true
	),

	// ─── SSRC handlers ───
	handleSsrcTemporalAlphaChange: handleChange(
		val => set( { ssrcTemporalAlpha: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setSSRCParams( { temporalAlpha: val[ 0 ] } ),
		false
	),

	handleSsrcSpatialRadiusChange: handleChange(
		val => set( { ssrcSpatialRadius: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setSSRCParams( { spatialRadius: val[ 0 ] } ),
		false
	),

	handleSsrcSpatialWeightChange: handleChange(
		val => set( { ssrcSpatialWeight: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setSSRCParams( { spatialWeight: val[ 0 ] } ),
		false
	),

	handleDebugThresholdChange: val => {

		set( { debugThreshold: val } );
		getApp()?.settings.set( 'debugVisScale', val[ 0 ] );

	},

	handleDebugModeChange: val => {

		set( { debugMode: val } );
		const mode = {
			'1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
			'6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11,
			'12': 12, '13': 13, '14': 14, '15': 15,
		}[ val ] || 0;
		getApp()?.settings.set( 'visMode', mode );

	},

	handleExposureChange: val => {

		// Slider component emits [number]; unwrap so settings.set receives a scalar.
		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { exposure: v } );
		getApp()?.settings.set( 'exposure', v );

	},

	handleSaturationChange: handleChange(
		val => set( { saturation: val } ),
		( val, app ) => app.settings.set( 'saturation', val ),
		false
	),

	// Auto-exposure handlers
	handleAutoExposureChange: handleChange(
		val => set( { autoExposure: val } ),
		( val, app ) => app.denoisingManager.setAutoExposure( val ),
		false // engine method handles reset internally
	),

	handleAutoExposureKeyValueChange: handleChange(
		val => set( { autoExposureKeyValue: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAutoExposureParams( { keyValue: value } );

		},
		true
	),

	handleAutoExposureMinExposureChange: handleChange(
		val => set( { autoExposureMinExposure: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAutoExposureParams( { minExposure: value } );

		},
		true
	),

	handleAutoExposureMaxExposureChange: handleChange(
		val => set( { autoExposureMaxExposure: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.denoisingManager.setAutoExposureParams( { maxExposure: value } );

		},
		true
	),

	handleAutoExposureAdaptSpeedChange: handleChange(
		val => set( { autoExposureAdaptSpeedBright: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			// Maintain ratio between bright and dark adaptation (6:1)
			app.denoisingManager.setAutoExposureParams( {
				adaptSpeedBright: value,
				adaptSpeedDark: value / 6.0
			} );

		},
		true
	),

	handleEnableEnvironmentChange: val => {

		set( { enableEnvironment: val } );
		getApp()?.settings.set( 'enableEnvironment', val );

	},

	handleShowBackgroundChange: val => {

		set( { showBackground: val } );
		const app = getApp();
		if ( app ) {

			if ( app.scene ) app.scene.background = val ? app.scene.environment : null;
			app.settings.set( 'showBackground', val );

		}

	},

	handleTransparentBackgroundChange: val => {

		const app = getApp();
		if ( val ) {

			set( { transparentBackground: val, showBackground: false } );
			if ( app ) {

				if ( app.scene ) app.scene.background = null;
				app.settings.setMany( { showBackground: false, transparentBackground: val } );

			}

		} else {

			set( { transparentBackground: val } );
			app?.settings.set( 'transparentBackground', val );

		}

	},

	handleBackgroundIntensityChange: val => {

		set( { backgroundIntensity: val } );
		getApp()?.settings.set( 'backgroundIntensity', val );

	},

	handleEnvironmentIntensityChange: val => {

		set( { environmentIntensity: val } );
		getApp()?.settings.set( 'environmentIntensity', val );

	},

	handleEnvironmentRotationChange: val => {

		set( { environmentRotation: val } );
		getApp()?.settings.set( 'environmentRotation', val[ 0 ] );

	},

	handleGIIntensityChange: val => {

		set( { GIIntensity: val } );
		getApp()?.settings.set( 'globalIlluminationIntensity', val );

	},

	// Environment Mode Handlers
	handleEnvironmentModeChange: ( val ) => {

		set( { environmentMode: val } );
		const app = getApp();
		if ( app ) app.environmentManager.setMode( val );

	},

	// Gradient Sky Handlers
	handleGradientZenithColorChange: handleChange(
		val => set( { gradientZenithColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientZenithColor.copy( color );
			app.environmentManager.generateGradient();

		}
	),

	handleGradientHorizonColorChange: handleChange(
		val => set( { gradientHorizonColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientHorizonColor.copy( color );
			app.environmentManager.generateGradient();

		}
	),

	handleGradientGroundColorChange: handleChange(
		val => set( { gradientGroundColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientGroundColor.copy( color );
			app.environmentManager.generateGradient();

		}
	),

	// Solid Color Sky Handler
	handleSolidSkyColorChange: handleChange(
		val => set( { solidSkyColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'color' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.solidSkyColor.copy( color );
			app.environmentManager.generateSolid();

		}
	),

	// Procedural Sky (Preetham Model) Handlers
	handleSkySunAzimuthChange: handleChange(
		val => set( { skySunAzimuth: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;

			// Update sun direction based on azimuth and elevation
			const azimuth = val * ( Math.PI / 180 );
			const elevation = get().skySunElevation * ( Math.PI / 180 );
			const sunDir = new THREE.Vector3(
				Math.cos( elevation ) * Math.sin( azimuth ),
				Math.sin( elevation ),
				Math.cos( elevation ) * Math.cos( azimuth )
			).normalize();

			envParams.skySunDirection.copy( sunDir );
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkySunElevationChange: handleChange(
		val => set( { skySunElevation: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;

			// Update sun direction based on azimuth and elevation
			const azimuth = get().skySunAzimuth * ( Math.PI / 180 );
			const elevation = val * ( Math.PI / 180 );
			const sunDir = new THREE.Vector3(
				Math.cos( elevation ) * Math.sin( azimuth ),
				Math.sin( elevation ),
				Math.cos( elevation ) * Math.cos( azimuth )
			).normalize();

			envParams.skySunDirection.copy( sunDir );
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkySunIntensityChange: handleChange(
		val => set( { skySunIntensity: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			envParams.skySunIntensity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkyRayleighDensityChange: handleChange(
		val => set( { skyRayleighDensity: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			envParams.skyRayleighDensity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkyTurbidityChange: handleChange(
		val => set( { skyTurbidity: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			envParams.skyTurbidity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),


	handleSkyMieAnisotropyChange: handleChange(
		val => set( { skyMieAnisotropy: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			envParams.skyMieAnisotropy = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkyPresetChange: handleChange(
		val => set( { skyPreset: val } ),
		val => {

			const preset = SKY_PRESETS[ val ];
			if ( ! preset ) return;

			const store = get();

			// Update all parameters using handlers (which update both store AND uniforms)
			store.handleSkySunAzimuthChange( [ preset.sunAzimuth ] );
			store.handleSkySunElevationChange( [ preset.sunElevation ] );
			store.handleSkySunIntensityChange( [ preset.sunIntensity ] );
			store.handleSkyRayleighDensityChange( [ preset.rayleighDensity ] );
			store.handleSkyTurbidityChange( [ preset.turbidity ] );

		}
	),

	handleToneMappingChange: handleChange(
		val => set( { toneMapping: val } ),
		( val, app ) => {

			app.renderer.toneMapping = parseInt( val );
			app.reset();

		}
	),

	handleRenderLimitModeChange: val => {

		set( { renderLimitMode: val } );
		getApp()?.settings.set( 'renderLimitMode', val );

	},

	handleRenderTimeLimitChange: val => {

		set( { renderTimeLimit: val } );
		getApp()?.settings.set( 'renderTimeLimit', parseFloat( val ) );

	},

	handleInteractionModeEnabledChange: handleChange(
		val => set( { interactionModeEnabled: val } ),
		( val, app ) => app.stages.pathTracer?.setInteractionModeEnabled( val ),
		false // Don't reset - exitInteractionMode handles the soft reset internally
	),

	handleAsvgfTemporalAlphaChange: handleChange(
		val => set( { asvgfTemporalAlpha: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setASVGFParams( { temporalAlpha: val[ 0 ] } ),
		false
	),

	handleAsvgfPhiColorChange: handleChange(
		val => set( { asvgfPhiColor: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setASVGFParams( { phiColor: val[ 0 ] } ),
		false
	),

	handleEnableASVGFChange: handleChange(
		val => set( { enableASVGF: val } ),
		( val, app ) => app.denoisingManager.setASVGFEnabled( val, get().asvgfQualityPreset ),
		false
	),

	handleShowAsvgfHeatmapChange: handleChange(
		val => set( { showAsvgfHeatmap: val } ),
		( val, app ) => app.denoisingManager.toggleASVGFHeatmap( val )
	),

	handleAsvgfPhiLuminanceChange: handleChange(
		val => set( { asvgfPhiLuminance: val } ),
		( val, app ) => app.denoisingManager.setASVGFParams( { phiLuminance: val[ 0 ] } ),
		false
	),

	handleAsvgfAtrousIterationsChange: handleChange(
		val => set( { asvgfAtrousIterations: val[ 0 ] } ),
		( val, app ) => app.denoisingManager.setASVGFParams( { atrousIterations: val[ 0 ] } ),
		false
	),

	// Canvas configuration handlers
	handleConfigureForPreview: () => {

		set( { ...PREVIEW_STATE, isRendering: true } );

		const app = getApp();
		if ( ! app ) return;

		const state = get();
		const { width, height } = computeCanvasDimensions( state.resolution, state.aspectRatioPreset, state.orientation );
		set( { canvasWidth: width, canvasHeight: height } );

		app.configureForMode( 'preview', { canvasWidth: width, canvasHeight: height } );

	},

	handleConfigureForFinalRender: () => {

		set( { ...FINAL_RENDER_STATE, isRendering: true } );

		const app = getApp();
		if ( ! app ) return;

		const state = get();
		const { width, height } = computeCanvasDimensions( state.finalRenderResolution, state.aspectRatioPreset, state.orientation );
		set( { canvasWidth: width, canvasHeight: height } );

		app.configureForMode( 'final-render', { canvasWidth: width, canvasHeight: height } );

	},

	handleConfigureForResults: () => {

		const app = getApp();
		if ( ! app ) return;
		app.configureForMode( 'results' );
		set( { isRendering: false } );

	},

	handleModeChange: mode => {

		const actions = {
			preview: 'handleConfigureForPreview',
			'final-render': 'handleConfigureForFinalRender',
			results: 'handleConfigureForResults'
		};
		const action = actions[ mode ];
		action ? get()[ action ]() : console.warn( `Unknown mode: ${mode}` );

	},
} ) );

// Light store
const useLightStore = create( set => ( {
	...DEFAULT_STATE,
	showLightHelper: DEFAULT_STATE.showLightHelper,
	lights: [],
	selectedLightIndex: null,
	setSelectedLightIndex: idx => set( { selectedLightIndex: idx } ),
	setLights: lights => set( { lights } ),
	updateLight: ( idx, prop, val ) => set( s => {

		const lights = [ ...s.lights ];
		if ( ! lights[ idx ] ) return s;

		// Handle array values (from sliders)
		const value = Array.isArray( val ) ? val[ 0 ] : val;
		lights[ idx ][ prop ] = value;

		// Update the actual Three.js light object
		const app = getApp();

		if ( app ) {

			const light = app.scene.getObjectByProperty( 'uuid', lights[ idx ].uuid );
			if ( light ) {

				if ( prop === 'intensity' ) {

					light.intensity = value;

				} else if ( prop === 'color' ) {

					light.color.set( value );

				} else if ( prop === 'position' ) {

					const pos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
					light.position.set( ...pos );

				} else if ( prop === 'angle' ) {

					if ( light.type === 'DirectionalLight' || light.type === 'SpotLight' ) {

						// Convert degrees to radians for Three.js
						light.angle = value * ( Math.PI / 180 );

					}

				} else if ( prop === 'target' ) {

					if ( light.type === 'SpotLight' ) {

						const targetPos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
						light.target.position.set( ...targetPos );
						light.target.updateMatrixWorld();

					} else if ( light.type === 'RectAreaLight' ) {

						const targetPos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
						light.lookAt( ...targetPos );
						light.updateMatrixWorld();

					}

				} else if ( prop === 'width' || prop === 'height' ) {

					if ( light.type === 'RectAreaLight' ) {

						light[ prop ] = value;

					}

				}

				if ( app.lightManager?.sync ) {

					app.lightManager.sync();

				}

				app.reset();

			}

		}

		return { lights };

	} ),

	// Add angle support for directional lights
	updateDirectionalLightAngle: ( idx, angle ) => set( s => {

		const lights = [ ...s.lights ];
		if ( lights[ idx ] && lights[ idx ].type === 'DirectionalLight' ) {

			lights[ idx ].angle = angle;

		}

		return { lights };

	} ),

	// Add light to scene
	addLight: ( lightType ) => {

		const app = getApp();
		if ( ! app ) return;

		const newLight = app.lightManager.add( lightType );
		if ( newLight ) {

			set( s => ( { lights: [ ...s.lights, newLight ], selectedLightIndex: s.lights.length } ) );
			window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		}

	},

	// Remove light from scene
	removeLight: ( lightIndex ) => {

		const app = getApp();
		if ( ! app ) return;

		set( s => {

			if ( lightIndex < 0 || lightIndex >= s.lights.length ) return s;

			const lightToRemove = s.lights[ lightIndex ];
			const success = app.lightManager.remove( lightToRemove.uuid );

			if ( success ) {

				window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );
				const newLights = s.lights.filter( ( _, idx ) => idx !== lightIndex );
				let newSelected = s.selectedLightIndex;
				if ( newSelected === lightIndex ) {

					newSelected = newLights.length > 0 ? Math.min( lightIndex, newLights.length - 1 ) : null;

				} else if ( newSelected !== null && newSelected > lightIndex ) {

					newSelected = newSelected - 1;

				}

				return { lights: newLights, selectedLightIndex: newSelected };

			}

			return s;

		} );

	},

	// Toggle area light helper visibility
	handleShowLightHelperChange: ( val ) => {

		set( { showLightHelper: val } );
		const app = getApp();
		if ( app ) {

			app.lightManager.showHelpers( val );

		}

	},

	// Clear all lights
	clearAllLights: () => {

		const app = getApp();
		if ( ! app ) return;

		app.lightManager.clear();
		set( { lights: [], selectedLightIndex: null } );
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

	},
} ) );

// Camera store
const useCameraStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	activePreset: "product",
	cameraNames: [],
	selectedCameraIndex: 0,
	focusMode: false,
	selectMode: false,

	// Auto-focus state
	autoFocusMode: DEFAULT_STATE.autoFocusMode,
	afScreenPoint: { ...DEFAULT_STATE.afScreenPoint },
	afSmoothingFactor: DEFAULT_STATE.afSmoothingFactor,
	afPlacingPoint: false,

	setCameraNames: names => set( { cameraNames: names } ),
	setSelectedCameraIndex: idx => set( { selectedCameraIndex: idx } ),
	setFocusMode: mode => set( { focusMode: mode } ),
	setSelectMode: mode => set( { selectMode: mode } ),
	setAutoFocusDistance: val => set( { focusDistance: val } ),
	setFov: val => set( { fov: val, activePreset: "custom" } ),
	setFocusDistance: val => set( { focusDistance: val, activePreset: "custom" } ),
	setAperture: val => set( { aperture: val, activePreset: "custom" } ),
	setFocalLength: val => set( { focalLength: val, activePreset: "custom" } ),
	setEnableDOF: val => set( { enableDOF: val, activePreset: "custom" } ),
	setZoomToCursor: val => set( { zoomToCursor: val } ),
	setPreset: key => {

		if ( key === "custom" ) return;
		const preset = CAMERA_PRESETS[ key ];
		set( { ...preset, activePreset: key } );

	},

	handleToggleFocusMode: () => {

		const { autoFocusMode } = get();
		if ( autoFocusMode !== 'manual' ) return; // Block when auto-focus active
		const app = getApp();
		if ( ! app ) return;
		const isActive = app.interactionManager.toggleFocusMode();
		console.log( 'Focus mode:', isActive ? 'enabled' : 'disabled' );
		set( { focusMode: isActive } );

	},

	handleToggleSelectMode: () => {

		const app = getApp();
		if ( ! app ) return;

		const isActive = app.interactionManager.toggleSelectMode();
		set( { selectMode: isActive } );

	},

	handleEnableDOFChange: val => {

		set( { enableDOF: val, activePreset: "custom" } );
		getApp()?.settings.set( 'enableDOF', val );

	},

	handleZoomToCursorChange: val => {

		set( { zoomToCursor: val } );
		const app = getApp();
		if ( app?.cameraManager?.controls ) {

			app.cameraManager.controls.zoomToCursor = val;

		}

	},

	handleFocusDistanceChange: val => {

		set( { focusDistance: val, activePreset: "custom", autoFocusMode: 'manual' } );
		const app = getApp();
		if ( app ) {

			const scale = app.assetLoader?.getSceneScale() || 1.0;
			app.settings.set( 'focusDistance', val * scale );
			app.cameraManager.setAutoFocusMode( 'manual' );
			app.reset();

		}

	},

	handleAutoFocusModeChange: mode => {

		set( { autoFocusMode: mode, afPlacingPoint: false } );
		getApp()?.cameraManager.setAutoFocusMode( mode );

	},

	handleAFScreenPointChange: point => {

		set( { afScreenPoint: point, afPlacingPoint: false } );
		const app = getApp();
		if ( app ) {

			app.cameraManager.setAFScreenPoint( point.x, point.y );
			app.wake();

		}

	},

	handleAFResetToCenter: () => {

		const center = { x: 0.5, y: 0.5 };
		set( { afScreenPoint: center } );
		const app = getApp();
		if ( app ) {

			app.cameraManager.setAFScreenPoint( 0.5, 0.5 );
			app.wake();

		}

	},

	handleAFSmoothingChange: val => {

		set( { afSmoothingFactor: val } );
		const cm = getApp()?.cameraManager;
		if ( cm ) cm.afSmoothingFactor = val;

	},

	handleToggleAFPointPlacement: () => {

		const current = get().afPlacingPoint;
		set( { afPlacingPoint: ! current } );
		const cm = getApp()?.cameraManager;
		if ( cm ) {

			if ( ! current ) {

				cm.enterAFPointPlacementMode();

			} else {

				cm.exitAFPointPlacementMode();

			}

		}

	},

	handlePresetChange: key => {

		if ( key === "custom" ) {

			set( { activePreset: "custom" } );
			return;

		}

		const preset = CAMERA_PRESETS[ key ];
		const presetApertureScale = preset.apertureScale ?? 1.0;
		const presetAnamorphicRatio = preset.anamorphicRatio ?? 1.0;
		set( { ...preset, apertureScale: presetApertureScale, anamorphicRatio: presetAnamorphicRatio, activePreset: key } );

		const app = getApp();
		if ( app ) {

			const isAutoFocus = get().autoFocusMode === 'auto';

			app.cameraManager.active.fov = preset.fov;
			app.cameraManager.active.updateProjectionMatrix();

			const updates = {
				aperture: preset.aperture,
				focalLength: preset.focalLength,
				apertureScale: presetApertureScale,
				anamorphicRatio: presetAnamorphicRatio,
			};

			// Skip focus distance when auto-focus is active — it will recompute
			if ( ! isAutoFocus ) {

				const scale = app.assetLoader?.getSceneScale() || 1.0;
				updates.focusDistance = preset.focusDistance * scale;

			}

			app.settings.setMany( updates );

		}

	},

	handleFovChange: val => {

		const app = getApp();
		if ( app ) {

			const oldFov = app.cameraManager.active.fov;
			const target = app.cameraManager.controls.target.clone();
			const oldDistance = app.cameraManager.active.position.distanceTo( target );

			// Keep perceived size constant: distance * tan(fov/2) = constant
			const newDistance = oldDistance * Math.tan( oldFov * Math.PI / 360 ) / Math.tan( val * Math.PI / 360 );

			// Move camera along the orbit direction
			const direction = app.cameraManager.active.position.clone().sub( target ).normalize();
			app.cameraManager.active.position.copy( target ).addScaledVector( direction, newDistance );

			app.cameraManager.active.fov = val;
			app.cameraManager.active.updateProjectionMatrix();
			app.cameraManager.controls.update();
			app.reset();

		}

		set( { fov: val, activePreset: "custom" } );

	},

	handleApertureChange: val => {

		set( { aperture: val, activePreset: "custom" } );
		getApp()?.settings.set( 'aperture', val );

	},

	handleFocalLengthChange: val => {

		set( { focalLength: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.settings.set( 'focalLength', val );
			if ( val <= 0 ) app.settings.set( 'aperture', 16.0 );

		}

	},

	handleCameraMove: point => {

		const app = getApp();
		if ( ! app?.cameraManager?.controls ) return;
		const controls = app.cameraManager.controls;
		const camera = app.cameraManager.camera;
		const target = controls.target.clone();
		const distance = camera.position.distanceTo( target );
		const remap = ( val, inMin, inMax, outMin, outMax ) => ( val - inMin ) * ( outMax - outMin ) / ( inMax - inMin ) + outMin;
		const phi = remap( point.y, 0, 100, 0, - Math.PI );
		const theta = remap( point.x, 0, 100, 0, - Math.PI );
		const newX = target.x + distance * Math.sin( phi ) * Math.cos( theta );
		const newY = target.y + distance * Math.cos( phi );
		const newZ = target.z + distance * Math.sin( phi ) * Math.sin( theta );
		camera.position.set( newX, newY, newZ );
		camera.lookAt( target );
		controls.update();

	},

	handleCameraChange: idx => {

		const app = getApp();
		if ( app ) {

			const index = Number( idx );
			app.cameraManager.switchCamera( index );
			set( { selectedCameraIndex: index } );

		}

	},

	handleApertureScaleChange: val => {

		set( { apertureScale: val, activePreset: "custom" } );
		getApp()?.settings.set( 'apertureScale', val );

	},

	handleAnamorphicRatioChange: val => {

		set( { anamorphicRatio: val, activePreset: "custom" } );
		getApp()?.settings.set( 'anamorphicRatio', val );

	},

	handleFocusChangeEvent: event => set( { focusDistance: event.distance, focusMode: false, activePreset: "custom", autoFocusMode: 'manual' } ),

} ) );

// Material store
const useMaterialStore = create( ( set, get ) => ( {
	updateMaterialProperty: ( prop, val ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		try {

			obj.material[ prop ] = val;
			obj.material.needsUpdate = true;

			const idx = obj.userData?.materialIndex ?? 0;
			const app = getApp();
			if ( ! app ) {

				console.warn( "Path tracer not available" );
				return;

			}

			app.setMaterialProperty( idx, prop, val );


		} catch ( error ) {

			console.error( `Error updating material property ${prop}:`, error );

		}

	},

	// Texture property handlers - update texture transforms in material data texture
	handleTextureOffsetChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].offset.set( value.x, value.y );
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture offset for ${textureName}:`, error );

		}

	},

	handleTextureRepeatChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].repeat.set( value.x, value.y );
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture repeat for ${textureName}:`, error );

		}

	},

	handleTextureFlipYChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].flipY = value;
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture flipY for ${textureName}:`, error );

		}

	},

	handleTextureRotationChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].rotation = value * Math.PI / 180; // Convert degrees to radians
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture rotation for ${textureName}:`, error );

		}

	},

	updateTextureTransform: ( textureName, texture ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material ) return;

		const materialIndex = obj.userData?.materialIndex ?? 0;
		const app = getApp();

		if ( ! app ) {

			console.warn( "Path tracer not available" );
			return;

		}

		// Create transform matrix from texture properties
		const transform = new Float32Array( 9 ); // 3x3 matrix
		const sx = texture.repeat.x;
		const sy = texture.repeat.y;
		const ox = texture.offset.x;
		const oy = texture.offset.y;
		const rotation = texture.rotation ?? 0; // rotation in radians

		// Calculate rotation matrix components
		const cos = Math.cos( rotation );
		const sin = Math.sin( rotation );

		// Combined transform matrix with rotation, scale, and offset
		// T * R * S where T = translation, R = rotation, S = scale
		// [sx*cos  -sx*sin  ox]
		// [sy*sin   sy*cos  oy]
		// [0        0       1 ]
		transform[ 0 ] = sx * cos; // m00
		transform[ 1 ] = - sx * sin; // m01
		transform[ 2 ] = ox; // m02
		transform[ 3 ] = sy * sin; // m10
		transform[ 4 ] = sy * cos; // m11
		transform[ 5 ] = oy; // m12
		transform[ 6 ] = 0; // m20
		transform[ 7 ] = 0; // m21
		transform[ 8 ] = 1; // m22

		// Update the appropriate transform in material data texture
		app.setTextureTransform( materialIndex, textureName, transform );

	},

	// Material handlers (shortened)
	handleColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.color ) {

			obj.material.color.set( val );
			get().updateMaterialProperty( 'color', obj.material.color );

		}

	},
	handleRoughnessChange: val => get().updateMaterialProperty( 'roughness', val[ 0 ] ),
	handleMetalnessChange: val => get().updateMaterialProperty( 'metalness', val[ 0 ] ),
	handleIorChange: val => get().updateMaterialProperty( 'ior', val[ 0 ] ),
	handleTransmissionChange: val => get().updateMaterialProperty( 'transmission', val[ 0 ] ),
	handleThicknessChange: val => get().updateMaterialProperty( 'thickness', val[ 0 ] ),
	handleAttenuationColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.attenuationColor ) {

			obj.material.attenuationColor.set( val );
			get().updateMaterialProperty( 'attenuationColor', obj.material.attenuationColor );

		}

	},
	handleAttenuationDistanceChange: val => get().updateMaterialProperty( 'attenuationDistance', val ),
	handleDispersionChange: val => get().updateMaterialProperty( 'dispersion', val[ 0 ] ),
	handleEmissiveIntensityChange: val => get().updateMaterialProperty( 'emissiveIntensity', val[ 0 ] ),
	handleClearcoatChange: val => get().updateMaterialProperty( 'clearcoat', val[ 0 ] ),
	handleClearcoatRoughnessChange: val => get().updateMaterialProperty( 'clearcoatRoughness', val[ 0 ] ),
	handleOpacityChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		// Update opacity property
		const opacity = val[ 0 ];
		obj.material.opacity = opacity;
		get().updateMaterialProperty( 'opacity', opacity );

		// Recalculate alphaMode if transparent is enabled
		if ( obj.material.transparent ) {

			let alphaMode = 0; // OPAQUE
			if ( obj.material.alphaTest > 0.0 ) {

				alphaMode = 1; // MASK

			} else if ( opacity < 1.0 ) {

				alphaMode = 2; // BLEND

			} else if ( obj.material.map && obj.material.map.format === 1023 ) { // 1023 = RGBAFormat

				alphaMode = 2; // BLEND

			}

			// Update alphaMode
			get().updateMaterialProperty( 'alphaMode', alphaMode );

		}

	},
	handleSideChange: val => get().updateMaterialProperty( 'side', val ),
	handleEmissiveChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.emissive ) {

			obj.material.emissive.set( val );
			get().updateMaterialProperty( 'emissive', obj.material.emissive );

		}

	},
	handleTransparentChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		// Update transparent property
		obj.material.transparent = val;
		get().updateMaterialProperty( 'transparent', val ? 1 : 0 );

		// Recalculate alphaMode based on new transparent state
		let alphaMode = 0; // OPAQUE
		if ( obj.material.alphaTest > 0.0 ) {

			alphaMode = 1; // MASK

		} else if ( val && obj.material.opacity < 1.0 ) {

			alphaMode = 2; // BLEND

		} else if ( obj.material.map && obj.material.map.format === 1023 && val ) { // 1023 = RGBAFormat

			alphaMode = 2; // BLEND

		}

		// Update alphaMode
		get().updateMaterialProperty( 'alphaMode', alphaMode );

	},
	handleAlphaTestChange: val => get().updateMaterialProperty( 'alphaTest', val[ 0 ] ),
	handleSheenChange: val => get().updateMaterialProperty( 'sheen', val[ 0 ] ),
	handleSheenRoughnessChange: val => get().updateMaterialProperty( 'sheenRoughness', val[ 0 ] ),
	handleSheenColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.sheenColor ) {

			obj.material.sheenColor.set( val );
			get().updateMaterialProperty( 'sheenColor', obj.material.sheenColor );

		}

	},
	handleSpecularIntensityChange: val => get().updateMaterialProperty( 'specularIntensity', val[ 0 ] ),
	handleSpecularColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.specularColor ) {

			obj.material.specularColor.set( val );
			get().updateMaterialProperty( 'specularColor', obj.material.specularColor );

		}

	},
	handleIridescenceChange: val => get().updateMaterialProperty( 'iridescence', val[ 0 ] ),
	handleIridescenceIORChange: val => get().updateMaterialProperty( 'iridescenceIOR', val[ 0 ] ),
	handleIridescenceThicknessRangeChange: val => get().updateMaterialProperty( 'iridescenceThicknessRange', val ),
	handleNormalScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		get().updateMaterialProperty( 'normalScale', value );

		// Also update the material object directly for UI consistency
		const obj = useStore.getState().selectedObject;
		if ( obj?.material ) {

			obj.material.normalScale = value;
			obj.material.needsUpdate = true;

		}

	},
	handleBumpScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		get().updateMaterialProperty( 'bumpScale', value );

		// Also update the material object directly for UI consistency
		const obj = useStore.getState().selectedObject;
		if ( obj?.material ) {

			obj.material.bumpScale = value;
			obj.material.needsUpdate = true;

		}

	},

	// Displacement mapping handlers
	handleDisplacementScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		get().updateMaterialProperty( 'displacementScale', value );

		// Also update the material object directly for UI consistency
		const obj = useStore.getState().selectedObject;
		if ( obj?.material ) {

			obj.material.displacementScale = value;
			obj.material.needsUpdate = true;

		}

	},

	/**
	 * Toggle material feature groups on/off with smart default values.
	 *
	 * This handler enables or disables material feature groups (clearcoat, volumetric/transmission,
	 * iridescence, sheen, dispersion) by updating the main feature property and applying sensible
	 * defaults for supporting properties when enabling.
	 *
	 * Strategy:
	 * - When enabling: Set main property to default value, apply smart defaults for supporting properties
	 * - When disabling: Only set main property to 0, preserve supporting properties for next enable
	 *
	 * @param {string} featureName - Feature to toggle: 'clearcoat', 'volumetric', 'iridescence', 'sheen', 'dispersion'
	 * @param {boolean} enabled - True to enable feature, false to disable
	 *
	 * @example
	 * // Enable transmission with smart defaults
	 * handleToggleFeature('volumetric', true);
	 * // Sets: transmission=1.0, ior=1.5 (if currently 0), thickness=0.1 (if currently 0)
	 *
	 * // Disable transmission
	 * handleToggleFeature('volumetric', false);
	 * // Sets: transmission=0, preserves ior and thickness values
	 */

	/**
	 * Change or add a texture on the selected material.
	 * Loads the image file, assigns it to the material slot, and triggers a full material rebuild.
	 * @param {string} textureName - Material texture slot (e.g., 'map', 'normalMap', 'roughnessMap')
	 * @param {File} file - Image file from file input
	 */
	handleTextureChange: async ( textureName, file ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		let url;
		try {

			const { TextureLoader, RepeatWrapping, SRGBColorSpace, LinearSRGBColorSpace } = await import( 'three' );
			url = URL.createObjectURL( file );
			const loader = new TextureLoader();
			const newTexture = await loader.loadAsync( url );

			// Configure texture
			newTexture.wrapS = RepeatWrapping;
			newTexture.wrapT = RepeatWrapping;
			newTexture.name = file.name;

			// Albedo/emissive maps use sRGB; others use linear
			const srgbMaps = [ 'map', 'emissiveMap' ];
			newTexture.colorSpace = srgbMaps.includes( textureName )
				? SRGBColorSpace
				: LinearSRGBColorSpace;

			// Preserve existing transform if replacing
			const existing = obj.material[ textureName ];
			if ( existing?.isTexture ) {

				newTexture.offset.copy( existing.offset );
				newTexture.repeat.copy( existing.repeat );
				newTexture.rotation = existing.rotation;
				existing.dispose();

			}

			// Assign to material
			obj.material[ textureName ] = newTexture;
			obj.material.needsUpdate = true;

			// Rebuild all material textures on the GPU
			const app = getApp();
			if ( app ) {

				await app.rebuildMaterials();
				app.reset();

			}

			// Notify UI
			window.dispatchEvent( new Event( 'MaterialUpdate' ) );

		} catch ( error ) {

			console.error( `Error changing texture ${textureName}:`, error );

		} finally {

			if ( url ) URL.revokeObjectURL( url );

		}

	},

	/**
	 * Remove a texture from the selected material slot.
	 * @param {string} textureName - Material texture slot to clear
	 */
	handleTextureRemove: async ( textureName ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		try {

			const existing = obj.material[ textureName ];
			if ( existing?.isTexture ) existing.dispose();

			obj.material[ textureName ] = null;
			obj.material.needsUpdate = true;

			const app = getApp();
			if ( app ) {

				await app.rebuildMaterials();
				app.reset();

			}

			window.dispatchEvent( new Event( 'MaterialUpdate' ) );

		} catch ( error ) {

			console.error( `Error removing texture ${textureName}:`, error );

		}

	},

	handleToggleFeature: ( featureName, enabled ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		try {

			// Feature default values and property mappings
			// Strategy: Only set main property when toggling, preserve supporting properties
			const FEATURE_CONFIGS = {
				clearcoat: {
					properties: {
						clearcoat: enabled ? 1.0 : 0
						// Preserve clearcoatRoughness - only set main property
					},
					// Set sensible defaults for supporting properties when enabling (only if currently 0)
					smartDefaults: enabled ? {
						clearcoatRoughness: { value: 0.1, condition: () => obj.material.clearcoatRoughness === 0 }
					} : {}
				},
				volumetric: {
					properties: {
						transmission: enabled ? 1.0 : 0
						// Preserve ior, thickness, attenuationDistance - only set main property
					},
					// Set sensible defaults for supporting properties when enabling (only if currently 0)
					smartDefaults: enabled ? {
						ior: { value: 1.5, condition: () => obj.material.ior === 1.0 || obj.material.ior === 0 },
						thickness: { value: 0.1, condition: () => obj.material.thickness === 0 }
					} : {},
					colorDefaults: enabled ? {
						attenuationColor: { value: '#ffffff', condition: () => true }
					} : {}
				},
				iridescence: {
					properties: {
						iridescence: enabled ? 0.5 : 0
					},
					smartDefaults: enabled ? {
						iridescenceIOR: { value: 1.3, condition: () => obj.material.iridescenceIOR === 1.0 },
						iridescenceThicknessRange: { value: [ 100, 400 ], condition: () => obj.material.iridescenceThicknessRange?.[ 0 ] === 0 }
					} : {}
				},
				sheen: {
					properties: {
						sheen: enabled ? 0.5 : 0
					},
					smartDefaults: enabled ? {
						sheenRoughness: { value: 0.5, condition: () => obj.material.sheenRoughness === 0 }
					} : {},
					colorDefaults: enabled ? {
						sheenColor: { value: '#ffffff', condition: () => true }
					} : {}
				},
				dispersion: {
					properties: {
						dispersion: enabled ? 0.02 : 0
					}
				},
				transparency: {
					properties: {
						transparent: enabled ? 1 : 0, // Store as number for material texture
						opacity: enabled ? ( obj.material.opacity === 1.0 ? 0.5 : obj.material.opacity ) : 1.0
					// Preserve alphaTest - only set main properties
					},
					smartDefaults: enabled ? {
						alphaTest: { value: 0, condition: () => true } // Ensure alphaTest is 0 when using opacity
					} : {}
				}
			};

			const config = FEATURE_CONFIGS[ featureName ];
			if ( ! config ) {

				console.warn( `Unknown feature: ${featureName}` );
				return;

			}

			// Update main feature properties
			Object.entries( config.properties ).forEach( ( [ prop, value ] ) => {

				// Always set the property, even if it doesn't exist yet
				// This allows enabling features that weren't initially configured
				obj.material[ prop ] = value;
				get().updateMaterialProperty( prop, value );

			} );

			// Apply smart defaults (only when enabling and condition is met)
			if ( config.smartDefaults ) {

				Object.entries( config.smartDefaults ).forEach( ( [ prop, { value, condition } ] ) => {

					// Always set if condition is met, even if property doesn't exist yet
					if ( condition() ) {

						obj.material[ prop ] = value;
						get().updateMaterialProperty( prop, value );

					}

				} );

			}

			// Apply color defaults
			if ( config.colorDefaults ) {

				Object.entries( config.colorDefaults ).forEach( ( [ prop, { value: hexValue, condition } ] ) => {

					if ( condition() ) {

						// Initialize Color object if it doesn't exist
						if ( ! obj.material[ prop ]?.isColor ) {

							obj.material[ prop ] = new THREE.Color( hexValue );

						} else {

							obj.material[ prop ].set( hexValue );

						}

						get().updateMaterialProperty( prop, obj.material[ prop ] );

					}

				} );

			}

			// Force material update
			obj.material.needsUpdate = true;

			// Force Zustand store update by updating selectedObject reference
			// This ensures React components re-render with the new material values
			set( { selectedObject: obj } );

			// Trigger shader recompilation by resetting the path tracer
			const app = getApp();
			if ( app ) {

				app.reset();
				app.reset();

			}

			// Dispatch event for UI update (important for reactive state)
			window.dispatchEvent( new Event( 'MaterialUpdate' ) );


		} catch ( error ) {

			console.error( `Error toggling feature ${featureName}:`, error );

		}

	},

} ) );

// Favorites store
const useFavoritesStore = create( ( set, get ) => ( {
	favorites: JSON.parse( localStorage.getItem( 'rayzee-favorites' ) || '{}' ),

	addFavorite: ( catalogType, itemId ) => set( state => {

		const newFavorites = {
			...state.favorites,
			[ catalogType ]: [ ...( state.favorites[ catalogType ] || [] ), itemId ]
		};

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} ),

	removeFavorite: ( catalogType, itemId ) => set( state => {

		const newFavorites = {
			...state.favorites,
			[ catalogType ]: ( state.favorites[ catalogType ] || [] ).filter( id => id !== itemId )
		};

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} ),

	toggleFavorite: ( catalogType, itemId ) => {

		const currentFavorites = get().favorites[ catalogType ] || [];
		const isFavorite = currentFavorites.includes( itemId );

		if ( isFavorite ) {

			get().removeFavorite( catalogType, itemId );

		} else {

			get().addFavorite( catalogType, itemId );

		}

	},

	isFavorite: ( catalogType, itemId ) => {

		const favorites = get().favorites[ catalogType ] || [];
		return favorites.includes( itemId );

	},

	getFavorites: ( catalogType ) => {

		return get().favorites[ catalogType ] || [];

	},

	clearFavorites: ( catalogType ) => set( state => {

		const newFavorites = { ...state.favorites };
		delete newFavorites[ catalogType ];

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} )
} ) );

// ═══════════════════════════════════════════════════════════════
// Animation Store
// ═══════════════════════════════════════════════════════════════

export const VIDEO_RENDER_FPS = 30;

// Module-scoped refs — not reactive state, only used for imperative cancel
let _activeVideoManager = null;
let _activeEncoder = null;

const useAnimationStore = create( ( set, get ) => ( {

	clips: [],
	selectedClip: 0,
	isPlaying: false,
	isPaused: false,
	speed: 1.0,
	loop: true,

	setClips: ( clips ) => set( { clips, selectedClip: 0, isPlaying: false, isPaused: false, speed: 1.0, loop: true, loopCount: 1 } ),
	setIsPlaying: ( isPlaying ) => set( { isPlaying } ),
	setIsPaused: ( isPaused ) => set( { isPaused } ),

	handlePlay: () => {

		const app = getApp();
		if ( ! app ) return;
		const { selectedClip, isPaused } = get();
		if ( isPaused ) {

			app.animationManager.resume();
			set( { isPlaying: true, isPaused: false } );

		} else {

			app.animationManager.play( selectedClip );
			set( { isPlaying: true, isPaused: false } );

		}

	},

	handlePause: () => {

		const app = getApp();
		if ( app ) app.animationManager.pause();
		set( { isPlaying: false, isPaused: true } );

	},

	handleStop: () => {

		const app = getApp();
		if ( app ) app.animationManager.stop();
		set( { isPlaying: false, isPaused: false } );

	},

	handleClipChange: ( index ) => {

		const app = getApp();
		const { isPlaying } = get();
		set( { selectedClip: index } );
		if ( isPlaying && app ) {

			app.animationManager.play( index );

		}

	},

	handleSpeedChange: ( speed ) => {

		const app = getApp();
		if ( app ) app.animationManager.setSpeed( speed );
		set( { speed } );

	},

	handleLoopChange: ( loop ) => {

		const app = getApp();
		if ( app ) app.animationManager.setLoop( loop );
		set( { loop } );

	},

	// ── Video Rendering ──────────────────────────────────────

	loopCount: 1,
	isVideoRendering: false,
	videoRenderProgress: 0,
	videoRenderFrame: 0,
	videoRenderTotalFrames: 0,

	handleLoopCountChange: ( val ) => set( { loopCount: val } ),

	handleRenderAnimation: async ( { totalDuration } = {} ) => {

		const app = getApp();
		if ( ! app || ! app.animationManager?.clips?.length ) return;

		const { selectedClip, loopCount, speed } = get();
		const clip = app.animationManager.clips[ selectedClip ];
		if ( ! clip ) return;

		const fps = VIDEO_RENDER_FPS;
		const loops = Math.max( 1, loopCount );
		const effectiveDuration = ( clip.duration * loops ) / ( speed || 1 );
		const duration = totalDuration || effectiveDuration;
		const totalFrames = Math.ceil( duration * fps );

		// Check codec support
		const canvas = app.getCanvas() || app.renderer?.domElement;
		if ( ! canvas ) return;

		const { supported, codec } = await checkCodecSupport( canvas.width, canvas.height );
		if ( ! supported ) {

			console.error( 'VideoEncoder: No supported video codec found (VP9/VP8)' );
			return;

		}

		set( { isVideoRendering: true, videoRenderProgress: 0, videoRenderFrame: 0, videoRenderTotalFrames: totalFrames } );

		const encoder = new VideoEncoderPipeline( canvas.width, canvas.height, { fps, codec } );
		const videoManager = new VideoRenderManager( app );

		_activeVideoManager = videoManager;
		_activeEncoder = encoder;

		await videoManager.renderAnimation( {
			clipIndex: selectedClip,
			fps,
			speed: speed || 1,
			samplesPerFrame: ENGINE_DEFAULTS.maxSamples,
			enableOIDN: true,
			totalFrames,
			onFrame: async ( bitmap ) => {

				await encoder.addFrame( bitmap );

			},
			onProgress: ( { frame, totalFrames: total, percent } ) => {

				set( { videoRenderProgress: percent, videoRenderFrame: frame, videoRenderTotalFrames: total } );

			},
			onComplete: async ( success ) => {

				if ( success ) {

					try {

						const blob = await encoder.finalize();
						const url = URL.createObjectURL( blob );
						const a = document.createElement( 'a' );
						a.href = url;
						a.download = `animation-${Date.now()}.webm`;
						a.click();
						setTimeout( () => URL.revokeObjectURL( url ), 60_000 );

					} catch ( err ) {

						console.error( 'VideoEncoder: Finalize failed:', err );

					}

				} else {

					// Clean up encoder on cancellation
					try {

						encoder._encoder.close();

					} catch { /* already closed */ }

				}

				_activeVideoManager = null;
				_activeEncoder = null;
				set( { isVideoRendering: false, videoRenderProgress: 0, videoRenderFrame: 0, videoRenderTotalFrames: 0 } );

			},
		} );

	},

	handleCancelVideoRender: () => {

		if ( _activeVideoManager ) _activeVideoManager.cancel();

	},

} ) );

export { useStore, useAssetsStore, useEnvironmentStore, usePathTracerStore, useLightStore, useCameraStore, useMaterialStore, useFavoritesStore, useAnimationStore };
