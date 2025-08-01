import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { DEFAULT_STATE, CAMERA_PRESETS, ASVGF_QUALITY_PRESETS } from '@/Constants';

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
const useStore = create( devtools( set => ( {
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
	appMode: 'interactive',
	setAppMode: mode => set( { appMode: mode } ),
	layers: [],
	setLayers: layers => set( { layers } ),
	selectedResult: null,
	setSelectedResult: imageData => set( { selectedResult: imageData } ),
	imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 0 },
	setImageProcessingParam: ( param, val ) => set( s => ( { imageProcessing: { ...s.imageProcessing, [ param ]: val } } ) ),
	resetImageProcessing: () => set( { imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 } } ),
} ), { name: 'main-store' } ) );

// Assets store
const useAssetsStore = create( devtools( set => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [],
	selectedMaterial: null,
	selectedEnvironmentIndex: null,
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
} ), { name: 'assets-store' } ) );

// Environment store
const useEnvironmentStore = create( devtools( set => ( {
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
} ), { name: 'environment-store' } ) );

// Path tracer store with handlers
const FINAL_STATE = {
	maxSamples: 30, bounces: 20, transmissiveBounces: 8, samplesPerPixel: 1, renderMode: 1, tiles: 3, tilesHelper: false,
	resolution: 3, enableOIDN: true, oidnQuality: 'balance', oidnHDR: false, useGBuffer: true,
	interactionModeEnabled: false,
};

const INTERACTIVE_STATE = {
	bounces: 3, samplesPerPixel: 1, renderMode: 0, transmissiveBounces: 3, tiles: 3, tilesHelper: false, resolution: 1,
	enableOIDN: false, oidnQuality: 'fast', oidnHDR: false, useGBuffer: true,
	interactionModeEnabled: true,
};

const usePathTracerStore = create( devtools( ( set, get ) => ( {
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
	setInteractionModeEnabled: val => set( { interactionModeEnabled: val } ),
	setEnableASVGF: val => set( { enableASVGF: val } ),
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
			interactive: {
				enabled: false, // Disable during interaction
				temporalAlpha: 0.5
			},
			progressive: {
				enabled: true,
				temporalAlpha: 0.1,
				atrousIterations: 4
			},
			final: {
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
		val => window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { max: val[ 0 ] } )
	),

	handleAdaptiveSamplingVarianceThresholdChange: handleChange(
		val => set( { adaptiveSamplingVarianceThreshold: val } ),
		val => window.pathTracerApp.pathTracingPass.setAdaptiveSamplingParameters( { threshold: val[ 0 ] } )
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
		val => window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( val )
	),

	handleTileUpdate: handleChange(
		val => set( { tiles: val } ),
		val => window.pathTracerApp.pathTracingPass.tileManager.tiles = val[ 0 ],
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

	handleDebugThresholdChange: handleChange(
		val => set( { debugThreshold: val } ),
		val => window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = val[ 0 ]
	),

	handleDebugModeChange: handleChange(
		val => set( { debugMode: val } ),
		val => {

			const mode = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 }[ val ] || 0;
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

			window.pathTracerApp.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = val * Math.PI;
			window.pathTracerApp.reset();

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
		val => window.pathTracerApp.pathTracingPass.setInteractionModeEnabled( val )
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

			// Coordinate with EdgeAware filtering
			app.edgeAwareFilterPass.setFilteringEnabled( ! val );

			// Reset when toggling
			app.reset();

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
	handleConfigureForInteractive: () => {

		const a = get();
		Object.entries( INTERACTIVE_STATE ).forEach( ( [ k, v ] ) => {

			const setter = `set${k[ 0 ].toUpperCase()}${k.slice( 1 )}`;
			const value = Array.isArray( v ) ? [ ...v ] : ( v && typeof v === 'object' ) ? { ...v } : v;
			a[ setter ]?.( value );

		} );

		if ( ! window.pathTracerApp ) return;
		const app = window.pathTracerApp;
		app.controls.enabled = true;

		requestAnimationFrame( () => {

			const uniforms = app.pathTracingPass.material.uniforms;
			uniforms.maxBounceCount.value = INTERACTIVE_STATE.bounces;
			uniforms.numRaysPerPixel.value = INTERACTIVE_STATE.samplesPerPixel;
			uniforms.renderMode.value = INTERACTIVE_STATE.renderMode;
			uniforms.transmissiveBounces.value = INTERACTIVE_STATE.transmissiveBounces;
			app.pathTracingPass.tileManager.tiles = INTERACTIVE_STATE.tiles;
			app.tileHighlightPass.enabled = INTERACTIVE_STATE.tilesHelper;
			app.denoiser.enabled = INTERACTIVE_STATE.enableOIDN;
			app.denoiser.updateQuality( INTERACTIVE_STATE.oidnQuality );
			app.denoiser.toggleHDR( INTERACTIVE_STATE.oidnHDR );
			app.denoiser.toggleUseGBuffer( INTERACTIVE_STATE.useGBuffer );
			app.updateResolution( window.devicePixelRatio * 0.5 );

			app.renderer?.domElement && ( app.renderer.domElement.style.display = 'block' );
			app.denoiser?.output && ( app.denoiser.output.style.display = 'block' );

			app.pauseRendering = false;
			app.reset();

		} );

	},

	handleConfigureForFinal: () => {

		const a = get();
		Object.entries( FINAL_STATE ).forEach( ( [ k, v ] ) => {

			const setter = `set${k.charAt( 0 ).toUpperCase()}${k.slice( 1 )}`;
			a[ setter ]?.( typeof v === 'number' ? v : v.toString() );

		} );

		if ( ! window.pathTracerApp ) return;
		const app = window.pathTracerApp;
		app.controls.enabled = false;

		requestAnimationFrame( () => {

			const uniforms = app.pathTracingPass.material.uniforms;
			uniforms.maxFrames.value = FINAL_STATE.maxSamples;
			uniforms.maxBounceCount.value = FINAL_STATE.bounces;
			uniforms.numRaysPerPixel.value = FINAL_STATE.samplesPerPixel;
			uniforms.renderMode.value = FINAL_STATE.renderMode;
			uniforms.transmissiveBounces.value = FINAL_STATE.transmissiveBounces;
			app.pathTracingPass.tileManager.tiles = FINAL_STATE.tiles;
			app.tileHighlightPass.enabled = FINAL_STATE.tilesHelper;
			app.denoiser.enabled = FINAL_STATE.enableOIDN;
			app.denoiser.updateQuality( FINAL_STATE.oidnQuality );
			app.denoiser.toggleHDR( FINAL_STATE.oidnHDR );
			app.denoiser.toggleUseGBuffer( FINAL_STATE.useGBuffer );
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

		const actions = { interactive: 'handleConfigureForInteractive', final: 'handleConfigureForFinal', results: 'handleConfigureForResults' };
		const action = actions[ mode ];
		action ? get()[ action ]() : console.warn( `Unknown mode: ${mode}` );

	},
} ), { name: 'path-tracer-store' } ) );

// Light store
const useLightStore = create( set => ( {
	...DEFAULT_STATE,
	lights: [],
	setLights: lights => set( { lights } ),
	updateLight: ( idx, prop, val ) => set( s => {

		const lights = [ ...s.lights ];
		lights[ idx ][ prop ] = val;
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
			const idx = obj.userData?.materialIndex ?? 0;
			const pt = window.pathTracerApp?.pathTracingPass;
			if ( ! pt ) {

				console.warn( "Path tracer not available" );
				return;

			}

			const methods = [ 'updateMaterial', 'updateMaterialProperty', 'updateMaterialDataTexture', 'rebuildMaterialDataTexture' ];
			const args = [
				[ idx, obj.material ],
				[ idx, prop, val ],
				[ idx, prop, val ],
				[ idx, obj.material ]
			];

			for ( let i = 0; i < methods.length; i ++ ) {

				if ( typeof pt[ methods[ i ] ] === 'function' ) {

					pt[ methods[ i ] ]( ...args[ i ] );
					break;

				}

			}

			window.pathTracerApp?.reset();

		} catch ( error ) {

			console.error( `Error updating material property ${prop}:`, error );

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
	handleOpacityChange: val => get().updateMaterialProperty( 'opacity', val[ 0 ] ),
	handleSideChange: val => get().updateMaterialProperty( 'side', val ),
	handleEmissiveChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.emissive ) {

			obj.material.emissive.set( val );
			get().updateMaterialProperty( 'emissive', obj.material.emissive );

		}

	},
	handleTransparentChange: val => get().updateMaterialProperty( 'transparent', val ? 1 : 0 ),
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
} ) );

export { useStore, useAssetsStore, useEnvironmentStore, usePathTracerStore, useLightStore, useCameraStore, useMaterialStore };
