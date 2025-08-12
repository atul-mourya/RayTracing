/**
 * Service class for handling asset loading operations
 */
export class AssetLoaderService {

	/**
	 * Load a model from the example models list
	 * @param {number} modelIndex - Index of the model to load
	 * @param {Array} modelFiles - Array of model file definitions
	 * @returns {Promise} Promise that resolves when model is loaded
	 */
	static async loadExampleModel( modelIndex, modelFiles ) {

		if ( ! window.pathTracerApp ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( modelIndex < 0 || modelIndex >= modelFiles.length ) {

			throw new Error( `Invalid model index: ${modelIndex}` );

		}

		const modelFile = modelFiles[ modelIndex ];

		try {

			await window.pathTracerApp.loadExampleModels( modelIndex );
			return {
				success: true,
				modelName: modelFile.name,
				message: `${modelFile.name} loaded successfully`
			};

		} catch ( error ) {

			throw new Error( `Failed to load ${modelFile.name}: ${error.message}` );

		}

	}

	/**
	 * Load a debug model
	 * @param {number} modelIndex - Index of the debug model to load
	 * @param {Array} debugModels - Array of debug model definitions
	 * @returns {Promise} Promise that resolves when model is loaded
	 */
	static async loadDebugModel( modelIndex, debugModels ) {

		if ( ! window.pathTracerApp ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( modelIndex < 0 || modelIndex >= debugModels.length ) {

			throw new Error( `Invalid debug model index: ${modelIndex}` );

		}

		const debugModel = debugModels[ modelIndex ];

		try {

			await window.pathTracerApp.loadModel( debugModel.url );
			return {
				success: true,
				modelName: debugModel.name,
				message: `${debugModel.name} loaded successfully`
			};

		} catch ( error ) {

			throw new Error( `Failed to load ${debugModel.name}: ${error.message}` );

		}

	}

	/**
	 * Load an environment map
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

	/**
	 * Fetch materials from API
	 * @returns {Promise<Array>} Promise that resolves to processed materials array
	 */
	static async fetchMaterialCatalog() {

		try {

			const response = await fetch( 'https://api.physicallybased.info/materials' );

			if ( ! response.ok ) {

				throw new Error( `HTTP error! status: ${response.status}` );

			}

			const data = await response.json();

			// Process materials to add preview property
			const processedMaterials = data.map( ( mData ) => ( {
				...mData,
				preview: mData.reference[ 0 ]
			} ) );

			return processedMaterials;

		} catch ( error ) {

			throw new Error( `Failed to fetch material catalog: ${error.message}` );

		}

	}

	/**
	 * Reset path tracer after loading operations
	 */
	static resetPathTracer() {

		if ( window.pathTracerApp?.reset ) {

			window.pathTracerApp.reset();

		}

	}

}
