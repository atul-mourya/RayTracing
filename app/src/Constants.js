import debugModelsData from './DebugModels.json';

// Re-export engine constants for backward compatibility
import { ENGINE_DEFAULTS } from 'rayzee';
export {
	ASVGF_QUALITY_PRESETS,
	CAMERA_RANGES,
	SKY_PRESETS,
	CAMERA_PRESETS,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TRIANGLE_DATA_LAYOUT,
	TEXTURE_CONSTANTS,
	DEFAULT_TEXTURE_MATRIX,
	MEMORY_CONSTANTS,
} from 'rayzee';

// CDN base URL for static assets (models, hdri, noise)
export const ASSETS_BASE_URL = 'https://assets.rayzee.atulmourya.com';

// DEFAULT_STATE = engine defaults + UI-only keys
export const DEFAULT_STATE = {
	...ENGINE_DEFAULTS,
	// UI-only keys (not needed by the engine)
	model: 9,
	environment: 'aristea_wreck_puresky',
	aspectRatioPreset: '1:1',
	orientation: 'landscape',
	finalRenderResolution: 2048,
	originalPixelRatio: window.devicePixelRatio / 2,
	zoomToCursor: true,
};

// export const MODEL_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/';
export const MODEL_FILES = [
	{ name: "Cornell Box 1", 		url: `${ASSETS_BASE_URL}/models/CornellBox1.glb`, preview: `${ASSETS_BASE_URL}/models/CornellBox1.png` },
	{ name: "Gameboy", 				url: `${ASSETS_BASE_URL}/models/Gameboy.glb`, preview: `${ASSETS_BASE_URL}/models/Gameboy.png` },
	{ name: "Stanford Bunny", 		url: `${ASSETS_BASE_URL}/models/StanfordBunny.glb`, preview: `${ASSETS_BASE_URL}/models/StanfordBunny.png` },
	{ name: "Table 1", 				url: `${ASSETS_BASE_URL}/models/Table1.glb`, preview: `${ASSETS_BASE_URL}/models/Table1.png` },
	{ name: "Table 2", 				url: `${ASSETS_BASE_URL}/models/Table2.glb`, preview: `${ASSETS_BASE_URL}/models/Table2.png` },
	{ name: "Ambassedor", 			url: `${ASSETS_BASE_URL}/models/ambassedor.glb`, preview: `${ASSETS_BASE_URL}/models/ambassedor.png` },
	{ name: "Antique Phone", 		url: `${ASSETS_BASE_URL}/models/antique_phone.glb`, preview: `${ASSETS_BASE_URL}/models/antique_phone.png` },
	{ name: "Bus Traveler", 		url: `${ASSETS_BASE_URL}/models/bus_traveler.glb`, preview: `${ASSETS_BASE_URL}/models/bus_traveler.png` },
	{ name: "C.W.M", 				url: `${ASSETS_BASE_URL}/models/c.w.m.glb`, preview: `${ASSETS_BASE_URL}/models/c.w.png` },
	{ name: "Camera", 				url: `${ASSETS_BASE_URL}/models/camera.glb`, preview: `${ASSETS_BASE_URL}/models/camera.png` },
	{ name: "Advanced Unit Blocks", url: `${ASSETS_BASE_URL}/models/cgt116_week_8_-_advanced_unit_blocks.glb`, preview: `${ASSETS_BASE_URL}/models/cgt116_week_8_-_advanced_unit_blocks.png` },
	{ name: "Diamond", 				url: `${ASSETS_BASE_URL}/models/diamond.glb`, preview: `${ASSETS_BASE_URL}/models/diamond.png` },
	{ name: "Diorama", 				url: `${ASSETS_BASE_URL}/models/diorama.glb`, preview: `${ASSETS_BASE_URL}/models/diorama.png` },
	{ name: "Dragon", 				url: `${ASSETS_BASE_URL}/models/dragon.glb`, preview: `${ASSETS_BASE_URL}/models/dragon.png` },
	{ name: "Ferrari", 				url: `${ASSETS_BASE_URL}/models/ferrari.glb`, preview: `${ASSETS_BASE_URL}/models/ferrari.png` },
	{ name: "Flashing Light", 		url: `${ASSETS_BASE_URL}/models/flashing_light.glb`, preview: `${ASSETS_BASE_URL}/models/flashing_light.png` },
	{ name: "Folliage", 			url: `${ASSETS_BASE_URL}/models/folliage.glb`, preview: `${ASSETS_BASE_URL}/models/folliage.png` },
	{ name: "Gelatinous Cube", 		url: `${ASSETS_BASE_URL}/models/gelatinous_cube.glb`, preview: `${ASSETS_BASE_URL}/models/gelatinous_cube.png` },
	{ name: "Helmet", 				url: `${ASSETS_BASE_URL}/models/helmet.glb`, preview: `${ASSETS_BASE_URL}/models/helmet.png` },
	{ name: "Jiotto Caspita F1", 	url: `${ASSETS_BASE_URL}/models/jiotto_caspita_f1_road_car_1989_by_alex.ka.glb`, preview: `${ASSETS_BASE_URL}/models/jiotto_caspita_f1_road_car_1989_by_alex.ka.png` },
	{ name: "Lemon", 				url: `${ASSETS_BASE_URL}/models/lemon.glb`, preview: `${ASSETS_BASE_URL}/models/lemon.png` },
	{ name: "Mercedes Mayback", 	url: `${ASSETS_BASE_URL}/models/mercedesmayback.glb`, preview: `${ASSETS_BASE_URL}/models/mercedesmayback.png` },
	{ name: "Model 3", 				url: `${ASSETS_BASE_URL}/models/model3.glb`, preview: `${ASSETS_BASE_URL}/models/model3.png` },
	{ name: "Modern Bathroom", 		url: `${ASSETS_BASE_URL}/models/modernbathroom.glb`, preview: `${ASSETS_BASE_URL}/models/modernbathroom.png` },
	{ name: "Old Stool", 			url: `${ASSETS_BASE_URL}/models/old_stool.glb`, preview: `${ASSETS_BASE_URL}/models/old_stool.png` },
	{ name: "Outdoor Sofaset", 		url: `${ASSETS_BASE_URL}/models/outdoorsofaset.glb`, preview: `${ASSETS_BASE_URL}/models/outdoorsofaset.png` },
	{ name: "Pagani Huayra Free", 	url: `${ASSETS_BASE_URL}/models/pagani_huayra_free.glb`, preview: `${ASSETS_BASE_URL}/models/pagani_huayra_free.png` },
	{ name: "Retro Telephone", 		url: `${ASSETS_BASE_URL}/models/retro_telephone_bordstelefon_tunnan.glb`, preview: `${ASSETS_BASE_URL}/models/retro_telephone_bordstelefon_tunnan.png` },
	{ name: "Road", 				url: `${ASSETS_BASE_URL}/models/road.glb`, preview: `${ASSETS_BASE_URL}/models/road.png` },
	{ name: "Rollerskates", 		url: `${ASSETS_BASE_URL}/models/rollerskates_race_-_inliner.glb`, preview: `${ASSETS_BASE_URL}/models/rollerskates_race_-_inliner.png` },
	{ name: "Scull Cup", 			url: `${ASSETS_BASE_URL}/models/scull_cup.glb`, preview: `${ASSETS_BASE_URL}/models/scull_cup.png` },
	{ name: "Mantel Clocks", 		url: `${ASSETS_BASE_URL}/models/simple_1800s_mantel_clocks.glb`, preview: `${ASSETS_BASE_URL}/models/simple_1800s_mantel_clocks.png` },
	{ name: "Skatin Jade Dragon", 	url: `${ASSETS_BASE_URL}/models/skatin_jade_dragon.glb`, preview: `${ASSETS_BASE_URL}/models/skatin_jade_dragon.png` },
	{ name: "Sony Walkman", 		url: `${ASSETS_BASE_URL}/models/sony_walkman_wm-f2078.glb`, preview: `${ASSETS_BASE_URL}/models/sony_walkman_wm-f2078.png` },
	{ name: "Spyglasscase", 		url: `${ASSETS_BASE_URL}/models/spyglasscase.glb`, preview: `${ASSETS_BASE_URL}/models/spyglasscase.png` },
	{ name: "Rolex Oyster", 		url: `${ASSETS_BASE_URL}/models/watch-rolex-oyster-perpetual.glb`, preview: `${ASSETS_BASE_URL}/models/watch-rolex-oyster-perpetual.png` },
	{ name: "Suzzane", 				url: `${ASSETS_BASE_URL}/models/suzzane.glb`, preview: `${ASSETS_BASE_URL}/models/suzzane.png` },
	{ name: "Laser Flashlight", 	url: `${ASSETS_BASE_URL}/models/zenitco_klesch-2p__laser_flashlight.glb`, preview: `${ASSETS_BASE_URL}/models/zenitco_klesch-2p__laser_flashlight.png` },
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

// Aspect ratio presets — always landscape-native (orientation toggle handles portrait)
export const ASPECT_RATIO_PRESETS = {
	'1:1': { label: '1:1', width: 1, height: 1 },
	'16:9': { label: '16:9', width: 16, height: 9 },
	'4:3': { label: '4:3', width: 4, height: 3 },
	'3:2': { label: '3:2', width: 3, height: 2 },
	'2.39:1': { label: '2.39:1', width: 239, height: 100 },
	'21:9': { label: '21:9', width: 21, height: 9 },
};

// Resolution presets — longest edge in pixels
export const RESOLUTION_PRESETS = [
	{ value: 256, label: '256' },
	{ value: 512, label: '512' },
	{ value: 1024, label: '1024' },
	{ value: 2048, label: '2048' },
	{ value: 4096, label: '4096' },
];

/**
 * Compute canvas width/height from resolution + aspect ratio + orientation.
 * Resolution = longest edge. Aspect ratio defines the shape. Orientation flips it.
 */
export function computeCanvasDimensions( resolution, aspectPreset, orientation ) {

	const preset = ASPECT_RATIO_PRESETS[ aspectPreset ];
	if ( ! preset ) return { width: resolution, height: resolution };

	const maxRatio = Math.max( preset.width, preset.height );
	const minRatio = Math.min( preset.width, preset.height );
	const longSide = resolution;
	const shortSide = Math.round( resolution * minRatio / maxRatio );

	if ( orientation === 'portrait' && longSide !== shortSide ) {

		return { width: shortSide, height: longSide };

	}

	return { width: longSide, height: shortSide };

}



/*

Test models:
Khronos Group glTF-Sample-Assets: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Models.md

https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MosquitoInAmber/glTF-Binary/MosquitoInAmber.glb

 */

// studio lights: https://stock.adobe.com/in/search?k=studio+hdri
