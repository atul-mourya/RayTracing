import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import DimensionDisplay from './DimensionDisplay';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';
import ViewportToolbar from './ViewportToolbar';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { saveRender } from '@/utils/database';
import { useAutoFitScale } from '@/hooks/useAutoFitScale';
import { generateViewportStyles } from '@/utils/viewport';


const Viewport3D = forwardRef( ( { viewportMode = "interactive" }, ref ) => {

	const { toast } = useToast();

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const primaryCanvasRef = useRef( null );
	const denoiserCanvasRef = useRef( null );
	const appRef = useRef( null );
	const isInitialized = useRef( false );

	// Viewport state
	const [ actualCanvasSize, setActualCanvasSize ] = useState( 512 );
	const [ canvasReady, setCanvasReady ] = useState( false );
	const [ renderResolution, setRenderResolution ] = useState( { width: 512, height: 512 } );
	const [ isAppInitialized, setIsAppInitialized ] = useState( false );

	// Optimized store subscriptions
	const isDenoising = useStore( useCallback( state => state.isDenoising, [] ) );
	const isRenderComplete = useStore( useCallback( state => state.isRenderComplete, [] ) );
	const setIsRenderComplete = useStore( useCallback( state => state.setIsRenderComplete, [] ) );

	// Store access - memoized to prevent recreation
	const setLoading = useStore( useCallback( state => state.setLoading, [] ) );
	const appMode = useStore( useCallback( state => state.appMode, [] ) );

	// Auto-fit scaling logic - only initialize after canvases are ready
	const {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit
	} = useAutoFitScale( {
		viewportRef,
		canvasSize: actualCanvasSize,
		padding: 40,
		minScale: 25,
		maxScale: 200,
		enabled: canvasReady // Only enable auto-fit after canvases are ready
	} );


	// Effect to mark canvases as ready
	useEffect( () => {

		if ( primaryCanvasRef.current && denoiserCanvasRef.current ) {

			// Small delay to ensure DOM is fully rendered
			const timer = setTimeout( () => {

				setCanvasReady( true );

			}, 100 );

			return () => clearTimeout( timer );

		}

	}, [ actualCanvasSize ] );

	// Effect to listen for resolution changes and update render resolution
	useEffect( () => {

		const handleResolutionChange = ( { width, height } ) => {

			setRenderResolution( { width, height } );

		};

		// Listen for resolution change events
		window.addEventListener( 'resolution_changed', ( event ) => handleResolutionChange( event.detail ) );

		// Set initial resolution when app is initialized
		if ( isAppInitialized && appRef.current ) {

			// Get the actual canvas dimensions from the app
			const app = appRef.current;
			if ( app && app.width && app.height ) {

				handleResolutionChange( { width: app.width, height: app.height } );

			}

		}

		return () => {

			window.removeEventListener( 'resolution_changed', handleResolutionChange );

		};

	}, [ isAppInitialized ] );


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
			// setRenderComplete( false );
			setIsRenderComplete( false );

		} catch ( error ) {

			console.error( 'Failed to save render:', error );
			toast( {
				title: "Failed to save render",
				description: "See console for details.",
				variant: "destructive",
			} );

		}

	}, [ setIsRenderComplete, toast ] );

	const handleDiscard = useCallback( () => {

		setIsRenderComplete( false );

	}, [ setIsRenderComplete ] );


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
					resetLoadingFn();

					if ( window.pathTracerApp ) {

						window.pathTracerApp.reset();

					}

					isInitialized.current = true;
					setIsAppInitialized( true );

				} );

		}

	}, [ setLoading, toast, appMode ] );


	// Compute whether to show save controls
	const shouldShowSaveControls = useMemo( () => {

		if ( ! window.pathTracerApp ) return false;
		if ( viewportMode !== "final" ) return false;
		if ( ! isRenderComplete ) return false;
		if ( isDenoising ) return false;
		return window.pathTracerApp.pathTracingPass.isComplete;

	}, [ isRenderComplete, isDenoising, viewportMode ] );

	// Memoize style objects
	const { wrapperStyle, containerStyle, canvasStyle } = useMemo( () =>
		generateViewportStyles( actualCanvasSize, viewportScale ),
	[ actualCanvasSize, viewportScale ]
	);

	return (
		<div ref={viewportRef} className="flex justify-center items-center h-full overflow-scroll" >

			<div ref={viewportWrapperRef} className="relative shadow-2xl" style={wrapperStyle} >
				<div ref={containerRef} className={`relative`} style={containerStyle} >
					<canvas
						ref={denoiserCanvasRef}
						width={actualCanvasSize}
						height={actualCanvasSize}
						style={canvasStyle}
					/>
					<canvas
						ref={primaryCanvasRef}
						width={actualCanvasSize}
						height={actualCanvasSize}
						style={canvasStyle}
					/>
					<DimensionDisplay dimension={renderResolution} />
				</div>
			</div>

			<StatsMeter viewportMode={viewportMode} appRef={appRef} />

			{shouldShowSaveControls && (
				<SaveControls onSave={handleSave} onDiscard={handleDiscard} />
			)}

			{canvasReady && (
				<ViewportToolbar
					onResize={handleViewportResize}
					viewportWrapperRef={viewportRef}
					appRef={appRef}
					autoFitScale={autoFitScale}
					isManualScale={isManualScale}
					onResetToAutoFit={handleResetToAutoFit}
				/>
			)}

		</div>
	);

} );

Viewport3D.displayName = 'Viewport3D';

// Export a memoized version of the component
export default React.memo( Viewport3D );
