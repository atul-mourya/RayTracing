import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import { Upload, Maximize, Target, Camera, Check, X, Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from '@/hooks/use-toast';
import { useStore, usePathTracerStore } from '@/store';
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import LoadingOverlay from './LoadingOverlay';
import ViewportResizer from './ViewportResizer';
import { useAssetsStore } from '@/store';
import { saveRender } from '@/utils/database';

// Extract dropzone visualization to a separate component
const DropzoneOverlay = React.memo( ( { isActive } ) => {

	if ( ! isActive ) return null;

	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-xs">
			<div className="flex flex-col items-center space-y-4">
				<Upload className="h-16 w-16 text-primary" />
				<p className="text-xl font-medium text-foreground">Drop GLB model or HDR environment</p>
			</div>
		</div>
	);

} );

DropzoneOverlay.displayName = 'DropzoneOverlay';

// Extract dimension display to a separate component
const DimensionDisplay = React.memo( ( { width, height, scale } ) => (
	<div className="absolute left-0 bottom-0 right-0 text-center z-10">
		<div className="text-xs text-background">
			{width} × {height} ({scale}%)
		</div>
	</div>
) );

DimensionDisplay.displayName = 'DimensionDisplay';

// Integrated StatsMeter component
const StatsMeter = React.memo( forwardRef( ( { onMaxSamplesEdit }, ref ) => {

	// State for editing mode (minimal state that doesn't affect parent rendering)
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( "60" );

	// Create refs for DOM elements
	const containerRef = useRef( null );
	const timeElapsedRef = useRef( null );
	const samplesRef = useRef( null );
	const maxSamplesRef = useRef( null );
	const denoisingRef = useRef( null );

	// Stats data ref (not state)
	const statsDataRef = useRef( {
		timeElapsed: 0,
		samples: 0,
		maxSamples: 60,
		isDenoising: false
	} );

	// Handle input blur to submit value
	const handleInputBlur = useCallback( () => {

		setIsEditing( false );
		const numValue = Number( inputValue );
		if ( numValue !== statsDataRef.current.maxSamples && ! isNaN( numValue ) ) {

			// Call the parent callback with new value
			onMaxSamplesEdit && onMaxSamplesEdit( numValue );

		}

	}, [ inputValue, onMaxSamplesEdit ] );

	// Handle key press events
	const handleKeyDown = useCallback( ( e ) => {

		if ( e.key === 'Enter' ) {

			handleInputBlur();

		}

	}, [ handleInputBlur ] );

	// Handle input change
	const handleInputChange = useCallback( ( e ) => {

		setInputValue( e.target.value );

	}, [] );

	// Handle click to start editing
	const startEditing = useCallback( () => {

		setIsEditing( true );
		// Initialize input value from current stats
		setInputValue( String( statsDataRef.current.maxSamples ) );

	}, [] );

	// Expose methods to update stats without re-rendering
	React.useImperativeHandle( ref, () => ( {
		updateStats: ( newStats ) => {

			if ( ! containerRef.current ) return;

			// Update our internal ref data
			if ( newStats.timeElapsed !== undefined ) {

				statsDataRef.current.timeElapsed = newStats.timeElapsed;
				if ( timeElapsedRef.current ) {

					timeElapsedRef.current.textContent = newStats.timeElapsed.toFixed( 2 );

				}

			}

			if ( newStats.samples !== undefined ) {

				statsDataRef.current.samples = newStats.samples;
				if ( samplesRef.current ) {

					samplesRef.current.textContent = newStats.samples;

				}

			}

			if ( newStats.maxSamples !== undefined ) {

				statsDataRef.current.maxSamples = newStats.maxSamples;
				if ( maxSamplesRef.current && ! isEditing ) {

					maxSamplesRef.current.textContent = newStats.maxSamples;

				}

			}

			if ( newStats.isDenoising !== undefined ) {

				statsDataRef.current.isDenoising = newStats.isDenoising;
				if ( denoisingRef.current ) {

					denoisingRef.current.style.visibility = newStats.isDenoising ? 'visible' : 'hidden';

				}

			}

		},
		getStats: () => statsDataRef.current
	} ), [ isEditing ] );

	return (
		<div
			ref={containerRef}
			className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded"
		>
      Time: <span ref={timeElapsedRef}>0.00</span>s | Frames: <span ref={samplesRef}>0</span> /{' '}
			{isEditing ? (
				<input
					className="bg-transparent border-b border-white text-white w-12"
					type="number"
					value={inputValue}
					onChange={handleInputChange}
					onBlur={handleInputBlur}
					onKeyDown={handleKeyDown}
					autoFocus
				/>
			) : (
				<span
					ref={maxSamplesRef}
					onClick={startEditing}
					className="cursor-pointer border-b border-dotted border-white group-hover:border-blue-400 transition-colors duration-300"
				>
					{statsDataRef.current.maxSamples}
				</span>
			)}
			<div
				ref={denoisingRef}
				className="py-1 rounded-full flex items-center invisible"
			>
				<span className="mr-2">Denoising</span>
				<Loader2 className="h-5 w-5 animate-spin" />
			</div>
		</div>
	);

} ) );

StatsMeter.displayName = 'StatsMeter';

// Integrated SaveControls component
const SaveControls = React.memo( ( { onSave, onDiscard } ) => {

	return (
		<div className="absolute top-2 right-2 flex space-x-2">
			<button
				onClick={onSave}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-primary/90 transition-all cursor-pointer"
			>
				<Check size={14} className="mr-1" /> Save
			</button>
			<button
				onClick={onDiscard}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-secondary/90 transition-all cursor-pointer"
			>
				<X size={14} className="mr-1" /> Ignore
			</button>
		</div>
	);

} );

SaveControls.displayName = 'SaveControls';

// Extract control buttons to a separate component
const ViewportControls = React.memo( ( { onScreenshot, onResetCamera, onFullscreen } ) => (
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
) );

ViewportControls.displayName = 'ViewportControls';

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

	// Path tracer store state
	const maxSamples = usePathTracerStore( state => state.maxSamples );
	// Get the setter function directly without subscription
	const setMaxSamples = usePathTracerStore.getState().setMaxSamples;

	// Viewport state
	const [ viewportState, setViewportState ] = useState( {
		isDragging: false,
		dimensions: { width: 512, height: 512 },
		viewportScale: 100,
		actualCanvasSize: 512, // Fixed canvas size
		isDenoising: false,
		renderComplete: false
	} );

	// Destructure for readability
	const {
		isDragging,
		dimensions,
		viewportScale,
		actualCanvasSize,
		isDenoising,
		renderComplete
	} = viewportState;

	// Store access - memoized to prevent recreation
	const setLoading = useStore( ( state ) => state.setLoading );
	const appMode = useStore( state => state.appMode );
	const setEnvironment = useAssetsStore( state => state.setEnvironment );

	// Stats handling
	const updateStatsRef = useCallback( ( newStats ) => {

		if ( statsRef.current ) {

			statsRef.current.updateStats( newStats );

		}

	}, [] );

	// Handler for stats updates
	const handleStatsUpdate = useCallback( ( newStats ) => {

		updateStatsRef( {
			timeElapsed: newStats.timeElapsed,
			samples: newStats.samples,
			maxSamples
		} );

	}, [ maxSamples, updateStatsRef ] );

	// Handler for editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		if ( value === maxSamples ) return;

		setMaxSamples( value );
		const app = appRef.current;

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = value;
			app.reset();
			updateStatsRef( { maxSamples: value } );

		}

	}, [ maxSamples, setMaxSamples, updateStatsRef ] );

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
			setViewportState( prev => ( { ...prev, renderComplete: false } ) );

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

		setViewportState( prev => ( { ...prev, renderComplete: false } ) );

	}, [] );

	// Set up event listeners for denoising and rendering
	useEffect( () => {

		const app = appRef.current;
		if ( ! app ) return;

		const handleDenoisingStart = () => {

			setViewportState( prev => ( { ...prev, isDenoising: true } ) );
			updateStatsRef( { isDenoising: true } );

		};

		const handleDenoisingEnd = () => {

			setViewportState( prev => ( { ...prev, isDenoising: false } ) );
			updateStatsRef( { isDenoising: false } );

		};

		if ( app.denoiser ) {

			app.denoiser.addEventListener( 'start', handleDenoisingStart );
			app.denoiser.addEventListener( 'end', handleDenoisingEnd );

		}

		app.addEventListener( 'RenderComplete', () =>
			setViewportState( prev => ( { ...prev, renderComplete: true } ) )
		);

		app.addEventListener( 'RenderReset', () =>
			setViewportState( prev => ( { ...prev, renderComplete: false } ) )
		);

		return () => {

			if ( app.denoiser ) {

				app.denoiser.removeEventListener( 'start', handleDenoisingStart );
				app.denoiser.removeEventListener( 'end', handleDenoisingEnd );

			}

			app.removeEventListener( 'RenderComplete', () =>
				setViewportState( prev => ( { ...prev, renderComplete: true } ) )
			);
			app.removeEventListener( 'RenderReset', () =>
				setViewportState( prev => ( { ...prev, renderComplete: false } ) )
			);

		};

	}, [ updateStatsRef ] );

	// Expose the app instance via ref
	React.useImperativeHandle( ref, () => ( {
		getPathTracerApp: () => appRef.current
	} ), [] );

	// Effect for app initialization - dependencies optimized
	useEffect( () => {

		// Only initialize if the component is visible (not in results mode)
		if ( ! appRef.current && containerRef.current && appMode !== 'results' ) {

			appRef.current = new PathTracerApp( primaryCanvasRef.current, denoiserCanvasRef.current );
			window.pathTracerApp = appRef.current;
			appRef.current.setOnStatsUpdate( handleStatsUpdate );

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

		} else if ( appRef.current ) {

			// If app already exists, just update the stats callback
			appRef.current.setOnStatsUpdate( handleStatsUpdate );

		}

	}, [ handleStatsUpdate, setLoading, toast, appMode ] );

	// Effect for dimension updates
	useEffect( () => {

		const updateDimensions = () => {

			if ( primaryCanvasRef.current ) {

				const { width, height } = primaryCanvasRef.current;
				setViewportState( prev => ( { ...prev, dimensions: { width, height } } ) );

			}

		};

		window.addEventListener( 'resolution_changed', updateDimensions );
		return () => {

			window.removeEventListener( 'resolution_changed', updateDimensions );

		};

	}, [] );

	// Mode change handling (moved from MainViewport)
	useEffect( () => {

		// Update maxSamples when viewportMode changes
		const newMaxSamples = viewportMode === "interactive" ? 60 : 30;
		const app = appRef.current;

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
			setMaxSamples( newMaxSamples );
			updateStatsRef( { maxSamples: newMaxSamples, samples: 0 } );

		}

	}, [ viewportMode, setMaxSamples, updateStatsRef ] );

	// File type detection helpers
	const isEnvironmentMap = useCallback( ( fileName ) => {

		const extension = fileName.split( '.' ).pop().toLowerCase();
		return [ 'hdr', 'exr', 'png', 'jpg', 'jpeg', 'webp' ].includes( extension );

	}, [] );

	// Drag event handlers
	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();
		setViewportState( prev => ( { ...prev, isDragging: true } ) );

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		setViewportState( prev => ( { ...prev, isDragging: false } ) );

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
		setViewportState( prev => ( { ...prev, isDragging: false } ) );

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

		setViewportState( prev => ( { ...prev, viewportScale: scale } ) );

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

		if ( isDenoising ) return false;
		const currentSamples = statsRef.current ? statsRef.current.getStats().samples : 0;
		return renderComplete && currentSamples === maxSamples && viewportMode === "final";

	}, [ renderComplete, maxSamples, viewportMode, isDenoising ] );

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

			{/* Integrated Stats Meter */}
			<StatsMeter
				ref={statsRef}
				onMaxSamplesEdit={handleMaxSamplesEdit}
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
