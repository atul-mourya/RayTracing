import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import DimensionDisplay from './DimensionDisplay';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';
import ViewportControls from './ViewportControls';
import DropzoneOverlay from './DropzoneOverlay';
import LoadingOverlay from './LoadingOverlay';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { Toaster } from "@/components/ui/toaster";
import { useAssetsStore } from '@/store';
import { saveRender } from '@/utils/database';


const Viewport3D = forwardRef( ( { viewportMode = "interactive" }, ref ) => {

	const { toast } = useToast();

	// Refs
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const primaryCanvasRef = useRef( null );
	const denoiserCanvasRef = useRef( null );
	const appRef = useRef( null );
	const isInitialized = useRef( false );
	const statsRef = useRef( null );

	// Viewport state - now using separate useState hooks
	const [ isDragging, setIsDragging ] = useState( false );
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize, setActualCanvasSize ] = useState( 512 ); // Fixed canvas size
	const [ renderComplete, setRenderComplete ] = useState( false );

	// Store access - memoized to prevent recreation
	const setLoading = useStore( ( state ) => state.setLoading );
	const appMode = useStore( state => state.appMode );
	const setEnvironment = useAssetsStore( state => state.setEnvironment );

	// Save/Discard Handlers
	const handleSave = useCallback( async () => {

		const app = appRef.current;
		if ( ! app ) return;

		try {

			const canvas = app.denoiser.enabled && app.denoiser.output
				? app.denoiser.output
				: app.renderer.domElement;

			const imageData = canvas.toDataURL( 'image/png' );
			const saveData = {
				image: imageData,
				colorCorrection: {
					brightness: 0,
					contrast: 0,
					saturation: 0,
					hue: 0,
					exposure: 0,
				},
				timestamp: new Date(),
				isEdited: true
			};

			const id = await saveRender( saveData );
			window.dispatchEvent( new CustomEvent( 'render-saved', { detail: { id } } ) );
			setRenderComplete( false );

		} catch ( error ) {

			console.error( 'Failed to save render:', error );
			toast( {
				title: "Failed to save render",
				description: "See console for details.",
				variant: "destructive",
			} );

		}

	}, [ toast ] );

	const handleDiscard = useCallback( () => {

		setRenderComplete( false );

	}, [] );

	useEffect( () => {

		const app = appRef.current;
		if ( ! app ) return;

		app.addEventListener( 'RenderComplete', () => setRenderComplete( true ) );
		app.addEventListener( 'RenderReset', () => setRenderComplete( false ) );

		return () => {

			app.removeEventListener( 'RenderComplete', () => setRenderComplete( true ) );
			app.removeEventListener( 'RenderReset', () => setRenderComplete( false ) );

		};

	}, [] );

	// Effect for app initialization - dependencies optimized
	useEffect( () => {

		// Only initialize if the component is visible (not in results mode)
		if ( ! appRef.current && containerRef.current && appMode !== 'results' ) {

			appRef.current = new PathTracerApp( primaryCanvasRef.current, denoiserCanvasRef.current );
			window.pathTracerApp = appRef.current;

			setLoading( { isLoading: true, title: "Starting", status: "Setting up Scene...", progress: 0 } );

			appRef.current.init()
				.catch( ( err ) => {

					console.error( "Error initializing PathTracerApp:", err );
					toast( {
						title: "Failed to load application",
						description: err.message || "Uh oh!! Something went wrong. Please try again.",
						variant: "destructive",
					} );

				} )
				.finally( () => {

					setLoading( { isLoading: true, title: "Starting", status: "Setup Complete!", progress: 100 } );

					// Get a stable reference to the store function
					const resetLoadingFn = useStore.getState().resetLoading;
					setTimeout( () => resetLoadingFn(), 1000 );

					if ( window.pathTracerApp ) {

						window.pathTracerApp.reset();

					}

					isInitialized.current = true;

				} );

		}

	}, [ setLoading, toast, appMode ] );

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
		const setLoadingFn = useStore.getState().setLoading;
		const resetLoadingFn = useStore.getState().resetLoading;

		setLoadingFn( { isLoading: true, title: "Loading", status: "Processing Environment Map...", progress: 0 } );

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

		// Load the environment into the renderer
		if ( appRef.current ) {

			try {

				appRef.current.loadEnvironment( url )
					.then( () => {

						toast( {
							title: "Environment Loaded",
							description: `Successfully loaded environment: ${file.name}`,
						} );

						appRef.current.reset();

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

						setLoadingFn( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => resetLoadingFn(), 1000 );

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
				setLoadingFn( { isLoading: false } );

			}

		}

	}, [ toast, setEnvironment ] );

	// Handle model loading
	const handleModelLoad = useCallback( ( file ) => {

		// Capture the setLoading function from store to avoid closure issues
		const setLoadingFn = useStore.getState().setLoading;
		const resetLoadingFn = useStore.getState().resetLoading;

		setLoadingFn( { isLoading: true, title: "Loading", status: "Processing Model...", progress: 0 } );

		const reader = new FileReader();
		reader.onload = ( event ) => {

			const arrayBuffer = event.target.result;
			if ( appRef.current && appRef.current.loadGLBFromArrayBuffer ) {

				// Stop any ongoing rendering before loading new model
				if ( appRef.current.pauseRendering !== undefined ) {

					appRef.current.pauseRendering = true;

				}

				appRef.current.loadGLBFromArrayBuffer( arrayBuffer )
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

						setLoadingFn( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => resetLoadingFn(), 1000 );

					} );

			}

		};

		reader.readAsArrayBuffer( file );

	}, [ toast ] );

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

	// Control button handlers
	const handleViewportResize = useCallback( ( scale ) => {

		setViewportScale( scale );

	}, [] );

	const handleFullscreen = useCallback( () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement
			? document.exitFullscreen()
			: viewportWrapperRef.current.requestFullscreen();

	}, [] );

	const handleResetCamera = useCallback( () => {

		appRef.current && appRef.current.controls.reset();

	}, [] );

	const handleScreenshot = useCallback( () => {

		appRef.current && appRef.current.takeScreenshot();

	}, [] );

	// Compute whether to show save controls
	const shouldShowSaveControls = useMemo( () => {

		if ( ! window.pathTracerApp ) return false;
		const currentSamples = window.pathTracerApp.pathTracingPass.material.uniforms.frame.value - 1;
		const currentMaxSamples = window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value;
		return renderComplete && currentSamples === currentMaxSamples && viewportMode === "final";

	}, [ renderComplete, viewportMode ] );

	// Memoize style objects to prevent recreating them on each render
	const wrapperStyle = useMemo( () => ( {
		width: `${actualCanvasSize}px`,
		height: `${actualCanvasSize}px`,
		transform: `scale(${viewportScale / 100})`,
		transformOrigin: 'center center',
		transition: "transform 0.1s ease-out"
	} ), [ actualCanvasSize, viewportScale ] );

	const containerStyle = useMemo( () => ( {
		position: "relative",
		width: `${actualCanvasSize}px`,
		height: `${actualCanvasSize}px`,
		overflow: "hidden",
		background: "repeating-conic-gradient(rgb(128 128 128 / 20%) 0%, rgb(128 128 128 / 20%) 25%, transparent 0%, transparent 50%) 50% center / 20px 20px"
	} ), [ actualCanvasSize ] );

	const canvasStyle = useMemo( () => ( {
		width: `${actualCanvasSize}px`,
		height: `${actualCanvasSize}px`
	} ), [ actualCanvasSize ] );

	return (
		<div
			className="flex justify-center items-center h-full"
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Outer wrapper div for applying scale transform */}
			<div
				ref={viewportWrapperRef}
				className="relative"
				style={wrapperStyle}
			>
				{/* Container with fixed size */}
				<div
					ref={containerRef}
					className={`relative ${isDragging ? 'bg-primary/10' : ''}`}
					style={containerStyle}
				>
					{/* denoiser container */}
					<canvas
						ref={denoiserCanvasRef}
						width="1024"
						height="1024"
						style={canvasStyle}
					/>
					{/* primary container */}
					<canvas
						ref={primaryCanvasRef}
						width="1024"
						height="1024"
						style={canvasStyle}
					/>
					<DimensionDisplay canvasRef={primaryCanvasRef} scale={viewportScale} />
				</div>
			</div>

			{/* Integrated Stats Meter - now only passing appRef */}
			<StatsMeter
				viewportMode={viewportMode}
				ref={statsRef}
				appRef={appRef}
			/>

			{/* Integrated Save Controls */}
			{shouldShowSaveControls && (
				<SaveControls
					onSave={handleSave}
					onDiscard={handleDiscard}
				/>
			)}

			{/* Controls */}
			<ViewportControls
				onScreenshot={handleScreenshot}
				onResetCamera={handleResetCamera}
				onFullscreen={handleViewportResize}
			/>

			<Toaster />
			<LoadingOverlay />
			<DropzoneOverlay isActive={isDragging} />
		</div>
	);

} );

Viewport3D.displayName = 'Viewport3D';

// Export a memoized version of the component
export default React.memo( Viewport3D );
