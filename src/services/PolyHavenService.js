/**
 * Service class for handling Poly Haven API operations
 */
export class PolyHavenService {

	static API_BASE_URL = 'https://api.polyhaven.com';
	static CDN_BASE_URL = 'https://cdn.polyhaven.com';
	static DL_BASE_URL = 'https://dl.polyhaven.org';

	/**
	 * Fetch available asset types
	 * @returns {Promise<Array>} Array of asset types
	 */
	static async getAssetTypes() {

		try {

			const response = await fetch( `${this.API_BASE_URL}/types` );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			console.error( 'Error fetching asset types:', error );
			throw new Error( `Failed to fetch asset types: ${error.message}` );

		}

	}

	/**
	 * Fetch assets of a specific type
	 * @param {string} type - Asset type ('hdris', 'textures', 'models')
	 * @param {Array<string>} categories - Optional categories to filter by
	 * @returns {Promise<Object>} Assets object
	 */
	static async getAssets( type = 'textures', categories = null ) {

		try {

			let url = `${this.API_BASE_URL}/assets?t=${type}`;
			if ( categories && categories.length > 0 ) {

				url += `&c=${categories.join( ',' )}`;

			}

			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			console.error( 'Error fetching assets:', error );
			throw new Error( `Failed to fetch ${type} assets: ${error.message}` );

		}

	}

	/**
	 * Fetch detailed information about a specific asset
	 * @param {string} assetId - Asset ID
	 * @returns {Promise<Object>} Asset details
	 */
	static async getAssetInfo( assetId ) {

		try {

			const response = await fetch( `${this.API_BASE_URL}/info/${assetId}` );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			console.error( `Error fetching asset info for ${assetId}:`, error );
			throw new Error( `Failed to fetch asset info: ${error.message}` );

		}

	}

	/**
	 * Fetch file information for a specific asset
	 * @param {string} assetId - Asset ID
	 * @returns {Promise<Object>} Asset files information
	 */
	static async getAssetFiles( assetId ) {

		try {

			const response = await fetch( `${this.API_BASE_URL}/files/${assetId}` );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			console.error( `Error fetching asset files for ${assetId}:`, error );
			throw new Error( `Failed to fetch asset files: ${error.message}` );

		}

	}

	/**
	 * Fetch categories for a specific asset type
	 * @param {string} type - Asset type
	 * @returns {Promise<Object>} Categories with counts
	 */
	static async getCategories( type ) {

		try {

			const response = await fetch( `${this.API_BASE_URL}/categories/${type}` );
			if ( ! response.ok ) throw new Error( `HTTP ${response.status}: ${response.statusText}` );
			return await response.json();

		} catch ( error ) {

			console.error( `Error fetching categories for ${type}:`, error );
			throw new Error( `Failed to fetch categories: ${error.message}` );

		}

	}

	/**
	 * Process texture materials from Poly Haven API response
	 * @param {Object} assetsData - Raw assets data from API
	 * @param {string} resolution - Texture resolution ('1k', '2k', '4k', '8k')
	 * @returns {Array} Processed materials array
	 */
	static processTextureMaterials( assetsData, resolution = '2k' ) {

		if ( ! assetsData || typeof assetsData !== 'object' ) {

			throw new Error( 'Invalid assets data provided' );

		}

		return Object.entries( assetsData )
			.filter( ( [ , info ] ) => info.type === 1 ) // Only textures
			.map( ( [ id, info ] ) => ( {
				id,
				name: info.name,
				preview: `${this.CDN_BASE_URL}/asset_img/thumbs/${id}.png?width=256&height=256`,
				categories: info.categories || [],
				tags: info.tags || [],
				redirection: `https://polyhaven.com/a/${id}`,
				resolution: info.max_resolution || [ 2048, 2048 ],
				dimensions: info.dimensions || [ 1000, 1000 ], // in mm
				downloadCount: info.download_count || 0,
				datePublished: info.date_published || 0,
				authors: info.authors || {},
				// Store the asset ID for file fetching
				assetId: id,
				// Mark as Poly Haven source
				source: 'polyhaven',
				// Resolution for texture downloads
				targetResolution: resolution
			} ) )
			.sort( ( a, b ) => b.downloadCount - a.downloadCount ); // Sort by popularity

	}

	/**
	 * Get the best available texture files for an asset
	 * @param {string} assetId - Asset ID
	 * @param {string} resolution - Target resolution ('1k', '2k', '4k', '8k')
	 * @returns {Promise<Object>} Object containing texture file URLs
	 */
	static async getAssetTextureFiles( assetId, resolution = '2k' ) {

		try {

			const files = await this.getAssetFiles( assetId );
			const textureFiles = {};

			// Map of texture types to their common names
			const textureTypeMap = {
				// PolyHaven actual naming convention
				'Diffuse': 'map', // Diffuse/Color
				'Displacement': 'displacementMap', // Displacement
				'nor_dx': 'normalMap', // Normal (DirectX format)
				'nor_gl': 'normalMap', // Normal (OpenGL format) - prefer this if both exist
				'Rough': 'roughnessMap', // Roughness
				'AO': 'aoMap', // Ambient Occlusion
				'arm': 'aoMap', // ARM texture (AO+Roughness+Metallic) - use for AO
				// Legacy names (keep for compatibility)
				'diff': 'map',
				'disp': 'displacementMap',
				'nor': 'normalMap',
				'rough': 'roughnessMap',
				'metal': 'metalnessMap',
				'ao': 'aoMap',
				'bump': 'bumpMap',
				'spec': 'specularMap',
				'opacity': 'alphaMap',
				'emission': 'emissiveMap'
			};

			// Valid image formats for textures
			const validImageFormats = [ 'jpg', 'jpeg', 'png', 'webp', 'exr', 'hdr' ];

			// Process each texture map type
			for ( const [ mapType, files_by_res ] of Object.entries( files ) ) {

				// Only process known texture types
				if ( ! textureTypeMap[ mapType ] ) continue;

				if ( typeof files_by_res === 'object' && files_by_res !== null ) {

					// Find the best available resolution
					const availableResolutions = Object.keys( files_by_res );
					const targetRes = availableResolutions.includes( resolution )
						? resolution
						: availableResolutions[ 0 ]; // Fallback to first available

					if ( targetRes && files_by_res[ targetRes ] ) {

						const formatFiles = files_by_res[ targetRes ];

						// Filter only valid image formats
						const validFormats = Object.keys( formatFiles ).filter( format =>
							validImageFormats.includes( format.toLowerCase() )
						);

						if ( validFormats.length === 0 ) continue; // Skip if no valid formats

						// Prefer JPG for diffuse, PNG for others, EXR for HDR maps
						let fileUrl = null;
						let firstFormat = null;

						if ( formatFiles.jpg ) {

							fileUrl = formatFiles.jpg.url;
							firstFormat = formatFiles.jpg;

						} else if ( formatFiles.png ) {

							fileUrl = formatFiles.png.url;
							firstFormat = formatFiles.png;

						} else if ( formatFiles.webp ) {

							fileUrl = formatFiles.webp.url;
							firstFormat = formatFiles.webp;

						} else if ( formatFiles.exr ) {

							fileUrl = formatFiles.exr.url;
							firstFormat = formatFiles.exr;

						} else if ( formatFiles.hdr ) {

							fileUrl = formatFiles.hdr.url;
							firstFormat = formatFiles.hdr;

						} else {

							// Get first valid format
							const firstValidFormat = validFormats[ 0 ];
							if ( firstValidFormat && formatFiles[ firstValidFormat ] ) {

								fileUrl = formatFiles[ firstValidFormat ].url;
								firstFormat = formatFiles[ firstValidFormat ];

							}

						}

						if ( fileUrl ) {

							const threejsMapName = textureTypeMap[ mapType ] || mapType;

							// Special handling for ARM texture (AO+Roughness+Metallic packed)
							if ( mapType === 'arm' ) {

								// ARM texture contains multiple channels, add all relevant maps
								textureFiles.aoMap = {
									url: fileUrl,
									resolution: targetRes,
									mapType: 'arm_ao',
									size: firstFormat?.size || 0,
									md5: firstFormat?.md5 || null,
									channel: 'r' // Red channel for AO
								};

								textureFiles.roughnessMap = {
									url: fileUrl,
									resolution: targetRes,
									mapType: 'arm_roughness',
									size: firstFormat?.size || 0,
									md5: firstFormat?.md5 || null,
									channel: 'g' // Green channel for Roughness
								};

								textureFiles.metalnessMap = {
									url: fileUrl,
									resolution: targetRes,
									mapType: 'arm_metalness',
									size: firstFormat?.size || 0,
									md5: firstFormat?.md5 || null,
									channel: 'b' // Blue channel for Metalness
								};

							} else {

								// Special handling for normal maps - prefer OpenGL format if we haven't set one yet
								if ( mapType === 'nor_dx' && textureFiles.normalMap ) {

									// Skip DirectX normal if we already have OpenGL

								} else if ( mapType === 'nor_gl' && textureFiles.normalMap ) {

									// Replace DirectX normal with OpenGL version
									textureFiles[ threejsMapName ] = {
										url: fileUrl,
										resolution: targetRes,
										mapType,
										size: firstFormat?.size || 0,
										md5: firstFormat?.md5 || null
									};

								} else {

									textureFiles[ threejsMapName ] = {
										url: fileUrl,
										resolution: targetRes,
										mapType,
										size: firstFormat?.size || 0,
										md5: firstFormat?.md5 || null
									};

								}

							}

						}

					}

				}

			}

			return textureFiles;

		} catch ( error ) {

			console.error( `Error getting texture files for ${assetId}:`, error );
			throw new Error( `Failed to get texture files: ${error.message}` );

		}

	}

	/**
	 * Create a Three.js PBR material from Poly Haven texture data
	 * @param {Object} materialData - Material data with texture URLs
	 * @param {Object} textureFiles - Texture files object
	 * @returns {Promise<Object>} Material configuration object
	 */
	static async createMaterialFromTextures( materialData, textureFiles ) {

		try {

			// Base material properties from Poly Haven textures
			const materialConfig = {
				name: materialData.name,
				uuid: `polyhaven-${materialData.assetId}`,

				// Basic PBR properties (will be modified by textures)
				color: [ 1, 1, 1 ], // White base - let diffuse texture control color
				metalness: textureFiles.metalnessMap ? 1.0 : 0.0, // Full metallic if metalness map exists
				roughness: textureFiles.roughnessMap ? 1.0 : 0.5, // Let roughness map control, or default
				emissive: [ 0, 0, 0 ],
				emissiveIntensity: 1.0,

				// Transmission and transparency
				transmission: 0.0,
				opacity: 1.0,
				transparent: !! textureFiles.alphaMap,

				// Advanced PBR properties
				ior: 1.5,
				clearcoat: 0.0,
				clearcoatRoughness: 0.0,
				sheen: 0.0,
				sheenRoughness: 1.0,
				sheenColor: [ 0, 0, 0 ],
				specularIntensity: 1.0,
				specularColor: [ 1, 1, 1 ],
				iridescence: 0.0,
				iridescenceIOR: 1.3,
				iridescenceThicknessRange: [ 100, 400 ],

				// Texture maps
				textureFiles,

				// Metadata
				source: 'polyhaven',
				assetId: materialData.assetId,
				categories: materialData.categories,
				tags: materialData.tags,
				authors: materialData.authors,

				// Physical dimensions (for UV scaling)
				realWorldDimensions: materialData.dimensions, // in mm
			};

			return materialConfig;

		} catch ( error ) {

			console.error( 'Error creating material from textures:', error );
			throw new Error( `Failed to create material: ${error.message}` );

		}

	}

	/**
	 * Fetch and process texture materials from Poly Haven
	 * @param {string} resolution - Target resolution
	 * @param {Array<string>} categories - Optional categories to filter
	 * @param {number} limit - Maximum number of materials to return
	 * @returns {Promise<Array>} Array of processed material objects
	 */
	static async fetchTextureMaterials( resolution = '2k', categories = null, limit = 50 ) {

		try {

			// Fetch texture assets
			const assetsData = await this.getAssets( 'textures', categories );

			// Process materials
			const materials = this.processTextureMaterials( assetsData, resolution );

			// Limit results if specified
			const limitedMaterials = limit > 0 ? materials.slice( 0, limit ) : materials;

			return limitedMaterials;

		} catch ( error ) {

			console.error( 'Error fetching Poly Haven materials:', error );
			throw new Error( `Failed to fetch Poly Haven materials: ${error.message}` );

		}

	}

	/**
	 * Load a complete material with all its texture files
	 * @param {Object} materialData - Material data object
	 * @returns {Promise<Object>} Complete material with loaded textures
	 */
	static async loadCompleteMaterial( materialData ) {

		try {

			console.log( 'Loading complete Poly Haven material:', materialData.name );

			// Fetch texture files for the asset
			const textureFiles = await this.getAssetTextureFiles(
				materialData.assetId,
				materialData.targetResolution
			);

			// Create material configuration
			const materialConfig = await this.createMaterialFromTextures( materialData, textureFiles );

			console.log( `Loaded material "${materialData.name}" with ${Object.keys( textureFiles ).length} textures` );

			return materialConfig;

		} catch ( error ) {

			console.error( `Error loading material ${materialData.name}:`, error );
			throw new Error( `Failed to load material: ${error.message}` );

		}

	}

}
