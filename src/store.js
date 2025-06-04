import { create } from 'zustand';
import { DEFAULT_STATE, CAMERA_PRESETS } from '@/Constants';

const handleChange = ( setter, appUpdater, needsReset = true ) => value => {

	if ( typeof setter !== 'function' ) {

		console.error( "Invalid setter function passed to handleChange:", setter );
		return;

	}

	setter( value );
	if ( window.pathTracerApp ) {

		appUpdater( value );
		needsReset && window.pathTracerApp.reset();

	}

};

// Main store
const useStore = create( ( set ) => ( {
	selectedObject: null,
	setSelectedObject: ( object ) => set( { selectedObject: object } ),
	loading: { isLoading: false, progress: 0, title: '', status: '' },
	setLoading: ( loadingState ) => set( ( state ) => ( { loading: { ...state.loading, ...loadingState } } ) ),
	stats: { samples: 0, timeElapsed: 0 },
	setStats: ( stats ) => set( { stats } ),
	isDenoising: false,
	setIsDenoising: ( value ) => set( { isDenoising: value } ),
	isRenderComplete: false,
	setIsRenderComplete: ( value ) => set( { isRenderComplete: value } ),
	resetLoading: () => set( { loading: { isLoading: false, progress: 0, title: '', status: '' } } ),
	appMode: 'interactive', // 'interactive', 'final' or 'results'
	setAppMode: ( mode ) => set( { appMode: mode } ),
	layers: [],
	setLayers: ( layers ) => set( { layers } ),
	selectedResult: null,
	setSelectedResult: ( imageData ) => set( { selectedResult: imageData } ),
	imageProcessing: {
		brightness: 0,
		contrast: 0,
		saturation: 0,
		hue: 0,
		exposure: 0,
		gamma: 0,
	},
	setImageProcessingParam: ( param, value ) =>
		set( state => ( {
			imageProcessing: {
				...state.imageProcessing,
				[ param ]: value
			}
		} ) ),
	resetImageProcessing: () =>
		set( {
			imageProcessing: {
				brightness: 0,
				contrast: 0,
				saturation: 0,
				hue: 0,
				exposure: 0,
				gamma: 2.2,
			}
		} ),
} ) );

// Assets store
const useAssetsStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [],
	selectedMaterial: null,
	selectedEnvironmentIndex: null,
	setMaterials: ( materials ) => set( { materials } ),
	setSelectedMaterial: ( materialIndex ) => set( { selectedMaterial: materialIndex } ),
	setActiveTab: ( tab ) => set( { activeTab: tab } ),
	setModel: ( model ) => set( { model } ),
	setEnvironment: ( env ) => {

		// When setting environment, also update the selected index if we have environments
		set( ( state ) => {

			const environmentStore = useEnvironmentStore.getState();
			const environments = environmentStore.environments || [];
			const index = environments.findIndex( e => e.id === env.id );

			return {
				environment: env,
				selectedEnvironmentIndex: index >= 0 ? index : null
			};

		} );

	},
	setSelectedEnvironmentIndex: ( index ) => set( { selectedEnvironmentIndex: index } ),
	setDebugModel: ( model ) => set( { debugModel: model } ),
} ) );

// Environment store
const useEnvironmentStore = create( ( set ) => ( {
	apiData: null,
	environments: [],
	isLoading: true,
	error: null,
	selectedResolution: '1k',
	setApiData: ( data ) => set( { apiData: data } ),
	setEnvironments: ( environments ) => set( { environments } ),
	setIsLoading: ( isLoading ) => set( { isLoading } ),
	setError: ( error ) => set( { error } ),
	setSelectedResolution: ( resolution ) => set( { selectedResolution: resolution } ),
} ) );

// Path tracer store with handlers
const FINAL_RENDER_STATE = {
	maxSamples: 30,
	bounces: 20,
	samplesPerPixel: 1,
	renderMode: 1,
	tiles: 3,
	tilesHelper: false,
	resolution: 3,
	enableOIDN: true,
	oidnQuality: 'balance',
	oidnHDR: false,
	useGBuffer: true,
	interactionModeEnabled: false,
	enableASVGF: false,
};

const INTERACTIVE_RENDER_STATE = {
	bounces: 3,
	samplesPerPixel: 1,
	renderMode: 0,
	tiles: 3,
	tilesHelper: false,
	resolution: 1,
	enableOIDN: false,
	oidnQuality: 'fast',
	oidnHDR: false,
	useGBuffer: true,
	interactionModeEnabled: true,
	enableASVGF: false,
};

const usePathTracerStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	backgroundIntensity: DEFAULT_STATE.backgroundIntensity,
	performanceModeAdaptive: 'medium',

	// State setters
	setMaxSamples: ( value ) => set( { maxSamples: value } ),
	setEnablePathTracer: ( value ) => set( { enablePathTracer: value } ),
	setEnableAccumulation: ( value ) => set( { enableAccumulation: value } ),
	setBounces: ( value ) => set( { bounces: value } ),
	setSamplesPerPixel: ( value ) => set( { samplesPerPixel: value } ),
	setSamplingTechnique: ( value ) => set( { samplingTechnique: value } ),
	setAdaptiveSampling: ( value ) => set( { adaptiveSampling: value } ),
	setPerformanceModeAdaptive: ( value ) => set( { performanceModeAdaptive: value } ),
	setAdaptiveSamplingMin: ( value ) => set( { adaptiveSamplingMin: value } ),
	setAdaptiveSamplingMax: ( value ) => set( { adaptiveSamplingMax: value } ),
	setAdaptiveSamplingVarianceThreshold: ( value ) => set( { adaptiveSamplingVarianceThreshold: value } ),
	setTemporalVarianceThreshold: ( value ) => set( { temporalVarianceThreshold: value } ),
	setTemporalVarianceWeight: ( value ) => set( { temporalVarianceWeight: value } ),
	setEnableEarlyTermination: ( value ) => set( { enableEarlyTermination: value } ),
	setEarlyTerminationThreshold: ( value ) => set( { earlyTerminationThreshold: value } ),
	setShowAdaptiveSamplingHelper: ( value ) => set( { showAdaptiveSamplingHelper: value } ),
	setFireflyThreshold: ( value ) => set( { fireflyThreshold: value } ),
	setRenderMode: ( value ) => set( { renderMode: value } ),
	setTiles: ( value ) => set( { tiles: value } ),
	setTilesHelper: ( value ) => set( { tilesHelper: value } ),
	setResolution: ( value ) => set( { resolution: value } ),
	setEnableOIDN: ( value ) => set( { enableOIDN: value } ),
	setUseGBuffer: ( value ) => set( { useGBuffer: value } ),
	setEnableRealtimeDenoiser: ( value ) => set( { enableRealtimeDenoiser: value } ),
	setDenoiserBlurStrength: ( value ) => set( { denoiserBlurStrength: value } ),
	setDenoiserBlurRadius: ( value ) => set( { denoiserBlurRadius: value } ),
	setDenoiserDetailPreservation: ( value ) => set( { denoiserDetailPreservation: value } ),
	setDebugMode: ( value ) => set( { debugMode: value } ),
	setDebugThreshold: ( value ) => set( { debugThreshold: value } ),
	setEnableBloom: ( value ) => set( { enableBloom: value } ),
	setBloomThreshold: ( value ) => set( { bloomThreshold: value } ),
	setBloomStrength: ( value ) => set( { bloomStrength: value } ),
	setBloomRadius: ( value ) => set( { bloomRadius: value } ),
	setOidnQuality: ( value ) => set( { oidnQuality: value } ),
	setOidnHdr: ( value ) => set( { oidnHdr: value } ),
	setExposure: ( value ) => set( { exposure: value } ),
	setEnableEnvironment: ( value ) => set( { enableEnvironment: value } ),
	setUseImportanceSampledEnvironment: ( value ) => set( { useImportanceSampledEnvironment: value } ),
	setShowBackground: ( value ) => set( { showBackground: value } ),
	setBackgroundIntensity: ( value ) => set( { backgroundIntensity: value } ),
	setEnvironmentIntensity: ( value ) => set( { environmentIntensity: value } ),
	setEnvironmentRotation: ( value ) => set( { environmentRotation: value } ),
	setGIIntensity: ( value ) => set( { GIIntensity: value } ),
	setToneMapping: ( value ) => set( { toneMapping: value } ),
	setInteractionModeEnabled: ( value ) => set( { interactionModeEnabled: value } ),
	setEnableASVGF: ( value ) => set( { enableASVGF: value } ),
	setAsvgfTemporalAlpha: ( value ) => set( { asvgfTemporalAlpha: value } ),
	setAsvgfVarianceClip: ( value ) => set( { asvgfVarianceClip: value } ),
	setAsvgfMomentClip: ( value ) => set( { asvgfMomentClip: value } ),
	setAsvgfPhiColor: ( value ) => set( { asvgfPhiColor: value } ),
	setAsvgfPhiNormal: ( value ) => set( { asvgfPhiNormal: value } ),
	setAsvgfPhiDepth: ( value ) => set( { asvgfPhiDepth: value } ),
	setAsvgfPhiLuminance: ( value ) => set( { asvgfPhiLuminance: value } ),
	setAsvgfAtrousIterations: ( value ) => set( { asvgfAtrousIterations: value } ),
	setAsvgfFilterSize: ( value ) => set( { asvgfFilterSize: value } ),

	// Handlers that combine state updates with app updates
	handlePathTracerChange: handleChange(
		( value ) => set( { enablePathTracer: value } ),
		value => {

			window.pathTracerApp.accPass.enabled = value;
			window.pathTracerApp.pathTracingPass.enabled = value;
			window.pathTracerApp.renderPass.enabled = ! value;

		}
	),

	handleAccumulationChange: handleChange(
		( value ) => set( { enableAccumulation: value } ),
		value => window.pathTracerApp.accPass.enabled = value
	),

	handleBouncesChange: handleChange(
		( value ) => set( { bounces: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = value
	),

	handleSamplesPerPixelChange: handleChange(
		( value ) => set( { samplesPerPixel: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = value
	),

	handleSamplingTechniqueChange: handleChange(
		( value ) => set( { samplingTechnique: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.samplingTechnique.value = value
	),

	handleResolutionChange: handleChange(
		( value ) => set( { resolution: value } ),
		value => {

			let result;
			switch ( value ) {

				case '1': result = window.devicePixelRatio * 0.5; break;
				case '2': result = window.devicePixelRatio * 1; break;
				case '3': result = window.devicePixelRatio * 2; break;
				case '4': result = window.devicePixelRatio * 4; break;
				default: result = window.devicePixelRatio * 0.25;

			}

			window.pathTracerApp.updateResolution( result );

		}
	),

	handleAdaptiveSamplingChange: handleChange(
		( value ) => set( { adaptiveSampling: value } ),
		value => {

			window.pathTracerApp.pathTracingPass.material.uniforms.useAdaptiveSampling.value = value;
			window.pathTracerApp.adaptiveSamplingPass.enabled = value;
			window.pathTracerApp.adaptiveSamplingPass.toggleHelper( false );

		}
	),

	handlePerformanceModeAdaptiveChange: handleChange(
		( value ) => set( { performanceModeAdaptive: value } ),
		value => window.pathTracerApp.temporalStatsPass.setPerformanceMode( value )
	),

	handleAdaptiveSamplingMinChange: handleChange(
		( value ) => set( { adaptiveSamplingMin: value } ),
		value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMin.value = value[ 0 ]
	),

	handleAdaptiveSamplingMaxChange: handleChange(
		( value ) => set( { adaptiveSamplingMax: value } ),
		value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMax.value = value[ 0 ]
	),

	handleAdaptiveSamplingVarianceThresholdChange: handleChange(
		( value ) => set( { adaptiveSamplingVarianceThreshold: value } ),
		value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingVarianceThreshold.value = value[ 0 ]
	),

	handleAdaptiveSamplingHelperToggle: handleChange(
		( value ) => set( { showAdaptiveSamplingHelper: value } ),
		value => window.pathTracerApp?.adaptiveSamplingPass?.toggleHelper( value )
	),

	handleTemporalVarianceWeightChange: handleChange(
		( value ) => set( { temporalVarianceWeight: value } ),
		value => {

			window.pathTracerApp.adaptiveSamplingPass.material.uniforms.temporalWeight.value = value[ 0 ];
			window.pathTracerApp.reset();

		}
	),

	handleEnableEarlyTerminationChange: handleChange(
		( value ) => set( { enableEarlyTermination: value } ),
		value => {

			window.pathTracerApp.temporalStatsPass.setEnableEarlyTermination( value );
			window.pathTracerApp.reset();

		}
	),

	handleEarlyTerminationThresholdChange: handleChange(
		( value ) => set( { earlyTerminationThreshold: value } ),
		value => {

			window.pathTracerApp.temporalStatsPass.setConvergenceThreshold( value[ 0 ] );
		 window.pathTracerApp.reset();

		}
	),

	handleFireflyThresholdChange: handleChange(
		( value ) => set( { fireflyThreshold: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.fireflyThreshold.value = value[ 0 ]
	),

	handleRenderModeChange: handleChange(
		( value ) => set( { renderMode: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( value )
	),

	handleTileUpdate: handleChange(
		( value ) => set( { tiles: value } ),
		value => window.pathTracerApp.pathTracingPass.tiles = value[ 0 ],
		false
	),

	handleTileHelperToggle: handleChange(
		( value ) => set( { tilesHelper: value } ),
		value => {

			const { renderMode } = get();
			parseInt( renderMode ) === 1 && ( window.pathTracerApp.tileHighlightPass.enabled = value );

		},
		false
	),

	handleEnableOIDNChange: handleChange(
		( value ) => set( { enableOIDN: value } ),
		value => window.pathTracerApp.denoiser.enabled = value,
		false
	),

	handleOidnQualityChange: handleChange(
		( value ) => set( { oidnQuality: value } ),
		value => window.pathTracerApp.denoiser.updateQuality( value ),
		false
	),

	handleOidnHdrChange: handleChange(
		( value ) => set( { oidnHdr: value } ),
		value => window.pathTracerApp.denoiser.toggleHDR( value ),
		false
	),

	handleUseGBufferChange: handleChange(
		( value ) => set( { useGBuffer: value } ),
		value => window.pathTracerApp.denoiser.toggleUseGBuffer( value ),
		false
	),

	handleEnableRealtimeDenoiserChange: handleChange(
		( value ) => set( { enableRealtimeDenoiser: value } ),
		value => window.pathTracerApp.denoiserPass.enabled = value,
		false
	),

	handleDenoiserBlurStrengthChange: handleChange(
		( value ) => set( { denoiserBlurStrength: value } ),
		value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.sigma.value = value[ 0 ],
		false
	),

	handleDenoiserBlurRadiusChange: handleChange(
		( value ) => set( { denoiserBlurRadius: value } ),
		value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.kSigma.value = value[ 0 ],
		false
	),

	handleDenoiserDetailPreservationChange: handleChange(
		( value ) => set( { denoiserDetailPreservation: value } ),
		value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.threshold.value = value[ 0 ],
		false
	),

	handleDebugThresholdChange: handleChange(
		( value ) => set( { debugThreshold: value } ),
		value => window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = value[ 0 ]
	),

	handleDebugModeChange: handleChange(
		( value ) => set( { debugMode: value } ),
		value => {

			let mode;
			switch ( value ) {

				case '1': mode = 1; break;
				case '2': mode = 2; break;
				case '3': mode = 3; break;
				case '4': mode = 4; break;
				case '5': mode = 5; break;
				default: mode = 0;

			}

			window.pathTracerApp.pathTracingPass.material.uniforms.visMode.value = mode;

		}
	),

	handleEnableBloomChange: handleChange(
		( value ) => set( { enableBloom: value } ),
		value => window.pathTracerApp.bloomPass.enabled = value
	),

	handleBloomThresholdChange: handleChange(
		( value ) => set( { bloomThreshold: value } ),
		value => window.pathTracerApp.bloomPass.threshold = value[ 0 ]
	),

	handleBloomStrengthChange: handleChange(
		( value ) => set( { bloomStrength: value } ),
		value => window.pathTracerApp.bloomPass.strength = value[ 0 ]
	),

	handleBloomRadiusChange: handleChange(
		( value ) => set( { bloomRadius: value } ),
		value => window.pathTracerApp.bloomPass.radius = value[ 0 ]
	),

	handleExposureChange: handleChange(
		( value ) => set( { exposure: value } ),
		value => {

			window.pathTracerApp.renderer.toneMappingExposure = value;
			window.pathTracerApp.pathTracingPass.material.uniforms.exposure.value = value;
			window.pathTracerApp.reset();

		}
	),

	handleEnableEnvironmentChange: handleChange(
		( value ) => set( { enableEnvironment: value } ),
		value => {

			window.pathTracerApp.pathTracingPass.material.uniforms.enableEnvironmentLight.value = value;
			window.pathTracerApp.reset();

		}
	),

	handleUseImportanceSampledEnvironmentChange: handleChange(
		( value ) => set( { useImportanceSampledEnvironment: value } ),
		value => {

			window.pathTracerApp.pathTracingPass.material.uniforms.useEnvMapIS.value = value;
			window.pathTracerApp.reset();

		}
	),

	handleShowBackgroundChange: handleChange(
		( value ) => set( { showBackground: value } ),
		value => {

			window.pathTracerApp.scene.background = value ? window.pathTracerApp.scene.environment : null;
			window.pathTracerApp.pathTracingPass.material.uniforms.showBackground.value = value ? true : false;
			window.pathTracerApp.reset();

		}
	),

	handleBackgroundIntensityChange: handleChange(
		( value ) => set( { backgroundIntensity: value } ),
		value => {

			window.pathTracerApp.scene.backgroundIntensity = value;
			window.pathTracerApp.pathTracingPass.material.uniforms.backgroundIntensity.value = value;
			window.pathTracerApp.reset();

		}
	),

	handleEnvironmentIntensityChange: handleChange(
		( value ) => set( { environmentIntensity: value } ),
		value => {

			window.pathTracerApp.scene.environmentIntensity = value;
			window.pathTracerApp.pathTracingPass.material.uniforms.environmentIntensity.value = value;
			window.pathTracerApp.reset();

		}
	),

	handleEnvironmentRotationChange: handleChange(
		( value ) => set( { environmentRotation: value } ),
		value => {

			window.pathTracerApp.pathTracingPass.material.uniforms.environmentRotation.value = value[ 0 ] * ( Math.PI / 180 );
			window.pathTracerApp.reset();

		}
	),

	handleGIIntensityChange: handleChange(
		( value ) => set( { GIIntensity: value } ),
		value => {

			window.pathTracerApp.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = value * Math.PI;
			window.pathTracerApp.reset();

		}
	),

	handleToneMappingChange: handleChange(
		( value ) => set( { toneMapping: value } ),
		value => {

			value = parseInt( value );
			window.pathTracerApp.renderer.toneMapping = value;
			window.pathTracerApp.reset();

		}
	),

	handleInteractionModeEnabledChange: handleChange(
		( value ) => set( { interactionModeEnabled: value } ),
		value => window.pathTracerApp.pathTracingPass.setInteractionModeEnabled( value )
	),

	handleEnableASVGFChange: handleChange(
		( value ) => set( { enableASVGF: value } ),
		value => {

			window.pathTracerApp.setASVGFEnabled( value );
			if ( value ) {

				window.pathTracerApp.denoiserPass.enabled = false;
				const { setEnableRealtimeDenoiser } = get();
				setEnableRealtimeDenoiser( false );

			}

		},
		false
	),

	handleAsvgfTemporalAlphaChange: handleChange(
		( value ) => set( { asvgfTemporalAlpha: value } ),
		value => window.pathTracerApp.updateASVGFParameters( { temporalAlpha: value[ 0 ] } ),
		false
	),

	handleAsvgfPhiColorChange: handleChange(
		( value ) => set( { asvgfPhiColor: value } ),
		value => window.pathTracerApp.updateASVGFParameters( { phiColor: value[ 0 ] } ),
		false
	),

	handleAsvgfPhiLuminanceChange: handleChange(
		( value ) => set( { asvgfPhiLuminance: value } ),
		value => window.pathTracerApp.updateASVGFParameters( { phiLuminance: value[ 0 ] } ),
		false
	),

	handleAsvgfAtrousIterationsChange: handleChange(
		( value ) => set( { asvgfAtrousIterations: value } ),
		value => window.pathTracerApp.updateASVGFParameters( { atrousIterations: value[ 0 ] } ),
		false
	),

	// Canvas configuration handlers
	handleConfigureForInteractive: () => {

		const actions = get();

		// Update store state
		actions.setBounces( INTERACTIVE_RENDER_STATE.bounces );
		actions.setSamplesPerPixel( INTERACTIVE_RENDER_STATE.samplesPerPixel );
		actions.setRenderMode( INTERACTIVE_RENDER_STATE.renderMode.toString() );
		actions.setTiles( INTERACTIVE_RENDER_STATE.tiles );
		actions.setTilesHelper( INTERACTIVE_RENDER_STATE.tilesHelper );
		actions.setResolution( INTERACTIVE_RENDER_STATE.resolution );
		actions.setEnableOIDN( INTERACTIVE_RENDER_STATE.enableOIDN );
		actions.setOidnQuality( INTERACTIVE_RENDER_STATE.oidnQuality );
		actions.setOidnHdr( INTERACTIVE_RENDER_STATE.oidnHDR );
		actions.setUseGBuffer( INTERACTIVE_RENDER_STATE.useGBuffer );
		actions.setInteractionModeEnabled( INTERACTIVE_RENDER_STATE.interactionModeEnabled );
		actions.setEnableASVGF( INTERACTIVE_RENDER_STATE.enableASVGF );

		if ( window.pathTracerApp ) {

			window.pathTracerApp.controls.enabled = true;

			requestAnimationFrame( () => {

				window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = INTERACTIVE_RENDER_STATE.bounces;
				window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = INTERACTIVE_RENDER_STATE.samplesPerPixel;
				window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = INTERACTIVE_RENDER_STATE.renderMode;
				window.pathTracerApp.pathTracingPass.tiles = INTERACTIVE_RENDER_STATE.tiles;
				window.pathTracerApp.tileHighlightPass.enabled = INTERACTIVE_RENDER_STATE.tilesHelper;

				window.pathTracerApp.setASVGFEnabled( INTERACTIVE_RENDER_STATE.enableASVGF );
				window.pathTracerApp.denoiser.enabled = INTERACTIVE_RENDER_STATE.enableOIDN;
				window.pathTracerApp.denoiser.updateQuality( INTERACTIVE_RENDER_STATE.oidnQuality );
				window.pathTracerApp.denoiser.toggleHDR( INTERACTIVE_RENDER_STATE.oidnHDR );
				window.pathTracerApp.denoiser.toggleUseGBuffer( INTERACTIVE_RENDER_STATE.useGBuffer );

				window.pathTracerApp.updateResolution( window.devicePixelRatio * 0.5 );

				// Show canvases
				if ( window.pathTracerApp.renderer?.domElement ) {

					window.pathTracerApp.renderer.domElement.style.display = 'block';

				}

				if ( window.pathTracerApp.denoiser?.output ) {

					window.pathTracerApp.denoiser.output.style.display = 'block';

				}

				// Resume rendering
				window.pathTracerApp.pauseRendering = false;
				window.pathTracerApp.reset();

			} );

		}

	},

	handleConfigureForFinal: () => {

		const actions = get();

		// Update store state
		actions.setBounces( FINAL_RENDER_STATE.bounces );
		actions.setSamplesPerPixel( FINAL_RENDER_STATE.samplesPerPixel );
		actions.setRenderMode( FINAL_RENDER_STATE.renderMode.toString() );
		actions.setTiles( FINAL_RENDER_STATE.tiles );
		actions.setTilesHelper( FINAL_RENDER_STATE.tilesHelper );
		actions.setResolution( FINAL_RENDER_STATE.resolution );
		actions.setEnableOIDN( FINAL_RENDER_STATE.enableOIDN );
		actions.setOidnQuality( FINAL_RENDER_STATE.oidnQuality );
		actions.setOidnHdr( FINAL_RENDER_STATE.oidnHDR );
		actions.setUseGBuffer( FINAL_RENDER_STATE.useGBuffer );
		actions.setInteractionModeEnabled( FINAL_RENDER_STATE.interactionModeEnabled );
		actions.setEnableASVGF( FINAL_RENDER_STATE.enableASVGF );

		if ( window.pathTracerApp ) {

			// Disable controls in final render mode
			window.pathTracerApp.controls.enabled = false;

			requestAnimationFrame( () => {

				window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = FINAL_RENDER_STATE.maxSamples;
				window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = FINAL_RENDER_STATE.bounces;
				window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = FINAL_RENDER_STATE.samplesPerPixel;
				window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = FINAL_RENDER_STATE.renderMode;
				window.pathTracerApp.pathTracingPass.tiles = FINAL_RENDER_STATE.tiles;
				window.pathTracerApp.tileHighlightPass.enabled = FINAL_RENDER_STATE.tilesHelper;

				window.pathTracerApp.setASVGFEnabled( FINAL_RENDER_STATE.enableASVGF );
				window.pathTracerApp.denoiser.enabled = FINAL_RENDER_STATE.enableOIDN;
				window.pathTracerApp.denoiser.updateQuality( FINAL_RENDER_STATE.oidnQuality );
				window.pathTracerApp.denoiser.toggleHDR( FINAL_RENDER_STATE.oidnHDR );
				window.pathTracerApp.denoiser.toggleUseGBuffer( FINAL_RENDER_STATE.useGBuffer );

				window.pathTracerApp.updateResolution( window.devicePixelRatio * 2.0 );

				// Show canvases
				if ( window.pathTracerApp.renderer?.domElement ) {

					window.pathTracerApp.renderer.domElement.style.display = 'block';

				}

				if ( window.pathTracerApp.denoiser?.output ) {

					window.pathTracerApp.denoiser.output.style.display = 'block';

				}

				// Resume rendering
				window.pathTracerApp.pauseRendering = false;
				window.pathTracerApp.reset();

			} );

		}

	},

	handleConfigureForResults: () => {

		if ( window.pathTracerApp ) {

			// Pause rendering to save resources
			window.pathTracerApp.pauseRendering = true;

			// Disable controls but keep the app instance
			window.pathTracerApp.controls.enabled = false;

			// Hide the canvas but don't destroy the app
			if ( window.pathTracerApp.renderer?.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'none';

			}

			if ( window.pathTracerApp.denoiser?.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'none';

			}

		}

	},

	handleModeChange: ( mode ) => {

		const actions = get();

		switch ( mode ) {

			case "interactive":
				actions.handleConfigureForInteractive();
				break;
			case "final":
				actions.handleConfigureForFinal();
				break;
			case "results":
				actions.handleConfigureForResults();
				break;
			default:
				console.warn( `Unknown mode: ${mode}` );

		}

	},

} ) );

// Light store
const useLightStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	lights: [],
	setLights: ( lights ) => set( { lights } ),
	updateLight: ( index, property, value ) =>
		set( ( state ) => {

			const lights = [ ...state.lights ];
			lights[ index ][ property ] = value;
			return { lights };

		} ),
} ) );

// Camera store
const useCameraStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	activePreset: "custom",
	cameraNames: [],
	selectedCameraIndex: 0,
	focusMode: false,

	// State setters
	setCameraNames: ( names ) => set( { cameraNames: names } ),
	setSelectedCameraIndex: ( index ) => set( { selectedCameraIndex: index } ),
	setFocusMode: ( mode ) => set( { focusMode: mode } ),
	setFov: ( value ) => set( { fov: value, activePreset: "custom" } ),
	setFocusDistance: ( value ) => set( { focusDistance: value, activePreset: "custom" } ),
	setAperture: ( value ) => set( { aperture: value, activePreset: "custom" } ),
	setFocalLength: ( value ) => set( { focalLength: value, activePreset: "custom" } ),
	setPreset: ( presetKey ) => {

		if ( presetKey === "custom" ) return;
		const preset = CAMERA_PRESETS[ presetKey ];
		set( {
			fov: preset.fov,
			focusDistance: preset.focusDistance,
			aperture: preset.aperture,
			focalLength: preset.focalLength,
			activePreset: presetKey,
		} );

	},

	// Handlers that combine state updates with app updates
	handleToggleFocusMode: () => {

		if ( window.pathTracerApp ) {

			const isActive = window.pathTracerApp.toggleFocusMode();
			console.log( 'Focus mode:', isActive ? 'enabled' : 'disabled' );
			set( { focusMode: isActive } );

		}

	},

	handleFocusDistanceChange: ( value ) => {

		set( { focusDistance: value, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			const sceneScale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;
			const scaledFocusDistance = value * sceneScale;
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = scaledFocusDistance;
			window.pathTracerApp.reset();

		}

	},

	handlePresetChange: ( presetKey ) => {

		if ( presetKey === "custom" ) {

			set( { activePreset: "custom" } );
			return;

		}

		const preset = CAMERA_PRESETS[ presetKey ];
		set( {
			fov: preset.fov,
			focusDistance: preset.focusDistance,
			aperture: preset.aperture,
			focalLength: preset.focalLength,
			activePreset: presetKey,
		} );

		if ( window.pathTracerApp ) {

			const sceneScale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;

			// Update Three.js camera
			window.pathTracerApp.camera.fov = preset.fov;
			window.pathTracerApp.camera.updateProjectionMatrix();

			// Update path tracer uniforms
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = preset.focusDistance * sceneScale;
			window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = preset.aperture;
			window.pathTracerApp.pathTracingPass.material.uniforms.focalLength.value = preset.focalLength;

			window.pathTracerApp.reset();

		}

	},

	handleFovChange: ( value ) => {

		set( { fov: value, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.camera.fov = value;
			window.pathTracerApp.camera.updateProjectionMatrix();
			window.pathTracerApp.reset();

		}

	},

	handleApertureChange: ( value ) => {

		set( { aperture: value, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = value;
			window.pathTracerApp.reset();

		}

	},

	handleFocalLengthChange: ( value ) => {

		set( { focalLength: value, activePreset: "custom" } );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.focalLength.value = value;

			// If focal length is 0, ensure aperture is set to disable DOF
			if ( value <= 0 ) {

				window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = 16.0;

			}

			window.pathTracerApp.reset();

		}

	},

	handleCameraMove: ( point ) => {

		if ( ! window.pathTracerApp || ! window.pathTracerApp.controls ) return;

		const controls = window.pathTracerApp.controls;
		const camera = window.pathTracerApp.camera;

		const target = controls.target.clone();
		const distance = camera.position.distanceTo( target );

		// remap function inline since it's from utils
		const remap = ( value, inMin, inMax, outMin, outMax ) => {

			return ( value - inMin ) * ( outMax - outMin ) / ( inMax - inMin ) + outMin;

		};

		const phi = remap( point.y, 0, 100, 0, - Math.PI );
		const theta = remap( point.x, 0, 100, 0, - Math.PI );

		const newX = target.x + distance * Math.sin( phi ) * Math.cos( theta );
		const newY = target.y + distance * Math.cos( phi );
		const newZ = target.z + distance * Math.sin( phi ) * Math.sin( theta );

		camera.position.set( newX, newY, newZ );
		camera.lookAt( target );
		controls.update();

	},

	handleCameraChange: ( index ) => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.switchCamera( index );
			set( { selectedCameraIndex: index } );

		}

	},

	handleApertureScaleChange: ( value ) => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.apertureScale.value = value;
			window.pathTracerApp.reset();

		}

	},

	// Event handler for focus changes from the 3D view
	handleFocusChangeEvent: ( event ) => {

		set( {
			focusDistance: event.distance,
			focusMode: false,
			activePreset: "custom"
		} );

	},

} ) );

// Material store for handling material property updates
const useMaterialStore = create( ( set, get ) => ( {
	// Material property update handler
	updateMaterialProperty: ( property, value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( ! selectedObject?.isMesh || ! selectedObject.material ) return;

		try {

			// Update the Three.js material property
			selectedObject.material[ property ] = value;

			// Get material index with fallback
			const materialIndex = selectedObject.userData?.materialIndex ?? 0;

			// Update the path tracer material
			const pathTracer = window.pathTracerApp?.pathTracingPass;
			if ( ! pathTracer ) {

				console.warn( "Path tracer not available" );
				return;

			}

			// Try different APIs in order of preference
			if ( typeof pathTracer.updateMaterial === 'function' ) {

				pathTracer.updateMaterial( materialIndex, selectedObject.material );

			} else if ( typeof pathTracer.updateMaterialProperty === 'function' ) {

				pathTracer.updateMaterialProperty( materialIndex, property, value );

			} else if ( typeof pathTracer.updateMaterialDataTexture === 'function' ) {

				pathTracer.updateMaterialDataTexture( materialIndex, property, value );

			} else if ( typeof pathTracer.rebuildMaterialDataTexture === 'function' ) {

				pathTracer.rebuildMaterialDataTexture( materialIndex, selectedObject.material );

			} else {

				console.warn( "No compatible material update method found" );

			}

			// Reset rendering to apply changes
			if ( window.pathTracerApp?.reset ) {

				window.pathTracerApp.reset();

			}

		} catch ( error ) {

			console.error( `Error updating material property ${property}:`, error );

		}

	},

	// Material handlers
	handleColorChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject?.material?.color ) {

			selectedObject.material.color.set( value );
			get().updateMaterialProperty( 'color', selectedObject.material.color );

		}

	},

	handleRoughnessChange: ( value ) => {

		get().updateMaterialProperty( 'roughness', value[ 0 ] );

	},

	handleMetalnessChange: ( value ) => {

		get().updateMaterialProperty( 'metalness', value[ 0 ] );

	},

	handleIorChange: ( value ) => {

		get().updateMaterialProperty( 'ior', value[ 0 ] );

	},

	handleTransmissionChange: ( value ) => {

		get().updateMaterialProperty( 'transmission', value[ 0 ] );

	},

	handleThicknessChange: ( value ) => {

		get().updateMaterialProperty( 'thickness', value[ 0 ] );

	},

	handleAttenuationColorChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject?.material?.attenuationColor ) {

			selectedObject.material.attenuationColor.set( value );
			get().updateMaterialProperty( 'attenuationColor', selectedObject.material.attenuationColor );

		}

	},

	handleAttenuationDistanceChange: ( value ) => {

		get().updateMaterialProperty( 'attenuationDistance', value );

	},

	handleDispersionChange: ( value ) => {

		get().updateMaterialProperty( 'dispersion', value[ 0 ] );

	},

	handleEmissiveIntensityChange: ( value ) => {

		get().updateMaterialProperty( 'emissiveIntensity', value[ 0 ] );

	},

	handleClearcoatChange: ( value ) => {

		get().updateMaterialProperty( 'clearcoat', value[ 0 ] );

	},

	handleClearcoatRoughnessChange: ( value ) => {

		get().updateMaterialProperty( 'clearcoatRoughness', value[ 0 ] );

	},

	handleOpacityChange: ( value ) => {

		get().updateMaterialProperty( 'opacity', value[ 0 ] );

	},

	handleSideChange: ( value ) => {

		get().updateMaterialProperty( 'side', value );

	},

	handleEmissiveChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject?.material?.emissive ) {

			selectedObject.material.emissive.set( value );
			get().updateMaterialProperty( 'emissive', selectedObject.material.emissive );

		}

	},

	handleTransparentChange: ( value ) => {

		get().updateMaterialProperty( 'transparent', value ? 1 : 0 );

	},

	handleAlphaTestChange: ( value ) => {

		get().updateMaterialProperty( 'alphaTest', value[ 0 ] );

	},

	handleSheenChange: ( value ) => {

		get().updateMaterialProperty( 'sheen', value[ 0 ] );

	},

	handleSheenRoughnessChange: ( value ) => {

		get().updateMaterialProperty( 'sheenRoughness', value[ 0 ] );

	},

	handleSheenColorChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject?.material?.sheenColor ) {

			selectedObject.material.sheenColor.set( value );
			get().updateMaterialProperty( 'sheenColor', selectedObject.material.sheenColor );

		}

	},

	handleSpecularIntensityChange: ( value ) => {

		get().updateMaterialProperty( 'specularIntensity', value[ 0 ] );

	},

	handleSpecularColorChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject?.material?.specularColor ) {

			selectedObject.material.specularColor.set( value );
			get().updateMaterialProperty( 'specularColor', selectedObject.material.specularColor );

		}

	},

	handleIridescenceChange: ( value ) => {

		get().updateMaterialProperty( 'iridescence', value[ 0 ] );

	},

	handleIridescenceIORChange: ( value ) => {

		get().updateMaterialProperty( 'iridescenceIOR', value[ 0 ] );

	},

	handleIridescenceThicknessRangeChange: ( value ) => {

		get().updateMaterialProperty( 'iridescenceThicknessRange', value );

	},

	handleVisibleChange: ( value ) => {

		const selectedObject = useStore.getState().selectedObject;
		if ( selectedObject ) {

			selectedObject.visible = value;
			get().updateMaterialProperty( 'visible', value ? 1 : 0 );

		}

	},
} ) );

export {
	useStore,
	useAssetsStore,
	useEnvironmentStore,
	usePathTracerStore,
	useLightStore,
	useCameraStore,
	useMaterialStore,
};
