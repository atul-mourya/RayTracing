import { Color } from "three";
import BVHBuilder from './BVHBuilder.js';
import TextureCreator from './TextureCreator.js';
import GeometryExtractor from './GeometryExtractor.js';
import { updateLoading } from '../Processor/utils.js';

/**
 * TriangleSDF - Handles the triangle-based signed distance field
 * processing for path tracing.
 */
export default class TriangleSDF {

	/**
     * Create a new TriangleSDF processor
     * @param {Object} options - Configuration options
     * @param {boolean} [options.useWorkers=false] - Use worker threads when available
     * @param {number} [options.bvhDepth=30] - Maximum BVH tree depth
     * @param {number} [options.maxLeafSize=4] - Maximum triangles per BVH leaf
     * @param {boolean} [options.verbose=false] - Enable verbose logging
     */
	constructor( options = {} ) {

		// Configuration options with defaults
		this.config = {
			useWorkers: false, // Default to false for compatibility
			bvhDepth: 30,
			maxLeafSize: 4,
			verbose: false,
			...options
		};

		// Initialize geometry data containers
		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;

		// Initialize texture references
		this.materialTexture = null;
		this.triangleTexture = null;
		this.albedoTextures = null;
		this.normalTextures = null;
		this.bumpTextures = null;
		this.roughnessTextures = null;
		this.metalnessTextures = null;
		this.emissiveTextures = null;
		this.bvhTexture = null;

		// Initialize processing components
		this._initProcessors();

		// Processing state
		this.isProcessing = false;
		this.processingStage = null;

	}

	/**
     * Initialize processing components with configuration
     * @private
     */
	_initProcessors() {

		// Create and configure geometry extractor
		this.geometryExtractor = new GeometryExtractor();

		// Create and configure BVH builder
		this.bvhBuilder = new BVHBuilder();
		this.bvhBuilder.maxLeafSize = this.config.maxLeafSize;

		// Create and configure texture creator
		this.textureCreator = new TextureCreator();
		this.textureCreator.useWorkers = this.config.useWorkers;

	}

	/**
     * Log message if verbose mode is enabled
     * @private
     * @param {string} message - Message to log
     * @param {Object} [data] - Optional data to log
     */
	_log( message, data ) {

		if ( this.config.verbose ) {

			console.log( `[TriangleSDF] ${message}`, data || '' );

		}

	}

	/**
     * Build the BVH from a 3D object/scene
     * @param {Object3D} object - Three.js object to process
     * @returns {Promise<TriangleSDF>} - This instance (for chaining)
     */
	async buildBVH( object ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing a scene. Call dispose() first." );

		}

		this.isProcessing = true;
		this.processingStage = 'init';

		try {

			// Reset state before beginning
			this._reset();
			this._log( 'Starting scene processing' );

			// Step 1: Extract geometry (0-30%)
			this.processingStage = 'extraction';
			await this._extractGeometry( object );

			// Step 2: Build BVH (30-80%)
			this.processingStage = 'bvh';
			await this._buildBVH();

			// Step 3: Create textures (80-100%)
			this.processingStage = 'textures';
			await this._createTextures();

			// Create additional scene elements (spheres, etc.)
			this.processingStage = 'finalize';
			this.spheres = this._createSpheres();

			this._log( 'Processing complete', {
				triangles: this.triangles.length,
				materials: this.materials.length,
				textures: this.maps.length
			} );

			this.processingStage = 'complete';
			return this;

		} catch ( error ) {

			this.processingStage = 'error';
			console.error( '[TriangleSDF] Processing error:', error );
			updateLoading( {
				status: `Error: ${error.message}`,
				progress: 100
			} );
			throw error;

		} finally {

			this.isProcessing = false;

		}

	}

	/**
     * Extract geometry data from the object
     * @private
     * @param {Object3D} object - Three.js object to process
     */
	async _extractGeometry( object ) {

		updateLoading( {
			status: "Extracting geometry...",
			progress: 0
		} );

		this._log( 'Extracting geometry' );
		const startTime = performance.now();

		try {

			// Extract geometry data
			const extractedData = this.geometryExtractor.extract( object );

			// Store all extracted data to instance properties
			this.triangles = extractedData.triangles;
			this.materials = extractedData.materials;
			this.maps = extractedData.maps;
			this.normalMaps = extractedData.normalMaps;
			this.bumpMaps = extractedData.bumpMaps;
			this.roughnessMaps = extractedData.roughnessMaps;
			this.metalnessMaps = extractedData.metalnessMaps;
			this.emissiveMaps = extractedData.emissiveMaps;
			this.directionalLights = extractedData.directionalLights;
			this.cameras = extractedData.cameras;

			const duration = performance.now() - startTime;
			this._log( `Geometry extraction complete (${duration.toFixed( 2 )}ms)`, {
				triangles: this.triangles.length,
				materials: this.materials.length
			} );

			updateLoading( {
				status: `Extracted ${this.triangles.length.toLocaleString()} triangles`,
				progress: 30
			} );

		} catch ( error ) {

			console.error( '[TriangleSDF] Geometry extraction error:', error );
			updateLoading( {
				status: `Extraction error: ${error.message}`,
				progress: 30
			} );
			throw error;

		}

	}

	/**
     * Build the BVH structure from extracted triangles
     * @private
     */
	async _buildBVH() {

		updateLoading( {
			status: "Building BVH...",
			progress: 30
		} );

		if ( ! this.triangles || this.triangles.length === 0 ) {

			throw new Error( "No triangles to build BVH from" );

		}

		this._log( 'Building BVH' );
		const startTime = performance.now();

		try {

			// Define progress callback
			const progressCallback = ( progress ) => {

				const scaledProgress = 30 + Math.floor( progress * 0.5 );
				const triangleCount = this.triangles.length.toLocaleString();
				updateLoading( {
					status: `Building BVH for ${triangleCount} triangles... ${progress}%`,
					progress: scaledProgress
				} );

			};

			// Build the BVH
			this.bvhRoot = await this.bvhBuilder.build(
				this.triangles,
				this.config.bvhDepth,
				progressCallback
			);

			const duration = performance.now() - startTime;
			this._log( `BVH building complete (${duration.toFixed( 2 )}ms)` );

			updateLoading( {
				status: "BVH construction complete",
				progress: 80
			} );

		} catch ( error ) {

			console.error( '[TriangleSDF] BVH building error:', error );
			updateLoading( {
				status: `BVH error: ${error.message}`,
				progress: 80
			} );
			throw error;

		}

	}

	/**
     * Create texture data from geometry and materials
     * @private
     */
	async _createTextures() {

		updateLoading( {
			status: "Processing Textures...",
			progress: 80
		} );

		this._log( 'Creating textures' );
		const startTime = performance.now();

		try {

			// Prepare parameters for texture creation
			const params = {
				materials: this.materials,
				triangles: this.triangles,
				maps: this.maps,
				normalMaps: this.normalMaps,
				bumpMaps: this.bumpMaps,
				roughnessMaps: this.roughnessMaps,
				metalnessMaps: this.metalnessMaps,
				emissiveMaps: this.emissiveMaps,
				bvhRoot: this.bvhRoot
			};

			// Create all textures
			const textures = await this.textureCreator.createAllTextures( params );

			// Store texture references
			this.materialTexture = textures.materialTexture;
			this.triangleTexture = textures.triangleTexture;
			this.albedoTextures = textures.albedoTexture;
			this.normalTextures = textures.normalTexture;
			this.bumpTextures = textures.bumpTexture;
			this.roughnessTextures = textures.roughnessTexture;
			this.metalnessTextures = textures.metalnessTexture;
			this.emissiveTextures = textures.emissiveTexture;
			this.bvhTexture = textures.bvhTexture;

			const duration = performance.now() - startTime;
			this._log( `Texture creation complete (${duration.toFixed( 2 )}ms)`, {
				materialTexture: !! this.materialTexture,
				triangleTexture: !! this.triangleTexture,
				bvhTexture: !! this.bvhTexture
			} );

			updateLoading( {
				status: "Texture processing complete",
				progress: 100
			} );

		} catch ( error ) {

			console.error( '[TriangleSDF] Texture creation error:', error );
			updateLoading( {
				status: `Texture error: ${error.message}`,
				progress: 100
			} );
			throw error;

		}

	}

	/**
     * Create additional sphere objects if needed
     * @private
     * @returns {Array} - Array of sphere objects
     */
	_createSpheres() {

		// Factory method for creating any additional scene elements
		// Currently returns an empty array by default
		const white = new Color( 0xffffff );
		const black = new Color( 0x000000 );
		return [
			// { position: new Vector3( - 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( - 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

			// { position: new Vector3( 0, 2, 0 ), radius: 1, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

		];

	}

	/**
     * Reset all data before processing a new scene
     * @private
     */
	_reset() {

		// First dispose any existing resources
		this._disposeTextures();

		// Reset all containers
		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;

	}

	/**
     * Dispose of texture resources
     * @private
     */
	_disposeTextures() {

		// List of texture properties to dispose
		const textureProps = [
			'materialTexture', 'triangleTexture', 'albedoTextures',
			'normalTextures', 'bumpTextures', 'roughnessTextures',
			'metalnessTextures', 'emissiveTextures', 'bvhTexture'
		];

		// Dispose each texture if it exists
		textureProps.forEach( prop => {

			if ( this[ prop ] ) {

				if ( typeof this[ prop ].dispose === 'function' ) {

					this[ prop ].dispose();

				}

				this[ prop ] = null;

			}

		} );

	}

	/**
     * Get statistics about the current state
     * @returns {Object} - Statistics object
     */
	getStatistics() {

		return {
			triangleCount: this.triangles.length,
			materialCount: this.materials.length,
			textureCount: this.maps.length,
			lightCount: this.directionalLights.length,
			cameraCount: this.cameras.length,
			processingComplete: this.processingStage === 'complete',
			hasBVH: !! this.bvhRoot,
			hasTextures: !! this.materialTexture && !! this.triangleTexture
		};

	}

	/**
     * Completely dispose of all resources
     * Call this when the instance is no longer needed
     */
	dispose() {

		this._log( 'Disposing resources' );

		// Dispose textures
		this._disposeTextures();

		// Clear all data
		this._reset();

		// Clear reference to processing components
		this.geometryExtractor = null;
		this.bvhBuilder = null;
		this.textureCreator = null;

	}

}
