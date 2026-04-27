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
	fov: 55,
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
	enableAlphaShadows: false,
	tiles: 3,
	tilesHelper: false,
	showLightHelper: false,

	directionalLightIntensity: 0,
	directionalLightColor: "#ffffff",
	directionalLightPosition: [ 1, 1, 1 ],
	directionalLightAngle: 0.0,

	filterStrength: 0.75,
	strengthDecaySpeed: 0.05,
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
	denoiserStrategy: 'none',

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

// Material data layout constants — single source of truth for material buffer offsets.
// Shared between CPU writers (TextureCreator, MaterialDataManager) and GPU readers (Common.js getMaterial).
export const MATERIAL_DATA_LAYOUT = {

	SLOTS_PER_MATERIAL: 27, // vec4 slots per material
	FLOATS_PER_MATERIAL: 108, // total floats per material (27 × 4)

	// ── Flat float offsets (CPU side) ────────────────────────────────
	// Used as: data[ materialIndex * FLOATS_PER_MATERIAL + offset ]
	// Ordered for cache-line coherence: shadow/culling → BxDF core → maps → extended → transforms

	// Slot 0: ior + transmission + thickness + emissiveIntensity   [shadow]
	IOR: 0, TRANSMISSION: 1, THICKNESS: 2, EMISSIVE_INTENSITY: 3,
	// Slot 1: attenuationColor.rgb + attenuationDistance            [shadow]
	ATTENUATION_COLOR: 4, ATTENUATION_DISTANCE: 7,
	// Slot 2: opacity + side + transparent + alphaTest              [shadow + culling]
	OPACITY: 8, SIDE: 9, TRANSPARENT: 10, ALPHA_TEST: 11,
	// Slot 3: alphaMode + depthWrite + normalScale                  [shadow]
	ALPHA_MODE: 12, DEPTH_WRITE: 13, NORMAL_SCALE: 14,
	// Slot 4: color.rgb + metalness                                 [BxDF core]
	COLOR: 16, METALNESS: 19,
	// Slot 5: emissive.rgb + roughness                              [BxDF core]
	EMISSIVE: 20, ROUGHNESS: 23,
	// Slot 6: map indices (albedo, normal, roughness, metalness)    [maps]
	ALBEDO_MAP_INDEX: 24, NORMAL_MAP_INDEX: 25, ROUGHNESS_MAP_INDEX: 26, METALNESS_MAP_INDEX: 27,
	// Slot 7: map indices (emissive, bump) + clearcoat              [maps]
	EMISSIVE_MAP_INDEX: 28, BUMP_MAP_INDEX: 29, CLEARCOAT: 30, CLEARCOAT_ROUGHNESS: 31,
	// Slot 8: dispersion + visible + sheen + sheenRoughness         [extended BxDF]
	DISPERSION: 32, VISIBLE: 33, SHEEN: 34, SHEEN_ROUGHNESS: 35,
	// Slot 9: sheenColor.rgb + (reserved)                           [extended BxDF]
	SHEEN_COLOR: 36,
	// Slot 10: specularIntensity + specularColor.rgb                [extended BxDF]
	SPECULAR_INTENSITY: 40, SPECULAR_COLOR: 41,
	// Slot 11: iridescence + iridescenceIOR + iridescenceThicknessRange [extended BxDF]
	IRIDESCENCE: 44, IRIDESCENCE_IOR: 45, IRIDESCENCE_THICKNESS_RANGE: 46,
	// Slot 12: bumpScale + displacementScale + displacementMapIndex + (padding)
	BUMP_SCALE: 48, DISPLACEMENT_SCALE: 49, DISPLACEMENT_MAP_INDEX: 50,

	// ── Transform float offsets (8 floats each: 7 matrix values + 1 padding) ──
	ALBEDO_TRANSFORM: 52,
	NORMAL_TRANSFORM: 60,
	ROUGHNESS_TRANSFORM: 68,
	METALNESS_TRANSFORM: 76,
	EMISSIVE_TRANSFORM: 84,
	BUMP_TRANSFORM: 92,
	DISPLACEMENT_TRANSFORM: 100,

	// ── Vec4 slot indices (GPU/TSL side) ─────────────────────────────
	// Used with getDatafromStorageBuffer( buf, matIdx, int(slot), int(SLOTS_PER_MATERIAL) )
	SLOT: {
		IOR_TRANSMISSION: 0, // [shadow] ior, transmission, thickness, emissiveIntensity
		ATTENUATION: 1, // [shadow] attenuationColor, attenuationDistance
		OPACITY_ALPHA: 2, // [shadow+culling] opacity, side, transparent, alphaTest
		ALPHA_MODE: 3, // [shadow] alphaMode, depthWrite, normalScale
		COLOR_METALNESS: 4, // [BxDF] color.rgb, metalness
		EMISSIVE_ROUGHNESS: 5, // [BxDF] emissive.rgb, roughness
		MAP_INDICES_A: 6, // [maps] albedo, normal, roughness, metalness
		MAP_INDICES_B: 7, // [maps] emissive, bump, clearcoat, clearcoatRoughness
		DISPERSION_SHEEN: 8, // [extended] dispersion, visible, sheen, sheenRoughness
		SHEEN_COLOR: 9, // [extended] sheenColor, reserved
		SPECULAR: 10, // [extended] specularIntensity, specularColor
		IRIDESCENCE: 11, // [extended] iridescence, iridescenceIOR, iridescenceThicknessRange
		BUMP_DISPLACEMENT: 12, // bumpScale, displacementScale, displacementMapIndex
		ALBEDO_TRANSFORM_A: 13, ALBEDO_TRANSFORM_B: 14,
		NORMAL_TRANSFORM_A: 15, NORMAL_TRANSFORM_B: 16,
		ROUGHNESS_TRANSFORM_A: 17, ROUGHNESS_TRANSFORM_B: 18,
		METALNESS_TRANSFORM_A: 19, METALNESS_TRANSFORM_B: 20,
		EMISSIVE_TRANSFORM_A: 21, EMISSIVE_TRANSFORM_B: 22,
		BUMP_TRANSFORM_A: 23, BUMP_TRANSFORM_B: 24,
		DISPLACEMENT_TRANSFORM_A: 25, DISPLACEMENT_TRANSFORM_B: 26,
	},

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
	renderMode: 1, enableAlphaShadows: true, tiles: 3, tilesHelper: true,
	enableOIDN: true, oidnQuality: 'balance',
	interactionModeEnabled: false,
};

export const PREVIEW_RENDER_CONFIG = {
	maxSamples: ENGINE_DEFAULTS.maxSamples, bounces: ENGINE_DEFAULTS.bounces,
	samplesPerPixel: ENGINE_DEFAULTS.samplesPerPixel, renderMode: ENGINE_DEFAULTS.renderMode, enableAlphaShadows: ENGINE_DEFAULTS.enableAlphaShadows,
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
