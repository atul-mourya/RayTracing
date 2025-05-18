import {
	Box3,
	Vector3,
	RectAreaLight,
	Color,
	FloatType,
	LinearFilter,
	EquirectangularReflectionMapping,
	TextureLoader,
	BufferAttribute,
	Mesh,
	MeshStandardMaterial,
	Points,
	PointsMaterial,
	LoadingManager
} from 'three';

import {
	GLTFLoader,
	RGBELoader,
	DRACOLoader,
	EXRLoader,
} from 'three/examples/jsm/Addons';

import { createMeshesFromMultiMaterialMesh } from 'three/addons/utils/SceneUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { disposeObjectFromMemory, updateLoading, resetLoading } from './utils';
import { MODEL_FILES, DEFAULT_STATE } from '@/Constants';

// Define supported file types
const SUPPORTED_FORMATS = {
	// 3D Models
	'glb': { type: 'model', name: 'GLB (GLTF Binary)' },
	'gltf': { type: 'model', name: 'GLTF' },
	'fbx': { type: 'model', name: 'FBX' },
	'obj': { type: 'model', name: 'OBJ' },
	'stl': { type: 'model', name: 'STL' },
	'ply': { type: 'model', name: 'PLY (Polygon File Format)' },
	'dae': { type: 'model', name: 'Collada' },
	'3mf': { type: 'model', name: '3D Manufacturing Format' },
	'usdz': { type: 'model', name: 'Universal Scene Description' },

	// Environment Maps
	'hdr': { type: 'environment', name: 'HDR (High Dynamic Range)' },
	'exr': { type: 'environment', name: 'EXR (OpenEXR)' },

	// Basic Image Formats for Textures & Environments
	'png': { type: 'image', name: 'PNG' },
	'jpg': { type: 'image', name: 'JPEG' },
	'jpeg': { type: 'image', name: 'JPEG' },
	'webp': { type: 'image', name: 'WebP' },

	// Archive
	'zip': { type: 'archive', name: 'ZIP Archive' }
};

// Import MeshoptEncoder for mesh optimization
// Note: You need to ensure the meshoptimizer package is properly installed
// npm install meshoptimizer
let MeshoptEncoder;

// Load the MeshoptEncoder dynamically
async function loadMeshoptEncoder() {

	try {

		// Dynamically import the meshoptimizer package
		const module = await import( 'meshoptimizer' );
		MeshoptEncoder = module.MeshoptEncoder;

		// Wait for the encoder to be ready
		await MeshoptEncoder.ready;
		console.log( 'MeshoptEncoder loaded and ready' );
		return true;

	} catch ( error ) {

		console.warn( 'Failed to load MeshoptEncoder:', error );
		return false;

	}

}

class AssetLoader {

	constructor( scene, camera, controls, pathTracingPass ) {

		this.scene = scene;
		this.camera = camera;
		this.controls = controls;
		this.pathTracingPass = pathTracingPass;
		this.targetModel = null;
		this.floorPlane = null;
		this.sceneScale = 1.0;

		// Optimization settings
		this.optimizeMeshes = DEFAULT_STATE.optimizeMeshes;
		this.meshoptEncoderLoaded = false;

		// Loaders registry
		this.loaders = {};

		// Event listeners
		this.eventListeners = {
			'load': [],
			'progress': [],
			'error': []
		};

		// Initialize
		this.initMeshoptEncoder();

	}

	/**
     * Add an event listener
     * @param {string} event - Event type ('load', 'progress', 'error')
     * @param {Function} callback - Callback function
     */
	addEventListener( event, callback ) {

		if ( this.eventListeners[ event ] ) {

			this.eventListeners[ event ].push( callback );

		}

	}

	/**
     * Remove an event listener
     * @param {string} event - Event type ('load', 'progress', 'error')
     * @param {Function} callback - Callback function to remove
     */
	removeEventListener( event, callback ) {

		if ( this.eventListeners[ event ] ) {

			const index = this.eventListeners[ event ].indexOf( callback );
			if ( index !== - 1 ) {

				this.eventListeners[ event ].splice( index, 1 );

			}

		}

	}

	/**
     * Dispatch an event
     * @param {string} event - Event type
     * @param {*} data - Event data
     */
	dispatchEvent( event, data ) {

		if ( this.eventListeners[ event ] ) {

			for ( const callback of this.eventListeners[ event ] ) {

				callback( data );

			}

		}

	}

	async initMeshoptEncoder() {

		this.meshoptEncoderLoaded = await loadMeshoptEncoder();

	}

	/**
     * Check if a file format is supported
     * @param {string} filename - Filename to check
     * @returns {Object|null} - Format info or null if not supported
     */
	getFileFormat( filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		return SUPPORTED_FORMATS[ extension ] || null;

	}

	/**
     * Load an asset from a file
     * @param {File} file - File object to load
     * @returns {Promise} - Promise that resolves when the asset is loaded
     */
	async loadAssetFromFile( file ) {

		const filename = file.name;
		const format = this.getFileFormat( filename );

		if ( ! format ) {

			throw new Error( `Unsupported file format: ${filename}` );

		}

		updateLoading( { isLoading: true, status: `Loading ${format.name}...`, progress: 5 } );

		try {

			switch ( format.type ) {

				case 'model':
					return await this.loadModelFromFile( file, filename );
				case 'environment':
				case 'image':
					return await this.loadEnvironmentFromFile( file, filename );
				case 'archive':
					return await this.loadArchiveFromFile( file, filename );
				default:
					throw new Error( `Unknown asset type: ${format.type}` );

			}

		} catch ( error ) {

			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 100 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a model from a file
     * @param {File} file - File object to load
     * @param {string} filename - Name of the file
     * @returns {Promise} - Promise that resolves when the model is loaded
     */
	async loadModelFromFile( file, filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();

		// Read the file as ArrayBuffer
		const arrayBuffer = await this.readFileAsArrayBuffer( file );

		switch ( extension ) {

			case 'glb':
			case 'gltf':
				return await this.loadGLBFromArrayBuffer( arrayBuffer, filename );
			case 'fbx':
				return await this.loadFBXFromArrayBuffer( arrayBuffer, filename );
			case 'obj':
				return await this.loadOBJFromFile( file, filename );
			case 'stl':
				return await this.loadSTLFromArrayBuffer( arrayBuffer, filename );
			case 'ply':
				return await this.loadPLYFromArrayBuffer( arrayBuffer, filename );
			case 'dae':
				return await this.loadColladaFromFile( file, filename );
			case '3mf':
				return await this.load3MFFromArrayBuffer( arrayBuffer, filename );
			case 'usdz':
				return await this.loadUSDZFromArrayBuffer( arrayBuffer, filename );
			default:
				throw new Error( `Support for ${extension} files is not yet implemented` );

		}

	}

	/**
     * Load an environment map from a file
     * @param {File} file - File object to load
     * @param {string} filename - Name of the file
     * @returns {Promise} - Promise that resolves when the environment is loaded
     */
	async loadEnvironmentFromFile( file, filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		const url = URL.createObjectURL( file );

		// Store file info in global context for reference
		window.uploadedEnvironmentFileInfo = {
			name: filename,
			type: file.type,
			size: file.size
		};

		try {

			const texture = await this.loadEnvironment( url );
			this.dispatchEvent( 'load', { type: 'environment', texture, filename } );
			return texture;

		} finally {

			// Clean up the blob URL
			URL.revokeObjectURL( url );

		}

	}

	/**
     * Load a ZIP archive
     * @param {File} file - ZIP file to load
     * @param {string} filename - Name of the file
     * @returns {Promise} - Promise that resolves when the archive contents are loaded
     */
	async loadArchiveFromFile( file, filename ) {

		// Import the fflate library for ZIP handling
		// const { unzipSync, strFromU8 } = await import( 'three/examples/jsm/libs/fflate.module.js' );

		try {

			const arrayBuffer = await this.readFileAsArrayBuffer( file );
			const zip = unzipSync( new Uint8Array( arrayBuffer ) );

			// Find all OBJ and MTL files in the archive
			const objFiles = [];
			const mtlFiles = [];

			// First pass: categorize files by extension
			for ( const path in zip ) {

				const lowerPath = path.toLowerCase();
				if ( lowerPath.endsWith( '.obj' ) ) {

					objFiles.push( { path, content: zip[ path ] } );

				} else if ( lowerPath.endsWith( '.mtl' ) ) {

					mtlFiles.push( { path, content: zip[ path ] } );

				}

			}

			// If we have both OBJ and MTL files, try to match them
			if ( objFiles.length > 0 && mtlFiles.length > 0 ) {

				console.log( `Found ${objFiles.length} OBJ files and ${mtlFiles.length} MTL files in ZIP` );

				// Try to find matching pairs (same base name)
				const matches = [];

				for ( const objFile of objFiles ) {

					// Get base name without extension and path
					const objBaseName = objFile.path.split( '/' ).pop().replace( /\.obj$/i, '' ).toLowerCase();

					// Look for MTL files with same base name
					for ( const mtlFile of mtlFiles ) {

						const mtlBaseName = mtlFile.path.split( '/' ).pop().replace( /\.mtl$/i, '' ).toLowerCase();

						if ( objBaseName === mtlBaseName || objBaseName.includes( mtlBaseName ) || mtlBaseName.includes( objBaseName ) ) {

							matches.push( { obj: objFile, mtl: mtlFile } );
							break; // Found a match for this OBJ

						}

					}

				}

				// If we found matching pairs, load the first one
				if ( matches.length > 0 ) {

					console.log( `Found ${matches.length} matching OBJ+MTL pairs` );
					return await this.loadOBJMTLPairFromZip( matches[ 0 ].obj, matches[ 0 ].mtl, zip, filename );

				}

				// If no matches by name but we have OBJ and MTL files, try the first of each
				if ( matches.length === 0 ) {

					console.log( 'No matching pairs by name, using first OBJ and MTL files' );
					return await this.loadOBJMTLPairFromZip( objFiles[ 0 ], mtlFiles[ 0 ], zip, filename );

				}

			}

			// Look for a main model file based on common conventions
			const mainModelFiles = [
				'scene.gltf', 'scene.glb', 'model.gltf', 'model.glb',
				'main.gltf', 'main.glb', 'asset.gltf', 'asset.glb'
			];

			for ( const mainFile of mainModelFiles ) {

				if ( zip[ mainFile ] ) {

					console.log( `Found main model file: ${mainFile}` );
					const extension = mainFile.split( '.' ).pop().toLowerCase();
					return await this.loadModelFromZipEntry( zip[ mainFile ], mainFile, extension, zip );

				}

			}

			// If no main model files, look for any supported model file
			for ( const path in zip ) {

				const extension = path.split( '.' ).pop().toLowerCase();
				if ( SUPPORTED_FORMATS[ extension ] && SUPPORTED_FORMATS[ extension ].type === 'model' ) {

					console.log( `Loading model file from ZIP: ${path}` );
					return await this.loadModelFromZipEntry( zip[ path ], path, extension, zip );

				}

			}

			throw new Error( 'No supported model files found in the ZIP archive' );

		} catch ( error ) {

			console.error( 'Error loading ZIP archive:', error );
			throw error;

		}

	}

	/**
 * Load a model from a ZIP archive entry
 * @param {Uint8Array} fileContent - ZIP file entry content
 * @param {string} filePath - Path in the ZIP archive
 * @param {string} extension - File extension
 * @param {Object} zipContents - The full ZIP archive contents
 * @returns {Promise} - Promise that resolves when the model is loaded
 */
	async loadModelFromZipEntry( fileContent, filePath, extension, zipContents ) {

		try {

			updateLoading( { isLoading: true, status: `Processing ${extension.toUpperCase()} from ZIP...`, progress: 20 } );

			// Create a blob from the file content
			const blob = new Blob( [ fileContent.buffer ], { type: 'application/octet-stream' } );
			const blobUrl = URL.createObjectURL( blob );

			let result;

			switch ( extension ) {

				case 'glb':
				case 'gltf':
					// For GLTF, we need to handle both binary and JSON formats
					if ( extension === 'gltf' ) {

						// Handle JSON GLTF by parsing it and resolving any referenced files from the ZIP
						const gltfContent = strFromU8( fileContent );
						const gltfJson = JSON.parse( gltfContent );

						// Create a manager to handle loading referenced files from the ZIP
						const manager = new LoadingManager();
						manager.setURLModifier( url => {

							// Remove any leading slashes or relative path indicators
							const normalizedUrl = url.replace( /^\.\/|^\//, '' );

							// Get the directory of the GLTF file
							const gltfDir = filePath.split( '/' ).slice( 0, - 1 ).join( '/' );
							const possiblePaths = [
								normalizedUrl,
								`${gltfDir}/${normalizedUrl}`,
								normalizedUrl.split( '/' ).pop()
							];

							// Try to find the file in the ZIP
							for ( const path of possiblePaths ) {

								if ( zipContents[ path ] ) {

									const fileBlob = new Blob( [ zipContents[ path ].buffer ], { type: 'application/octet-stream' } );
									return URL.createObjectURL( fileBlob );

								}

							}

							console.warn( `File not found in ZIP: ${url}` );
							return url;

						} );

						// Create and configure GLTFLoader with the manager
						const loader = await this.createGLTFLoader();
						loader.manager = manager;

						// Load the GLTF file from the blob URL
						result = await new Promise( ( resolve, reject ) => {

							loader.parse( gltfContent, '',
								gltf => resolve( gltf ),
								error => reject( error )
							);

						} );

					} else {

						// Handle binary GLB
						const arrayBuffer = fileContent.buffer;
						result = await this.loadGLBFromArrayBuffer( arrayBuffer, filePath );

					}

					break;

				case 'fbx':
					result = await this.loadFBXFromArrayBuffer( fileContent.buffer, filePath );
					break;

				case 'obj':
					// For OBJ, we need to look for an associated MTL file
					const objContent = strFromU8( fileContent );

					// Look for referenced MTL files in the OBJ content
					const mtlMatch = objContent.match( /mtllib\s+([^\s]+)/ );
					let materials = null;

					if ( mtlMatch && mtlMatch[ 1 ] ) {

						const mtlFilename = mtlMatch[ 1 ];

						// Get the directory of the OBJ file
						const objDir = filePath.split( '/' ).slice( 0, - 1 ).join( '/' );
						const possibleMtlPaths = [
							mtlFilename,
							`${objDir}/${mtlFilename}`,
							mtlFilename.split( '/' ).pop()
						];

						// Try to find the MTL file in the ZIP
						for ( const path of possibleMtlPaths ) {

							if ( zipContents[ path ] ) {

								const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
								const mtlContent = strFromU8( zipContents[ path ] );

								// Create a manager to handle loading textures from the ZIP
								const manager = new LoadingManager();
								manager.setURLModifier( url => {

									// Remove any leading slashes or relative path indicators
									const normalizedUrl = url.replace( /^\.\/|^\//, '' );

									// Try different possible locations for the texture
									const possiblePaths = [
										normalizedUrl,
										`${objDir}/${normalizedUrl}`,
										normalizedUrl.split( '/' ).pop()
									];

									// Try to find the texture in the ZIP
									for ( const texPath of possiblePaths ) {

										if ( zipContents[ texPath ] ) {

											const textureBlob = new Blob( [ zipContents[ texPath ].buffer ], { type: 'application/octet-stream' } );
											return URL.createObjectURL( textureBlob );

										}

									}

									console.warn( `Texture not found in ZIP: ${url}` );
									return url;

								} );

								// Parse MTL file
								const mtlLoader = new MTLLoader( manager );
								materials = mtlLoader.parse( mtlContent, objDir );
								materials.preload();
								break;

							}

						}

					}

					// Load OBJ with materials if found
					const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
					const objLoader = new OBJLoader();

					if ( materials ) {

						objLoader.setMaterials( materials );

					}

					const object = objLoader.parse( objContent );
					object.name = filePath;

					if ( this.targetModel ) {

						disposeObjectFromMemory( this.targetModel );

					}

					this.targetModel = object;
					await this.onModelLoad( this.targetModel );
					result = object;
					break;

				case 'stl':
					result = await this.loadSTLFromArrayBuffer( fileContent.buffer, filePath );
					break;

				case 'ply':
					result = await this.loadPLYFromArrayBuffer( fileContent.buffer, filePath );
					break;

				case 'dae':
					const daeContent = strFromU8( fileContent );

					// Create a file-like object for the Collada loader
					const daeFile = new File( [ new Blob( [ daeContent ] ) ], filePath );
					result = await this.loadColladaFromFile( daeFile, filePath );
					break;

				case '3mf':
					result = await this.load3MFFromArrayBuffer( fileContent.buffer, filePath );
					break;

				case 'usdz':
					result = await this.loadUSDZFromArrayBuffer( fileContent.buffer, filePath );
					break;

				default:
					throw new Error( `Support for ${extension} files is not yet implemented` );

			}

			// Clean up the blob URL
			URL.revokeObjectURL( blobUrl );

			this.dispatchEvent( 'load', {
				type: 'model',
				model: this.targetModel,
				filename: `${filePath} (from ZIP)`
			} );

			return result;

		} catch ( error ) {

			console.error( `Error loading ${extension} from ZIP:`, error );
			this.dispatchEvent( 'error', { message: error.message, filename: filePath } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a model from a ZIP archive entry
     * @param {Object} file - ZIP file entry
     * @param {string} path - Path in the ZIP archive
     * @param {string} extension - File extension
     * @param {Object} zip - The full ZIP archive contents
     * @returns {Promise} - Promise that resolves when the model is loaded
     */
	async loadOBJMTLPairFromZip( objFile, mtlFile, zip, filename ) {

		const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		// const { strFromU8 } = await import( 'three/examples/jsm/libs/fflate.module.js' );

		// Keep track of created blob URLs for cleanup
		const createdUrls = [];

		// Create manager to handle textures
		const manager = new LoadingManager();

		// Log all files in the ZIP for debugging
		console.log( "Files in ZIP:", Object.keys( zip ) );

		// Extract directories for easier searching
		const objDir = objFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );
		const mtlDir = mtlFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );

		manager.setURLModifier( function ( url ) {

			// Remove any URL parameters or anchors
			const cleanUrl = url.split( '?' )[ 0 ].split( '#' )[ 0 ];

			// Log the requested texture URL
			console.log( `Trying to resolve texture: ${cleanUrl}` );

			// Clean up the URL by removing any problematic components
			// 1. Remove leading "./" or "/"
			let normalizedUrl = cleanUrl.replace( /^\.\/|^\//, '' );

			// 2. Handle case where the MTL filename is incorrectly prepended
			// Check if URL starts with the MTL filename
			const mtlFilename = mtlFile.path.split( '/' ).pop();
			if ( normalizedUrl.startsWith( mtlFilename ) ) {

				normalizedUrl = normalizedUrl.substring( mtlFilename.length );
				// Remove any leading slashes or dots
				normalizedUrl = normalizedUrl.replace( /^\.\/|^\/|^\./, '' );

			}

			// Array of possible locations to try in order
			const possibleLocations = [
				normalizedUrl, // As is
				`${objDir}/${normalizedUrl}`, // In OBJ directory
				`${mtlDir}/${normalizedUrl}`, // In MTL directory
				`textures/${normalizedUrl}`, // In a textures subdirectory
				`texture/${normalizedUrl}`, // Alternate textures directory
				`materials/${normalizedUrl}`, // In a materials directory
				normalizedUrl.split( '/' ).pop() // Just the filename anywhere
			];

			// Try each possible location
			for ( const location of possibleLocations ) {

				if ( zip[ location ] ) {

					console.log( `Found texture at: ${location}` );
					const blob = new Blob( [ zip[ location ].buffer ], { type: 'application/octet-stream' } );
					const blobUrl = URL.createObjectURL( blob );
					createdUrls.push( blobUrl );
					return blobUrl;

				}

			}

			// If still not found, try more aggressive search - look for any file that ends with the texture filename
			const textureFilename = normalizedUrl.split( '/' ).pop();
			for ( const zipPath in zip ) {

				if ( zipPath.endsWith( textureFilename ) ) {

					console.log( `Found texture with fuzzy match at: ${zipPath}` );
					const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
					const blobUrl = URL.createObjectURL( blob );
					createdUrls.push( blobUrl );
					return blobUrl;

				}

			}

			// Last resort: try partial matches for the filename
			if ( textureFilename && textureFilename.length > 5 ) {

				for ( const zipPath in zip ) {

					const zipFilename = zipPath.split( '/' ).pop();
					// Check if the texture filename is contained within any ZIP file name
					if ( zipFilename.includes( textureFilename ) || textureFilename.includes( zipFilename ) ) {

						console.log( `Found texture with partial match: ${zipPath}` );
						const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
						const blobUrl = URL.createObjectURL( blob );
						createdUrls.push( blobUrl );
						return blobUrl;

					}

				}

			}

			// If still not found, log the failure and return the original URL
			console.warn( `Texture not found in ZIP: ${cleanUrl} (normalized: ${normalizedUrl})` );
			return url;

		} );

		// Load the MTL file manually to fix any path issues before passing to the MTLLoader
		const mtlContent = strFromU8( mtlFile.content );

		// Fix common issues in MTL files
		let fixedMtlContent = mtlContent
		// Fix cases where texture paths have the MTL filename prepended
			.replace( new RegExp( `${mtlFile.path.split( '/' ).pop()}\\s+`, 'g' ), ' ' )
		// Make sure there's whitespace between directives and paths
			.replace( /([a-zA-Z_]+)([\\/])/g, '$1 $2' );

		// Parse MTL file
		const materials = new MTLLoader( manager ).parse( fixedMtlContent, mtlDir );
		materials.preload();

		// Parse OBJ file with materials
		const objLoader = new OBJLoader( manager );
		objLoader.setMaterials( materials );
		const objContent = strFromU8( objFile.content );
		const object = objLoader.parse( objContent );

		if ( this.targetModel ) {

			disposeObjectFromMemory( this.targetModel );

		}

		this.targetModel = object;
		await this.onModelLoad( this.targetModel );

		// Clean up blob URLs
		createdUrls.forEach( url => URL.revokeObjectURL( url ) );

		this.dispatchEvent( 'load', {
			type: 'model',
			model: object,
			filename: `${objFile.path} (from ${filename})`
		} );

		return object;

	}

	/**
     * Load OBJ+MTL from a ZIP archive
     * @param {Object} zip - ZIP archive contents
     * @param {string} filename - ZIP filename
     * @returns {Promise} - Promise that resolves when the model is loaded
     */
	async loadOBJMTLFromZip( zip, filename ) {

		const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		// const { strFromU8 } = await import( 'three/examples/jsm/libs/fflate.module.js' );

		// Create manager to handle textures
		const manager = new LoadingManager();
		manager.setURLModifier( function ( url ) {

			url = url.replace( /^(\.?\/)/, '' ); // remove './'
			const zipFile = zip[ url ];

			if ( zipFile ) {

				console.log( 'Loading texture from ZIP:', url );
				const blob = new Blob( [ zipFile.buffer ], { type: 'application/octet-stream' } );
				return URL.createObjectURL( blob );

			}

			return url;

		} );

		// Parse MTL file
		const materials = new MTLLoader( manager ).parse( strFromU8( zip[ 'materials.mtl' ] ) );

		// Parse OBJ file with materials
		const objLoader = new OBJLoader( manager );
		objLoader.setMaterials( materials );
		const object = objLoader.parse( strFromU8( zip[ 'model.obj' ] ) );

		if ( this.targetModel ) {

			disposeObjectFromMemory( this.targetModel );

		}

		this.targetModel = object;
		await this.onModelLoad( this.targetModel );
		this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
		return object;

	}

	/**
     * Read a file as ArrayBuffer
     * @param {File} file - File to read
     * @returns {Promise<ArrayBuffer>} - Promise that resolves with the ArrayBuffer
     */
	readFileAsArrayBuffer( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsArrayBuffer( file );

		} );

	}

	/**
     * Read a file as text
     * @param {File} file - File to read
     * @returns {Promise<string>} - Promise that resolves with the text content
     */
	readFileAsText( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsText( file );

		} );

	}

	// ---- Model Loading Methods ----

	async createGLTFLoader() {

		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderConfig( { type: 'js' } );
		dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/v1/decoders/' );

		const loader = new GLTFLoader();
		loader.setDRACOLoader( dracoLoader );

		// Set up MeshoptDecoder for decompression
		loader.setMeshoptDecoder( MeshoptDecoder );

		return loader;

	}

	async loadExampleModels( index ) {

		const modelUrl = `${MODEL_FILES[ index ].url}`;
		return await this.loadModel( modelUrl );

	}

	async loadModel( modelUrl ) {

		let loader = null;

		try {

			loader = await this.createGLTFLoader();
			updateLoading( { status: "Loading Model...", progress: 5 } );
			const data = await loader.loadAsync( modelUrl );
			updateLoading( { status: "Processing Data...", progress: 30 } );

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			// Apply mesh optimizations if enabled
			if ( this.optimizeMeshes ) {

				updateLoading( { status: "Optimizing Mesh...", progress: 40 } );
				await this.optimizeModel( data.scene );

			}

			this.targetModel = data.scene;

			await this.onModelLoad( this.targetModel );
			this.dispatchEvent( 'load', { type: 'model', model: data.scene, filename: modelUrl.split( '/' ).pop() } );
			return data;

		} catch ( error ) {

			console.error( "Error loading model:", error );
			this.dispatchEvent( 'error', { message: error.message, filename: modelUrl } );
			throw error;

		} finally {

			loader?.dracoLoader && loader.dracoLoader.dispose();
			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a GLB/GLTF model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model data
     */
	async loadGLBFromArrayBuffer( arrayBuffer, filename = 'model.glb' ) {

		try {

			const loader = await this.createGLTFLoader();
			updateLoading( { isLoading: true, status: "Processing GLB Data...", progress: 10 } );

			const data = await new Promise( ( resolve, reject ) =>
				loader.parse( arrayBuffer, '', gltf => resolve( gltf ), error => reject( error ) )
			);

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			// Apply mesh optimizations if enabled
			if ( this.optimizeMeshes ) {

				updateLoading( { status: "Optimizing Mesh...", progress: 40 } );
				await this.optimizeModel( data.scene );

			}

			this.targetModel = data.scene;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );
			loader.dracoLoader && loader.dracoLoader.dispose();

			this.dispatchEvent( 'load', { type: 'model', model: data.scene, filename } );
			return data;

		} catch ( error ) {

			console.error( 'Error loading GLB:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load an FBX model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadFBXFromArrayBuffer( arrayBuffer, filename = 'model.fbx' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing FBX Data...", progress: 10 } );

			// Dynamically import the FBX loader
			const { FBXLoader } = await import( 'three/examples/jsm/loaders/FBXLoader.js' );

			const loader = new FBXLoader();
			const object = loader.parse( arrayBuffer );

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading FBX:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load an OBJ model from a File
     * @param {File} file - The OBJ file
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadOBJFromFile( file, filename = 'model.obj' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing OBJ Data...", progress: 10 } );

			// Dynamically import the OBJ loader
			const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );

			// Read the file as text
			const contents = await this.readFileAsText( file );

			const loader = new OBJLoader();
			const object = loader.parse( contents );
			object.name = filename;

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading OBJ:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load an STL model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadSTLFromArrayBuffer( arrayBuffer, filename = 'model.stl' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing STL Data...", progress: 10 } );

			// Dynamically import the STL loader
			const { STLLoader } = await import( 'three/examples/jsm/loaders/STLLoader.js' );

			const loader = new STLLoader();
			const geometry = loader.parse( arrayBuffer );

			// Create a mesh with the geometry
			const material = new MeshStandardMaterial();
			const mesh = new Mesh( geometry, material );
			mesh.name = filename;

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = mesh;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: mesh, filename } );
			return mesh;

		} catch ( error ) {

			console.error( 'Error loading STL:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a PLY model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadPLYFromArrayBuffer( arrayBuffer, filename = 'model.ply' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing PLY Data...", progress: 10 } );

			// Dynamically import the PLY loader
			const { PLYLoader } = await import( 'three/examples/jsm/loaders/PLYLoader.js' );

			const loader = new PLYLoader();
			const geometry = loader.parse( arrayBuffer );

			let object;

			if ( geometry.index !== null ) {

				// Create a mesh with the geometry
				const material = new MeshStandardMaterial();
				object = new Mesh( geometry, material );

			} else {

				// Create points for point clouds
				const material = new PointsMaterial( { size: 0.01 } );
				material.vertexColors = geometry.hasAttribute( 'color' );
				object = new Points( geometry, material );

			}

			object.name = filename;

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading PLY:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a Collada (DAE) model from a File
     * @param {File} file - The DAE file
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadColladaFromFile( file, filename = 'model.dae' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing Collada Data...", progress: 10 } );

			// Dynamically import the Collada loader
			const { ColladaLoader } = await import( 'three/examples/jsm/loaders/ColladaLoader.js' );

			// Read the file as text
			const contents = await this.readFileAsText( file );

			const loader = new ColladaLoader();
			const collada = loader.parse( contents );
			collada.scene.name = filename;

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = collada.scene;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: collada.scene, filename } );
			return collada;

		} catch ( error ) {

			console.error( 'Error loading Collada:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a 3MF model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async load3MFFromArrayBuffer( arrayBuffer, filename = 'model.3mf' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing 3MF Data...", progress: 10 } );

			// Dynamically import the 3MF loader
			const { ThreeMFLoader } = await import( 'three/examples/jsm/loaders/3MFLoader.js' );

			const loader = new ThreeMFLoader();
			const object = loader.parse( arrayBuffer );

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading 3MF:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	/**
     * Load a USDZ model from an ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - The binary data
     * @param {string} filename - Optional filename for reference
     * @returns {Promise<Object>} - The loaded model
     */
	async loadUSDZFromArrayBuffer( arrayBuffer, filename = 'model.usdz' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing USDZ Data...", progress: 10 } );

			// Dynamically import the USDZ loader
			const { USDZLoader } = await import( 'three/examples/jsm/loaders/USDZLoader.js' );

			const loader = new USDZLoader();
			const object = loader.parse( arrayBuffer );
			object.name = filename;

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

			}

			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( 'load', { type: 'model', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading USDZ:', error );
			this.dispatchEvent( 'error', { message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	// ---- Environment Loading Methods ----

	async loadEnvironment( envUrl ) {

		try {

			let texture;

			// Check if it's a blob URL
			if ( envUrl.startsWith( 'blob:' ) ) {

				// For blob URLs, we need to fetch the blob to determine its type
				const response = await fetch( envUrl );
				const blob = await response.blob();

				// Determine file type from mime type or filename if available in the original URL
				let extension;
				if ( blob.type === 'image/x-exr' || blob.type.includes( 'exr' ) ) {

					extension = 'exr';

				} else if ( blob.type === 'image/vnd.radiance' || blob.type.includes( 'hdr' ) ) {

					extension = 'hdr';

				} else {

					// Try to get extension from original file name
					const fileNameMatch = envUrl.split( '/' ).pop();
					if ( fileNameMatch ) {

						const extMatch = fileNameMatch.match( /\.([^.]+)$/ );
						if ( extMatch ) {

							extension = extMatch[ 1 ].toLowerCase();

						}

					}

				}

				// If we still couldn't determine the extension, check stored environment data
				if ( ! extension && window.uploadedEnvironmentFileInfo ) {

					extension = window.uploadedEnvironmentFileInfo.name.split( '.' ).pop().toLowerCase();

				}

				console.log( `Determined file extension for blob: ${extension}` );

				// Create a new blob URL for the file
				const blobUrl = URL.createObjectURL( blob );

				try {

					if ( extension === 'hdr' || extension === 'exr' ) {

						const loader = extension === 'hdr' ? new RGBELoader() : new EXRLoader();
						loader.setDataType( FloatType );
						texture = await loader.loadAsync( blobUrl );

					} else {

						// If we can't determine the extension, try loading as a regular texture
						const loader = new TextureLoader();
						texture = await loader.loadAsync( blobUrl );

					}

				} finally {

					// Always revoke the blob URL to avoid memory leaks
					URL.revokeObjectURL( blobUrl );

				}

			} else {

				// Regular URL handling
				const extension = envUrl.split( '.' ).pop().toLowerCase();

				if ( extension === 'hdr' || extension === 'exr' ) {

					const loader = extension === 'hdr' ? new RGBELoader() : new EXRLoader();
					loader.setDataType( FloatType );
					texture = await loader.loadAsync( envUrl );

				} else {

					const loader = new TextureLoader();
					texture = await loader.loadAsync( envUrl );

				}

			}

			texture.mapping = EquirectangularReflectionMapping;
			texture.minFilter = LinearFilter;
			texture.magFilter = LinearFilter;

			this.scene.background = texture;
			this.scene.environment = texture;

			if ( this.pathTracingPass ) {

				this.pathTracingPass.material.uniforms.environmentIntensity.value = this.scene.environmentIntensity;
				this.pathTracingPass.material.uniforms.backgroundIntensity.value = this.scene.backgroundIntensity;
				this.pathTracingPass.material.uniforms.environment.value = texture;

				this.pathTracingPass.setEnvironmentMap( texture );
				this.pathTracingPass.reset();

			}

			this.dispatchEvent( 'load', { type: 'environment', texture } );
			return texture;

		} catch ( error ) {

			console.error( "Error loading environment:", error );
			this.dispatchEvent( 'error', { message: error.message, filename: envUrl } );
			throw error;

		}

	}

	// ---- Model Processing and Optimization Methods ----

	async onModelLoad( model ) {

		// Center model and adjust camera
		const box = new Box3().setFromObject( model );
		const center = box.getCenter( new Vector3() );
		const size = box.getSize( new Vector3() );

		this.controls.target.copy( center );

		const maxDim = Math.max( size.x, size.y, size.z );
		const fov = this.camera.fov * ( Math.PI / 180 );
		const cameraDistance = Math.abs( maxDim / Math.sin( fov / 2 ) / 2 );

		// Set up 2/3 angle projection (approximately 120° between axes)
		// Calculate camera position for isometric-like view
		const angle = Math.PI / 6; // 30 degrees
		const pos = new Vector3(
			Math.cos( angle ) * cameraDistance,
			cameraDistance / Math.sqrt( 2 ), // Elevation
			Math.sin( angle ) * cameraDistance
		);

		this.camera.position.copy( pos.add( center ) );
		this.camera.lookAt( center );

		this.camera.near = maxDim / 100;
		this.camera.far = maxDim * 100;
		this.camera.updateProjectionMatrix();
		this.controls.maxDistance = cameraDistance * 10;
		this.controls.saveState();

		this.controls.update();

		// Adjust floor plane
		if ( this.floorPlane ) {

			const floorY = box.min.y;
			this.floorPlane.position.y = floorY;
			this.floorPlane.rotation.x = - Math.PI / 2;
			this.floorPlane.scale.setScalar( maxDim * 5 );

		}

		// Process model for lights and multi-material meshes
		model.traverse( ( object ) => {

			const userData = object.userData;
			if ( object.name.startsWith( 'RectAreaLightPlaceholder' ) && userData.name && userData.name.includes( "ceilingLight" ) ) {

				if ( userData.type === 'RectAreaLight' ) {

					const light = new RectAreaLight(
						new Color( ...userData.color ),
						userData.intensity,
						userData.width,
						userData.height
					);

					// flip light in x axis by 180 degrees
					light.rotation.x = Math.PI;
					light.position.z = - 2;
					light.name = userData.name;
					object.add( light );

				}

			}

			// Handle multi-material meshes
			if ( object.isMesh && Array.isArray( object.material ) ) {

				console.log( 'Found multi-material mesh:', object.name );

				// Create separate meshes for each material
				const group = createMeshesFromMultiMaterialMesh( object );

				// replace the group to the object's parent
				if ( object.parent ) {

					object.parent.add( group );

					// Remove the original multi-material mesh
					object.parent.remove( object );

				}

			}

		} );

		this.scene.add( model );

		// Calculate scene scale factor based on model size
		// We'll consider a "standard" model size to be 1 meter
		const sceneScale = maxDim;

		// Rebuild path tracing
		if ( this.pathTracingPass ) {

			await this.pathTracingPass.build( this.scene );

			// Store scene scale for use in camera settings
			this.sceneScale = sceneScale;

			// Update camera parameters scaled to scene size
			this.camera.near = maxDim / 100;
			this.camera.far = maxDim * 100;

			// Scale the default focus distance to scene size
			this.pathTracingPass.material.uniforms.focusDistance.value =
                DEFAULT_STATE.focusDistance * ( sceneScale / 1.0 );

			// Update aperture scale factor in the path tracer
			this.pathTracingPass.material.uniforms.apertureScale.value = sceneScale;

			this.pathTracingPass.reset();

		}

		// Notify that the model has been loaded and processed
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		return {
			center,
			size,
			maxDim,
			sceneScale
		};

	}

	/**
     * Optimize a loaded model using MeshoptEncoder
     * @param {Object3D} model - The loaded model scene
     */
	async optimizeModel( model ) {

		if ( ! this.meshoptEncoderLoaded ) {

			console.log( 'MeshoptEncoder not loaded, skipping optimization' );
			return;

		}

		try {

			// Process each mesh in the model
			model.traverse( object => {

				if ( object.isMesh && object.geometry ) {

					this.optimizeMeshGeometry( object.geometry );

				}

			} );

			console.log( 'Model optimization complete' );

		} catch ( error ) {

			console.error( 'Error during mesh optimization:', error );

		}

	}

	/**
     * Optimize a single mesh geometry using MeshoptEncoder
     * @param {BufferGeometry} geometry - The geometry to optimize
     */
	optimizeMeshGeometry( geometry ) {

		try {

			// Make sure we have index and position attributes
			if ( ! geometry.index || ! geometry.attributes.position ) {

				return;

			}

			// Get the original indices
			const indices = Array.from( geometry.index.array );
			const triangles = true; // Assuming we're working with triangle meshes
			const optsize = true; // Optimize for size (true) or performance (false)

			// Use MeshoptEncoder to reorder the mesh for better compression and GPU performance
			const [ remap, unique ] = MeshoptEncoder.reorderMesh( new Uint32Array( indices ), triangles, optsize );

			if ( ! remap || ! unique ) {

				console.warn( 'MeshoptEncoder.reorderMesh failed to produce valid output' );
				return;

			}

			// Update the geometry with the optimized index buffer
			const remappedIndices = new Uint32Array( indices.length );
			for ( let i = 0; i < indices.length; i ++ ) {

				remappedIndices[ i ] = remap[ indices[ i ] ];

			}

			// Create a new index buffer with the appropriate type
			let newIndexBuffer;
			if ( remappedIndices.every( idx => idx < 65536 ) ) {

				newIndexBuffer = new Uint16Array( remappedIndices );

			} else {

				newIndexBuffer = remappedIndices;

			}

			// Update the geometry's index buffer
			geometry.setIndex( new BufferAttribute( newIndexBuffer, 1 ) );

			// Optimize vertex attributes for locality
			this.optimizeAttributes( geometry, remap, unique );

			console.log( `Optimized geometry: unique vertices ${unique}` );

		} catch ( error ) {

			console.error( 'Error optimizing geometry:', error );

		}

	}

	/**
     * Optimize vertex attributes based on the remapping from MeshoptEncoder
     * @param {BufferGeometry} geometry - The geometry to optimize
     * @param {Uint32Array} remap - The remap array from MeshoptEncoder
     * @param {number} unique - The number of unique vertices
     */
	optimizeAttributes( geometry, remap, unique ) {

		// Process each attribute in the geometry
		Object.keys( geometry.attributes ).forEach( name => {

			const attribute = geometry.attributes[ name ];
			const itemSize = attribute.itemSize;
			const count = attribute.count;

			// Create a new optimized attribute
			const newArray = new Float32Array( unique * itemSize );

			// Remap the attribute data
			for ( let i = 0; i < count; i ++ ) {

				const newIndex = remap[ i ];
				if ( newIndex !== 0xffffffff ) { // Skip unused vertices

					for ( let j = 0; j < itemSize; j ++ ) {

						newArray[ newIndex * itemSize + j ] = attribute.array[ i * itemSize + j ];

					}

				}

			}

			// Update the geometry attribute
			geometry.setAttribute( name, new BufferAttribute( newArray, itemSize ) );

		} );

	}

	// ---- Utility Methods ----

	setFloorPlane( floorPlane ) {

		this.floorPlane = floorPlane;

	}

	/**
     * Enable or disable mesh optimization
     * @param {boolean} enabled - Whether to optimize meshes during loading
     */
	setOptimizeMeshes( enabled ) {

		this.optimizeMeshes = enabled;

		// If enabling, make sure MeshoptEncoder is loaded
		if ( enabled && ! this.meshoptEncoderLoaded ) {

			this.initMeshoptEncoder();

		}

	}

	/**
     * Get current mesh optimization status
     * @returns {Object} - Status object with optimization flags
     */
	getOptimizationStatus() {

		return {
			optimizeMeshes: this.optimizeMeshes,
			meshoptEncoderLoaded: this.meshoptEncoderLoaded,
		};

	}

	/**
     * Get the current scene scale
     * @returns {number} - The scene scale
     */
	getSceneScale() {

		return this.sceneScale;

	}

	/**
     * Get the current target model
     * @returns {Object3D} - The target model
     */
	getTargetModel() {

		return this.targetModel;

	}

	/**
     * Get a list of all supported file formats
     * @param {string} [type] - Filter by type (model, environment, etc.)
     * @returns {Object} - Object with supported formats
     */
	getSupportedFormats( type = null ) {

		if ( type ) {

			const filtered = {};
			for ( const [ ext, info ] of Object.entries( SUPPORTED_FORMATS ) ) {

				if ( info.type === type ) {

					filtered[ ext ] = info;

				}

			}

			return filtered;

		}

		return SUPPORTED_FORMATS;

	}

}

export default AssetLoader;
