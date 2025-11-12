import { create } from 'zustand';
import * as THREE from 'three';
import { DEFAULT_STATE, CAMERA_PRESETS, ASVGF_QUALITY_PRESETS, SKY_PRESETS } from '@/Constants';

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
	if ( window.pathTracerApp ) {

		appUpdater( val );
		needsReset && window.pathTracerApp.reset();

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

		if ( ! window.pathTracerApp ) return;

		const object = window.pathTracerApp.scene.getObjectByProperty( 'uuid', uuid );
		if ( ! object?.isMesh || ! object.material ) return;

		// Toggle Three.js object visibility
		object.visible = ! object.visible;

		// Update material visible property for path tracing
		const materialIndex = object.userData?.materialIndex ?? 0;
		const pt = window.pathTracerApp?.pathTracingPass;
		if ( pt && typeof pt.updateMaterialProperty === 'function' ) {

			pt.updateMaterialProperty( materialIndex, 'visible', object.visible ? 1 : 0 );

		}

		// Reset path tracer to see changes
		window.pathTracerApp.reset();

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
	resolution: 3, enableOIDN: true, oidnQuality: 'balance', oidnHDR: false, useGBuffer: true,
	interactionModeEnabled: false,
};

const PREVIEW_STATE = {
	bounces: 3, samplesPerPixel: 1, renderMode: 0, transmissiveBounces: 3, tiles: 3, tilesHelper: false, resolution: 1,
	enableOIDN: false, oidnQuality: 'fast', oidnHDR: false, useGBuffer: true,
	interactionModeEnabled: true,
};

// Debounced procedural sky texture generation (300ms delay)
// This prevents expensive texture regeneration on every slider movement
const debouncedGenerateProceduralSkyTexture = debounce( () => {

	const app = window.pathTracerApp;
	if ( app?.pathTracingPass ) {

		app.pathTracingPass.generateProceduralSkyTexture();

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
	setDebugMode: val => set( { debugMode: val } ),
	setDebugThreshold: val => set( { debugThreshold: val } ),
	setEnableBloom: val => set( { enableBloom: val } ),
	setBloomThreshold: val => set( { bloomThreshold: val } ),
	setBloomStrength: val => set( { bloomStrength: val } ),
	setBloomRadius: val => set( { bloomRadius: val } ),
	setOidnQuality: val => set( { oidnQuality: val } ),
	setOidnHdr: val => set( { oidnHdr: val } ),
	setExposure: val => set( { exposure: val } ),
	setEnableEnvironment: val => set( { enableEnvironment: val } ),
	setUseImportanceSampledEnvironment: val => set( { useImportanceSampledEnvironment: val } ),
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

	// Denoiser strategy and EdgeAware filter setters
	setDenoiserStrategy: val => set( { denoiserStrategy: val } ),
	setPixelEdgeSharpness: val => set( { pixelEdgeSharpness: val } ),
	setEdgeSharpenSpeed: val => set( { edgeSharpenSpeed: val } ),
	setEdgeThreshold: val => set( { edgeThreshold: val } ),

	handleAsvgfQualityPresetChange: handleChange(
		val => set( { asvgfQualityPreset: val } ),
		val => {

			const preset = ASVGF_QUALITY_PRESETS[ val ];
			if ( preset && window.pathTracerApp ) {

				const store = get();

				// Update store state
				Object.entries( preset ).forEach( ( [ key, value ] ) => {

					const setter = `setAsvgf${key.charAt( 0 ).toUpperCase()}${key.slice( 1 )}`;
					if ( store[ setter ] ) {

						store[ setter ]( value );

					}

				} );

				// Update ASVGF pass
				window.pathTracerApp.asvgfPass.updateParameters( preset );

				// Force reset to see the change immediately
				window.pathTracerApp.reset();

			}

		}
	),

	handleAsvgfDebugModeChange: handleChange(
		val => set( { asvgfDebugMode: val } ),
		val => {

			window.pathTracerApp.asvgfPass.updateParameters( {
				debugMode: parseInt( val ),
				enableDebug: parseInt( val ) > 0
			} );

		},
		false
	),

	// Smart ASVGF configuration based on render mode
	handleConfigureASVGFForMode: ( mode ) => {

		if ( ! window.pathTracerApp?.asvgfPass ) return;

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

			const app = window.pathTracerApp;
			app.asvgfPass.enabled = config.enabled;
			if ( config.enabled ) {

				app.asvgfPass.updateParameters( config );

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
		if ( settings && app.adaptiveSamplingPass ) {

			// Update store state
			Object.entries( settings ).forEach( ( [ key, value ] ) => {

				const setter = `set${key.charAt( 0 ).toUpperCase()}${key.slice( 1 )}`;
				if ( get()[ setter ] ) {

					get()[ setter ]( value );

				}

			} );

			// Update adaptive sampling pass parameters
			app.pathTracingPass.setAdaptiveSamplingParameters( settings );

		}

	},

	// Handlers
	handlePathTracerChange: handleChange(
		val => set( { enablePathTracer: val } ),
		val => {

			const app = window.pathTracerApp;
			app.pathTracingPass.setAccumulationEnabled( val );
			app.pathTracingPass.enabled = val;
			app.renderPass.enabled = ! val;

		}
	),

	handleAccumulationChange: handleChange(
		val => set( { enableAccumulation: val } ),
		val => window.pathTracerApp.pathTracingPass.setAccumulationEnabled( val )
	),

	handleBouncesChange: handleChange(
		val => set( { bounces: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = val
	),

	handleSamplesPerPixelChange: handleChange(
		val => set( { samplesPerPixel: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = val
	),

	handleTransmissiveBouncesChange: handleChange(
		val => set( { transmissiveBounces: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.transmissiveBounces.value = val
	),

	handleSamplingTechniqueChange: handleChange(
		val => set( { samplingTechnique: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.samplingTechnique.value = val
	),

	handleEnableEmissiveTriangleSamplingChange: handleChange(
		val => set( { enableEmissiveTriangleSampling: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.enableEmissiveTriangleSampling.value = val
	),

	handleEmissiveBoostChange: handleChange(
		val => set( { emissiveBoost: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.emissiveBoost.value = val
	),

	handleResolutionChange: handleChange(
		val => set( { resolution: val } ),
		val => {

			const scale = { '1': 0.5, '2': 1, '3': 2, '4': 4 }[ val ] || 0.25;
			window.pathTracerApp.updateResolution( window.devicePixelRatio * scale );

		}
	),

	handleAdaptiveSamplingChange: handleChange(
		val => set( { adaptiveSampling: val } ),
		val => {

			const app = window.pathTracerApp;
			app.pathTracingPass.material.uniforms.useAdaptiveSampling.value = val;
			app.adaptiveSamplingPass.enabled = val;
			app.adaptiveSamplingPass.toggleHelper( false );

		}
	),

	handleAdaptiveSamplingMinChange: handleChange(
		val => set( { adaptiveSamplingMin: val } ),
		val => window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { min: val[ 0 ] } )
	),

	handleAdaptiveSamplingMaxChange: handleChange(
		val => set( { adaptiveSamplingMax: val } ),
		val => window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { max: Array.isArray( val ) ? val[ 0 ] : val } )
	),

	handleAdaptiveSamplingVarianceThresholdChange: handleChange(
		val => set( { adaptiveSamplingVarianceThreshold: val } ),
		val => window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { threshold: Array.isArray( val ) ? val[ 0 ] : val } )
	),

	handleAdaptiveSamplingHelperToggle: handleChange(
		val => set( { showAdaptiveSamplingHelper: val } ),
		val => window.pathTracerApp?.adaptiveSamplingPass?.toggleHelper( val )
	),

	handleAdaptiveSamplingMaterialBiasChange: handleChange(
		val => set( { adaptiveSamplingMaterialBias: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { materialBias: val[ 0 ] } );

		}
	),

	handleAdaptiveSamplingEdgeBiasChange: handleChange(
		val => set( { adaptiveSamplingEdgeBias: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { edgeBias: val[ 0 ] } );

		}
	),

	handleAdaptiveSamplingConvergenceSpeedChange: handleChange(
		val => set( { adaptiveSamplingConvergenceSpeed: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { convergenceSpeedUp: val[ 0 ] } );

		}
	),

	handleAdaptiveSamplingQualityPresetChange: handleChange(
		val => set( { adaptiveSamplingQualityPreset: val } ),
		val => {

			get().applyAdaptiveSamplingQualityPreset( window.pathTracerApp, val );

		}
	),

	handleFireflyThresholdChange: handleChange(
		val => set( { fireflyThreshold: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.fireflyThreshold.value = val[ 0 ]
	),

	handleRenderModeChange: handleChange(
		val => set( { renderMode: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( val );

			// Enable/disable tile highlight based on render mode and tilesHelper state
			const { tilesHelper } = get();
			if ( parseInt( val ) === 1 && tilesHelper ) {

				window.pathTracerApp.tileHighlightPass.enabled = true;

			} else if ( parseInt( val ) !== 1 ) {

				window.pathTracerApp.tileHighlightPass.enabled = false;

			}

		}
	),

	handleTileUpdate: handleChange(
		val => set( { tiles: val } ),
		val => {

			const tileCount = val[ 0 ];

			// Validate tile count before applying
			if ( tileCount < 1 || tileCount > 10 ) {

				console.warn( `Store: Tile count ${tileCount} is outside recommended range (1-10)` );

			}

			window.pathTracerApp.pathTracingPass.setTileCount( tileCount );

		},
		false
	),

	handleTileHelperToggle: handleChange(
		val => set( { tilesHelper: val } ),
		val => {

			const { renderMode } = get();
			parseInt( renderMode ) === 1 && ( window.pathTracerApp.tileHighlightPass.enabled = val );

		},
		false
	),

	handleEnableOIDNChange: handleChange(
		val => set( { enableOIDN: val } ),
		val => window.pathTracerApp.denoiser.enabled = val,
		false
	),

	handleOidnQualityChange: handleChange(
		val => set( { oidnQuality: val } ),
		val => window.pathTracerApp.denoiser.updateQuality( val ),
		false
	),

	handleOidnHdrChange: handleChange(
		val => set( { oidnHdr: val } ),
		val => window.pathTracerApp.denoiser.toggleHDR( val ),
		false
	),

	handleUseGBufferChange: handleChange(
		val => set( { useGBuffer: val } ),
		val => window.pathTracerApp.denoiser.toggleUseGBuffer( val ),
		false
	),

	// Denoiser strategy and EdgeAware filter handlers
	handleDenoiserStrategyChange: handleChange(
		val => set( { denoiserStrategy: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app ) return;

			// Disable all denoisers first
			app.asvgfPass.enabled = false;
			app.denoiser.enabled = false;
			app.edgeAwareFilterPass.setFilteringEnabled( false );

			// Enable the selected denoiser
			switch ( val ) {

				case 'none':
					// All denoisers already disabled above
					// Clear any stale denoiser outputs to ensure clean pipeline
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'asvgf:output' );
						ctx.removeTexture( 'asvgf:temporalColor' );
						ctx.removeTexture( 'asvgf:variance' );
						ctx.removeTexture( 'edgeFiltering:output' );

					}

					break;

				case 'asvgf': {

					app.asvgfPass.enabled = true;
					app.asvgfPass.setTemporalEnabled && app.asvgfPass.setTemporalEnabled( true );

					// Apply current quality preset parameters
					const store = get();
					const preset = ASVGF_QUALITY_PRESETS[ store.asvgfQualityPreset ];
					if ( preset ) {

						app.asvgfPass.updateParameters( preset );

					}

					break;

				}

				case 'oidn':
					app.denoiser.enabled = true;
					break;

				case 'edgeaware':
				default:
					app.edgeAwareFilterPass.setFilteringEnabled( true );
					// Clear any stale ASVGF outputs so EdgeAware reads live path tracer texture
					if ( app.pipeline?.context ) {

						const ctx = app.pipeline.context;
						ctx.removeTexture( 'asvgf:output' );
						ctx.removeTexture( 'asvgf:temporalColor' );
						ctx.removeTexture( 'asvgf:variance' );

					}

					break;

			}

			// Update store state for individual toggles (for backward compatibility)
			set( {
				enableASVGF: val === 'asvgf',
				enableOIDN: val === 'oidn'
			} );

			// Reset when switching denoiser strategy
			app.reset();

		}
	),

	handlePixelEdgeSharpnessChange: handleChange(
		val => set( { pixelEdgeSharpness: Array.isArray( val ) ? val[ 0 ] : val } ),
		val => {

			const app = window.pathTracerApp;
			if ( app?.edgeAwareFilterPass ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilterPass.updateUniforms( { pixelEdgeSharpness: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	handleEdgeSharpenSpeedChange: handleChange(
		val => set( { edgeSharpenSpeed: Array.isArray( val ) ? val[ 0 ] : val } ),
		val => {

			const app = window.pathTracerApp;
			if ( app?.edgeAwareFilterPass ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilterPass.updateUniforms( { edgeSharpenSpeed: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	handleEdgeThresholdChange: handleChange(
		val => set( { edgeThreshold: Array.isArray( val ) ? val[ 0 ] : val } ),
		val => {

			const app = window.pathTracerApp;
			if ( app?.edgeAwareFilterPass ) {

				const value = Array.isArray( val ) ? val[ 0 ] : val;
				app.edgeAwareFilterPass.updateUniforms( { edgeThreshold: value } );

			}

		},
		true // Enable reset to see changes immediately
	),

	handleDebugThresholdChange: handleChange(
		val => set( { debugThreshold: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = val[ 0 ]
	),

	handleDebugModeChange: handleChange(
		val => set( { debugMode: val } ),
		val => {

			const mode = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8 }[ val ] || 0;
			window.pathTracerApp.pathTracingPass.material.uniforms.visMode.value = mode;

		}
	),

	handleEnableBloomChange: handleChange(
		val => set( { enableBloom: val } ),
		val => window.pathTracerApp.bloomPass.enabled = val
	),

	handleBloomThresholdChange: handleChange(
		val => set( { bloomThreshold: val } ),
		val => window.pathTracerApp.bloomPass.threshold = val[ 0 ]
	),

	handleBloomStrengthChange: handleChange(
		val => set( { bloomStrength: val } ),
		val => window.pathTracerApp.bloomPass.strength = val[ 0 ]
	),

	handleBloomRadiusChange: handleChange(
		val => set( { bloomRadius: val } ),
		val => window.pathTracerApp.bloomPass.radius = val[ 0 ]
	),

	handleExposureChange: handleChange(
		val => set( { exposure: val } ),
		val => {

			const app = window.pathTracerApp;
			app.renderer.toneMappingExposure = val;
			app.pathTracingPass.material.uniforms.exposure.value = val;
			app.denoiser.mapGenerator.syncWithRenderer();
			app.reset();

		}
	),

	handleEnableEnvironmentChange: handleChange(
		val => set( { enableEnvironment: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.material.uniforms.enableEnvironmentLight.value = val;
			window.pathTracerApp.reset();

		}
	),

	handleUseImportanceSampledEnvironmentChange: handleChange(
		val => set( { useImportanceSampledEnvironment: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.material.uniforms.useEnvMapIS.value = val;
			window.pathTracerApp.reset();

		}
	),

	handleShowBackgroundChange: handleChange(
		val => set( { showBackground: val } ),
		val => {

			const app = window.pathTracerApp;
			app.scene.background = val ? app.scene.environment : null;
			app.pathTracingPass.material.uniforms.showBackground.value = val;
			app.reset();

		}
	),

	handleBackgroundIntensityChange: handleChange(
		val => set( { backgroundIntensity: val } ),
		val => {

			const app = window.pathTracerApp;
			app.scene.backgroundIntensity = val;
			app.pathTracingPass.material.uniforms.backgroundIntensity.value = val;
			app.reset();

		}
	),

	handleEnvironmentIntensityChange: handleChange(
		val => set( { environmentIntensity: val } ),
		val => {

			const app = window.pathTracerApp;
			app.scene.environmentIntensity = val;
			app.pathTracingPass.material.uniforms.environmentIntensity.value = val;
			app.reset();

		}
	),

	handleEnvironmentRotationChange: handleChange(
		val => set( { environmentRotation: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.setEnvironmentRotation( val[ 0 ] );
			window.pathTracerApp.reset();

		}
	),

	handleGIIntensityChange: handleChange(
		val => set( { GIIntensity: val } ),
		val => {

			window.pathTracerApp.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = val;
			window.pathTracerApp.reset();

		}
	),

	// Environment Mode Handlers
	handleEnvironmentModeChange: handleChange(
		val => set( { environmentMode: val } ),
		async val => {

			const app = window.pathTracerApp;
			if ( ! app ) return;

			const modeMap = { hdri: 0, procedural: 1, gradient: 2, color: 3 };

			// Store previous HDRI if switching away
			if ( val !== 'hdri' && get().environmentMode === 'hdri' ) {

				app._previousHDRI = app.pathTracingPass.material.uniforms.environment.value;
				app._previousCDF = app.pathTracingPass.material.uniforms.envCDF.value;

			}

			// Generate texture for procedural modes
			if ( val === 'gradient' ) {

				await app.pathTracingPass.generateGradientTexture();

			} else if ( val === 'color' ) {

				await app.pathTracingPass.generateSolidColorTexture();

			} else if ( val === 'procedural' ) {

				await app.pathTracingPass.generateProceduralSkyTexture();

			} else if ( val === 'hdri' ) {

				// Restore previous HDRI
				if ( app._previousHDRI ) {

					await app.pathTracingPass.setEnvironmentMap( app._previousHDRI );

				}

			}

			// Update envParams mode (CPU-side parameter, not passed to shader)
			app.pathTracingPass.envParams.mode = val;

			// Force texture update
			if ( app.pathTracingPass.material.uniforms.environment.value ) {

				app.pathTracingPass.material.uniforms.environment.value.needsUpdate = true;

			}

			console.log( '✅ Environment mode changed to:', val, '(uniform value:', modeMap[ val ], ')' );

			app.reset();

		}
	),

	// Gradient Sky Handlers
	handleGradientZenithColorChange: handleChange(
		val => set( { gradientZenithColor: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const color = new THREE.Color( val );
			app.pathTracingPass.envParams.gradientZenithColor.copy( color );
			app.pathTracingPass.generateGradientTexture();

		}
	),

	handleGradientHorizonColorChange: handleChange(
		val => set( { gradientHorizonColor: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const color = new THREE.Color( val );
			app.pathTracingPass.envParams.gradientHorizonColor.copy( color );
			app.pathTracingPass.generateGradientTexture();

		}
	),

	handleGradientGroundColorChange: handleChange(
		val => set( { gradientGroundColor: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'gradient' ) return;

			const color = new THREE.Color( val );
			app.pathTracingPass.envParams.gradientGroundColor.copy( color );
			app.pathTracingPass.generateGradientTexture();

		}
	),

	// Solid Color Sky Handler
	handleSolidSkyColorChange: handleChange(
		val => set( { solidSkyColor: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'color' ) return;

			const color = new THREE.Color( val );
			app.pathTracingPass.envParams.solidSkyColor.copy( color );
			app.pathTracingPass.generateSolidColorTexture();

		}
	),

	// Procedural Sky (Preetham Model) Handlers
	handleSkySunAzimuthChange: handleChange(
		val => set( { skySunAzimuth: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			// Update sun direction based on azimuth and elevation
			const azimuth = val * ( Math.PI / 180 );
			const elevation = get().skySunElevation * ( Math.PI / 180 );
			const sunDir = new THREE.Vector3(
				Math.cos( elevation ) * Math.sin( azimuth ),
				Math.sin( elevation ),
				Math.cos( elevation ) * Math.cos( azimuth )
			).normalize();

			app.pathTracingPass.envParams.skySunDirection.copy( sunDir );
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkySunElevationChange: handleChange(
		val => set( { skySunElevation: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			// Update sun direction based on azimuth and elevation
			const azimuth = get().skySunAzimuth * ( Math.PI / 180 );
			const elevation = val * ( Math.PI / 180 );
			const sunDir = new THREE.Vector3(
				Math.cos( elevation ) * Math.sin( azimuth ),
				Math.sin( elevation ),
				Math.cos( elevation ) * Math.cos( azimuth )
			).normalize();

			app.pathTracingPass.envParams.skySunDirection.copy( sunDir );
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkySunIntensityChange: handleChange(
		val => set( { skySunIntensity: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			app.pathTracingPass.envParams.skySunIntensity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkyRayleighDensityChange: handleChange(
		val => set( { skyRayleighDensity: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			app.pathTracingPass.envParams.skyRayleighDensity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),

	handleSkyTurbidityChange: handleChange(
		val => set( { skyTurbidity: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			app.pathTracingPass.envParams.skyTurbidity = val;
			// Use debounced version to prevent rapid regeneration
			debouncedGenerateProceduralSkyTexture();

		}
	),


	handleSkyMieAnisotropyChange: handleChange(
		val => set( { skyMieAnisotropy: val } ),
		val => {

			const app = window.pathTracerApp;
			if ( ! app || get().environmentMode !== 'procedural' ) return;

			app.pathTracingPass.envParams.skyMieAnisotropy = val;
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
		val => {

			const app = window.pathTracerApp;
			app.renderer.toneMapping = parseInt( val );
			app.denoiser.mapGenerator.syncWithRenderer();
			app.reset();

		}
	),

	handleInteractionModeEnabledChange: handleChange(
		val => set( { interactionModeEnabled: val } ),
		val => window.pathTracerApp.pathTracingPass.setInteractionModeEnabled( val ),
		false // Don't reset - exitInteractionMode handles the soft reset internally
	),

	handleAsvgfTemporalAlphaChange: handleChange(
		val => set( { asvgfTemporalAlpha: val[ 0 ] } ),
		val => window.pathTracerApp.asvgfPass.updateParameters( { temporalAlpha: val[ 0 ] } ),
		false
	),

	handleAsvgfPhiColorChange: handleChange(
		val => set( { asvgfPhiColor: val[ 0 ] } ),
		val => window.pathTracerApp.asvgfPass.updateParameters( { phiColor: val[ 0 ] } ),
		false
	),

	handleEnableASVGFChange: handleChange(
		val => set( { enableASVGF: val } ),
		val => {

			const app = window.pathTracerApp;
			app.asvgfPass.enabled = val;

			if ( val ) {

				// When enabling ASVGF, ensure temporal processing is enabled
				app.asvgfPass.setTemporalEnabled && app.asvgfPass.setTemporalEnabled( true );

				// Apply current quality preset parameters
				const store = get();
				const preset = ASVGF_QUALITY_PRESETS[ store.asvgfQualityPreset ];

				if ( preset ) {

					app.asvgfPass.updateParameters( preset );

				}

			}

			// Coordinate with EdgeAware filtering
			app.edgeAwareFilterPass.setFilteringEnabled( ! val );

			// Reset when toggling
			app.reset();

		}
	),

	handleShowAsvgfHeatmapChange: handleChange(
		val => set( { showAsvgfHeatmap: val } ),
		val => {

			if ( window.pathTracerApp?.asvgfPass ) {

				window.pathTracerApp.asvgfPass.toggleHeatmap && window.pathTracerApp.asvgfPass.toggleHeatmap( val );

			}

		}
	),


	handleAsvgfPhiLuminanceChange: handleChange(
		val => set( { asvgfPhiLuminance: val } ),
		val => window.pathTracerApp.updateASVGFParameters( { phiLuminance: val[ 0 ] } ),
		false
	),

	handleAsvgfAtrousIterationsChange: handleChange(
		val => set( { asvgfAtrousIterations: val[ 0 ] } ),
		val => window.pathTracerApp.asvgfPass.updateParameters( { atrousIterations: val[ 0 ] } ),
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

		if ( ! window.pathTracerApp ) return;
		const app = window.pathTracerApp;
		app.controls.enabled = true;

		requestAnimationFrame( () => {

			const uniforms = app.pathTracingPass.material.uniforms;
			uniforms.maxBounceCount.value = PREVIEW_STATE.bounces;
			uniforms.numRaysPerPixel.value = PREVIEW_STATE.samplesPerPixel;
			uniforms.renderMode.value = PREVIEW_STATE.renderMode;
			uniforms.transmissiveBounces.value = PREVIEW_STATE.transmissiveBounces;

			// Use setTileCount to properly update completion threshold
			app.pathTracingPass.setTileCount( PREVIEW_STATE.tiles );
			app.tileHighlightPass.enabled = PREVIEW_STATE.tilesHelper;

			// Ensure completion threshold is updated after render mode change
			app.pathTracingPass.updateCompletionThreshold();

			// Abort any ongoing denoising before switching modes
			app.denoiser.abort();
			app.denoiser.enabled = PREVIEW_STATE.enableOIDN;
			app.denoiser.updateQuality( PREVIEW_STATE.oidnQuality );
			app.denoiser.toggleHDR( PREVIEW_STATE.oidnHDR );
			app.denoiser.toggleUseGBuffer( PREVIEW_STATE.useGBuffer );
			app.updateResolution( window.devicePixelRatio * 0.5 );

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

		if ( ! window.pathTracerApp ) return;
		const app = window.pathTracerApp;
		app.controls.enabled = false;

		requestAnimationFrame( () => {

			const uniforms = app.pathTracingPass.material.uniforms;
			uniforms.maxFrames.value = FINAL_RENDER_STATE.maxSamples;
			uniforms.maxBounceCount.value = FINAL_RENDER_STATE.bounces;
			uniforms.numRaysPerPixel.value = FINAL_RENDER_STATE.samplesPerPixel;
			uniforms.renderMode.value = FINAL_RENDER_STATE.renderMode;
			uniforms.transmissiveBounces.value = FINAL_RENDER_STATE.transmissiveBounces;

			// Use setTileCount to properly update completion threshold
			app.pathTracingPass.setTileCount( FINAL_RENDER_STATE.tiles );
			app.tileHighlightPass.enabled = FINAL_RENDER_STATE.tilesHelper;

			// Ensure completion threshold is updated after render mode change
			app.pathTracingPass.updateCompletionThreshold();

			// Abort any ongoing denoising before switching modes
			app.denoiser.abort();
			app.denoiser.enabled = FINAL_RENDER_STATE.enableOIDN;
			app.denoiser.updateQuality( FINAL_RENDER_STATE.oidnQuality );
			app.denoiser.toggleHDR( FINAL_RENDER_STATE.oidnHDR );
			app.denoiser.toggleUseGBuffer( FINAL_RENDER_STATE.useGBuffer );
			app.updateResolution( window.devicePixelRatio * 2.0 );

			app.renderer?.domElement && ( app.renderer.domElement.style.display = 'block' );
			app.denoiser?.output && ( app.denoiser.output.style.display = 'block' );

			app.pauseRendering = false;
			app.reset();

		} );

	},

	handleConfigureForResults: () => {

		if ( ! window.pathTracerApp ) return;
		const app = window.pathTracerApp;
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
	lights: [],
	setLights: lights => set( { lights } ),
	updateLight: ( idx, prop, val ) => set( s => {

		const lights = [ ...s.lights ];
		if ( ! lights[ idx ] ) return s;

		// Handle array values (from sliders)
		const value = Array.isArray( val ) ? val[ 0 ] : val;
		lights[ idx ][ prop ] = value;

		// Update the actual Three.js light object
		if ( window.pathTracerApp ) {

			const light = window.pathTracerApp.scene.getObjectByProperty( 'uuid', lights[ idx ].uuid );
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

					}

				}

				window.pathTracerApp.pathTracingPass.updateLights();
				window.pathTracerApp.reset();

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

		if ( ! window.pathTracerApp ) return;

		const newLight = window.pathTracerApp.addLight( lightType );
		if ( newLight ) {

			set( s => ( { lights: [ ...s.lights, newLight ] } ) );
			window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		}

	},

	// Remove light from scene
	removeLight: ( lightIndex ) => {

		if ( ! window.pathTracerApp ) return;

		set( s => {

			if ( lightIndex < 0 || lightIndex >= s.lights.length ) return s;

			const lightToRemove = s.lights[ lightIndex ];
			const success = window.pathTracerApp.removeLight( lightToRemove.uuid );

			if ( success ) {

				window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );
				return { lights: s.lights.filter( ( _, idx ) => idx !== lightIndex ) };

			}

			return s;

		} );

	},

	// Clear all lights
	clearAllLights: () => {

		if ( ! window.pathTracerApp ) return;

		window.pathTracerApp.clearLights();
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

	setCameraNames: names => set( { cameraNames: names } ),
	setSelectedCameraIndex: idx => set( { selectedCameraIndex: idx } ),
	setFocusMode: mode => set( { focusMode: mode } ),
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

		if ( ! window.pathTracerApp ) return;
		const isActive = window.pathTracerApp.toggleFocusMode();
		console.log( 'Focus mode:', isActive ? 'enabled' : 'disabled' );
		set( { focusMode: isActive } );

	},

	handleEnableDOFChange: val => {

		set( { enableDOF: val, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.enableDOF.value = val;
			window.pathTracerApp.reset();

		}

	},

	handleZoomToCursorChange: val => {

		set( { zoomToCursor: val } );
		if ( window.pathTracerApp?.controls ) {

			window.pathTracerApp.controls.zoomToCursor = val;

		}

	},

	handleFocusDistanceChange: val => {

		set( { focusDistance: val, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			const scale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = val * scale;
			window.pathTracerApp.reset();

		}

	},

	handlePresetChange: key => {

		if ( key === "custom" ) {

			set( { activePreset: "custom" } );
			return;

		}

		const preset = CAMERA_PRESETS[ key ];
		set( { ...preset, activePreset: key } );

		if ( window.pathTracerApp ) {

			const scale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;
			const { camera, pathTracingPass } = window.pathTracerApp;
			camera.fov = preset.fov;
			camera.updateProjectionMatrix();
			const uniforms = pathTracingPass.material.uniforms;
			uniforms.focusDistance.value = preset.focusDistance * scale;
			uniforms.aperture.value = preset.aperture;
			uniforms.focalLength.value = preset.focalLength;
			// Preserve the current apertureScale (DOF intensity) value
			uniforms.apertureScale.value = get().apertureScale || 1.0;
			window.pathTracerApp.reset();

		}

	},

	handleFovChange: val => {

		set( { fov: val, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.camera.fov = val;
			window.pathTracerApp.camera.updateProjectionMatrix();
			window.pathTracerApp.reset();

		}

	},

	handleApertureChange: val => {

		set( { aperture: val, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = val;
			window.pathTracerApp.reset();

		}

	},

	handleFocalLengthChange: val => {

		set( { focalLength: val, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			const uniforms = window.pathTracerApp.pathTracingPass.material.uniforms;
			uniforms.focalLength.value = val;
			val <= 0 && ( uniforms.aperture.value = 16.0 );
			window.pathTracerApp.reset();

		}

	},

	handleCameraMove: point => {

		if ( ! window.pathTracerApp?.controls ) return;
		const { controls, camera } = window.pathTracerApp;
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

		if ( window.pathTracerApp ) {

			window.pathTracerApp.switchCamera( idx );
			set( { selectedCameraIndex: idx } );

		}

	},

	handleApertureScaleChange: val => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.apertureScale.value = val;
			window.pathTracerApp.reset();

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
			const pt = window.pathTracerApp?.pathTracingPass;
			if ( ! pt ) {

				console.warn( "Path tracer not available" );
				return;

			}

			if ( typeof pt.updateMaterialProperty === 'function' ) {

				pt.updateMaterialProperty( idx, prop, val );

			} else if ( typeof pt.updateMaterialDataTexture === 'function' ) {

				// Fallback to legacy method
				pt.updateMaterialDataTexture( idx, prop, val );

			} else {

				console.warn( "No material update method available" );

			}


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
		const pt = window.pathTracerApp?.pathTracingPass;

		if ( ! pt ) {

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
		if ( typeof pt.updateTextureTransform === 'function' ) {

			pt.updateTextureTransform( materialIndex, textureName, transform );

		} else {

			console.warn( `No texture transform update method available for ${textureName}` );

		}

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
			if ( window.pathTracerApp ) {

				window.pathTracerApp.pathTracingPass.material.needsUpdate = true;
				window.pathTracerApp.reset();

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
