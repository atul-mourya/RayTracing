/**
 * Engine-owned default values and configuration constants.
 * These are used exclusively by the rendering engine (src/core/)
 * and should not depend on any UI framework or external modules.
 */

export const ENGINE_DEFAULTS = {
	// Canvas output
	resolution: 512,
	canvasWidth: 512,
	canvasHeight: 512,

	toneMapping: 4,
	exposure: 1,
	saturation: 1.2,
	enableEnvironment: true,
	showBackground: true,
	transparentBackground: false,
	useImportanceSampledEnvironment: true,
	environmentIntensity: 1,
	backgroundIntensity: 1,
	environmentRotation: 270.0,
	globalIlluminationIntensity: 1,

	// Environment Mode System
	environmentMode: 'hdri', // 'hdri' | 'procedural' | 'gradient' | 'color'

	// Gradient Sky Colors
	gradientZenithColor: '#0077BE',
	gradientHorizonColor: '#87CEEB',
	gradientGroundColor: '#654321',

	// Solid Color Sky
	solidSkyColor: '#87CEEB',

	// Procedural Sky Parameters (Preetham Model - Clear Morning preset)
	skySunAzimuth: 90,
	skySunElevation: 20,
	skySunIntensity: 15.0,
	skyRayleighDensity: 0.9,
	skyTurbidity: 0.8,
	skyMieAnisotropy: 0.76,
	skyPreset: 'clearMorning',

	enableDOF: false,
	fov: 65,
	focusDistance: 0.8,
	aperture: 5.6,
	focalLength: 50,
	apertureScale: 1.0,
	anamorphicRatio: 1.0,

	// Auto-focus
	autoFocusMode: 'auto', // 'manual' | 'auto'
	afScreenPoint: { x: 0.5, y: 0.5 },
	afSmoothingFactor: 0.15,

	enablePathTracer: true,
	enableAccumulation: true,
	pauseRendering: false,
	maxSamples: 60,
	bounces: 3,
	samplesPerPixel: 1,
	transmissiveBounces: 5,
	samplingTechnique: 3,
	enableEmissiveTriangleSampling: false,
	emissiveBoost: 1.0,

	adaptiveSampling: false,
	adaptiveSamplingMin: 1,
	adaptiveSamplingMax: 8,
	adaptiveSamplingVarianceThreshold: 0.1,
	temporalVarianceWeight: 0.6,
	enableEarlyTermination: true,
	earlyTerminationThreshold: 0.002,
	showAdaptiveSamplingHelper: false,
	performanceModeAdaptive: 'medium',

	fireflyThreshold: 3.0,
	renderLimitMode: 'frames',
	renderTimeLimit: 30,
	renderMode: 0,
	tiles: 3,
	tilesHelper: false,
	showLightHelper: false,

	directionalLightIntensity: 0,
	directionalLightColor: "#ffffff",
	directionalLightPosition: [ 1, 1, 1 ],
	directionalLightAngle: 0.0,

	pixelEdgeSharpness: 0.75,
	edgeSharpenSpeed: 0.05,
	edgeThreshold: 1.0,

	enableOIDN: false,
	oidnQuality: 'fast',
	debugGbufferMaps: false,

	enableUpscaler: false,
	upscalerScale: 2,
	upscalerQuality: 'fast',
	upscalerHdr: true,

	debugMode: 0,
	debugThreshold: 100,
	debugModel: 0,

	enableBloom: false,
	bloomStrength: 0.2,
	bloomRadius: 0.15,
	bloomThreshold: 0.85,
	interactionModeEnabled: true,
	debugVisScale: 100,

	// Denoising strategy
	denoiserStrategy: 'edgeaware',

	enableASVGF: false,
	asvgfTemporalAlpha: 0.1,
	asvgfAtrousIterations: 8,
	asvgfPhiColor: 10.0,
	asvgfPhiNormal: 128.0,
	asvgfPhiDepth: 1.0,
	asvgfVarianceBoost: 1.0,
	asvgfMaxAccumFrames: 32,
	asvgfDebugMode: 0,
	asvgfQualityPreset: 'medium',
	showAsvgfHeatmap: false,

	// SSRC settings
	ssrcTemporalAlpha: 0.1,
	ssrcSpatialRadius: 4,
	ssrcSpatialWeight: 0.4,

	// Auto-exposure settings
	autoExposure: false,
	autoExposureKeyValue: 0.18,
	autoExposureMinExposure: 0.1,
	autoExposureMaxExposure: 20.0,
	autoExposureAdaptSpeedBright: 3.0,
	autoExposureAdaptSpeedDark: 0.5,
};

export const ASVGF_QUALITY_PRESETS = {
	low: {
		temporalAlpha: 0.3,
		atrousIterations: 1,
		phiColor: 30.0,
		phiNormal: 64.0,
		phiDepth: 2.0,
		phiLuminance: 6.0,
		maxAccumFrames: 8,
		varianceBoost: 0.5
	},
	medium: {
		temporalAlpha: 0.1,
		atrousIterations: 3,
		phiColor: 20.0,
		phiNormal: 128.0,
		phiDepth: 1.0,
		phiLuminance: 2.0,
		maxAccumFrames: 32,
		varianceBoost: 1.0
	},
	high: {
		temporalAlpha: 0.05,
		atrousIterations: 8,
		phiColor: 5.0,
		phiNormal: 256.0,
		phiDepth: 0.5,
		phiLuminance: 2.0,
		maxAccumFrames: 64,
		varianceBoost: 1.5
	}
};

export const CAMERA_RANGES = {
	fov: {
		min: 10,
		max: 90,
		default: ENGINE_DEFAULTS.fov
	},
	focusDistance: {
		min: 0.3,
		max: 100.0,
		default: ENGINE_DEFAULTS.focusDistance
	},
	aperture: {
		options: [ 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0 ],
		default: ENGINE_DEFAULTS.aperture
	},
	focalLength: {
		min: 0,
		max: 200,
		default: ENGINE_DEFAULTS.focalLength
	}
};

export const SKY_PRESETS = {
	clearMorning: {
		name: "Clear Morning",
		sunAzimuth: 90,
		sunElevation: 20,
		sunIntensity: 15.0,
		rayleighDensity: 0.9,
		turbidity: 0.8,
	},
	clearNoon: {
		name: "Clear Noon",
		sunAzimuth: 0,
		sunElevation: 75,
		sunIntensity: 20.0,
		rayleighDensity: 1.0,
		turbidity: 0.3,
	},
	overcast: {
		name: "Overcast",
		sunAzimuth: 0,
		sunElevation: 45,
		sunIntensity: 6.0,
		rayleighDensity: 0.6,
		turbidity: 4.0,
	},
	goldenHour: {
		name: "Golden Hour",
		sunAzimuth: 270,
		sunElevation: 10,
		sunIntensity: 19.0,
		rayleighDensity: 0.8,
		turbidity: 1.2,
	},
	sunset: {
		name: "Sunset",
		sunAzimuth: 270,
		sunElevation: 2,
		sunIntensity: 18.0,
		rayleighDensity: 0.7,
		turbidity: 2.0,
	},
	dusk: {
		name: "Dusk",
		sunAzimuth: 270,
		sunElevation: - 8,
		sunIntensity: 8.0,
		rayleighDensity: 0.5,
		turbidity: 1.5,
	}
};

export const CAMERA_PRESETS = {
	portrait: {
		name: "Portrait",
		description: "Shallow depth of field, background blur",
		fov: 45,
		focusDistance: 1.5,
		aperture: 1.4,
		focalLength: 135,
		apertureScale: 1.5
	},
	landscape: {
		name: "Landscape",
		description: "Maximum depth of field, everything in focus",
		fov: 65,
		focusDistance: 10.0,
		aperture: 16.0,
		focalLength: 24,
		apertureScale: 0.5
	},
	macro: {
		name: "Macro",
		description: "Extreme close-up with thin focus plane",
		fov: 40,
		focusDistance: 0.3,
		aperture: 2.0,
		focalLength: 100,
		apertureScale: 2.0
	},
	product: {
		name: "Product",
		description: "Sharp detail with subtle background separation",
		fov: 50,
		focusDistance: 0.8,
		aperture: 2.8,
		focalLength: 85,
		apertureScale: 1.0
	},
	architectural: {
		name: "Architectural",
		description: "Wide view with deep focus",
		fov: 75,
		focusDistance: 5.0,
		aperture: 11.0,
		focalLength: 16,
		apertureScale: 0.5
	},
	cinematic: {
		name: "Cinematic",
		description: "Dramatic depth separation with anamorphic bokeh",
		fov: 35,
		focusDistance: 3.0,
		aperture: 1.4,
		focalLength: 200,
		apertureScale: 1.8,
		anamorphicRatio: 1.5
	}
};

export const AUTO_FOCUS_MODES = {
	MANUAL: 'manual',
	AUTO: 'auto',
};

export const AF_DEFAULTS = {
	SMOOTHING_FACTOR: 0.15,
	RESET_THRESHOLD: 0.05,
	FALLBACK_DISTANCE: 10.0,
	SNAP_THRESHOLD: 0.5,
};

// Triangle data layout constants - shared between GeometryExtractor and TextureCreator
export const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32,

	// Positions (3 vec4s = 12 floats)
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,

	// Normals (3 vec4s = 12 floats)
	NORMAL_A_OFFSET: 12,
	NORMAL_B_OFFSET: 16,
	NORMAL_C_OFFSET: 20,

	// UVs and Material (2 vec4s = 8 floats)
	UV_AB_OFFSET: 24,
	UV_C_MAT_OFFSET: 28
};

// BVH node leaf markers
export const BVH_LEAF_MARKERS = {
	TRIANGLE_LEAF: - 1, // Leaf containing triangle references
	BLAS_POINTER_LEAF: - 2, // TLAS leaf pointing to a BLAS root node
};

// Texture processing constants
export const TEXTURE_CONSTANTS = {
	PIXELS_PER_MATERIAL: 27,
	RGBA_COMPONENTS: 4,
	VEC4_PER_TRIANGLE: 8,
	VEC4_PER_BVH_NODE: 4,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: Math.min( typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4, 6 ),
	BUFFER_POOL_SIZE: 20,
	CANVAS_POOL_SIZE: 12,
	CACHE_SIZE_LIMIT: 50,
	MAX_TEXTURE_SIZE: 8192
};

// Default texture matrix for materials
export const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

// Render mode configurations
export const FINAL_RENDER_CONFIG = {
	maxSamples: 30, bounces: 20, transmissiveBounces: 8, samplesPerPixel: 1,
	renderMode: 1, tiles: 3, tilesHelper: false,
	enableOIDN: true, oidnQuality: 'balance',
	interactionModeEnabled: false,
};

export const PREVIEW_RENDER_CONFIG = {
	maxSamples: ENGINE_DEFAULTS.maxSamples, bounces: ENGINE_DEFAULTS.bounces,
	samplesPerPixel: ENGINE_DEFAULTS.samplesPerPixel, renderMode: ENGINE_DEFAULTS.renderMode,
	transmissiveBounces: ENGINE_DEFAULTS.transmissiveBounces,
	tiles: ENGINE_DEFAULTS.tiles, tilesHelper: ENGINE_DEFAULTS.tilesHelper,
	enableOIDN: false, oidnQuality: 'fast',
	interactionModeEnabled: true,
};

// Memory management constants
export const MEMORY_CONSTANTS = {
	MAX_BUFFER_MEMORY: 1024 * 1024 * 1024,
	MAX_TEXTURE_MEMORY: 2048 * 1024 * 1024,
	CLEANUP_THRESHOLD: 0.8,
	CHUNK_SIZE_THRESHOLD: 64 * 1024 * 1024,
	STREAM_BATCH_SIZE: 4
};
