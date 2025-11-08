import debugModelsData from './DebugModels.json';
import { WebGLRenderer } from 'three';

//some samples at https://casual-effects.com/data/

// const MODEL_URL = './models/planes.glb';
//hdri image orignal source: 'https://cdn.polyhaven.com/asset_img/primary/aerodynamics_workshop.png?height=150'
export const HDR_FILES = [
	{ name: "Adams Place Bridge", 			url: `${import.meta.env.BASE_URL}hdri/adams_place_bridge_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/adams_place_bridge.webp` },
	{ name: "Aerodynamics Workshop", 		url: `${import.meta.env.BASE_URL}hdri/aerodynamics_workshop_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/aerodynamics_workshop.webp` },
	{ name: "Aristea Wreck Pure Sky", 		url: `${import.meta.env.BASE_URL}hdri/aristea_wreck_puresky_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/aristea_wreck_puresky.webp` },
	{ name: "Auto Shop", 					url: `${import.meta.env.BASE_URL}hdri/autoshop_01_1k.hdr`, 				preview: `${import.meta.env.BASE_URL}hdri/autoshop_01.webp` },
	{ name: "Blocky Photo Studio",			url: `${import.meta.env.BASE_URL}hdri/blocky_photo_studio_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/blocky_photo_studio.webp` },
	{ name: "Brown Photo Studio 01", 		url: `${import.meta.env.BASE_URL}hdri/brown_photostudio_01_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/brown_photostudio_01.webp` },
	{ name: "Brown Photo Studio 02", 		url: `${import.meta.env.BASE_URL}hdri/brown_photostudio_02_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/brown_photostudio_02.webp` },
	{ name: "Brown Photo Studio 06", 		url: `${import.meta.env.BASE_URL}hdri/brown_photostudio_06_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/brown_photostudio_06.webp` },
	{ name: "Brown Photo Studio 07", 		url: `${import.meta.env.BASE_URL}hdri/brown_photostudio_07_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/brown_photostudio_07.webp` },
	{ name: "Chinese Garden", 				url: `${import.meta.env.BASE_URL}hdri/chinese_garden_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/chinese_garden.webp` },
	{ name: "Christmas Photo Studio 04", 	url: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_04_2k.hdr`, preview: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_04.webp` },
	{ name: "Christmas Photo Studio 05", 	url: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_05_2k.hdr`, preview: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_05.webp` },
	{ name: "Christmas Photo Studio 07", 	url: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_07_1k.hdr`, preview: `${import.meta.env.BASE_URL}hdri/christmas_photo_studio_07.webp` },
	{ name: "Circus Arena", 				url: `${import.meta.env.BASE_URL}hdri/circus_arena_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/circus_arena.webp` },
	{ name: "Comfy Cafe", 					url: `${import.meta.env.BASE_URL}hdri/comfy_cafe_2k.hdr`, 				preview: `${import.meta.env.BASE_URL}hdri/comfy_cafe.webp` },
	{ name: "Dancing Hall", 				url: `${import.meta.env.BASE_URL}hdri/dancing_hall_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/dancing_hall.webp` },
	{ name: "Drachenfels Cellar", 			url: `${import.meta.env.BASE_URL}hdri/drachenfels_cellar_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/drachenfels_cellar.webp` },
	{ name: "Hall of Mammals", 				url: `${import.meta.env.BASE_URL}hdri/hall_of_mammals_2k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/hall_of_mammals.webp` },
	{ name: "Herkulessaulen", 				url: `${import.meta.env.BASE_URL}hdri/herkulessaulen_2k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/herkulessaulen.webp` },
	{ name: "Hilly Terrain", 				url: `${import.meta.env.BASE_URL}hdri/hilly_terrain_01_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/hilly_terrain_01.webp` },
	{ name: "Kloppenheim", 					url: `${import.meta.env.BASE_URL}hdri/kloppenheim_05_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/kloppenheim_05.webp` },
	{ name: "Leadenhall Market", 			url: `${import.meta.env.BASE_URL}hdri/leadenhall_market_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/leadenhall_market.webp` },
	{ name: "Modern Buildings", 			url: `${import.meta.env.BASE_URL}hdri/modern_buildings_2_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/modern_buildings_2.webp` },
	{ name: "Narrow Moonlit Road", 			url: `${import.meta.env.BASE_URL}hdri/narrow_moonlit_road_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/narrow_moonlit_road.webp` },
	{ name: "Noon Grass", 					url: `${import.meta.env.BASE_URL}hdri/noon_grass_1k.hdr`, 				preview: `${import.meta.env.BASE_URL}hdri/noon_grass.webp` },
	{ name: "Peppermint Powerplant", 		url: `${import.meta.env.BASE_URL}hdri/peppermint_powerplant_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/peppermint_powerplant.webp` },
	{ name: "Phalzer Forest", 				url: `${import.meta.env.BASE_URL}hdri/phalzer_forest_01_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/phalzer_forest_01.webp` },
	{ name: "Photo Studio", 				url: `${import.meta.env.BASE_URL}hdri/photo_studio_01_2k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/photo_studio_01.webp` },
	{ name: "Photo Studio Loft Hall", 		url: `${import.meta.env.BASE_URL}hdri/photo_studio_loft_hall_2k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/photo_studio_loft_hall.webp` },
	{ name: "Rainforest Trail", 			url: `${import.meta.env.BASE_URL}hdri/rainforest_trail_1k.hdr`, 		preview: `${import.meta.env.BASE_URL}hdri/rainforest_trail.webp` },
	{ name: "Sepulchral Chapel Rotunda", 	url: `${import.meta.env.BASE_URL}hdri/sepulchral_chapel_rotunda_1k.hdr`, preview: `${import.meta.env.BASE_URL}hdri/sepulchral_chapel_rotunda.webp` },
	{ name: "St. Peter's Square Night", 	url: `${import.meta.env.BASE_URL}hdri/st_peters_square_night_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/st_peters_square_night.webp` },
	{ name: "Studio Small 05", 				url: `${import.meta.env.BASE_URL}hdri/studio_small_05_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/studio_small_05.webp` },
	{ name: "Studio Small 09", 				url: `${import.meta.env.BASE_URL}hdri/studio_small_09_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/studio_small_09.webp` },
	{ name: "Thatch Chapel", 				url: `${import.meta.env.BASE_URL}hdri/thatch_chapel_1k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/thatch_chapel.webp` },
	{ name: "Urban Alley",			 		url: `${import.meta.env.BASE_URL}hdri/urban_alley_01_2k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/urban_alley_01.webp` },
	{ name: "Vestibule", 					url: `${import.meta.env.BASE_URL}hdri/vestibule_1k.hdr`, 				preview: `${import.meta.env.BASE_URL}hdri/vestibule.webp` },
	{ name: "Vintage Measuring Lab", 		url: `${import.meta.env.BASE_URL}hdri/vintage_measuring_lab_1k.hdr`, 	preview: `${import.meta.env.BASE_URL}hdri/vintage_measuring_lab.webp` },
	{ name: "Wasteland Clouds Pure Sky", 	url: `${import.meta.env.BASE_URL}hdri/wasteland_clouds_puresky_2k.hdr`, preview: `${import.meta.env.BASE_URL}hdri/wasteland_clouds_puresky.webp` },
	{ name: "Whale Skeleton", 				url: `${import.meta.env.BASE_URL}hdri/whale_skeleton_2k.hdr`, 			preview: `${import.meta.env.BASE_URL}hdri/whale_skeleton.webp` },
];

// export const MODEL_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/';
export const MODEL_FILES = [
	{ name: "Cornell Box 1", 		url: `${import.meta.env.BASE_URL}models/CornellBox1.glb`, preview: `${import.meta.env.BASE_URL}models/CornellBox1.png` },
	{ name: "Gameboy", 				url: `${import.meta.env.BASE_URL}models/Gameboy.glb`, preview: `${import.meta.env.BASE_URL}models/Gameboy.png` },
	{ name: "Stanford Bunny", 		url: `${import.meta.env.BASE_URL}models/StanfordBunny.glb`, preview: `${import.meta.env.BASE_URL}models/StanfordBunny.png` },
	{ name: "Table 1", 				url: `${import.meta.env.BASE_URL}models/Table1.glb`, preview: `${import.meta.env.BASE_URL}models/Table1.png` },
	{ name: "Table 2", 				url: `${import.meta.env.BASE_URL}models/Table2.glb`, preview: `${import.meta.env.BASE_URL}models/Table2.png` },
	{ name: "Ambassedor", 			url: `${import.meta.env.BASE_URL}models/ambassedor.glb`, preview: `${import.meta.env.BASE_URL}models/ambassedor.png` },
	{ name: "Antique Phone", 		url: `${import.meta.env.BASE_URL}models/antique_phone.glb`, preview: `${import.meta.env.BASE_URL}models/antique_phone.png` },
	{ name: "Bus Traveler", 		url: `${import.meta.env.BASE_URL}models/bus_traveler.glb`, preview: `${import.meta.env.BASE_URL}models/bus_traveler.png` },
	{ name: "C.W.M", 				url: `${import.meta.env.BASE_URL}models/c.w.m.glb`, preview: `${import.meta.env.BASE_URL}models/c.w.png` },
	{ name: "Camera", 				url: `${import.meta.env.BASE_URL}models/camera.glb`, preview: `${import.meta.env.BASE_URL}models/camera.png` },
	{ name: "Advanced Unit Blocks", url: `${import.meta.env.BASE_URL}models/cgt116_week_8_-_advanced_unit_blocks.glb`, preview: `${import.meta.env.BASE_URL}models/cgt116_week_8_-_advanced_unit_blocks.png` },
	{ name: "Diamond", 				url: `${import.meta.env.BASE_URL}models/diamond.glb`, preview: `${import.meta.env.BASE_URL}models/diamond.png` },
	{ name: "Diorama", 				url: `${import.meta.env.BASE_URL}models/diorama.glb`, preview: `${import.meta.env.BASE_URL}models/diorama.png` },
	{ name: "Dragon", 				url: `${import.meta.env.BASE_URL}models/dragon.glb`, preview: `${import.meta.env.BASE_URL}models/dragon.png` },
	{ name: "Ferrari", 				url: `${import.meta.env.BASE_URL}models/ferrari.glb`, preview: `${import.meta.env.BASE_URL}models/ferrari.png` },
	{ name: "Flashing Light", 		url: `${import.meta.env.BASE_URL}models/flashing_light.glb`, preview: `${import.meta.env.BASE_URL}models/flashing_light.png` },
	{ name: "Folliage", 			url: `${import.meta.env.BASE_URL}models/folliage.glb`, preview: `${import.meta.env.BASE_URL}models/folliage.png` },
	{ name: "Gelatinous Cube", 		url: `${import.meta.env.BASE_URL}models/gelatinous_cube.glb`, preview: `${import.meta.env.BASE_URL}models/gelatinous_cube.png` },
	{ name: "Helmet", 				url: `${import.meta.env.BASE_URL}models/helmet.glb`, preview: `${import.meta.env.BASE_URL}models/helmet.png` },
	{ name: "Jiotto Caspita F1", 	url: `${import.meta.env.BASE_URL}models/jiotto_caspita_f1_road_car_1989_by_alex.ka.glb`, preview: `${import.meta.env.BASE_URL}models/jiotto_caspita_f1_road_car_1989_by_alex.ka.png` },
	{ name: "Lemon", 				url: `${import.meta.env.BASE_URL}models/lemon.glb`, preview: `${import.meta.env.BASE_URL}models/lemon.png` },
	{ name: "Mercedes Mayback", 	url: `${import.meta.env.BASE_URL}models/mercedesmayback.glb`, preview: `${import.meta.env.BASE_URL}models/mercedesmayback.png` },
	{ name: "Model 3", 				url: `${import.meta.env.BASE_URL}models/model3.glb`, preview: `${import.meta.env.BASE_URL}models/model3.png` },
	{ name: "Modern Bathroom", 		url: `${import.meta.env.BASE_URL}models/modernbathroom.glb`, preview: `${import.meta.env.BASE_URL}models/modernbathroom.png` },
	{ name: "Old Stool", 			url: `${import.meta.env.BASE_URL}models/old_stool.glb`, preview: `${import.meta.env.BASE_URL}models/old_stool.png` },
	{ name: "Outdoor Sofaset", 		url: `${import.meta.env.BASE_URL}models/outdoorsofaset.glb`, preview: `${import.meta.env.BASE_URL}models/outdoorsofaset.png` },
	{ name: "Pagani Huayra Free", 	url: `${import.meta.env.BASE_URL}models/pagani_huayra_free.glb`, preview: `${import.meta.env.BASE_URL}models/pagani_huayra_free.png` },
	{ name: "Retro Telephone", 		url: `${import.meta.env.BASE_URL}models/retro_telephone_bordstelefon_tunnan.glb`, preview: `${import.meta.env.BASE_URL}models/retro_telephone_bordstelefon_tunnan.png` },
	{ name: "Road", 				url: `${import.meta.env.BASE_URL}models/road.glb`, preview: `${import.meta.env.BASE_URL}models/road.png` },
	{ name: "Rollerskates", 		url: `${import.meta.env.BASE_URL}models/rollerskates_race_-_inliner.glb`, preview: `${import.meta.env.BASE_URL}models/rollerskates_race_-_inliner.png` },
	{ name: "Scull Cup", 			url: `${import.meta.env.BASE_URL}models/scull_cup.glb`, preview: `${import.meta.env.BASE_URL}models/scull_cup.png` },
	{ name: "Mantel Clocks", 		url: `${import.meta.env.BASE_URL}models/simple_1800s_mantel_clocks.glb`, preview: `${import.meta.env.BASE_URL}models/simple_1800s_mantel_clocks.png` },
	{ name: "Skatin Jade Dragon", 	url: `${import.meta.env.BASE_URL}models/skatin_jade_dragon.glb`, preview: `${import.meta.env.BASE_URL}models/skatin_jade_dragon.png` },
	{ name: "Sony Walkman", 		url: `${import.meta.env.BASE_URL}models/sony_walkman_wm-f2078.glb`, preview: `${import.meta.env.BASE_URL}models/sony_walkman_wm-f2078.png` },
	{ name: "Spyglasscase", 		url: `${import.meta.env.BASE_URL}models/spyglasscase.glb`, preview: `${import.meta.env.BASE_URL}models/spyglasscase.png` },
	{ name: "Rolex Oyster", 		url: `${import.meta.env.BASE_URL}models/watch-rolex-oyster-perpetual.glb`, preview: `${import.meta.env.BASE_URL}models/watch-rolex-oyster-perpetual.png` },
	{ name: "Suzzane", 				url: `${import.meta.env.BASE_URL}models/suzzane.glb`, preview: `${import.meta.env.BASE_URL}models/suzzane.png` },
	{ name: "Laser Flashlight", 	url: `${import.meta.env.BASE_URL}models/zenitco_klesch-2p__laser_flashlight.glb`, preview: `${import.meta.env.BASE_URL}models/zenitco_klesch-2p__laser_flashlight.png` },
];

const tagPriority = {
	'pbrtest': 1,
	'testing': 2,
	'core': 3,
	'extension': 4,
	'showcase': 5,
	'video': 6,
	'written': 7,
	'issues': 8
};
const getHighestPriorityTag = ( tags ) => {

	return tags.reduce( ( highest, tag ) => {

		const currentPriority = tagPriority[ tag ] || 999;
		const highestPriority = tagPriority[ highest ] || 999;
		return currentPriority < highestPriority ? tag : highest;

	}, tags[ 0 ] );

};

export const DEBUG_MODELS = debugModelsData
	// .filter( m =>  m.tags.includes('pbrtest') )
	.map( model => {

		let variantDir, variantFile;
		if ( model.variants[ 'glTF-Binary' ] ) {

			variantDir = 'glTF-Binary';
			variantFile = model.variants[ 'glTF-Binary' ];

		} else if ( model.variants[ 'glTF' ] ) {

			variantDir = 'glTF';
			variantFile = model.variants[ 'glTF' ];

		} else {

			// Fallback to the first available variant
			const firstVariant = Object.entries( model.variants )[ 0 ];
			variantDir = firstVariant[ 0 ];
			variantFile = firstVariant[ 1 ];

		}

		return {
			name: model.name,
			label: model.label,
			url: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${model.name}/${variantDir}/${variantFile}`,
			preview: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${model.name}/${model.screenshot}`,
			redirection: `https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/${model.name}/README.md`,
			tags: model.tags
		};

	} )
	.sort( ( a, b ) => {

		const tagA = getHighestPriorityTag( a.tags );
		const tagB = getHighestPriorityTag( b.tags );
		return ( tagPriority[ tagA ] || 999 ) - ( tagPriority[ tagB ] || 999 );

	} );

export const DEFAULT_STATE = {
	optimizeMeshes: true,
	model: 9,
	environment: 2,

	originalPixelRatio: window.devicePixelRatio / 2,
	toneMapping: 4,
	exposure: 1,
	enableEnvironment: true,
	showBackground: true,
	useImportanceSampledEnvironment: true,
	environmentIntensity: 1,
	backgroundIntensity: 1,
	environmentRotation: 0.0,
	globalIlluminationIntensity: 1,

	// Environment Mode System
	environmentMode: 'hdri', // 'hdri' | 'procedural' | 'gradient' | 'color'

	// Gradient Sky Colors
	gradientZenithColor: '#0077BE', // Deep blue sky top
	gradientHorizonColor: '#87CEEB', // Light blue horizon
	gradientGroundColor: '#654321', // Brown ground

	// Solid Color Sky
	solidSkyColor: '#87CEEB', // Sky blue

	// Procedural Sky Parameters (Preetham Model - Clear Morning preset)
	// Note: These values are scaled in PathTracerStage.js before passing to ProceduralSkyRenderer
	skySunAzimuth: 90, // 0-360 degrees
	skySunElevation: 20, // -90 to 90 degrees
	skySunIntensity: 15.0, // 1.0-100.0 (reduced from 30.0)
	skyRayleighDensity: 0.9, // 0.1-3.0
	skyTurbidity: 0.8, // 0.0-5.0 (atmospheric haze)
	skyMieAnisotropy: 0.76, // 0.0-0.99
	skyPreset: 'clearMorning', // Default preset

	enableDOF: false,
	zoomToCursor: true,
	fov: 65,
	focusDistance: 0.8,
	aperture: 5.6,
	focalLength: 50,

	enablePathTracer: true,
	enableAccumulation: true,
	pauseRendering: false,
	maxSamples: 60,
	bounces: 3,
	samplesPerPixel: 1,
	transmissiveBounces: 5,
	samplingTechnique: 3,
	enableEmissiveTriangleSampling: false, // Enabled by default, InteractionModeController disables during camera movement
	emissiveBoost: 100.0,

	adaptiveSampling: false,
	adaptiveSamplingMin: 1, // Guarantee minimum 1 sample per pixel
	adaptiveSamplingMax: 8, // 8 for quality when needed
	adaptiveSamplingVarianceThreshold: 0.003, // More sensitive threshold for better quality
	temporalVarianceWeight: 0.6, // Reduced to rely less on temporal (which can be noisy)
	enableEarlyTermination: true,
	earlyTerminationThreshold: 0.002, // More relaxed threshold
	showAdaptiveSamplingHelper: false,
	performanceModeAdaptive: 'medium',

	fireflyThreshold: 1.8,
	renderMode: 0,
	tiles: 3,
	tilesHelper: false,
	resolution: 1,

	directionalLightIntensity: 0,
	directionalLightColor: "#ffffff",
	directionalLightPosition: [ 1, 1, 1 ],
	directionalLightAngle: 0.0, // Angular diameter in radians (0 = sharp shadows)

	pixelEdgeSharpness: 0.75,
	edgeSharpenSpeed: 0.05,
	edgeThreshold: 1.0,

	enableOIDN: false,
	oidnQuality: 'fast', // 'fast', 'balance', 'high'
	oidnHDR: false,
	useGBuffer: true,
	debugGbufferMaps: false,

	debugMode: 0,
	debugThreshold: 100,
	debugModel: 0,

	enableBloom: false,
	bloomStrength: 0.2,
	bloomRadius: 0.15,
	bloomThreshold: 0.85,
	interactionModeEnabled: true,
	debugVisScale: 100,

	// Denoising strategy: 'edgeaware', 'asvgf', 'oidn'
	denoiserStrategy: 'edgeaware',

	enableASVGF: false,
	asvgfTemporalAlpha: 0.1,
	asvgfAtrousIterations: 8,
	asvgfPhiColor: 10.0,
	asvgfPhiNormal: 128.0,
	asvgfPhiDepth: 1.0,
	asvgfVarianceBoost: 1.0,
	asvgfMaxAccumFrames: 32,
	asvgfDebugMode: 0, // 0 = off, 1 = variance, 2 = history length, 3 = motion, 4 = normal, 5 = temporal gradient
	asvgfQualityPreset: 'medium', // 'low', 'medium', 'high'
	showAsvgfHeatmap: false, // Show ASVGF heatmap visualization

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
		min: 20, // Super telephoto equivalent
		max: 90, // Wide angle
		default: DEFAULT_STATE.fov // Standard lens
	},
	focusDistance: {
		min: 0.3, // 30cm - close focus
		max: 100.0, // 100m - distant focus
		default: DEFAULT_STATE.focusDistance // 2m - standard middle distance
	},
	aperture: {
		options: [ 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0 ],
		default: DEFAULT_STATE.aperture // f/16 - sharp focus by default
	},
	focalLength: {
		min: 0, // 0 = disable depth of field
		max: 200, // Telephoto
		default: DEFAULT_STATE.focalLength // Standard lens
	}
};

// Sky Presets - Define photography presets
// Note: These values are scaled in PathTracerStage.js before passing to ProceduralSkyRenderer
export const SKY_PRESETS = {
	clearMorning: {
		name: "Clear Morning",
		sunAzimuth: 90,
		sunElevation: 20, // Low morning sun
		sunIntensity: 15.0, // Moderate brightness (reduced from 30.0)
		rayleighDensity: 0.9, // Lighter blue
		turbidity: 0.8, // Some warmth
	},
	clearNoon: {
		name: "Clear Noon",
		sunAzimuth: 0,
		sunElevation: 75, // High sun
		sunIntensity: 20.0, // Bright sun (reduced from 40.0)
		rayleighDensity: 1.0, // Deep blue sky
		turbidity: 0.3, // Minimal haze
	},
	overcast: {
		name: "Overcast",
		sunAzimuth: 0,
		sunElevation: 45, // Mid-height
		sunIntensity: 6.0, // Diffused sun (reduced from 10.0)
		rayleighDensity: 0.6, // Muted blue
		turbidity: 4.0, // Heavy haze
	},
	goldenHour: {
		name: "Golden Hour",
		sunAzimuth: 270,
		sunElevation: 10, // Low sun
		sunIntensity: 19.0, // Strong warm glow (reduced from 38.0)
		rayleighDensity: 0.8, // Warm blue
		turbidity: 1.2, // Golden warmth
	},
	sunset: {
		name: "Sunset",
		sunAzimuth: 270,
		sunElevation: 2, // Sun just above horizon
		sunIntensity: 18.0, // Strong glow (reduced from 35.0)
		rayleighDensity: 0.7, // Less blue
		turbidity: 2.0, // Very warm horizon
	},
	dusk: {
		name: "Dusk",
		sunAzimuth: 270,
		sunElevation: - 8, // Sun below horizon
		sunIntensity: 8.0, // Dim light (reduced from 15.0)
		rayleighDensity: 0.5, // Darker sky
		turbidity: 1.5, // Warm afterglow
	}
};

export const CAMERA_PRESETS = {
	portrait: {
		name: "Portrait",
		description: "Shallow depth of field, background blur",
		fov: 45,
		focusDistance: 1.5,
		aperture: 2.0,
		focalLength: 85
	},
	landscape: {
		name: "Landscape",
		description: "Maximum depth of field, everything in focus",
		fov: 65,
		focusDistance: 10.0,
		aperture: 11.0,
		focalLength: 24
	},
	macro: {
		name: "Macro",
		description: "Extreme close-up with thin focus plane",
		fov: 40,
		focusDistance: 0.3,
		aperture: 2.8,
		focalLength: 100
	},
	product: {
		name: "Product",
		description: "Sharp detail with subtle background separation",
		fov: 65,
		focusDistance: 0.8,
		aperture: 5.6,
		focalLength: 50
	},
	architectural: {
		name: "Architectural",
		description: "Wide view with deep focus",
		fov: 75,
		focusDistance: 5.0,
		aperture: 8.0,
		focalLength: 16
	},
	cinematic: {
		name: "Cinematic",
		description: "Dramatic depth separation",
		fov: 40,
		focusDistance: 3.0,
		aperture: 1.4,
		focalLength: 135
	}
};

// Triangle data layout constants - shared between GeometryExtractor and TextureCreator
export const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32, // 8 vec4s: 3 positions + 3 normals + 2 UV/material/mesh

	// Positions (3 vec4s = 12 floats)
	POSITION_A_OFFSET: 0, // vec4: x, y, z, 0
	POSITION_B_OFFSET: 4, // vec4: x, y, z, 0
	POSITION_C_OFFSET: 8, // vec4: x, y, z, 0

	// Normals (3 vec4s = 12 floats)
	NORMAL_A_OFFSET: 12, // vec4: x, y, z, 0
	NORMAL_B_OFFSET: 16, // vec4: x, y, z, 0
	NORMAL_C_OFFSET: 20, // vec4: x, y, z, 0

	// UVs and Material (2 vec4s = 8 floats)
	UV_AB_OFFSET: 24, // vec4: uvA.x, uvA.y, uvB.x, uvB.y
	UV_C_MAT_OFFSET: 28 // vec4: uvC.x, uvC.y, materialIndex, meshIndex
};

// Texture processing constants
export const TEXTURE_CONSTANTS = {
	PIXELS_PER_MATERIAL: 27,
	RGBA_COMPONENTS: 4,
	VEC4_PER_TRIANGLE: 8, // 3 for positions, 3 for normals, 2 for UVs
	VEC4_PER_BVH_NODE: 3,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: Math.min( navigator.hardwareConcurrency || 4, 6 ),
	BUFFER_POOL_SIZE: 20,
	CANVAS_POOL_SIZE: 12,
	CACHE_SIZE_LIMIT: 50,
	MAX_TEXTURE_SIZE: ( () => {

		try {

			const renderer = new WebGLRenderer();
			const size = renderer.capabilities.maxTextureSize;
			renderer.dispose();
			return size;

		} catch {

			return 4096;

		}

	} )()
};

// Default texture matrix for materials
export const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

// Memory management constants
export const MEMORY_CONSTANTS = {
	MAX_BUFFER_MEMORY: 1024 * 1024 * 1024, // 1GB buffer pool limit (increased for large models)
	MAX_TEXTURE_MEMORY: 2048 * 1024 * 1024, // 2GB texture processing limit (increased for large models)
	CLEANUP_THRESHOLD: 0.8, // Start cleanup at 80% memory usage
	CHUNK_SIZE_THRESHOLD: 64 * 1024 * 1024, // 64MB - when to use chunked processing
	STREAM_BATCH_SIZE: 4 // Default batch size for streaming operations
};


/*

Test models:
Khronos Group glTF-Sample-Assets: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Models.md

https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MosquitoInAmber/glTF-Binary/MosquitoInAmber.glb

 */

// studio lights: https://stock.adobe.com/in/search?k=studio+hdri
