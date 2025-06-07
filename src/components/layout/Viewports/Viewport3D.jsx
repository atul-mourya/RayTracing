import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import DimensionDisplay from './DimensionDisplay';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';
import ViewportToolbar from './ViewportToolbar';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { saveRender } from '@/utils/database';


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

	// Viewport state - now using separate useState hooks
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize, setActualCanvasSize ] = useState( 512 ); // Fixed canvas size
	const isDenoising = useStore( state => state.isDenoising );
	const isRenderComplete = useStore( state => state.isRenderComplete );
	const setIsRenderComplete = useStore( state => state.setIsRenderComplete );

	// Store access - memoized to prevent recreation
	const setLoading = useStore( ( state ) => state.setLoading );
	const appMode = useStore( state => state.appMode );

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
					resetLoadingFn();

					if ( window.pathTracerApp ) {

						window.pathTracerApp.reset();

					}

					isInitialized.current = true;

				} );

		}

	}, [ setLoading, toast, appMode ] );

	// Control button handlers
	const handleViewportResize = useCallback( ( scale ) => {

		setViewportScale( scale );

	}, [] );


	// Compute whether to show save controls
	const shouldShowSaveControls = useMemo( () => {

		if ( ! window.pathTracerApp ) return false;
		if ( viewportMode !== "final" ) return false;
		if ( ! isRenderComplete ) return false;
		if ( isDenoising ) return false;
		return window.pathTracerApp.pathTracingPass.isComplete;

	}, [ isRenderComplete, isDenoising, viewportMode ] );

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
		<div ref={viewportRef} className="flex justify-center items-center h-full overflow-scroll" >

			<div ref={viewportWrapperRef} className="relative shadow-2xl" style={wrapperStyle} >
				<div ref={containerRef} className={`relative`} style={containerStyle} >
					<canvas ref={denoiserCanvasRef} width="1024" height="1024" style={canvasStyle} />
					<canvas ref={primaryCanvasRef} width="1024" height="1024" style={canvasStyle} />
					<DimensionDisplay canvasRef={primaryCanvasRef} />
				</div>
			</div>

			<StatsMeter viewportMode={viewportMode} appRef={appRef} />

			{shouldShowSaveControls && (
				<SaveControls onSave={handleSave} onDiscard={handleDiscard} />
			)}

			<ViewportToolbar onResize={handleViewportResize} viewportWrapperRef={viewportRef} appRef={appRef} />

		</div>
	);

} );

Viewport3D.displayName = 'Viewport3D';

// Export a memoized version of the component
export default React.memo( Viewport3D );
