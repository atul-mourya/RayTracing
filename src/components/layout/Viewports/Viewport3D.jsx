import React, { useRef, useEffect, useState, useCallback, forwardRef, useMemo } from 'react';
import PathTracerApp from '../../../core/main';
import DimensionDisplay from './DimensionDisplay';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';
import ViewportToolbar from './ViewportToolbar';
import InteractionContextMenu from '@/components/ui/InteractionContextMenu';
import { useToast } from '@/hooks/use-toast';
import { useStore, usePathTracerStore } from '@/store';
import { saveRender } from '@/utils/database';
import { useAutoFitScale } from '@/hooks/useAutoFitScale';
import { generateViewportStyles } from '@/utils/viewport';
import { getBackendManager, BackendType } from '@/core/BackendManager.js';
import { WebGPUPathTracerApp } from '@/core/WebGPU/WebGPUPathTracerApp.js';
import { getApp } from '@/core/appProxy';


const Viewport3D = forwardRef( ( { viewportMode = "preview" }, ref ) => {

	const { toast } = useToast();

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const webglCanvasRef = useRef( null ); // WebGL primary canvas
	const webgpuCanvasRef = useRef( null ); // WebGPU canvas
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
	const stats = useStore( useCallback( state => state.stats, [] ) );

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

		if ( webglCanvasRef.current && webgpuCanvasRef.current && denoiserCanvasRef.current ) {

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
				renderTime: stats.timeElapsed || 0,
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

	}, [ setIsRenderComplete, toast, stats ] );

	const handleDiscard = useCallback( () => {

		setIsRenderComplete( false );

	}, [ setIsRenderComplete ] );


	// Effect for app initialization - dependencies optimized
	useEffect( () => {

		// Only initialize if the component is visible (not in results mode)
		if ( ! appRef.current && containerRef.current && appMode !== 'results' ) {

			// Initialize WebGL app with its dedicated canvas
			appRef.current = new PathTracerApp( webglCanvasRef.current, denoiserCanvasRef.current );
			window.pathTracerApp = appRef.current;

			setLoading( { isLoading: true, title: "Starting", status: "Setting up Scene...", progress: 0 } );

			appRef.current.init()
				.then( async () => {

					// Initialize BackendManager and register WebGL app
					const backendManager = getBackendManager();
					backendManager.setCanvasRefs( webglCanvasRef, webgpuCanvasRef, denoiserCanvasRef );

					// Check WebGPU support and update store
					const { setIsWebGPUSupported, backend, setBackend } = usePathTracerStore.getState();
					const isWebGPUSupported = backendManager.canUseWebGPU();
					setIsWebGPUSupported( isWebGPUSupported );

					// Determine which backend to use initially
					const initialBackend = isWebGPUSupported && backend === 'webgpu' ? 'webgpu' : 'webgl';

					// Set backend state before registering apps so BackendManager knows which to pause
					backendManager.currentBackend = initialBackend === 'webgpu' ? BackendType.WEBGPU : BackendType.WEBGL;

					// Register WebGL app (will auto-pause if not active backend)
					backendManager.setWebGLApp( appRef.current );

					// If WebGPU is supported, initialize WebGPU app
					if ( isWebGPUSupported ) {

						try {

							setLoading( { isLoading: true, title: "Starting", status: "Initializing WebGPU...", progress: 80 } );

							// Initialize WebGPU app with its dedicated canvas
							const webgpuApp = new WebGPUPathTracerApp( webgpuCanvasRef.current, appRef.current );
							await webgpuApp.init();
							webgpuApp.loadSceneData();

							// Register WebGPU app (will auto-pause if not active backend)
							backendManager.setWebGPUApp( webgpuApp );
							window.webgpuPathTracerApp = webgpuApp;

							console.log( 'WebGPU backend initialized and ready' );

							// Switch to WebGPU if it's the desired backend
							if ( backend === 'webgpu' ) {

								await backendManager.setBackend( BackendType.WEBGPU );
								// Start animation loop for WebGPU
								webgpuApp.animate();

							}

						} catch ( err ) {

							console.warn( 'WebGPU initialization failed, using WebGL:', err.message );
							setBackend( 'webgl' );
							backendManager.currentBackend = BackendType.WEBGL;

						}

					} else {

						console.log( 'WebGPU not supported, using WebGL backend' );
						setBackend( 'webgl' );

					}

					// Ensure canvas visibility matches active backend
					backendManager.toggleCanvasVisibility( backendManager.currentBackend );

				} )
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

					if ( getApp() ) {

						getApp().reset();

					}

					isInitialized.current = true;
					setIsAppInitialized( true );

					// Re-dispatch SceneRebuild now that getApp() is available
					// (the initial SceneRebuild fires during init before isInitialized is set,
					// so UI components like Outliner miss the scene data)
					window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

				} );

		}

	}, [ setLoading, toast, appMode ] );

	// Disable select mode when leaving preview mode
	useEffect( () => {

		const app = getApp();
		if ( app && appMode !== 'preview' ) {

			app.disableSelectMode?.();

		}

	}, [ appMode ] );

	// Compute whether to show save controls
	const shouldShowSaveControls = useMemo( () => {

		if ( ! getApp() ) return false;
		if ( viewportMode !== "final-render" ) return false;
		if ( ! isRenderComplete ) return false;
		if ( isDenoising ) return false;
		return getApp().isComplete();

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
					{/* WebGL Canvas */}
					<canvas
						ref={webglCanvasRef}
						width={actualCanvasSize}
						height={actualCanvasSize}
						style={canvasStyle}
						data-backend="webgl"
					/>
					{/* WebGPU Canvas */}
					<canvas
						ref={webgpuCanvasRef}
						width={actualCanvasSize}
						height={actualCanvasSize}
						style={{ ...canvasStyle, display: 'none' }}
						data-backend="webgpu"
					/>
					<DimensionDisplay dimension={renderResolution} />
				</div>
			</div>

			<StatsMeter viewportMode={viewportMode} />

			{shouldShowSaveControls && (
				<SaveControls onSave={handleSave} onDiscard={handleDiscard} />
			)}

			{canvasReady && (
				<ViewportToolbar
					onResize={handleViewportResize}
					viewportWrapperRef={viewportRef}
					autoFitScale={autoFitScale}
					isManualScale={isManualScale}
					onResetToAutoFit={handleResetToAutoFit}
				/>
			)}

			<InteractionContextMenu appRef={appRef} isAppInitialized={isAppInitialized} />

		</div>
	);

} );

Viewport3D.displayName = 'Viewport3D';

// Export a memoized version of the component
export default React.memo( Viewport3D );
