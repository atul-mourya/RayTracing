import { Box3, Vector3, RectAreaLight, Color, FloatType, LinearFilter, EquirectangularReflectionMapping, LinearMipmapLinearFilter,
	TextureLoader, BufferAttribute, Mesh, MeshStandardMaterial, Points, PointsMaterial, LoadingManager, EventDispatcher
} from 'three';
import { GLTFLoader, HDRLoader, DRACOLoader, EXRLoader } from 'three/examples/jsm/Addons';
import { createMeshesFromMultiMaterialMesh } from 'three/addons/utils/SceneUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { disposeObjectFromMemory, updateLoading, resetLoading } from './utils';
import { MODEL_FILES, DEFAULT_STATE } from '@/Constants';

// Define supported file formats
const SUPPORTED_FORMATS = {
	'glb': { type: 'model', name: 'GLB (GLTF Binary)' }, 'gltf': { type: 'model', name: 'GLTF' },
	'fbx': { type: 'model', name: 'FBX' }, 'obj': { type: 'model', name: 'OBJ' },
	'stl': { type: 'model', name: 'STL' }, 'ply': { type: 'model', name: 'PLY (Polygon File Format)' },
	'dae': { type: 'model', name: 'Collada' }, '3mf': { type: 'model', name: '3D Manufacturing Format' },
	'usdz': { type: 'model', name: 'Universal Scene Description' },
	'hdr': { type: 'environment', name: 'HDR (High Dynamic Range)' }, 'exr': { type: 'environment', name: 'EXR (OpenEXR)' },
	'png': { type: 'image', name: 'PNG' }, 'jpg': { type: 'image', name: 'JPEG' },
	'jpeg': { type: 'image', name: 'JPEG' }, 'webp': { type: 'image', name: 'WebP' },
	'zip': { type: 'archive', name: 'ZIP Archive' }
};

// Import MeshoptEncoder for mesh optimization
let MeshoptEncoder;

// Load the MeshoptEncoder dynamically
async function loadMeshoptEncoder() {

	try {

		const module = await import( 'meshoptimizer' );
		MeshoptEncoder = module.MeshoptEncoder;
		await MeshoptEncoder.ready;
		console.log( 'MeshoptEncoder loaded and ready' );
		return true;

	} catch ( error ) {

		console.warn( 'Failed to load MeshoptEncoder:', error );
		return false;

	}

}

/**
 * AssetLoader class - handles loading of 3D models, environment maps, and archives
 */
class AssetLoader extends EventDispatcher {

	constructor( scene, camera, controls, pathTracingPass ) {

		super();
		this.scene = scene;
		this.camera = camera;
		this.controls = controls;
		this.pathTracingPass = pathTracingPass;
		this.targetModel = null;
		this.floorPlane = null;
		this.sceneScale = 1.0;
		this.loaderCache = {};
		this.optimizeMeshes = DEFAULT_STATE.optimizeMeshes;
		this.meshoptEncoderLoaded = false;
		this.initMeshoptEncoder();

	}

	async initMeshoptEncoder() {

		this.meshoptEncoderLoaded = await loadMeshoptEncoder();

	}

	// File utilities
	getFileFormat( filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		return SUPPORTED_FORMATS[ extension ] || null;

	}

	readFileAsArrayBuffer( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsArrayBuffer( file );

		} );

	}

	readFileAsText( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsText( file );

		} );

	}

	// Asset loading methods
	async loadAssetFromFile( file ) {

		const filename = file.name;
		const format = this.getFileFormat( filename );
		if ( ! format ) throw new Error( `Unsupported file format: ${filename}` );

		updateLoading( { isLoading: true, status: `Loading ${format.name}...`, progress: 5 } );
		try {

			let result;
			switch ( format.type ) {

				case 'model': result = await this.loadModelFromFile( file, filename ); break;
				case 'environment':
				case 'image': result = await this.loadEnvironmentFromFile( file, filename ); break;
				case 'archive': result = await this.loadArchiveFromFile( file, filename ); break;
				default: throw new Error( `Unknown asset type: ${format.type}` );

			}

			return result;

		} catch ( error ) {

			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 100 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadModelFromFile( file, filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		const arrayBuffer = await this.readFileAsArrayBuffer( file );

		switch ( extension ) {

			case 'glb':
			case 'gltf': return await this.loadGLBFromArrayBuffer( arrayBuffer, filename );
			case 'fbx': return await this.loadFBXFromArrayBuffer( arrayBuffer, filename );
			case 'obj': return await this.loadOBJFromFile( file, filename );
			case 'stl': return await this.loadSTLFromArrayBuffer( arrayBuffer, filename );
			case 'ply': return await this.loadPLYFromArrayBuffer( arrayBuffer, filename );
			case 'dae': return await this.loadColladaFromFile( file, filename );
			case '3mf': return await this.load3MFFromArrayBuffer( arrayBuffer, filename );
			case 'usdz': return await this.loadUSDZFromArrayBuffer( arrayBuffer, filename );
			default: throw new Error( `Support for ${extension} files is not yet implemented` );

		}

	}

	async loadEnvironmentFromFile( file, filename ) {

		const url = URL.createObjectURL( file );
		window.uploadedEnvironmentFileInfo = { name: filename, type: file.type, size: file.size };
		try {

			const texture = await this.loadEnvironment( url );
			this.dispatchEvent( { type: 'load', texture, filename } );
			return texture;

		} finally {

			URL.revokeObjectURL( url );

		}

	}

	async loadEnvironment( envUrl ) {

		try {

			let texture;
			if ( envUrl.startsWith( 'blob:' ) ) {

				texture = await this.loadEnvironmentFromBlob( envUrl );

			} else {

				const extension = envUrl.split( '.' ).pop().toLowerCase();
				texture = await this.loadEnvironmentByExtension( envUrl, extension );

			}

			texture.generateMipmaps = true;
			// texture.minFilter = LinearMipmapLinearFilter;
			// texture.magFilter = LinearFilter;

			this.applyEnvironmentToScene( texture );
			this.dispatchEvent( { type: 'load', texture } );
			return texture;

		} catch ( error ) {

			console.error( "Error loading environment:", error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: envUrl } );
			throw error;

		}

	}

	async loadEnvironmentFromBlob( blobUrl ) {

		const response = await fetch( blobUrl );
		const blob = await response.blob();
		const extension = this.determineEnvironmentExtension( blob, blobUrl );
		const newBlobUrl = URL.createObjectURL( blob );
		try {

			return await this.loadEnvironmentByExtension( newBlobUrl, extension );

		} finally {

			URL.revokeObjectURL( newBlobUrl );

		}

	}

	determineEnvironmentExtension( blob, url ) {

		let extension;
		if ( blob.type === 'image/x-exr' || blob.type.includes( 'exr' ) ) {

			extension = 'exr';

		} else if ( blob.type === 'image/vnd.radiance' || blob.type.includes( 'hdr' ) ) {

			extension = 'hdr';

		} else {

			const fileNameMatch = url.split( '/' ).pop();
			if ( fileNameMatch ) {

				const extMatch = fileNameMatch.match( /\.([^.]+)$/ );
				if ( extMatch ) extension = extMatch[ 1 ].toLowerCase();

			}

		}

		if ( ! extension && window.uploadedEnvironmentFileInfo ) {

			extension = window.uploadedEnvironmentFileInfo.name.split( '.' ).pop().toLowerCase();

		}

		return extension;

	}

	async loadEnvironmentByExtension( url, extension ) {

		let texture;
		if ( extension === 'hdr' || extension === 'exr' ) {

			const loader = extension === 'hdr'
				? ( this.loaderCache.hdr || ( this.loaderCache.hdr = new HDRLoader().setDataType( FloatType ) ) )
				: ( this.loaderCache.exr || ( this.loaderCache.exr = new EXRLoader().setDataType( FloatType ) ) );
			texture = await loader.loadAsync( url );

		} else {

			if ( ! this.loaderCache.texture ) this.loaderCache.texture = new TextureLoader();
			texture = await this.loaderCache.texture.loadAsync( url );

		}

		texture.mapping = EquirectangularReflectionMapping;
		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		return texture;

	}

	applyEnvironmentToScene( texture ) {

		this.scene.background = texture;
		this.scene.environment = texture;
		if ( this.pathTracingPass ) {

			this.pathTracingPass.material.uniforms.environmentIntensity.value = this.scene.environmentIntensity;
			this.pathTracingPass.material.uniforms.backgroundIntensity.value = this.scene.backgroundIntensity;
			this.pathTracingPass.material.uniforms.environment.value = texture;
			this.pathTracingPass.setEnvironmentMap( texture );
			this.pathTracingPass.reset();

		}

	}

	// Archive handling
	async loadArchiveFromFile( file, filename ) {

		try {

			const arrayBuffer = await this.readFileAsArrayBuffer( file );
			const zip = unzipSync( new Uint8Array( arrayBuffer ) );
			const result = await this.processObjMtlPairsInZip( zip, filename );
			if ( result ) return result;
			return await this.findAndLoadModelFromZip( zip, filename );

		} catch ( error ) {

			console.error( 'Error loading ZIP archive:', error );
			throw error;

		}

	}

	async processObjMtlPairsInZip( zip, filename ) {

		const objFiles = [];
		const mtlFiles = [];

		for ( const path in zip ) {

			const lowerPath = path.toLowerCase();
			if ( lowerPath.endsWith( '.obj' ) ) objFiles.push( { path, content: zip[ path ] } );
			else if ( lowerPath.endsWith( '.mtl' ) ) mtlFiles.push( { path, content: zip[ path ] } );

		}

		if ( objFiles.length > 0 && mtlFiles.length > 0 ) {

			console.log( `Found ${objFiles.length} OBJ files and ${mtlFiles.length} MTL files in ZIP` );
			const matches = this.findMatchingObjMtlPairs( objFiles, mtlFiles );

			if ( matches.length > 0 ) {

				console.log( `Found ${matches.length} matching OBJ+MTL pairs` );
				return await this.loadOBJMTLPairFromZip( matches[ 0 ].obj, matches[ 0 ].mtl, zip, filename );

			}

			if ( matches.length === 0 ) {

				console.log( 'No matching pairs by name, using first OBJ and MTL files' );
				return await this.loadOBJMTLPairFromZip( objFiles[ 0 ], mtlFiles[ 0 ], zip, filename );

			}

		}

		return null;

	}

	findMatchingObjMtlPairs( objFiles, mtlFiles ) {

		const matches = [];
		for ( const objFile of objFiles ) {

			const objBaseName = objFile.path.split( '/' ).pop().replace( /\.obj$/i, '' ).toLowerCase();

			for ( const mtlFile of mtlFiles ) {

				const mtlBaseName = mtlFile.path.split( '/' ).pop().replace( /\.mtl$/i, '' ).toLowerCase();
				if ( objBaseName === mtlBaseName || objBaseName.includes( mtlBaseName ) || mtlBaseName.includes( objBaseName ) ) {

					matches.push( { obj: objFile, mtl: mtlFile } );
					break;

				}

			}

		}

		return matches;

	}

	async findAndLoadModelFromZip( zip, filename ) {

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

		for ( const path in zip ) {

			const extension = path.split( '.' ).pop().toLowerCase();
			if ( SUPPORTED_FORMATS[ extension ] && SUPPORTED_FORMATS[ extension ].type === 'model' ) {

				console.log( `Loading model file from ZIP: ${path}` );
				return await this.loadModelFromZipEntry( zip[ path ], path, extension, zip );

			}

		}

		throw new Error( 'No supported model files found in the ZIP archive' );

	}

	async loadModelFromZipEntry( fileContent, filePath, extension, zipContents ) {

		try {

			updateLoading( { isLoading: true, status: `Processing ${extension.toUpperCase()} from ZIP...`, progress: 20 } );
			const blob = new Blob( [ fileContent.buffer ], { type: 'application/octet-stream' } );
			const blobUrl = URL.createObjectURL( blob );
			let result;

			switch ( extension ) {

				case 'glb':
				case 'gltf':
					result = await this.handleGltfFromZip( extension, fileContent, filePath, zipContents );
					break;
				case 'fbx':
					result = await this.loadFBXFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'obj':
					result = await this.handleObjFromZip( fileContent, filePath, zipContents );
					break;
				case 'stl':
					result = await this.loadSTLFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'ply':
					result = await this.loadPLYFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'dae':
					{

						const daeContent = strFromU8( fileContent );
						const daeFile = new File( [ new Blob( [ daeContent ] ) ], filePath );
						result = await this.loadColladaFromFile( daeFile, filePath );

					}

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

			URL.revokeObjectURL( blobUrl );
			this.dispatchEvent( {
				type: 'load',
				model: this.targetModel,
				filename: `${filePath} (from ZIP)`
			} );
			return result;

		} catch ( error ) {

			console.error( `Error loading ${extension} from ZIP:`, error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: filePath } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async handleGltfFromZip( extension, fileContent, filePath, zipContents ) {

		if ( extension === 'gltf' ) {

			const gltfContent = strFromU8( fileContent );
			const gltfJson = JSON.parse( gltfContent );
			const manager = new LoadingManager();
			const gltfDir = filePath.split( '/' ).slice( 0, - 1 ).join( '/' );

			manager.setURLModifier( url => this.resolveZipResource( url, gltfDir, zipContents ) );
			const loader = await this.createGLTFLoader();
			loader.manager = manager;

			return await new Promise( ( resolve, reject ) => {

				loader.parse( gltfContent, '',
					gltf => {

						if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
						this.targetModel = gltf.scene;
						this.onModelLoad( this.targetModel ).then( () => resolve( gltf ) );

					},
					error => reject( error )
				);

			} );

		} else {

			return await this.loadGLBFromArrayBuffer( fileContent.buffer, filePath );

		}

	}

	async handleObjFromZip( fileContent, filePath, zipContents ) {

		const objContent = strFromU8( fileContent );
		const mtlMatch = objContent.match( /mtllib\s+([^\s]+)/ );
		let materials = null;

		if ( mtlMatch && mtlMatch[ 1 ] ) {

			materials = await this.loadMtlFromZip( mtlMatch[ 1 ], filePath, zipContents );

		}

		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const objLoader = new OBJLoader();
		if ( materials ) objLoader.setMaterials( materials );

		const object = objLoader.parse( objContent );
		object.name = filePath;

		if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
		this.targetModel = object;
		await this.onModelLoad( this.targetModel );
		return object;

	}

	async loadMtlFromZip( mtlFilename, objPath, zipContents ) {

		const objDir = objPath.split( '/' ).slice( 0, - 1 ).join( '/' );
		const possibleMtlPaths = [
			mtlFilename,
			`${objDir}/${mtlFilename}`,
			mtlFilename.split( '/' ).pop()
		];

		for ( const path of possibleMtlPaths ) {

			if ( zipContents[ path ] ) {

				const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
				const mtlContent = strFromU8( zipContents[ path ] );
				const manager = new LoadingManager();
				manager.setURLModifier( url => this.resolveZipResource( url, objDir, zipContents ) );
				const mtlLoader = new MTLLoader( manager );
				const materials = mtlLoader.parse( mtlContent, objDir );
				materials.preload();
				return materials;

			}

		}

		return null;

	}

	resolveZipResource( url, baseDir, zipContents ) {

		const normalizedUrl = url.replace( /^\.\/|^\//, '' );
		const possiblePaths = [
			normalizedUrl,
			`${baseDir}/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const path of possiblePaths ) {

			if ( zipContents[ path ] ) {

				const fileBlob = new Blob( [ zipContents[ path ].buffer ], { type: 'application/octet-stream' } );
				return URL.createObjectURL( fileBlob );

			}

		}

		console.warn( `Resource not found in ZIP: ${url}` );
		return url;

	}

	async loadOBJMTLPairFromZip( objFile, mtlFile, zip, filename ) {

		const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const createdUrls = [];
		const manager = new LoadingManager();
		const objDir = objFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );
		const mtlDir = mtlFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );

		manager.setURLModifier( url => this.resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) );
		const mtlContent = this.prepareFixedMtlContent( mtlFile );
		const materials = new MTLLoader( manager ).parse( mtlContent, mtlDir );
		materials.preload();

		const objLoader = new OBJLoader( manager );
		objLoader.setMaterials( materials );
		const objContent = strFromU8( objFile.content );
		const object = objLoader.parse( objContent );

		if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
		this.targetModel = object;
		await this.onModelLoad( this.targetModel );

		createdUrls.forEach( url => URL.revokeObjectURL( url ) );
		this.dispatchEvent( {
			type: 'load',
			model: object,
			filename: `${objFile.path} (from ${filename})`
		} );

		return object;

	}

	prepareFixedMtlContent( mtlFile ) {

		const mtlContent = strFromU8( mtlFile.content );
		return mtlContent
			.replace( new RegExp( `${mtlFile.path.split( '/' ).pop()}\\s+`, 'g' ), ' ' )
			.replace( /([a-zA-Z_]+)([\\/])/g, '$1 $2' );

	}

	resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) {

		const cleanUrl = url.split( '?' )[ 0 ].split( '#' )[ 0 ];
		let normalizedUrl = cleanUrl.replace( /^\.\/|^\//, '' );

		const mtlFilename = mtlFile.path.split( '/' ).pop();
		if ( normalizedUrl.startsWith( mtlFilename ) ) {

			normalizedUrl = normalizedUrl.substring( mtlFilename.length ).replace( /^\.\/|^\/|^\./, '' );

		}

		const possibleLocations = [
			normalizedUrl,
			`${objDir}/${normalizedUrl}`,
			`${mtlDir}/${normalizedUrl}`,
			`textures/${normalizedUrl}`,
			`texture/${normalizedUrl}`,
			`materials/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const location of possibleLocations ) {

			if ( zip[ location ] ) {

				const blob = new Blob( [ zip[ location ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		return this.findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) || url;

	}

	findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) {

		const textureFilename = normalizedUrl.split( '/' ).pop();

		for ( const zipPath in zip ) {

			if ( zipPath.endsWith( textureFilename ) ) {

				const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		if ( textureFilename && textureFilename.length > 5 ) {

			for ( const zipPath in zip ) {

				const zipFilename = zipPath.split( '/' ).pop();
				if ( zipFilename.includes( textureFilename ) || textureFilename.includes( zipFilename ) ) {

					const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
					const blobUrl = URL.createObjectURL( blob );
					createdUrls.push( blobUrl );
					return blobUrl;

				}

			}

		}

		return null;

	}

	// Model loading methods
	async createGLTFLoader() {

		if ( this.loaderCache.gltf ) return this.loaderCache.gltf;

		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderConfig( { type: 'js' } );
		dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/v1/decoders/' );

		const loader = new GLTFLoader();
		loader.setDRACOLoader( dracoLoader );
		loader.setMeshoptDecoder( MeshoptDecoder );

		this.loaderCache.gltf = loader;
		return loader;

	}

	async loadExampleModels( index ) {

		const modelUrl = `${MODEL_FILES[ index ].url}`;
		return await this.loadModel( modelUrl );

	}

	async loadModel( modelUrl ) {

		try {

			const loader = await this.createGLTFLoader();
			updateLoading( { status: "Loading Model...", progress: 5 } );
			const data = await loader.loadAsync( modelUrl );
			updateLoading( { status: "Processing Data...", progress: 30 } );

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );

			this.targetModel = data.scene;
			await this.onModelLoad( this.targetModel );
			this.dispatchEvent( { type: 'load', model: data.scene, filename: modelUrl.split( '/' ).pop() } );
			return data;

		} catch ( error ) {

			console.error( "Error loading model:", error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: modelUrl } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadGLBFromArrayBuffer( arrayBuffer, filename = 'model.glb' ) {

		try {

			const loader = await this.createGLTFLoader();
			updateLoading( { isLoading: true, status: "Processing GLB Data...", progress: 10 } );

			const data = await new Promise( ( resolve, reject ) =>
				loader.parse( arrayBuffer, '', gltf => resolve( gltf ), error => reject( error ) )
			);

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );

			this.targetModel = data.scene;
			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: data.scene, filename } );
			return data;

		} catch ( error ) {

			console.error( 'Error loading GLB:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadFBXFromArrayBuffer( arrayBuffer, filename = 'model.fbx' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing FBX Data...", progress: 10 } );

			if ( ! this.loaderCache.fbx ) {

				const { FBXLoader } = await import( 'three/examples/jsm/loaders/FBXLoader.js' );
				this.loaderCache.fbx = new FBXLoader();

			}

			const object = this.loaderCache.fbx.parse( arrayBuffer );
			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading FBX:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadOBJFromFile( file, filename = 'model.obj' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing OBJ Data...", progress: 10 } );

			if ( ! this.loaderCache.obj ) {

				const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
				this.loaderCache.obj = new OBJLoader();

			}

			const contents = await this.readFileAsText( file );
			const object = this.loaderCache.obj.parse( contents );
			object.name = filename;

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading OBJ:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadSTLFromArrayBuffer( arrayBuffer, filename = 'model.stl' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing STL Data...", progress: 10 } );

			if ( ! this.loaderCache.stl ) {

				const { STLLoader } = await import( 'three/examples/jsm/loaders/STLLoader.js' );
				this.loaderCache.stl = new STLLoader();

			}

			const geometry = this.loaderCache.stl.parse( arrayBuffer );
			const material = new MeshStandardMaterial();
			const mesh = new Mesh( geometry, material );
			mesh.name = filename;

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = mesh;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: mesh, filename } );
			return mesh;

		} catch ( error ) {

			console.error( 'Error loading STL:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadPLYFromArrayBuffer( arrayBuffer, filename = 'model.ply' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing PLY Data...", progress: 10 } );

			if ( ! this.loaderCache.ply ) {

				const { PLYLoader } = await import( 'three/examples/jsm/loaders/PLYLoader.js' );
				this.loaderCache.ply = new PLYLoader();

			}

			const geometry = this.loaderCache.ply.parse( arrayBuffer );
			let object;

			if ( geometry.index !== null ) {

				const material = new MeshStandardMaterial();
				object = new Mesh( geometry, material );

			} else {

				const material = new PointsMaterial( { size: 0.01 } );
				material.vertexColors = geometry.hasAttribute( 'color' );
				object = new Points( geometry, material );

			}

			object.name = filename;
			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading PLY:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadColladaFromFile( file, filename = 'model.dae' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing Collada Data...", progress: 10 } );

			if ( ! this.loaderCache.collada ) {

				const { ColladaLoader } = await import( 'three/examples/jsm/loaders/ColladaLoader.js' );
				this.loaderCache.collada = new ColladaLoader();

			}

			const contents = await this.readFileAsText( file );
			const collada = this.loaderCache.collada.parse( contents );
			collada.scene.name = filename;

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = collada.scene;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: collada.scene, filename } );
			return collada;

		} catch ( error ) {

			console.error( 'Error loading Collada:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async load3MFFromArrayBuffer( arrayBuffer, filename = 'model.3mf' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing 3MF Data...", progress: 10 } );

			if ( ! this.loaderCache.threemf ) {

				const { ThreeMFLoader } = await import( 'three/examples/jsm/loaders/3MFLoader.js' );
				this.loaderCache.threemf = new ThreeMFLoader();

			}

			const object = this.loaderCache.threemf.parse( arrayBuffer );

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading 3MF:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	async loadUSDZFromArrayBuffer( arrayBuffer, filename = 'model.usdz' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing USDZ Data...", progress: 10 } );

			if ( ! this.loaderCache.usdz ) {

				const { USDZLoader } = await import( 'three/examples/jsm/loaders/USDZLoader.js' );
				this.loaderCache.usdz = new USDZLoader();

			}

			const object = this.loaderCache.usdz.parse( arrayBuffer );
			object.name = filename;

			if ( this.targetModel ) disposeObjectFromMemory( this.targetModel );
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 50 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading USDZ:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );
			setTimeout( () => resetLoading(), 1000 );

		}

	}

	// Model processing methods
	async onModelLoad( model ) {

		// Extract cameras from the loaded model
		const extractedCameras = this.extractCamerasFromModel( model );

		// Center model and adjust camera
		const box = new Box3().setFromObject( model );
		const center = box.getCenter( new Vector3() );
		const size = box.getSize( new Vector3() );

		this.controls.target.copy( center );

		const maxDim = Math.max( size.x, size.y, size.z );
		const fov = this.camera.fov * ( Math.PI / 180 );
		const cameraDistance = Math.abs( maxDim / Math.sin( fov / 2 ) / 2 );

		// Set up isometric-like view
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

		if ( this.optimizeMeshes ) {

			updateLoading( { status: "Optimizing Mesh...", progress: 40 } );
			await this.optimizeModel( model );

		}

		// Process model objects
		this.processModelObjects( model );

		this.scene.add( model );

		// Calculate scene scale factor based on model size
		const sceneScale = maxDim;

		// Rebuild path tracing
		await this.setupPathTracing( model, sceneScale, maxDim );

		// Dispatch event with cameras if found
		this.dispatchEvent( {
			type: 'modelProcessed',
			model: model,
			cameras: extractedCameras,
			sceneData: { center, size, maxDim, sceneScale }
		} );

		// Notify model loaded and processed
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		return { center, size, maxDim, sceneScale };

	}

	// New method to extract cameras from loaded models
	extractCamerasFromModel( model ) {

		const cameras = [];

		model.traverse( ( object ) => {

			if ( object.isCamera ) {

				// Clone the camera to avoid modifying the original
				const camera = object.clone();

				// Set a meaningful name
				if ( ! camera.name || camera.name === '' ) {

					camera.name = `Model Camera ${cameras.length + 1}`;

				}

				// Ensure the camera has proper aspect ratio
				if ( camera.isPerspectiveCamera ) {

					camera.aspect = this.camera.aspect;
					camera.updateProjectionMatrix();

				}

				cameras.push( camera );

			}

		} );

		return cameras;

	}

	processModelObjects( model ) {

		model.traverse( ( object ) => {

			const userData = object.userData;

			// Process ceiling lights
			if ( object.name.startsWith( 'RectAreaLightPlaceholder' ) &&
				userData.name && userData.name.includes( "ceilingLight" ) ) {

				if ( userData.type === 'RectAreaLight' ) {

					const light = new RectAreaLight(
						new Color( ...userData.color ),
						userData.intensity / 10,
						userData.width,
						userData.height
					);
					light.rotation.x = Math.PI;
					light.position.z = - 2;
					light.name = userData.name;
					object.add( light );

				}

			}

			// Handle multi-material meshes
			if ( object.isMesh && Array.isArray( object.material ) ) {

				console.log( 'Found multi-material mesh:', object.name );
				const group = createMeshesFromMultiMaterialMesh( object );

				if ( object.parent ) {

					object.parent.add( group );
					object.parent.remove( object );

				}

			}

		} );

	}

	async setupPathTracing( model, sceneScale, maxDim ) {

		if ( this.pathTracingPass ) {

			await this.pathTracingPass.build( this.scene );
			this.sceneScale = sceneScale;
			this.camera.near = maxDim / 100;
			this.camera.far = maxDim * 100;
			this.pathTracingPass.material.uniforms.focusDistance.value = DEFAULT_STATE.focusDistance * ( sceneScale / 1.0 );
			this.pathTracingPass.material.uniforms.apertureScale.value = sceneScale;
			this.pathTracingPass.reset();

		}

	}

	// Optimization methods
	async optimizeModel( model ) {

		if ( ! this.meshoptEncoderLoaded ) {

			console.log( 'MeshoptEncoder not loaded, skipping optimization' );
			return;

		}

		try {

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

	optimizeMeshGeometry( geometry ) {

		try {

			if ( ! geometry.index || ! geometry.attributes.position ) return;

			const indices = Array.from( geometry.index.array );
			const triangles = true;
			const optsize = true;

			const [ remap, unique ] = MeshoptEncoder.reorderMesh( new Uint32Array( indices ), triangles, optsize );

			if ( ! remap || ! unique ) {

				console.warn( 'MeshoptEncoder.reorderMesh failed to produce valid output' );
				return;

			}

			const remappedIndices = new Uint32Array( indices.length );
			for ( let i = 0; i < indices.length; i ++ ) {

				remappedIndices[ i ] = remap[ indices[ i ] ];

			}

			let newIndexBuffer;
			if ( remappedIndices.every( idx => idx < 65536 ) ) {

				newIndexBuffer = new Uint16Array( remappedIndices );

			} else {

				newIndexBuffer = remappedIndices;

			}

			geometry.setIndex( new BufferAttribute( newIndexBuffer, 1 ) );
			this.optimizeAttributes( geometry, remap, unique );
			console.log( `Optimized geometry: unique vertices ${unique}` );

		} catch ( error ) {

			console.error( 'Error optimizing geometry:', error );

		}

	}

	optimizeAttributes( geometry, remap, unique ) {

		Object.keys( geometry.attributes ).forEach( name => {

			const attribute = geometry.attributes[ name ];
			const itemSize = attribute.itemSize;
			const count = attribute.count;
			const newArray = new Float32Array( unique * itemSize );

			for ( let i = 0; i < count; i ++ ) {

				const newIndex = remap[ i ];
				if ( newIndex !== 0xffffffff ) {

					for ( let j = 0; j < itemSize; j ++ ) {

						newArray[ newIndex * itemSize + j ] = attribute.array[ i * itemSize + j ];

					}

				}

			}

			geometry.setAttribute( name, new BufferAttribute( newArray, itemSize ) );

		} );

	}

	// Utility methods
	setFloorPlane( floorPlane ) {

		this.floorPlane = floorPlane;

	}

	setOptimizeMeshes( enabled ) {

		this.optimizeMeshes = enabled;
		if ( enabled && ! this.meshoptEncoderLoaded ) {

			this.initMeshoptEncoder();

		}

	}

	getOptimizationStatus() {

		return {
			optimizeMeshes: this.optimizeMeshes,
			meshoptEncoderLoaded: this.meshoptEncoderLoaded,
		};

	}

	getSceneScale() {

		return this.sceneScale;

	}

	getTargetModel() {

		return this.targetModel;

	}

	getSupportedFormats( type = null ) {

		if ( type ) {

			const filtered = {};
			for ( const [ ext, info ] of Object.entries( SUPPORTED_FORMATS ) ) {

				if ( info.type === type ) filtered[ ext ] = info;

			}

			return filtered;

		}

		return SUPPORTED_FORMATS;

	}

	// Cleanup
	dispose() {

		for ( const key in this.loaderCache ) {

			const loader = this.loaderCache[ key ];
			if ( loader && typeof loader.dispose === 'function' ) {

				loader.dispose();

			}

		}

		this.loaderCache = {};
		super.dispose(); // Use EventDispatcher's dispose method

		if ( this.targetModel ) {

			disposeObjectFromMemory( this.targetModel );
			this.targetModel = null;

		}

		console.log( 'AssetLoader resources disposed' );

	}

	removeAllEventListeners() {

		// Use EventDispatcher's dispose method for backward compatibility
		super.dispose();

	}

}

export default AssetLoader;
