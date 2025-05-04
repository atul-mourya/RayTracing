import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import { Upload, Maximize, Target, Camera } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import LoadingOverlay from './LoadingOverlay';
import ViewportResizer from './ViewportResizer';
import { useAssetsStore } from '@/store';

// Extract dropzone visualization to a separate component
const DropzoneOverlay = ( { isActive } ) => {

	if ( ! isActive ) return null;

	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-xs">
			<div className="flex flex-col items-center space-y-4">
				<Upload className="h-16 w-16 text-primary" />
				<p className="text-xl font-medium text-foreground">Drop GLB model or HDR environment</p>
			</div>
		</div>
	);

};

// Extract dimension display to a separate component
const DimensionDisplay = ( { width, height, scale } ) => (
	<div className="absolute left-0 bottom-0 right-0 text-center z-10">
		<div className="text-xs text-background">
			{width} × {height} ({scale}%)
		</div>
	</div>
);

// Extract control buttons to a separate component
const ViewportControls = ( { onScreenshot, onResetCamera, onFullscreen } ) => (
	<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
		<TooltipProvider>
			<ViewportResizer onResize={onFullscreen} />
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						onClick={onScreenshot}
						className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
					>
						<Camera size={12} className="bg-transparent border-white text-forground/50" />
					</button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Take Screenshot</p>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						onClick={onResetCamera}
						className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
					>
						<Target size={12} className="bg-transparent border-white text-forground/50" />
					</button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Reset Camera</p>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						onClick={onFullscreen}
						className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
					>
						<Maximize size={12} className="bg-transparent border-white text-forground/50" />
					</button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Fullscreen</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	</div>
);

const Viewport3D = forwardRef( ( { onStatsUpdate, viewportMode }, ref ) => {

	const { toast } = useToast();

	// Refs
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const primaryCanvasRef = useRef( null );
	const denoiserCanvasRef = useRef( null );
	const appRef = useRef( null );
	const isInitialized = useRef( false );

	// Store access
	const setLoading = useStore( ( state ) => state.setLoading );
	const appMode = useStore( state => state.appMode );
	const { setEnvironment } = useAssetsStore();

	// Local state
	const [ isDragging, setIsDragging ] = useState( false );
	const [ dimensions, setDimensions ] = useState( { width: 512, height: 512 } );
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize ] = useState( 512 ); // Fixed canvas size

	// Expose the app instance via ref
	React.useImperativeHandle( ref, () => ( {
		getPathTracerApp: () => appRef.current
	} ), [] );

	// Effect for app initialization
	useEffect( () => {

		// Only initialize if the component is visible (not in results mode)
		if ( ! appRef.current && containerRef.current && appMode !== 'results' ) {

			appRef.current = new PathTracerApp( primaryCanvasRef.current, denoiserCanvasRef.current );
			window.pathTracerApp = appRef.current;
			appRef.current.setOnStatsUpdate( onStatsUpdate );

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

					setLoading( { isLoading: true, title: "Starting", status: "Setting up Complete !", progress: 100 } );
					setTimeout( () => useStore.getState().resetLoading(), 1000 );

					if ( window.pathTracerApp ) {

						window.pathTracerApp.reset();

					}

					isInitialized.current = true;

				} );

		} else if ( appRef.current ) {

			// If app already exists, just update the stats callback
			appRef.current.setOnStatsUpdate( onStatsUpdate );

		}

	}, [ onStatsUpdate, setLoading, toast, appMode ] );

	// Effect for dimension updates
	useEffect( () => {

		const updateDimensions = () => {

			if ( primaryCanvasRef.current ) {

				const { width, height } = primaryCanvasRef.current;
				setDimensions( { width, height } );

			}

		};

		window.addEventListener( 'resolution_changed', updateDimensions );
		return () => {

			window.removeEventListener( 'resolution_changed', updateDimensions );

		};

	}, [] );

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

						setLoading( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => useStore.getState().resetLoading(), 1000 );

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

	}, [ setLoading, toast, setEnvironment ] );

	// Handle model loading
	const handleModelLoad = useCallback( ( file ) => {

		setLoading( { isLoading: true, title: "Loading", status: "Processing Model...", progress: 0 } );

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

						setLoading( { isLoading: true, title: "Loading", status: "Loading Complete!", progress: 100 } );
						setTimeout( () => useStore.getState().resetLoading(), 1000 );

					} );

			}

		};

		reader.readAsArrayBuffer( file );

	}, [ setLoading, toast ] );

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
	const handleFullscreen = useCallback( () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement
			? document.exitFullscreen()
			: viewportWrapperRef.current.requestFullscreen();

	}, [] );

	const handleResetCamera = useCallback( () => {

		window.pathTracerApp && window.pathTracerApp.controls.reset();

	}, [] );

	const handleScreenshot = useCallback( () => {

		window.pathTracerApp && window.pathTracerApp.takeScreenshot();

	}, [] );

	const handleViewportResize = useCallback( ( scale ) => {

		setViewportScale( scale );

	}, [] );

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

					{/* Dimensions display */}
					<DimensionDisplay
						width={dimensions.width}
						height={dimensions.height}
						scale={viewportScale}
					/>
				</div>
			</div>

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
