import { create } from 'zustand';
import * as THREE from 'three';
import { DEFAULT_STATE, CAMERA_PRESETS, ASVGF_QUALITY_PRESETS, SKY_PRESETS } from '@/Constants';
import { getApp } from '@/core/appProxy';

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
	loading: { isLoading: false, progress: 0, title: '', status: '' },
	setLoading: state => set( s => ( { loading: { ...s.loading, ...state } } ) ),
	stats: { samples: 0, timeElapsed: 0 },
	setStats: stats => set( { stats } ),
	isDenoising: false,
	setIsDenoising: val => set( { isDenoising: val } ),
	isRenderComplete: false,
	setIsRenderComplete: val => set( { isRenderComplete: val } ),
	resetLoading: () => set( { loading: { isLoading: false, progress: 0, title: '', status: '' } } ),
	appMode: 'preview',
	setAppMode: mode => set( { appMode: mode } ),
	activeTab: 'pathtracer',
	setActiveTab: tab => set( { activeTab: tab } ),
	layers: [],
	setLayers: layers => set( { layers } ),
	selectedResult: null,
	setSelectedResult: imageData => set( { selectedResult: imageData } ),
	imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 0 },
	setImageProcessingParam: ( param, val ) => set( s => ( { imageProcessing: { ...s.imageProcessing, [ param ]: val } } ) ),
	resetImageProcessing: () => set( { imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 } } ),

	// Enhanced reset function that also triggers immediate update
	handleResetImageProcessing: () => {

		const resetValues = { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 };

		// Update store state
		useStore.setState( { imageProcessing: resetValues } );

		// Apply immediate processing if image processor is available
		const resultsViewport = window.resultsViewportRef?.current;
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
		const resultsViewport = window.resultsViewportRef?.current;
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

		// Toggle Three.js object visibility
		object.visible = ! object.visible;

		// Helper to update path tracer visibility recursively
		const updatePTVisibility = ( obj ) => {

			if ( obj.isMesh && obj.material ) {

				const materialIndex = obj.userData?.materialIndex ?? 0;

				if ( typeof app.updateMaterialProperty === 'function' ) {

					// Calculate effective visibility by checking all ancestors
					let effectiveVisible = obj.visible;
					let curr = obj.parent;
					while ( curr && effectiveVisible ) {

						if ( ! curr.visible ) effectiveVisible = false;
						curr = curr.parent;

					}

					app.updateMaterialProperty( materialIndex, 'visible', effectiveVisible ? 1 : 0 );

				}

			}

		};

		// Update visibility for the object and all its children
		object.traverse( updatePTVisibility );

		// Reset path tracer to see changes
		app.reset();

		// Dispatch custom event for synchronization with Outliner
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

		// Set Three.js object visibility
		object.visible = visible;

		// Helper to update path tracer visibility recursively
		const updatePTVisibility = ( obj ) => {

			if ( obj.isMesh && obj.material ) {

				const materialIndex = obj.userData?.materialIndex ?? 0;

				if ( typeof app.updateMaterialProperty === 'function' ) {

					// Calculate effective visibility by checking all ancestors
					let effectiveVisible = obj.visible;
					let curr = obj.parent;
					while ( curr && effectiveVisible ) {

						if ( ! curr.visible ) effectiveVisible = false;
						curr = curr.parent;

					}

					app.updateMaterialProperty( materialIndex, 'visible', effectiveVisible ? 1 : 0 );

				}

			}

		};

		// Update visibility for the object and all its children
		object.traverse( updatePTVisibility );

		// Reset path tracer to see changes
		app.reset();

		// Dispatch custom event for synchronization with Outliner
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
// 2. DYNAMIC CAMERA OPTIMIZATION (CameraMovementOptimizer Level):
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

const FINAL_RENDER_STATE = {
	maxSamples: 30, bounces: 20, transmissiveBounces: 8, samplesPerPixel: 1, renderMode: 1, tiles: 3, tilesHelper: false,
	resolution: 3, enableOIDN: true, oidnQuality: 'balance', oidnHdr: true, useGBuffer: true,
	interactionModeEnabled: false,
};

const PREVIEW_STATE = {
	bounces: 3, samplesPerPixel: 1, renderMode: 0, transmissiveBounces: 3, tiles: 3, tilesHelper: false, resolution: 1,
	enableOIDN: false, oidnQuality: 'fast', oidnHdr: true, useGBuffer: true,
	interactionModeEnabled: true,
};

// Debounced procedural sky texture generation (300ms delay)
// This prevents expensive texture regeneration on every slider movement
const debouncedGenerateProceduralSkyTexture = debounce( () => {

	const app = getApp();
	if ( app ) {

		app.generateProceduralSkyTexture();

	}

}, 10 );

const usePathTracerStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	backgroundIntensity: DEFAULT_STATE.backgroundIntensity,
	performanceModeAdaptive: 'medium',

	adaptiveSamplingMaterialBias: 1.2,
	adaptiveSamplingEdgeBias: 1.5,
	adaptiveSamplingConvergenceSpeed: 2.0,
	adaptiveSamplingQualityPreset: 'balanced',

	// Auto-exposure computed values (updated in real-time by AutoExposureStage)
	currentAutoExposure: null,
	currentAvgLuminance: null,

	// Simple setters
	setMaxSamples: val => set( { maxSamples: val } ),
	setEnablePathTracer: val => set( { enablePathTracer: val } ),
	setEnableAccumulation: val => set( { enableAccumulation: val } ),
	setBounces: val => set( { bounces: val } ),
	setSamplesPerPixel: val => set( { samplesPerPixel: val } ),
	setSamplingTechnique: val => set( { samplingTechnique: val } ),
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
	setFireflyThreshold: val => set( { fireflyThreshold: val } ),
	setRenderMode: val => set( { renderMode: val } ),
	setTiles: val => set( { tiles: val } ),
	setTilesHelper: val => set( { tilesHelper: val } ),
	setResolution: val => set( { resolution: val } ),
	setEnableOIDN: val => set( { enableOIDN: val } ),
	setUseGBuffer: val => set( { useGBuffer: val } ),
	setRenderLimitMode: val => set( { renderLimitMode: val } ),
	setRenderTimeLimit: val => set( { renderTimeLimit: val } ),
	setDebugMode: val => set( { debugMode: val } ),
	setDebugThreshold: val => set( { debugThreshold: val } ),
	setOidnQuality: val => set( { oidnQuality: val } ),
	setOidnHdr: val => set( { oidnHdr: val } ),
	setExposure: val => set( { exposure: val } ),
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

	// Denoiser strategy and EdgeAware filter setters
	setDenoiserStrategy: val => set( { denoiserStrategy: val } ),
	setPixelEdgeSharpness: val => set( { pixelEdgeSharpness: val } ),
	setEdgeSharpenSpeed: val => set( { edgeSharpenSpeed: val } ),
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

				// Update ASVGF pass
				app.asvgfStage?.updateParameters( preset );

				// Force reset to see the change immediately
				app.reset();

			}

		}
	),

	handleAsvgfDebugModeChange: handleChange(
		val => set( { asvgfDebugMode: val } ),
		( val, app ) => {

			app.asvgfStage?.updateParameters( {
				debugMode: parseInt( val ),
				enableDebug: parseInt( val ) > 0
			} );

		},
		false
	),

	// Smart ASVGF configuration based on render mode
	handleConfigureASVGFForMode: ( mode ) => {

		const app = getApp();
		if ( ! app?.asvgfStage ) return;

		const configs = {
			preview: {
				enabled: false, // Disable during preview for performance
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

			app.asvgfStage.enabled = config.enabled;

			// Also enable/disable the extracted stages
			if ( app.varianceEstimationStage ) app.varianceEstimationStage.enabled = config.enabled;
			if ( app.bilateralFilteringStage ) app.bilateralFilteringStage.enabled = config.enabled;

			if ( config.enabled ) {

				app.asvgfStage.updateParameters( config );

			}

		}

	},

	applyAdaptiveSamplingQualityPreset( app, preset ) {

		const presets = {
			performance: {
				adaptiveSamplingMin: 1,
				adaptiveSamplingMax: 4,
				adaptiveSamplingVarianceThreshold: 0.01,
				adaptiveSamplingMaterialBias: 1.0,
				adaptiveSamplingEdgeBias: 1.2,
				adaptiveSamplingConvergenceSpeed: 3.0
			},
			balanced: {
				adaptiveSamplingMin: 2,
				adaptiveSamplingMax: 8,
				adaptiveSamplingVarianceThreshold: 0.005,
				adaptiveSamplingMaterialBias: 1.2,
				adaptiveSamplingEdgeBias: 1.5,
				adaptiveSamplingConvergenceSpeed: 2.0
			},
			quality: {
				adaptiveSamplingMin: 4,
				adaptiveSamplingMax: 16,
				adaptiveSamplingVarianceThreshold: 0.002,
				adaptiveSamplingMaterialBias: 1.5,
				adaptiveSamplingEdgeBias: 2.0,
				adaptiveSamplingConvergenceSpeed: 1.0
			}
		};

		const settings = presets[ preset ];
		if ( settings && app.adaptiveSamplingStage ) {

			// Update store state
			Object.entries( settings ).forEach( ( [ key, value ] ) => {

				const setter = `set${key.charAt( 0 ).toUpperCase()}${key.slice( 1 )}`;
				if ( get()[ setter ] ) {

					get()[ setter ]( value );

				}

			} );

			// Sync with engine stages
			app.setAdaptiveSamplingMax( settings.adaptiveSamplingMax );
			app.pathTracingStage?.setAdaptiveSamplingMin( settings.adaptiveSamplingMin );
			app.adaptiveSamplingStage.setAdaptiveSamplingParameters( {
				threshold: settings.adaptiveSamplingVarianceThreshold,
				materialBias: settings.adaptiveSamplingMaterialBias,
				edgeBias: settings.adaptiveSamplingEdgeBias,
				convergenceSpeedUp: settings.adaptiveSamplingConvergenceSpeed,
			} );

		}

	},

	// Handlers
	handlePathTracerChange: handleChange(
		val => set( { enablePathTracer: val } ),
		( val, app ) => {

			app.setPathTracerEnabled( val );

		}
	),

	handleAccumulationChange: handleChange(
		val => set( { enableAccumulation: val } ),
		( val, app ) => app.setAccumulationEnabled( val )
	),

	handleBouncesChange: handleChange(
		val => set( { bounces: val } ),
		( val, app ) => app.setMaxBounces( val )
	),

	handleSamplesPerPixelChange: handleChange(
		val => set( { samplesPerPixel: val } ),
		( val, app ) => app.setSamplesPerPixel( val )
	),

	handleTransmissiveBouncesChange: handleChange(
		val => set( { transmissiveBounces: val } ),
		( val, app ) => app.setTransmissiveBounces( val )
	),

	handleSamplingTechniqueChange: handleChange(
		val => set( { samplingTechnique: parseInt( val ) } ),
		( val, app ) => app.setSamplingTechnique( parseInt( val ) )
	),

	handleEnableEmissiveTriangleSamplingChange: handleChange(
		val => set( { enableEmissiveTriangleSampling: val } ),
		( val, app ) => app.setEnableEmissiveTriangleSampling( val )
	),

	handleEmissiveBoostChange: handleChange(
		val => set( { emissiveBoost: val } ),
		( val, app ) => app.setEmissiveBoost( val )
	),

	handleResolutionChange: handleChange(
		val => set( { resolution: val } ),
		( val, app ) => {

			// Map UI value to absolute pixel resolution
			const targetResolution = { '0': 256, '1': 512, '2': 1024, '3': 2048, '4': 4096 }[ val ] || 512;

			// Calculate pixel ratio based on canvas client dimensions
			// Use the shorter dimension to ensure target resolution fits
			const clientWidth = app.canvas.clientWidth;
			const clientHeight = app.canvas.clientHeight;
			const shortestDimension = Math.min( clientWidth, clientHeight );

			// Calculate pixel ratio to achieve target resolution on shortest side
			const pixelRatio = targetResolution / shortestDimension;
			// Pass resolution index to store for resize recalculation
			app.updateResolution( pixelRatio, parseInt( val, 10 ) );

		}
	),

	handleAdaptiveSamplingChange: handleChange(
		val => set( { adaptiveSampling: val } ),
		( val, app ) => {

			app.setUseAdaptiveSampling( val );
			if ( app.adaptiveSamplingStage ) {

				app.adaptiveSamplingStage.enabled = val;
				app.adaptiveSamplingStage.toggleHelper( false );

			}

		}
	),

	handleAdaptiveSamplingMinChange: handleChange(
		val => set( { adaptiveSamplingMin: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.pathTracingStage?.setAdaptiveSamplingMin( v );

		}
	),

	handleAdaptiveSamplingMaxChange: handleChange(
		val => set( { adaptiveSamplingMax: val } ),
		( val, app ) => app.setAdaptiveSamplingMax( Array.isArray( val ) ? val[ 0 ] : val )
	),

	handleAdaptiveSamplingVarianceThresholdChange: handleChange(
		val => set( { adaptiveSamplingVarianceThreshold: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.adaptiveSamplingStage?.setVarianceThreshold( v );

		}
	),

	handleAdaptiveSamplingHelperToggle: handleChange(
		val => set( { showAdaptiveSamplingHelper: val } ),
		( val, app ) => app.adaptiveSamplingStage?.toggleHelper( val )
	),

	handleAdaptiveSamplingMaterialBiasChange: handleChange(
		val => set( { adaptiveSamplingMaterialBias: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.adaptiveSamplingStage?.setMaterialBias( v );

		}
	),

	handleAdaptiveSamplingEdgeBiasChange: handleChange(
		val => set( { adaptiveSamplingEdgeBias: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.adaptiveSamplingStage?.setEdgeBias( v );

		}
	),

	handleAdaptiveSamplingConvergenceSpeedChange: handleChange(
		val => set( { adaptiveSamplingConvergenceSpeed: val } ),
		( val, app ) => {

			const v = Array.isArray( val ) ? val[ 0 ] : val;
			app.adaptiveSamplingStage?.setConvergenceSpeed( v );

		}
	),

	handleAdaptiveSamplingQualityPresetChange: handleChange(
		val => set( { adaptiveSamplingQualityPreset: val } ),
		( val, app ) => {

			get().applyAdaptiveSamplingQualityPreset( app, val );

		}
	),

	handleFireflyThresholdChange: handleChange(
		val => set( { fireflyThreshold: val } ),
		( val, app ) => app.setFireflyThreshold( Array.isArray( val ) ? val[ 0 ] : val )
	),

	handleRenderModeChange: handleChange(
		val => set( { renderMode: val } ),
		( val, app ) => {

			app.setRenderMode( parseInt( val ) );

			// Enable/disable tile highlight based on render mode and tilesHelper state
			const { tilesHelper } = get();
			if ( parseInt( val ) === 1 && tilesHelper ) {

				if ( app.tileHighlightStage ) app.tileHighlightStage.enabled = true;

			} else if ( parseInt( val ) !== 1 ) {

				if ( app.tileHighlightStage ) app.tileHighlightStage.enabled = false;

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

			app.setTileCount( tileCount );

		},
		false
	),

	handleTileHelperToggle: handleChange(
		val => set( { tilesHelper: val } ),
		( val, app ) => {

			const { renderMode } = get();
			if ( parseInt( renderMode ) === 1 && app.tileHighlightStage ) app.tileHighlightStage.enabled = val;

		},
		false
	),

	handleEnableOIDNChange: handleChange(
		val => set( { enableOIDN: val } ),
		( val, app ) => {

			if ( app.denoiser ) app.denoiser.enabled = val;

		},
		false
	),

	handleOidnQualityChange: handleChange(
		val => set( { oidnQuality: val } ),
		( val, app ) => app.denoiser?.updateQuality( val ),
		false
	),

	handleOidnHdrChange: handleChange(
		val => set( { oidnHdr: val } ),
		( val, app ) => app.denoiser?.toggleHDR( val ),
		false
	),

	handleUseGBufferChange: handleChange(
		val => set( { useGBuffer: val } ),
		( val, app ) => app.denoiser?.toggleUseGBuffer( val ),
		false
	),

	// Denoiser strategy and EdgeAware filter handlers
	handleDenoiserStrategyChange: handleChange(
		val => set( { denoiserStrategy: val } ),
		( val, app ) => {

			if ( ! app ) return;

			// Disable all real-time denoisers first (OIDN remains independent)
			if ( app.asvgfStage ) app.asvgfStage.enabled = false;
			if ( app.varianceEstimationStage ) app.varianceEstimationStage.enabled = false;
			if ( app.bilateralFilteringStage ) app.bilateralFilteringStage.enabled = false;
			if ( app.edgeAwareFilteringStage ) app.edgeAwareFilteringStage.setFilteringEnabled( false );
			if ( app.ssrcStage ) app.ssrcStage.enabled = false;

			// Enable the selected real-time denoiser
			switch ( val ) {

				case 'none':
					// All real-time denoisers already disabled above
					// Clear any stale denoiser outputs to ensure clean pipeline
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'asvgf:output' );
						ctx.removeTexture( 'asvgf:temporalColor' );
						ctx.removeTexture( 'asvgf:variance' );
						ctx.removeTexture( 'variance:output' );
						ctx.removeTexture( 'bilateralFiltering:output' );
						ctx.removeTexture( 'edgeFiltering:output' );
						ctx.removeTexture( 'ssrc:output' );

					}

					break;

				case 'asvgf': {

					// Clear stale EdgeAware and SSRC outputs so DisplayStage picks ASVGF output
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'edgeFiltering:output' );
						ctx.removeTexture( 'ssrc:output' );

					}

					app.asvgfStage.enabled = true;
					if ( app.varianceEstimationStage ) app.varianceEstimationStage.enabled = true;
					if ( app.bilateralFilteringStage ) app.bilateralFilteringStage.enabled = true;
					app.asvgfStage.setTemporalEnabled && app.asvgfStage.setTemporalEnabled( true );

					// Apply current quality preset parameters
					const store = get();
					const preset = ASVGF_QUALITY_PRESETS[ store.asvgfQualityPreset ];
					if ( preset ) {

						app.asvgfStage.updateParameters( preset );

					}

					break;

				}

				case 'ssrc': {

					// Clear stale EdgeAware and ASVGF outputs so DisplayStage picks SSRC output
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'edgeFiltering:output' );
						ctx.removeTexture( 'asvgf:output' );
						ctx.removeTexture( 'asvgf:temporalColor' );
						ctx.removeTexture( 'asvgf:variance' );
						ctx.removeTexture( 'variance:output' );
						ctx.removeTexture( 'bilateralFiltering:output' );

					}

					if ( app.ssrcStage ) app.ssrcStage.enabled = true;
					break;

				}

				case 'edgeaware':
				default:
					app.edgeAwareFilteringStage.setFilteringEnabled( true );
					// Clear stale denoiser outputs so DisplayStage uses fresh textures
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'asvgf:output' );
						ctx.removeTexture( 'asvgf:temporalColor' );
						ctx.removeTexture( 'asvgf:variance' );
						ctx.removeTexture( 'variance:output' );
						ctx.removeTexture( 'bilateralFiltering:output' );
						ctx.removeTexture( 'edgeFiltering:output' );
						ctx.removeTexture( 'ssrc:output' );

					}

					break;

			}

			// Update store state for real-time denoisers only (OIDN remains independent)
			set( {
				enableASVGF: val === 'asvgf'
				// enableOIDN remains independent
			} );

			// Reset when switching denoiser strategy
			app.reset();

		}
	),

	handlePixelEdgeSharpnessChange: handleChange(
		val => set( { pixelEdgeSharpness: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			if ( app?.edgeAwareFilteringStage ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilteringStage.updateUniforms( { pixelEdgeSharpness: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	handleEdgeSharpenSpeedChange: handleChange(
		val => set( { edgeSharpenSpeed: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			if ( app?.edgeAwareFilteringStage ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilteringStage.updateUniforms( { edgeSharpenSpeed: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	handleEdgeThresholdChange: handleChange(
		val => set( { edgeThreshold: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			if ( app?.edgeAwareFilteringStage ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilteringStage.updateUniforms( { edgeThreshold: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	// ─── SSRC handlers ───
	handleSsrcTemporalAlphaChange: handleChange(
		val => set( { ssrcTemporalAlpha: val[ 0 ] } ),
		( val, app ) => app.ssrcStage?.updateParameters( { temporalAlpha: val[ 0 ] } ),
		false
	),

	handleSsrcSpatialRadiusChange: handleChange(
		val => set( { ssrcSpatialRadius: val[ 0 ] } ),
		( val, app ) => app.ssrcStage?.updateParameters( { spatialRadius: val[ 0 ] } ),
		false
	),

	handleSsrcSpatialWeightChange: handleChange(
		val => set( { ssrcSpatialWeight: val[ 0 ] } ),
		( val, app ) => app.ssrcStage?.updateParameters( { spatialWeight: val[ 0 ] } ),
		false
	),

	handleDebugThresholdChange: handleChange(
		val => set( { debugThreshold: val } ),
		( val, app ) => app.setDebugVisScale( val[ 0 ] )
	),

	handleDebugModeChange: handleChange(
		val => set( { debugMode: val } ),
		( val, app ) => {

			const mode = {
				'1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
				'6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11,
				'12': 12, '13': 13, '14': 14, '15': 15,
			}[ val ] || 0;
			app.setVisMode( mode );

		}
	),

	handleExposureChange: handleChange(
		val => set( { exposure: val } ),
		( val, app ) => {

			app.setExposure( val );
			app.reset();

		}
	),

	// Auto-exposure handlers
	handleAutoExposureChange: handleChange(
		val => set( { autoExposure: val } ),
		( val, app ) => {

			if ( app?.autoExposureStage ) {

				app.autoExposureStage.enabled = val;

				if ( val ) {

					// When enabling: WebGPU DisplayStage applies its own pow(exposure, 4.0)
					// curve on top of renderer.toneMappingExposure. Auto-exposure writes
					// directly to toneMappingExposure, so neutralize the DisplayStage
					// curve by setting its exposure to 1.0 (pow(1,4)=1).
					app.displayStage?.setExposure( 1.0 );

				} else {

					// When disabling auto-exposure, restore manual exposure
					const manualExposure = get().exposure;
					app.setExposure( manualExposure );

					// Auto-exposure wrote to renderer.toneMappingExposure,
					// but DisplayStage uses its own TSL uniform for manual exposure.
					// Reset renderer exposure so it doesn't stack with the manual curve.
					if ( app.displayStage && app.renderer ) {

						app.renderer.toneMappingExposure = 1.0;

					}

				}

				app.reset();

			}

		}
	),

	handleAutoExposureKeyValueChange: handleChange(
		val => set( { autoExposureKeyValue: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.autoExposureStage?.updateParameters( { keyValue: value } );

		},
		true
	),

	handleAutoExposureMinExposureChange: handleChange(
		val => set( { autoExposureMinExposure: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.autoExposureStage?.updateParameters( { minExposure: value } );

		},
		true
	),

	handleAutoExposureMaxExposureChange: handleChange(
		val => set( { autoExposureMaxExposure: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			app.autoExposureStage?.updateParameters( { maxExposure: value } );

		},
		true
	),

	handleAutoExposureAdaptSpeedChange: handleChange(
		val => set( { autoExposureAdaptSpeedBright: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => {

			const value = Array.isArray( val ) ? val[ 0 ] : val;
			// Maintain ratio between bright and dark adaptation (6:1)
			app.autoExposureStage?.updateParameters( {
				adaptSpeedBright: value,
				adaptSpeedDark: value / 6.0
			} );

		},
		true
	),

	handleEnableEnvironmentChange: handleChange(
		val => set( { enableEnvironment: val } ),
		( val, app ) => {

			app.setEnableEnvironment( val );
			app.reset();

		}
	),

	handleShowBackgroundChange: handleChange(
		val => set( { showBackground: val } ),
		( val, app ) => {

			if ( app.scene ) app.scene.background = val ? app.scene.environment : null;
			app.setShowBackground( val );
			app.reset();

		}
	),

	handleTransparentBackgroundChange: handleChange(
		val => set( { transparentBackground: val } ),
		( val, app ) => {

			if ( val ) {

				// Force background off for transparency to work
				if ( app.scene ) app.scene.background = null;
				app.setShowBackground( false );
				set( { showBackground: false } );

			}

			app.setTransparentBackground( val );

		}
	),

	handleBackgroundIntensityChange: handleChange(
		val => set( { backgroundIntensity: val } ),
		( val, app ) => {

			app.setBackgroundIntensity( val );
			app.reset();

		}
	),

	handleEnvironmentIntensityChange: handleChange(
		val => set( { environmentIntensity: val } ),
		( val, app ) => {

			app.setEnvironmentIntensity( val );
			app.reset();

		}
	),

	handleEnvironmentRotationChange: handleChange(
		val => set( { environmentRotation: val } ),
		( val, app ) => {

			app.setEnvironmentRotation( val[ 0 ] );
			app.reset();

		}
	),

	handleGIIntensityChange: handleChange(
		val => set( { GIIntensity: val } ),
		( val, app ) => {

			app.setGlobalIlluminationIntensity( val );
			app.reset();

		}
	),

	// Environment Mode Handlers
	handleEnvironmentModeChange: handleChange(
		val => set( { environmentMode: val } ),
		async ( val, app ) => {

			if ( ! app ) return;

			const modeMap = { hdri: 0, procedural: 1, gradient: 2, color: 3 };

			// Store previous HDRI if switching away
			if ( val !== 'hdri' && get().environmentMode === 'hdri' ) {

				app._previousHDRI = app.getEnvironmentTexture();
				app._previousCDF = app.getEnvironmentCDF();

			}

			// Generate texture for procedural modes
			if ( val === 'gradient' ) {

				await app.generateGradientTexture();

			} else if ( val === 'color' ) {

				await app.generateSolidColorTexture();

			} else if ( val === 'procedural' ) {

				await app.generateProceduralSkyTexture();

			} else if ( val === 'hdri' ) {

				// Restore previous HDRI
				if ( app._previousHDRI ) {

					await app.setEnvironmentMap( app._previousHDRI );

				}

			}

			// Update envParams mode (CPU-side parameter, not passed to shader)
			const envParams = app.getEnvParams();
			if ( envParams ) envParams.mode = val;

			// Force texture update
			app.markEnvironmentNeedsUpdate();

			console.log( '✅ Environment mode changed to:', val, '(uniform value:', modeMap[ val ], ')' );

			app.reset();

		}
	),

	// Gradient Sky Handlers
	handleGradientZenithColorChange: handleChange(
		val => set( { gradientZenithColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.getEnvParams();
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientZenithColor.copy( color );
			app.generateGradientTexture();

		}
	),

	handleGradientHorizonColorChange: handleChange(
		val => set( { gradientHorizonColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.getEnvParams();
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientHorizonColor.copy( color );
			app.generateGradientTexture();

		}
	),

	handleGradientGroundColorChange: handleChange(
		val => set( { gradientGroundColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const envParams = app.getEnvParams();
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.gradientGroundColor.copy( color );
			app.generateGradientTexture();

		}
	),

	// Solid Color Sky Handler
	handleSolidSkyColorChange: handleChange(
		val => set( { solidSkyColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'color' ) return;

			const envParams = app.getEnvParams();
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.solidSkyColor.copy( color );
			app.generateSolidColorTexture();

		}
	),

	// Procedural Sky (Preetham Model) Handlers
	handleSkySunAzimuthChange: handleChange(
		val => set( { skySunAzimuth: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'procedural' ) return;

			const envParams = app.getEnvParams();
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

			const envParams = app.getEnvParams();
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

			const envParams = app.getEnvParams();
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

			const envParams = app.getEnvParams();
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

			const envParams = app.getEnvParams();
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

			const envParams = app.getEnvParams();
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

	handleRenderLimitModeChange: handleChange(
		val => set( { renderLimitMode: val } ),
		( val, app ) => {

			app.setRenderLimitMode( val );
			app.reset();

		}
	),

	handleRenderTimeLimitChange: handleChange(
		val => set( { renderTimeLimit: val } ),
		( val, app ) => {

			app.renderTimeLimit = parseFloat( val );
			app.reset();

		}
	),

	handleInteractionModeEnabledChange: handleChange(
		val => set( { interactionModeEnabled: val } ),
		( val, app ) => app.setInteractionModeEnabled( val ),
		false // Don't reset - exitInteractionMode handles the soft reset internally
	),

	handleAsvgfTemporalAlphaChange: handleChange(
		val => set( { asvgfTemporalAlpha: val[ 0 ] } ),
		( val, app ) => app.asvgfStage?.updateParameters( { temporalAlpha: val[ 0 ] } ),
		false
	),

	handleAsvgfPhiColorChange: handleChange(
		val => set( { asvgfPhiColor: val[ 0 ] } ),
		( val, app ) => app.asvgfStage?.updateParameters( { phiColor: val[ 0 ] } ),
		false
	),

	handleEnableASVGFChange: handleChange(
		val => set( { enableASVGF: val } ),
		( val, app ) => {

			if ( app.asvgfStage ) app.asvgfStage.enabled = val;

			// Enable/disable the extracted variance and bilateral filtering stages
			if ( app.varianceEstimationStage ) {

				app.varianceEstimationStage.enabled = val;

			}

			if ( app.bilateralFilteringStage ) {

				app.bilateralFilteringStage.enabled = val;

			}

			if ( val ) {

				// When enabling ASVGF, ensure temporal processing is enabled
				app.asvgfStage.setTemporalEnabled && app.asvgfStage.setTemporalEnabled( true );

				// Apply current quality preset parameters
				const store = get();
				const preset = ASVGF_QUALITY_PRESETS[ store.asvgfQualityPreset ];

				if ( preset ) {

					app.asvgfStage.updateParameters( preset );

				}

			}

			// Coordinate with EdgeAware filtering
			if ( app.edgeAwareFilteringStage ) app.edgeAwareFilteringStage.setFilteringEnabled( ! val );

			// Reset when toggling
			app.reset();

		}
	),

	handleShowAsvgfHeatmapChange: handleChange(
		val => set( { showAsvgfHeatmap: val } ),
		( val, app ) => {

			if ( app?.asvgfStage ) {

				app.asvgfStage.toggleHeatmap && app.asvgfStage.toggleHeatmap( val );

			}

		}
	),


	handleAsvgfPhiLuminanceChange: handleChange(
		val => set( { asvgfPhiLuminance: val } ),
		( val, app ) => app.asvgfStage?.updateParameters( { phiLuminance: val[ 0 ] } ),
		false
	),

	handleAsvgfAtrousIterationsChange: handleChange(
		val => set( { asvgfAtrousIterations: val[ 0 ] } ),
		( val, app ) => app.asvgfStage?.updateParameters( { atrousIterations: val[ 0 ] } ),
		false
	),

	// Canvas configuration handlers
	handleConfigureForPreview: () => {

		const a = get();
		Object.entries( PREVIEW_STATE ).forEach( ( [ k, v ] ) => {

			const setter = `set${k[ 0 ].toUpperCase()}${k.slice( 1 )}`;
			const value = Array.isArray( v ) ? [ ...v ] : ( v && typeof v === 'object' ) ? { ...v } : v;
			a[ setter ]?.( value );

		} );

		const app = getApp();
		if ( ! app ) return;
		app.controls.enabled = true;

		requestAnimationFrame( () => {

			app.setMaxBounces( PREVIEW_STATE.bounces );
			app.setSamplesPerPixel( PREVIEW_STATE.samplesPerPixel );
			app.setRenderMode( PREVIEW_STATE.renderMode );
			app.setTransmissiveBounces( PREVIEW_STATE.transmissiveBounces );

			// Use setTileCount to properly update completion threshold
			app.setTileCount( PREVIEW_STATE.tiles );
			if ( app.tileHighlightStage ) app.tileHighlightStage.enabled = PREVIEW_STATE.tilesHelper;

			// Ensure completion threshold is updated after render mode change
			app.pathTracingStage?.updateCompletionThreshold?.();

			// Abort any ongoing denoising before switching modes
			if ( app.denoiser ) {

				app.denoiser.abort();
				app.denoiser.enabled = PREVIEW_STATE.enableOIDN;
				app.denoiser.updateQuality( PREVIEW_STATE.oidnQuality );
				app.denoiser.toggleHDR( PREVIEW_STATE.oidnHdr );
				app.denoiser.toggleUseGBuffer( PREVIEW_STATE.useGBuffer );

			}

			// Use absolute pixel resolution based on mode setting
			const previewTargetRes = { '0': 256, '1': 512, '2': 1024, '3': 2048, '4': 4096 }[ PREVIEW_STATE.resolution ] || 512;
			const previewShortestDim = Math.min( app.canvas.clientWidth, app.canvas.clientHeight );
			app.updateResolution( previewTargetRes / previewShortestDim, PREVIEW_STATE.resolution );

			app.renderer?.domElement && ( app.renderer.domElement.style.display = 'block' );
			app.denoiser?.output && ( app.denoiser.output.style.display = 'block' );

			app.pauseRendering = false;
			app.reset();

		} );

	},

	handleConfigureForFinalRender: () => {

		const a = get();
		Object.entries( FINAL_RENDER_STATE ).forEach( ( [ k, v ] ) => {

			const setter = `set${k.charAt( 0 ).toUpperCase()}${k.slice( 1 )}`;
			a[ setter ]?.( typeof v === 'number' ? v : v.toString() );

		} );

		const app = getApp();
		if ( ! app ) return;
		app.controls.enabled = false;

		requestAnimationFrame( () => {

			app.setMaxSamples( FINAL_RENDER_STATE.maxSamples );
			app.setMaxBounces( FINAL_RENDER_STATE.bounces );
			app.setSamplesPerPixel( FINAL_RENDER_STATE.samplesPerPixel );
			app.setRenderMode( FINAL_RENDER_STATE.renderMode );
			app.setTransmissiveBounces( FINAL_RENDER_STATE.transmissiveBounces );

			// Use setTileCount to properly update completion threshold
			app.setTileCount( FINAL_RENDER_STATE.tiles );
			if ( app.tileHighlightStage ) app.tileHighlightStage.enabled = FINAL_RENDER_STATE.tilesHelper;

			// Ensure completion threshold is updated after render mode change
			app.pathTracingStage?.updateCompletionThreshold?.();

			// Abort any ongoing denoising before switching modes
			if ( app.denoiser ) {

				app.denoiser.abort();
				app.denoiser.enabled = FINAL_RENDER_STATE.enableOIDN;
				app.denoiser.updateQuality( FINAL_RENDER_STATE.oidnQuality );
				app.denoiser.toggleHDR( FINAL_RENDER_STATE.oidnHdr );
				app.denoiser.toggleUseGBuffer( FINAL_RENDER_STATE.useGBuffer );

			}

			// Use absolute pixel resolution based on mode setting
			const finalTargetRes = { '0': 256, '1': 512, '2': 1024, '3': 2048, '4': 4096 }[ FINAL_RENDER_STATE.resolution ] || 2048;
			const finalShortestDim = Math.min( app.canvas.clientWidth, app.canvas.clientHeight );
			app.updateResolution( finalTargetRes / finalShortestDim, FINAL_RENDER_STATE.resolution );

			app.renderer?.domElement && ( app.renderer.domElement.style.display = 'block' );
			app.denoiser?.output && ( app.denoiser.output.style.display = 'block' );

			app.pauseRendering = false;
			app.reset();

		} );

	},

	handleConfigureForResults: () => {

		const app = getApp();
		if ( ! app ) return;
		app.pauseRendering = true;
		app.controls.enabled = false;
		app.renderer?.domElement && ( app.renderer.domElement.style.display = 'none' );
		app.denoiser?.output && ( app.denoiser.output.style.display = 'none' );

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

				if ( app.updateLights ) {

					app.updateLights();

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

		const newLight = app.addLight( lightType );
		if ( newLight ) {

			set( s => ( { lights: [ ...s.lights, newLight ] } ) );
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
			const success = app.removeLight( lightToRemove.uuid );

			if ( success ) {

				window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );
				return { lights: s.lights.filter( ( _, idx ) => idx !== lightIndex ) };

			}

			return s;

		} );

	},

	// Toggle area light helper visibility
	handleShowLightHelperChange: ( val ) => {

		set( { showLightHelper: val } );
		const app = getApp();
		if ( app ) {

			app.setShowLightHelper( val );

		}

	},

	// Clear all lights
	clearAllLights: () => {

		const app = getApp();
		if ( ! app ) return;

		app.clearLights();
		set( { lights: [] } );
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

	setCameraNames: names => set( { cameraNames: names } ),
	setSelectedCameraIndex: idx => set( { selectedCameraIndex: idx } ),
	setFocusMode: mode => set( { focusMode: mode } ),
	setSelectMode: mode => set( { selectMode: mode } ),
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

		const app = getApp();
		if ( ! app ) return;
		const isActive = app.toggleFocusMode();
		console.log( 'Focus mode:', isActive ? 'enabled' : 'disabled' );
		set( { focusMode: isActive } );

	},

	handleToggleSelectMode: () => {

		const app = getApp();
		if ( ! app ) return;

		const isActive = app.toggleSelectMode();
		set( { selectMode: isActive } );

	},

	handleEnableDOFChange: val => {

		set( { enableDOF: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.setEnableDOF( val );
			app.reset();

		}

	},

	handleZoomToCursorChange: val => {

		set( { zoomToCursor: val } );
		const app = getApp();
		if ( app?.controls ) {

			app.controls.zoomToCursor = val;

		}

	},

	handleFocusDistanceChange: val => {

		set( { focusDistance: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			const scale = app.assetLoader?.getSceneScale() || 1.0;
			app.setFocusDistance( val * scale );
			app.reset();

		}

	},

	handlePresetChange: key => {

		if ( key === "custom" ) {

			set( { activePreset: "custom" } );
			return;

		}

		const preset = CAMERA_PRESETS[ key ];
		set( { ...preset, activePreset: key } );

		const app = getApp();
		if ( app ) {

			const scale = app.assetLoader?.getSceneScale() || 1.0;
			app.camera.fov = preset.fov;
			app.camera.updateProjectionMatrix();
			app.setFocusDistance( preset.focusDistance * scale );
			app.setAperture( preset.aperture );
			app.setFocalLength( preset.focalLength );
			app.setApertureScale( get().apertureScale || 1.0 );
			app.reset();

		}

	},

	handleFovChange: val => {

		set( { fov: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.camera.fov = val;
			app.camera.updateProjectionMatrix();
			app.reset();

		}

	},

	handleApertureChange: val => {

		set( { aperture: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.setAperture( val );
			app.reset();

		}

	},

	handleFocalLengthChange: val => {

		set( { focalLength: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.setFocalLength( val );
			if ( val <= 0 ) app.setAperture( 16.0 );
			app.reset();

		}

	},

	handleCameraMove: point => {

		const app = getApp();
		if ( ! app?.controls ) return;
		const { controls, camera } = app;
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
			app.switchCamera( index );
			set( { selectedCameraIndex: index } );

		}

	},

	handleApertureScaleChange: val => {

		const app = getApp();
		if ( app ) {

			app.setApertureScale( val );
			app.reset();

		}

	},

	handleFocusChangeEvent: event => set( { focusDistance: event.distance, focusMode: false, activePreset: "custom" } ),

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

			app.updateMaterialProperty( idx, prop, val );


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
		app.updateTextureTransform( materialIndex, textureName, transform );

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
	handleVisibleChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj ) {

			obj.visible = val;
			get().updateMaterialProperty( 'visible', val ? 1 : 0 );

			// Dispatch custom event for synchronization with Outliner
			window.dispatchEvent( new CustomEvent( 'meshVisibilityChanged', {
				detail: { uuid: obj.uuid, visible: val }
			} ) );

		}

	},
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

				app.refreshMaterial();
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

export { useStore, useAssetsStore, useEnvironmentStore, usePathTracerStore, useLightStore, useCameraStore, useMaterialStore, useFavoritesStore };
