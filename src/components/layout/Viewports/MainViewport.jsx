import { memo, useCallback, useState } from 'react';
import Viewport3D from './Viewport3D';
import DropzoneOverlay from './DropzoneOverlay';
import LoadingOverlay from './LoadingOverlay';
import { useToast } from '@/hooks/use-toast';
import { Toaster } from "@/components/ui/toaster";
import { useStore, useAssetsStore } from '@/store';

// MainViewport component now serves as a simple wrapper for Viewport3D
const MainViewport = ( { mode = "interactive" } ) => {

	const [ isDragging, setIsDragging ] = useState( false );
	const setEnvironment = useAssetsStore( state => state.setEnvironment );
	const setLoading = useStore( state => state.setLoading );
	const resetLoading = useStore( state => state.resetLoading );
	const { toast } = useToast();

	// File type detection helpers
	const isEnvironmentMap = useCallback( ( fileName ) => {

		const extension = fileName.split( '.' ).pop().toLowerCase();
		return [ 'hdr', 'exr', 'png', 'jpg', 'jpeg', 'webp' ].includes( extension );

	}, [] );

	// Drag event handlers
	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( true );

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

	}, [] );

	// Handle environment map loading
	const handleEnvironmentLoad = useCallback( ( file ) => {

		// Capture the setLoading function from store to avoid closure issues

		setLoading( { isLoading: true, title: "Loading", status: "Processing Environment Map...", progress: 0 } );

		const url = URL.createObjectURL( file );

		// Store file info in global context for reference in the loader
		window.uploadedEnvironmentFileInfo = {
			name: file.name,
			type: file.type,
			size: file.size
		};

		// Create environment data object
		const customEnv = {
			id: 'custom-upload',
			name: file.name,
			preview: null,
			category: [],
			tags: [],
			redirection: '',
			url: url
		};

		// Update the environment in store
		setEnvironment( customEnv );

		const app = window.pathTracerApp;
		// Load the environment into the renderer
		if ( app ) {

			try {

				app.loadEnvironment( url )
					.then( () => {

						toast( {
							title: "Environment Loaded",
							description: `Successfully loaded environment: ${file.name}`,
						} );

						app.reset();

					} )
					.catch( ( err ) => {

						console.error( "Error loading environment file:", err );
						toast( {
							title: "Failed to load environment",
							description: err.message || "Please try another file.",
							variant: "destructive",
						} );

						// Clean up the blob URL on error
						URL.revokeObjectURL( url );

					} )
					.finally( () => {

						setLoading( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => resetLoading(), 1000 );

					} );

			} catch ( error ) {

				console.error( "Error in environment loading process:", error );
				toast( {
					title: "Error Loading Environment",
					description: error.message || "An unexpected error occurred.",
					variant: "destructive",
				} );

				// Clean up the blob URL on error
				URL.revokeObjectURL( url );
				setLoading( { isLoading: false } );

			}

		}

	}, [ toast, setEnvironment, resetLoading, setLoading ] );

	// Handle model loading
	const handleModelLoad = useCallback( ( file ) => {

		// Capture the setLoading function from store to avoid closure issues

		setLoading( { isLoading: true, title: "Loading", status: "Processing Model...", progress: 0 } );

		const reader = new FileReader();
		reader.onload = ( event ) => {

			const arrayBuffer = event.target.result;
			const app = window.pathTracerApp;
			if ( app && app.loadGLBFromArrayBuffer ) {

				// Stop any ongoing rendering before loading new model
				if ( app.pauseRendering !== undefined ) {

					app.pauseRendering = true;

				}

				app.loadGLBFromArrayBuffer( arrayBuffer )
					.then( () => {

						toast( {
							title: "Model Loaded",
							description: `Successfully loaded model: ${file.name}`,
						} );

					} )
					.catch( ( err ) => {

						console.error( "Error loading GLB file:", err );
						toast( {
							title: "Failed to load GLB file",
							description: err.message || "Please try again.",
							variant: "destructive",
						} );

					} )
					.finally( () => {

						setLoading( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => resetLoading(), 1000 );

					} );

			}

		};

		reader.readAsArrayBuffer( file );

	}, [ toast, setLoading, resetLoading ] );

	const handleDrop = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

		const file = e.dataTransfer.files[ 0 ];
		if ( ! file ) return;

		const fileName = file.name.toLowerCase();

		// Check if it's a GLB or GLTF model
		if ( fileName.endsWith( '.glb' ) || fileName.endsWith( '.gltf' ) ) {

			handleModelLoad( file );

		} else if ( isEnvironmentMap( fileName ) ) { // Check if it's an environment map

			handleEnvironmentLoad( file );

		} else { // Unsupported file type

			toast( {
				title: "Unsupported File Type",
				description: "Please drop a GLB model or an environment map (.hdr, .exr, .png, etc.)",
				variant: "destructive",
			} );

		}

	}, [ handleModelLoad, handleEnvironmentLoad, isEnvironmentMap, toast ] );

	console.log( 'MainViewport render' );

	return (
		<div className="w-full h-full relative"
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<Viewport3D viewportMode={mode} />
			<Toaster />
			<LoadingOverlay />
			<DropzoneOverlay isActive={isDragging} />
		</div>
	);

};

// Export a memoized version of the component
export default memo( MainViewport );
