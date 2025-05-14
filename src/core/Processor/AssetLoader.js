import {
	Box3,
	Vector3,
	RectAreaLight,
	Color,
	FloatType,
	LinearFilter,
	EquirectangularReflectionMapping,
	TextureLoader
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

class AssetLoader {

	constructor( scene, camera, controls, pathTracingPass ) {

		this.scene = scene;
		this.camera = camera;
		this.controls = controls;
		this.pathTracingPass = pathTracingPass;
		this.targetModel = null;
		this.floorPlane = null;
		this.sceneScale = 1.0;

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

	async createGLTFLoader() {

		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderConfig( { type: 'js' } );
		dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/v1/decoders/' );

		const loader = new GLTFLoader();
		loader.setDRACOLoader( dracoLoader );
		loader.setMeshoptDecoder( MeshoptDecoder );

		return loader;

	}

	async loadGLBFromArrayBuffer( arrayBuffer ) {

		try {

			const loader = await this.createGLTFLoader();
			const data = await new Promise( ( resolve, reject ) =>
				loader.parse( arrayBuffer, '', gltf => resolve( gltf ), error => reject( error ) )
			);

			if ( this.targetModel ) {

				disposeObjectFromMemory( this.targetModel );

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

	setPauseRendering( value ) {


	}

	getSceneScale() {

		return this.sceneScale;

	}

	getTargetModel() {

		return this.targetModel;

	}

}

export default AssetLoader;
