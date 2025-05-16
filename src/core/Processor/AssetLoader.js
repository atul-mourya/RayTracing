import {
	Box3,
	Vector3,
	RectAreaLight,
	Color,
	FloatType,
	LinearFilter,
	EquirectangularReflectionMapping,
	TextureLoader,
	BufferAttribute
} from 'three';

import {
	GLTFLoader,
	RGBELoader,
	DRACOLoader,
	EXRLoader
} from 'three/examples/jsm/Addons';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module';
import { disposeObjectFromMemory, updateLoading } from './utils';
import { MODEL_FILES, DEFAULT_STATE } from '@/Constants';

// Import MeshoptEncoder for mesh optimization
// Note: You need to ensure the meshoptimizer package is properly installed
// npm install meshoptimizer
let MeshoptEncoder;

// Load the MeshoptEncoder dynamically to avoid issues with SSR or environments
// where it might not be available
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

		// Try to load the MeshoptEncoder
		this.initMeshoptEncoder();

	}

	async initMeshoptEncoder() {

		this.meshoptEncoderLoaded = await loadMeshoptEncoder();

	}

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

			return texture;

		} catch ( error ) {

			console.error( "Error loading environment:", error );
			throw error;

		}

	}

	async loadExampleModels( index ) {

		const modelUrl = `${MODEL_FILES[ index ].url}`;
		return await this.loadModel( modelUrl );

	}

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
			return data;

		} catch ( error ) {

			console.error( "Error loading model:", error );
			throw error;

		} finally {

			loader?.dracoLoader && loader.dracoLoader.dispose();
			updateLoading( { status: "Ready", progress: 90 } );

		}

	}

	async loadGLBFromArrayBuffer( arrayBuffer ) {

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

			return data;

		} catch ( error ) {

			console.error( 'Error loading GLB:', error );
			throw error;

		} finally {

			updateLoading( { status: "Ready", progress: 90 } );

		}

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

	async onModelLoad( model ) {

		this.scene.add( model );

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

		// Process model for lights
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

		} );

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

	getSceneScale() {

		return this.sceneScale;

	}

	getTargetModel() {

		return this.targetModel;

	}

}

export default AssetLoader;
