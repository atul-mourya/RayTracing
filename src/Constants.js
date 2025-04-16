import debugModelsData from './DebugModels.json';

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
	originalPixelRatio: window.devicePixelRatio / 2,
	toneMapping: 4,
	exposure: 1,
	enableEnvironment: true,
	showBackground: true,
	model: 9,
	environment: 2,
	environmentIntensity: 1,
	backgroundIntensity: 1,
	environmentRotation: 0.0,
	globalIlluminationIntensity: 1,
	fov: 50, // Standard 50mm lens equivalent FOV (~47 degrees)
	focusDistance: 2.0, // 2 meters - good default middle distance
	aperture: 5.6, // f/5.6 - good balance between depth of field and sharpness
	focalLength: 50.0, // 50mm - standard/normal lens focal length
	enablePathTracer: true,
	enableAccumulation: true,
	pauseRendering: false,
	maxSamples: 30,
	bounces: 3,
	samplesPerPixel: 1,
	samplingTechnique: 1,
	adaptiveSampling: false,
	adaptiveSamplingMin: 1,
	adaptiveSamplingMax: 4,
	adaptiveSamplingVarianceThreshold: 0.1,
	showAdaptiveSamplingHelper: false,
	fireflyThreshold: 1,
	renderMode: 0,
	tiles: 4,
	tilesHelper: false,
	resolution: 1,
	directionalLightIntensity: 0,
	directionalLightColor: "#ffffff",
	directionalLightPosition: [ 1, 1, 1 ],
	enableOIDN: false,
	oidnQuality: 'fast', // 'fast', 'balance', 'high'
	oidnHDR: false,
	useGBuffer: true,
	debugGbufferMaps: false,
	enableRealtimeDenoiser: false,
	denoiserBlurStrength: 2,
	denoiserBlurRadius: 1,
	denoiserDetailPreservation: 0.05,
	debugMode: 0,
	debugThreshold: 100,
	debugModel: 0,
	enableBloom: false,
	bloomStrength: 0.2,
	bloomRadius: 0.15,
	bloomThreshold: 0.85,
	interactionModeEnabled: true
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
		default: DEFAULT_STATE.aperture // f/5.6 - good balance between depth of field and sharpness
	},
	focalLength: {
		min: 16, // Ultra wide angle
		max: 200, // Telephoto
		default: DEFAULT_STATE.focalLength // Standard lens
	}
};

// Define photography presets
export const CAMERA_PRESETS = {
	sharp: {
		name: "Sharp",
		description: "Infinite focus, everything in focus",
		fov: 65,
		focusDistance: 0,
		aperture: 16.0,
		focalLength: 0
	},
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
		fov: 50,
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


/*

Test models:
Khronos Group glTF-Sample-Assets: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Models.md

https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MosquitoInAmber/glTF-Binary/MosquitoInAmber.glb

 */
