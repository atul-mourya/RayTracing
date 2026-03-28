import { memo, useCallback, useState, useEffect, useRef } from 'react';
import Viewport3D from './Viewport3D';
import DropzoneOverlay from './DropzoneOverlay';
import LoadingOverlay from './LoadingOverlay';
import { useToast } from '@/hooks/use-toast';
import { Toaster } from "@/components/ui/toaster";
import { useStore, useAssetsStore, usePathTracerStore } from '@/store';
import { getApp } from '@/lib/appProxy';

const MainViewport = ( { mode = "preview" } ) => {

	const [ isDragging, setIsDragging ] = useState( false );
	const dragCounter = useRef( 0 );
	const setEnvironment = useAssetsStore( state => state.setEnvironment );
	const setLoading = useStore( state => state.setLoading );
	const environmentMode = usePathTracerStore( state => state.environmentMode );
	const handleEnvironmentModeChange = usePathTracerStore( state => state.handleEnvironmentModeChange );
	const { toast } = useToast();

	// Refs for values that change frequently — avoids tearing down/re-adding listeners
	const environmentModeRef = useRef( environmentMode );
	const handleEnvironmentModeChangeRef = useRef( handleEnvironmentModeChange );
	const toastRef = useRef( toast );
	const setEnvironmentRef = useRef( setEnvironment );
	const setLoadingRef = useRef( setLoading );

	useEffect( () => { environmentModeRef.current = environmentMode; }, [ environmentMode ] );
	useEffect( () => { handleEnvironmentModeChangeRef.current = handleEnvironmentModeChange; }, [ handleEnvironmentModeChange ] );
	useEffect( () => { toastRef.current = toast; }, [ toast ] );
	useEffect( () => { setEnvironmentRef.current = setEnvironment; }, [ setEnvironment ] );
	useEffect( () => { setLoadingRef.current = setLoading; }, [ setLoading ] );

	useEffect( () => {

		const app = getApp();
		if ( app && app.assetLoader ) {

			const handleBeforeEnvironmentLoad = () => {

				// Automatically switch to 'hdri' mode when loading an HDRI environment
				if ( environmentModeRef.current !== 'hdri' ) {

					console.log( `[MainViewport] Automatically switching environment mode from '${environmentModeRef.current}' to 'hdri'` );
					handleEnvironmentModeChangeRef.current( 'hdri' );

				}

			};

			const handleAssetLoad = ( event ) => {

				toastRef.current( {
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
					setEnvironmentRef.current( customEnv );

				}

			};

			const handleAssetError = ( event ) => {

				toastRef.current( {
					title: "Failed to load asset",
					description: event.message || "Please try another file.",
					variant: "destructive",
				} );

				setLoadingRef.current( { isLoading: false } );

			};

			app.assetLoader.addEventListener( 'beforeEnvironmentLoad', handleBeforeEnvironmentLoad );
			app.assetLoader.addEventListener( 'load', handleAssetLoad );
			app.assetLoader.addEventListener( 'error', handleAssetError );

			return () => {

				app.assetLoader.removeEventListener( 'beforeEnvironmentLoad', handleBeforeEnvironmentLoad );
				app.assetLoader.removeEventListener( 'load', handleAssetLoad );
				app.assetLoader.removeEventListener( 'error', handleAssetError );

			};

		}

	}, [] );

	// Drag event handlers — use a counter to avoid flickering when
	// the cursor moves over child elements (common issue on Windows).
	const handleDragEnter = useCallback( ( e ) => {

		e.preventDefault();
		dragCounter.current++;
		if ( dragCounter.current === 1 ) setIsDragging( true );

	}, [] );

	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		dragCounter.current--;
		if ( dragCounter.current === 0 ) setIsDragging( false );

	}, [] );

	// Enhanced file drop handler that uses the new AssetLoader capabilities
	const handleDrop = useCallback( ( e ) => {

		e.preventDefault();
		dragCounter.current = 0;
		setIsDragging( false );

		const file = e.dataTransfer.files[ 0 ];
		if ( ! file ) return;

		const app = getApp();
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

			// Store file info on asset loader for extension detection
			app.assetLoader.uploadedFileInfo = {
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
			onDragEnter={handleDragEnter}
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
