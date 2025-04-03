import { create } from 'zustand';
import { DEFAULT_STATE, CAMERA_PRESETS } from '@/Constants';

// Main store
const useStore = create( ( set ) => ( {
	selectedObject: null,
	setSelectedObject: ( object ) => set( { selectedObject: object } ),
	loading: { isLoading: false, progress: 0, title: '', status: '' },
	setLoading: ( loadingState ) => set( ( state ) => ( { loading: { ...state.loading, ...loadingState } } ) ),
	resetLoading: () => set( { loading: { isLoading: false, progress: 0, title: '', status: '' } } ),
	appMode: 'interactive', // 'interactive' or 'final'
	setAppMode: ( mode ) => set( { appMode: mode } ),
} ) );

// Assets store
const useAssetsStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [],
	setMaterials: ( materials ) => set( { materials } ),
	setActiveTab: ( tab ) => set( { activeTab: tab } ),
	setModel: ( model ) => set( { model } ),
	setEnvironment: ( env ) => set( { environment: env } ),
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

// Path tracer store
const usePathTracerStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	backgroundIntensity: DEFAULT_STATE.backgroundIntensity,
	setMaxSamples: ( value ) => set( { maxSamples: value } ),
	setEnablePathTracer: ( value ) => set( { enablePathTracer: value } ),
	setEnableAccumulation: ( value ) => set( { enableAccumulation: value } ),
	setBounces: ( value ) => set( { bounces: value } ),
	setSamplesPerPixel: ( value ) => set( { samplesPerPixel: value } ),
	setSamplingTechnique: ( value ) => set( { samplingTechnique: value } ),
	setAdaptiveSampling: ( value ) => set( { adaptiveSampling: value } ),
	setAdaptiveSamplingMin: ( value ) => set( { adaptiveSamplingMin: value } ),
	setAdaptiveSamplingMax: ( value ) => set( { adaptiveSamplingMax: value } ),
	setAdaptiveSamplingVarianceThreshold: ( value ) => set( { adaptiveSamplingVarianceThreshold: value } ),
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
	setShowBackground: ( value ) => set( { showBackground: value } ),
	setBackgroundIntensity: ( value ) => set( { backgroundIntensity: value } ),
	setEnvironmentIntensity: ( value ) => set( { environmentIntensity: value } ),
	setGIIntensity: ( value ) => set( { GIIntensity: value } ),
	setToneMapping: ( value ) => set( { toneMapping: value } ),
	setInteractionModeEnabled: ( value ) => set( { interactionModeEnabled: value } ),
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
const useCameraStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	activePreset: "custom",
	cameraNames: [],
	setCameraNames: ( names ) => set( { cameraNames: names } ),
	selectedCameraIndex: 0,
	setSelectedCameraIndex: ( index ) => set( { selectedCameraIndex: index } ),
	focusMode: false,
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
} ) );

export {
	useStore,
	useAssetsStore,
	useEnvironmentStore,
	usePathTracerStore,
	useLightStore,
	useCameraStore,
};

