/**
 * Service class for handling environment/HDRI operations
 */
export class EnvironmentService {

	/**
	 * Get available local HDRI categories based on file names and common patterns
	 * @returns {Object} Categories with counts
	 */
	static getLocalEnvironmentCategories() {

		// Define categories based on common HDRI naming patterns and types
		const categories = {
			'studio': 0,
			'outdoor': 0,
			'architectural': 0,
			'nature': 0,
			'urban': 0,
			'sky': 0,
			'interior': 0,
			'night': 0,
			'forest': 0,
			'misc': 0
		};

		// Categorize based on naming patterns
		const categoryPatterns = {
			'studio': /studio|photo.*studio|photostudio|blocky.*photo/i,
			'outdoor': /outdoor|garden|bridge|terrain|grass|trail/i,
			'architectural': /building|chapel|market|hall|square|vestibule|sepulchral|rotunda/i,
			'nature': /forest|garden|terrain|grass|trail|whale|rainforest|thatch/i,
			'urban': /urban|alley|building|market|square|aerodynamics|autoshop|powerplant/i,
			'sky': /sky|cloud|puresky/i,
			'interior': /cellar|kitchen|measuring.*lab|comfy.*cafe|hall.*mammals|vestibule/i,
			'night': /night|moonlit/i,
			'forest': /forest|phalzer|rainforest/i
		};

		// Sample of local HDRIs (you can extend this list)
		const localHDRIs = [
			'adams_place_bridge_1k.hdr',
			'aerodynamics_workshop_1k.hdr',
			'aristea_wreck_puresky_1k.hdr',
			'autoshop_01_1k.hdr',
			'blocky_photo_studio_1k.hdr',
			'brown_photostudio_01_1k.hdr',
			'brown_photostudio_02_1k.hdr',
			'brown_photostudio_06_1k.hdr',
			'brown_photostudio_07_1k.hdr',
			'chinese_garden_1k.hdr',
			'christmas_photo_studio_04_2k.hdr',
			'christmas_photo_studio_07_1k.hdr',
			'circus_arena_1k.hdr',
			'cloud_layers_2k.hdr',
			'comfy_cafe_2k.hdr',
			'dancing_hall_1k.hdr',
			'drachenfels_cellar_1k.hdr',
			'hall_of_mammals_2k.hdr',
			'herkulessaulen_2k.hdr',
			'hilly_terrain_01_1k.hdr',
			'kloppenheim_05_1k.hdr',
			'leadenhall_market_1k.hdr',
			'modern_buildings_2_1k.hdr',
			'narrow_moonlit_road_1k.hdr',
			'noon_grass_1k.hdr',
			'peppermint_powerplant_1k.hdr',
			'phalzer_forest_01_1k.hdr',
			'photo_studio_01_2k.hdr',
			'rainforest_trail_1k.hdr',
			'sepulchral_chapel_rotunda_1k.hdr',
			'st_peters_square_night_1k.hdr',
			'studio_small_05_1k.hdr',
			'studio_small_09_2k.hdr',
			'thatch_chapel_1k.hdr',
			'urban_alley_01_2k.hdr',
			'vestibule_1k.hdr',
			'wasteland_clouds_puresky_2k.hdr',
			'whale_skeleton_2k.hdr',
			'Car Scene.exr',
			'Default.exr',
			'Default (1).exr',
			'MR_INT-003_Kitchen_Pierre.hdr'
		];

		// Categorize each HDRI
		localHDRIs.forEach( fileName => {

			let categorized = false;

			// Check each category pattern
			for ( const [ category, pattern ] of Object.entries( categoryPatterns ) ) {

				if ( pattern.test( fileName ) ) {

					categories[ category ] ++;
					categorized = true;
					break;

				}

			}

			// If no category matches, put in misc
			if ( ! categorized ) {

				categories.misc ++;

			}

		} );

		// Remove categories with 0 count
		return Object.fromEntries(
			Object.entries( categories ).filter( ( [ , count ] ) => count > 0 )
		);

	}

	/**
	 * Get local environments filtered by categories
	 * @param {Array<string>} categories - Categories to filter by
	 * @returns {Array} Filtered environment objects
	 */
	static getLocalEnvironmentsByCategories( categories = null ) {

		const baseUrl = '/hdri/';
		
		// All local environments with metadata
		const localEnvironments = [
			{
				id: 'adams_place_bridge',
				name: 'Adams Place Bridge',
				preview: `${baseUrl}adams_place_bridge.webp`,
				url: `${baseUrl}adams_place_bridge_1k.hdr`,
				categories: [ 'outdoor', 'architectural' ],
				tags: [ 'bridge', 'outdoor', 'architectural', 'day' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'aerodynamics_workshop',
				name: 'Aerodynamics Workshop',
				preview: `${baseUrl}aerodynamics_workshop.webp`,
				url: `${baseUrl}aerodynamics_workshop_1k.hdr`,
				categories: [ 'urban', 'interior' ],
				tags: [ 'workshop', 'urban', 'interior', 'industrial' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'aristea_wreck_puresky',
				name: 'Aristea Wreck Pure Sky',
				preview: `${baseUrl}aristea_wreck_puresky.webp`,
				url: `${baseUrl}aristea_wreck_puresky_1k.hdr`,
				categories: [ 'sky', 'outdoor' ],
				tags: [ 'sky', 'pure', 'outdoor', 'clean' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'autoshop_01',
				name: 'Auto Shop 01',
				preview: `${baseUrl}autoshop_01.webp`,
				url: `${baseUrl}autoshop_01_1k.hdr`,
				categories: [ 'urban', 'interior' ],
				tags: [ 'autoshop', 'urban', 'interior', 'workshop' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'blocky_photo_studio',
				name: 'Blocky Photo Studio',
				preview: `${baseUrl}blocky_photo_studio.webp`,
				url: `${baseUrl}blocky_photo_studio_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'photography', 'lighting' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'brown_photostudio_01',
				name: 'Brown Photo Studio 01',
				preview: `${baseUrl}brown_photostudio_01.webp`,
				url: `${baseUrl}brown_photostudio_01_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'brown', 'photography' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'brown_photostudio_02',
				name: 'Brown Photo Studio 02',
				preview: `${baseUrl}brown_photostudio_02.webp`,
				url: `${baseUrl}brown_photostudio_02_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'brown', 'photography' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'brown_photostudio_06',
				name: 'Brown Photo Studio 06',
				preview: `${baseUrl}brown_photostudio_06.webp`,
				url: `${baseUrl}brown_photostudio_06_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'brown', 'photography' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'brown_photostudio_07',
				name: 'Brown Photo Studio 07',
				preview: `${baseUrl}brown_photostudio_07.webp`,
				url: `${baseUrl}brown_photostudio_07_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'brown', 'photography' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'chinese_garden',
				name: 'Chinese Garden',
				preview: `${baseUrl}chinese_garden.webp`,
				url: `${baseUrl}chinese_garden_1k.hdr`,
				categories: [ 'nature', 'outdoor' ],
				tags: [ 'garden', 'nature', 'outdoor', 'chinese' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'christmas_photo_studio_04',
				name: 'Christmas Photo Studio 04',
				preview: `${baseUrl}christmas_photo_studio_04.webp`,
				url: `${baseUrl}christmas_photo_studio_04_2k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'christmas', 'holiday' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'christmas_photo_studio_07',
				name: 'Christmas Photo Studio 07',
				preview: `${baseUrl}christmas_photo_studio_07.webp`,
				url: `${baseUrl}christmas_photo_studio_07_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'christmas', 'holiday' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'circus_arena',
				name: 'Circus Arena',
				preview: `${baseUrl}circus_arena.webp`,
				url: `${baseUrl}circus_arena_1k.hdr`,
				categories: [ 'architectural', 'interior' ],
				tags: [ 'circus', 'arena', 'architectural', 'interior' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'cloud_layers',
				name: 'Cloud Layers',
				preview: null, // No webp preview for this one
				url: `${baseUrl}cloud_layers_2k.hdr`,
				categories: [ 'sky' ],
				tags: [ 'clouds', 'sky', 'layers', 'weather' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'comfy_cafe',
				name: 'Comfy Cafe',
				preview: `${baseUrl}comfy_cafe.webp`,
				url: `${baseUrl}comfy_cafe_2k.hdr`,
				categories: [ 'interior' ],
				tags: [ 'cafe', 'interior', 'comfy', 'cozy' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'dancing_hall',
				name: 'Dancing Hall',
				preview: `${baseUrl}dancing_hall.webp`,
				url: `${baseUrl}dancing_hall_1k.hdr`,
				categories: [ 'architectural', 'interior' ],
				tags: [ 'dancing', 'hall', 'architectural', 'interior' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'drachenfels_cellar',
				name: 'Drachenfels Cellar',
				preview: `${baseUrl}drachenfels_cellar.webp`,
				url: `${baseUrl}drachenfels_cellar_1k.hdr`,
				categories: [ 'interior' ],
				tags: [ 'cellar', 'interior', 'underground', 'medieval' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'hall_of_mammals',
				name: 'Hall of Mammals',
				preview: `${baseUrl}hall_of_mammals.webp`,
				url: `${baseUrl}hall_of_mammals_2k.hdr`,
				categories: [ 'interior', 'architectural' ],
				tags: [ 'hall', 'mammals', 'museum', 'interior' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'herkulessaulen',
				name: 'Herkulessaulen',
				preview: `${baseUrl}herkulessaulen.webp`,
				url: `${baseUrl}herkulessaulen_2k.hdr`,
				categories: [ 'architectural', 'outdoor' ],
				tags: [ 'architectural', 'columns', 'outdoor', 'classical' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'hilly_terrain_01',
				name: 'Hilly Terrain 01',
				preview: `${baseUrl}hilly_terrain_01.webp`,
				url: `${baseUrl}hilly_terrain_01_1k.hdr`,
				categories: [ 'nature', 'outdoor' ],
				tags: [ 'terrain', 'hills', 'nature', 'outdoor' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'kloppenheim_05',
				name: 'Kloppenheim 05',
				preview: `${baseUrl}kloppenheim_05.webp`,
				url: `${baseUrl}kloppenheim_05_1k.hdr`,
				categories: [ 'architectural', 'outdoor' ],
				tags: [ 'architectural', 'outdoor', 'european', 'building' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'leadenhall_market',
				name: 'Leadenhall Market',
				preview: `${baseUrl}leadenhall_market.webp`,
				url: `${baseUrl}leadenhall_market_1k.hdr`,
				categories: [ 'architectural', 'urban' ],
				tags: [ 'market', 'architectural', 'urban', 'historic' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'modern_buildings_2',
				name: 'Modern Buildings 2',
				preview: `${baseUrl}modern_buildings_2.webp`,
				url: `${baseUrl}modern_buildings_2_1k.hdr`,
				categories: [ 'urban', 'architectural' ],
				tags: [ 'modern', 'buildings', 'urban', 'architectural' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'narrow_moonlit_road',
				name: 'Narrow Moonlit Road',
				preview: `${baseUrl}narrow_moonlit_road.webp`,
				url: `${baseUrl}narrow_moonlit_road_1k.hdr`,
				categories: [ 'night', 'outdoor' ],
				tags: [ 'night', 'moonlit', 'road', 'outdoor' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'noon_grass',
				name: 'Noon Grass',
				preview: `${baseUrl}noon_grass.webp`,
				url: `${baseUrl}noon_grass_1k.hdr`,
				categories: [ 'nature', 'outdoor' ],
				tags: [ 'grass', 'nature', 'outdoor', 'noon' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'peppermint_powerplant',
				name: 'Peppermint Powerplant',
				preview: `${baseUrl}peppermint_powerplant.webp`,
				url: `${baseUrl}peppermint_powerplant_1k.hdr`,
				categories: [ 'urban' ],
				tags: [ 'powerplant', 'urban', 'industrial', 'energy' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'phalzer_forest_01',
				name: 'Phalzer Forest 01',
				preview: `${baseUrl}phalzer_forest_01.webp`,
				url: `${baseUrl}phalzer_forest_01_1k.hdr`,
				categories: [ 'forest', 'nature' ],
				tags: [ 'forest', 'nature', 'trees', 'outdoor' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'photo_studio_01',
				name: 'Photo Studio 01',
				preview: `${baseUrl}photo_studio_01.webp`,
				url: `${baseUrl}photo_studio_01_2k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'photo', 'photography', 'lighting' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'rainforest_trail',
				name: 'Rainforest Trail',
				preview: `${baseUrl}rainforest_trail.webp`,
				url: `${baseUrl}rainforest_trail_1k.hdr`,
				categories: [ 'forest', 'nature' ],
				tags: [ 'rainforest', 'trail', 'nature', 'trees' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'sepulchral_chapel_rotunda',
				name: 'Sepulchral Chapel Rotunda',
				preview: `${baseUrl}sepulchral_chapel_rotunda.webp`,
				url: `${baseUrl}sepulchral_chapel_rotunda_1k.hdr`,
				categories: [ 'architectural', 'interior' ],
				tags: [ 'chapel', 'rotunda', 'architectural', 'interior' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'st_peters_square_night',
				name: "St Peter's Square Night",
				preview: `${baseUrl}st_peters_square_night.webp`,
				url: `${baseUrl}st_peters_square_night_1k.hdr`,
				categories: [ 'night', 'architectural' ],
				tags: [ 'night', 'square', 'architectural', 'historic' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'studio_small_05',
				name: 'Studio Small 05',
				preview: `${baseUrl}studio_small_05.webp`,
				url: `${baseUrl}studio_small_05_1k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'small', 'photography', 'lighting' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'studio_small_09',
				name: 'Studio Small 09',
				preview: `${baseUrl}studio_small_09.webp`,
				url: `${baseUrl}studio_small_09_2k.hdr`,
				categories: [ 'studio' ],
				tags: [ 'studio', 'small', 'photography', 'lighting' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'thatch_chapel',
				name: 'Thatch Chapel',
				preview: `${baseUrl}thatch_chapel.webp`,
				url: `${baseUrl}thatch_chapel_1k.hdr`,
				categories: [ 'architectural', 'nature' ],
				tags: [ 'chapel', 'thatch', 'architectural', 'rural' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'urban_alley_01',
				name: 'Urban Alley 01',
				preview: `${baseUrl}urban_alley_01.webp`,
				url: `${baseUrl}urban_alley_01_2k.hdr`,
				categories: [ 'urban' ],
				tags: [ 'urban', 'alley', 'city', 'street' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'vestibule',
				name: 'Vestibule',
				preview: `${baseUrl}vestibule.webp`,
				url: `${baseUrl}vestibule_1k.hdr`,
				categories: [ 'interior', 'architectural' ],
				tags: [ 'vestibule', 'interior', 'architectural', 'entrance' ],
				resolution: '1k',
				source: 'local'
			},
			{
				id: 'wasteland_clouds_puresky',
				name: 'Wasteland Clouds Pure Sky',
				preview: `${baseUrl}wasteland_clouds_puresky.webp`,
				url: `${baseUrl}wasteland_clouds_puresky_2k.hdr`,
				categories: [ 'sky' ],
				tags: [ 'sky', 'clouds', 'wasteland', 'pure' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'whale_skeleton',
				name: 'Whale Skeleton',
				preview: `${baseUrl}whale_skeleton.webp`,
				url: `${baseUrl}whale_skeleton_2k.hdr`,
				categories: [ 'nature', 'interior' ],
				tags: [ 'whale', 'skeleton', 'nature', 'museum' ],
				resolution: '2k',
				source: 'local'
			},
			{
				id: 'car_scene',
				name: 'Car Scene',
				preview: null,
				url: `${baseUrl}Car Scene.exr`,
				categories: [ 'misc' ],
				tags: [ 'car', 'scene', 'automotive' ],
				resolution: 'hdr',
				source: 'local'
			},
			{
				id: 'default',
				name: 'Default',
				preview: null,
				url: `${baseUrl}Default.exr`,
				categories: [ 'misc' ],
				tags: [ 'default', 'basic' ],
				resolution: 'hdr',
				source: 'local'
			},
			{
				id: 'default_1',
				name: 'Default (1)',
				preview: null,
				url: `${baseUrl}Default (1).exr`,
				categories: [ 'misc' ],
				tags: [ 'default', 'basic' ],
				resolution: 'hdr',
				source: 'local'
			},
			{
				id: 'kitchen_pierre',
				name: 'Kitchen Pierre',
				preview: null,
				url: `${baseUrl}MR_INT-003_Kitchen_Pierre.hdr`,
				categories: [ 'interior' ],
				tags: [ 'kitchen', 'interior', 'domestic' ],
				resolution: 'hdr',
				source: 'local'
			}
		];

		// Filter by categories if specified
		if ( categories && categories.length > 0 ) {

			return localEnvironments.filter( env =>
				env.categories.some( cat =>
					categories.some( filterCat =>
						cat.toLowerCase() === filterCat.toLowerCase()
					)
				)
			);

		}

		return localEnvironments;

	}

	/**
	 * Extract categories from environments array
	 * @param {Array} environments - Array of environment objects
	 * @returns {Object} Categories with counts
	 */
	static extractCategoriesFromEnvironments( environments ) {

		const categoryCount = {};

		environments.forEach( env => {

			if ( env.categories && Array.isArray( env.categories ) ) {

				env.categories.forEach( category => {

					if ( category && typeof category === 'string' ) {

						categoryCount[ category ] = ( categoryCount[ category ] || 0 ) + 1;

					}

				} );

			}

		} );

		return categoryCount;

	}

	/**
	 * Load an environment/HDRI
	 * @param {Object} envData - Environment data object
	 * @returns {Promise} Promise that resolves when environment is loaded
	 */
	static async loadEnvironment( envData ) {

		if ( ! window.pathTracerApp ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( ! envData || ! envData.url ) {

			throw new Error( 'Invalid environment data provided' );

		}

		try {

			// Handle custom environment uploads
			if ( envData.id === 'custom-upload' && envData.name ) {

				window.uploadedEnvironmentFileInfo = {
					name: envData.name,
					url: envData.url
				};

			}

			await window.pathTracerApp.loadEnvironment( envData.url );
			return {
				success: true,
				environmentName: envData.name,
				message: `${envData.name} loaded successfully`
			};

		} catch ( error ) {

			throw new Error( `Failed to load ${envData.name}: ${error.message || "Unknown error"}` );

		}

	}

}
