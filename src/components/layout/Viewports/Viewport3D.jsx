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
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const primaryCanvasRef = useRef( null );
	const denoiserCanvasRef = useRef( null );
	const appRef = useRef( null );
	const isInitialized = useRef( false );
	const statsRef = useRef( null );

	// Viewport state - now using separate useState hooks
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize, setActualCanvasSize ] = useState( 512 ); // Fixed canvas size
	const [ renderComplete, setRenderComplete ] = useState( false );

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

	// Control button handlers
	const handleViewportResize = useCallback( ( scale ) => {

		setViewportScale( scale );

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
					className={`relative`}
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
					<DimensionDisplay canvasRef={primaryCanvasRef} />
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
			<ViewportToolbar
				onResize={handleViewportResize}
				viewportWrapperRef={viewportWrapperRef}
				appRef={appRef}
			/>

		</div>
	);

} );

Viewport3D.displayName = 'Viewport3D';

// Export a memoized version of the component
export default React.memo( Viewport3D );
