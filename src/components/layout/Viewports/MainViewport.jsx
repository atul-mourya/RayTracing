import { memo, useCallback, useState, useEffect } from 'react';
import Viewport3D from './Viewport3D';
import DropzoneOverlay from './DropzoneOverlay';
import LoadingOverlay from './LoadingOverlay';
import { useToast } from '@/hooks/use-toast';
import { Toaster } from "@/components/ui/toaster";
import { useStore, useAssetsStore } from '@/store';
import { DEFAULT_STATE } from '@/Constants';

const MainViewport = ( { mode = "interactive" } ) => {

	const [ isDragging, setIsDragging ] = useState( false );
	const setEnvironment = useAssetsStore( useCallback( state => state.setEnvironment, [] ) );
	const setLoading = useStore( useCallback( state => state.setLoading, [] ) );
	const resetLoading = useStore( useCallback( state => state.resetLoading, [] ) );
	const { toast } = useToast();

	useEffect( () => {

		const app = window.pathTracerApp;
		if ( app && app.assetLoader ) {

			// Set optimization settings
			app.assetLoader.setOptimizeMeshes( DEFAULT_STATE.optimizeMeshes );

			const handleAssetLoad = ( event ) => {

				toast( {
					title: event.type === 'model' ? "Model Loaded" : "Environment Loaded",
					description: `Successfully loaded ${event.filename || ''}`,
				} );

				// If it's an environment, update the store
				if ( event.type === 'environment' && event.filename ) {

					const customEnv = {
						id: 'custom-upload',
						name: event.filename,
						preview: null,
						category: [],
						tags: [],
						redirection: '',
						url: event.url || ''
					};
					setEnvironment( customEnv );

				}

				setLoading( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
				setTimeout( () => resetLoading(), 1000 );

			};

			const handleAssetError = ( event ) => {

				toast( {
					title: "Failed to load asset",
					description: event.message || "Please try another file.",
					variant: "destructive",
				} );

				setLoading( { isLoading: false } );

			};

			app.assetLoader.addEventListener( 'load', handleAssetLoad );
			app.assetLoader.addEventListener( 'error', handleAssetError );

			// app.addEventListener( 'ModelLoaded', () => {
			// 	// Additional UI updates if needed
			// } );

			return () => {

				// Clean up listeners on component unmount
				app.assetLoader.removeEventListener( 'load', handleAssetLoad );
				app.assetLoader.removeEventListener( 'error', handleAssetError );

			};

		}

	}, [ toast, setEnvironment, resetLoading, setLoading ] );

	// Drag event handlers
	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( true );

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

	}, [] );

	// Enhanced file drop handler that uses the new AssetLoader capabilities
	const handleDrop = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

		const file = e.dataTransfer.files[ 0 ];
		if ( ! file ) return;

		const app = window.pathTracerApp;
		if ( ! app || ! app.assetLoader ) {

			toast( {
				title: "Application Error",
				description: "3D renderer not initialized",
				variant: "destructive",
			} );
			return;

		}

		// Check if the file format is supported
		const format = app.assetLoader.getFileFormat( file.name );
		if ( ! format ) {

			toast( {
				title: "Unsupported File Type",
				description: "Please drop a supported 3D model or environment map.",
				variant: "destructive",
			} );
			return;

		}

		// Show loading indicator
		setLoading( {
			isLoading: true,
			title: "Loading",
			status: `Processing ${format.name}...`,
			progress: 0
		} );

		// For environment maps, create and store the URL
		if ( format.type === 'environment' || format.type === 'image' ) {

			const url = URL.createObjectURL( file );

			// Store file info in global context for reference in the loader
			window.uploadedEnvironmentFileInfo = {
				name: file.name,
				type: file.type,
				size: file.size
			};

		}

		// Set pause state before loading
		app.pauseRendering = true;

		// Use the enhanced AssetLoader to load the file
		app.assetLoader.loadAssetFromFile( file )
			.catch( error => {

				console.error( "Error in asset loading:", error );
				// Error handling is done through the event listeners

			} );

	}, [ toast, setLoading ] );

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
