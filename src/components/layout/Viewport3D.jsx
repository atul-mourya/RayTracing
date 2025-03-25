import React, { useRef, useEffect, useState, useCallback } from 'react';
import PathTracerApp from '../../core/main';
import { Upload, Maximize, Target, Camera } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import LoadingOverlay from './LoadingOverlay';
import ViewportResizer from './ViewportResizer';

const Viewport3D = ( { onStatsUpdate } ) => {

	const { toast } = useToast();
	const viewportWrapperRef = useRef( null ); // Outer wrapper for scaling
	const containerRef = useRef( null ); // Inner container that holds canvases
	const primaryCanvasRef = useRef( null );
	const denoiserCanvasRef = useRef( null );
	const appRef = useRef( null );
	const setLoading = useStore( ( state ) => state.setLoading );
	const [ isDragging, setIsDragging ] = useState( false );
	const [ dimensions, setDimensions ] = useState( { width: 512, height: 512 } );
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize ] = useState( 512 ); // Fixed canvas size

	useEffect( () => {

		if ( appRef.current ) return;

		if ( containerRef.current ) {

			appRef.current = new PathTracerApp( primaryCanvasRef.current, denoiserCanvasRef.current );
			window.pathTracerApp = appRef.current;
			appRef.current.setOnStatsUpdate( onStatsUpdate );

			setLoading( { isLoading: true, title: "Starting", status: "Setting up Scene...", progress: 0 } );
			appRef.current.init().catch( ( err ) => {

				console.error( "Error initializing PathTracerApp:", err );
				toast( {
					title: "Failed to load application",
					description: err.message || "Uh oh!! Something went wrong. Please try again.",
					variant: "destructive",
				} );

			} ).finally( () => {

				setLoading( { isLoading: true, title: "Starting", status: "Setting up Complete !", progress: 100 } );
				setTimeout( () => useStore.getState().resetLoading(), 1000 );
				window.pathTracerApp.reset();

			} );

		}

		// Update dimensions when window resizes
		const updateDimensions = () => {

			if ( primaryCanvasRef.current ) {

				const { width, height } = primaryCanvasRef.current;
				console.log( "Dimensions updated:", width, height );
				setDimensions( { width, height } );

			}

		};

		window.addEventListener( 'resolution_changed', updateDimensions );

	}, [ onStatsUpdate, setLoading, toast ] );

	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( true );

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

	}, [] );

	const handleDrop = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

		const file = e.dataTransfer.files[ 0 ];
		if ( file && file.name.toLowerCase().endsWith( '.glb' ) ) {

			setLoading( { isLoading: true, title: "Loading", status: "Processing Model...", progress: 0 } );
			const reader = new FileReader();
			reader.onload = ( event ) => {

				const arrayBuffer = event.target.result;
				if ( appRef.current && appRef.current.loadGLBFromArrayBuffer ) {

					appRef.current.loadGLBFromArrayBuffer( arrayBuffer )
						.then( () => {

							toast( {
								title: "Model Loaded",
								description: `Successfully loaded model !!`,
							} );

						} )
						.catch( ( err ) => {

							console.error( "Error loading GLB file:", err );
							toast( {
								title: "Failed to load GLB file",
								description: "Please try again.",
								variant: "destructive",
							} );

						} ).finally( () => {

							setLoading( { isLoading: true, title: "Loading", status: "Loading Complete !", progress: 100 } );
							setTimeout( () => useStore.getState().resetLoading(), 1000 );

						} );

				}

			};

			reader.readAsArrayBuffer( file );

		} else {

			toast( {
				title: "Invalid File",
				description: "Please drop a valid GLB file.",
				variant: "destructive",
			} );

		}

	}, [ setLoading, toast ] );

	const handleFullscreen = () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement ? document.exitFullscreen() : viewportWrapperRef.current.requestFullscreen();

	};

	const handleResetCamera = () => window.pathTracerApp && window.pathTracerApp.controls.reset();
	const handleScreenshot = () => window.pathTracerApp && window.pathTracerApp.takeScreenshot();
	const handleViewportResize = ( scale ) => setViewportScale( scale );

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
				style={{
					width: `${actualCanvasSize}px`,
					height: `${actualCanvasSize}px`,
					transform: `scale(${viewportScale / 100})`,
					transformOrigin: 'center center',
					transition: "transform 0.1s ease-out"
				}}
			>
				{/* Container with fixed size */}
				<div
					ref={containerRef}
					className={`relative ${isDragging ? 'bg-primary/10' : ''}`}
					style={{
						position: "relative",
						width: `${actualCanvasSize}px`,
						height: `${actualCanvasSize}px`,
						overflow: "hidden",
						background: "repeating-conic-gradient(rgb(128 128 128 / 20%) 0%, rgb(128 128 128 / 20%) 25%, transparent 0%, transparent 50%) 50% center / 20px 20px"
					}}
				>
					{/* denoiser container */}
					<canvas
						ref={denoiserCanvasRef}
						width="1024"
						height="1024"
						style={{ width: `${actualCanvasSize}px`, height: `${actualCanvasSize}px` }}
					/>
					{/* primary container */}
					<canvas
						ref={primaryCanvasRef}
						width="1024"
						height="1024"
						style={{ width: `${actualCanvasSize}px`, height: `${actualCanvasSize}px` }}
					/>

					{/* Dimensions display */}
					<div className="absolute left-0 bottom-0 right-0 text-center z-10">
						<div className="text-xs text-background">
							{dimensions.width} × {dimensions.height} ({viewportScale}%)
						</div>
					</div>
				</div>

			</div>
			{/* Controls */}
			<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
				<TooltipProvider>
					<ViewportResizer onResize={handleViewportResize} />
					<Tooltip>
						<TooltipTrigger asChild>
							<button onClick={handleScreenshot} className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110">
								<Camera size={12} className="bg-transparent border-white text-forground/50" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Take Screenshot</p>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<button onClick={handleResetCamera} className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110">
								<Target size={12} className="bg-transparent border-white text-forground/50" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reset Camera</p>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<button onClick={handleFullscreen} className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110">
								<Maximize size={12} className="bg-transparent border-white text-forground/50" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Fullscreen</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
			<Toaster />
			<LoadingOverlay />
			{isDragging && (
				<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-xs">
					<div className="flex flex-col items-center space-y-4">
						<Upload className="h-16 w-16 text-primary" />
						<p className="text-xl font-medium text-foreground">Drop GLB file here</p>
					</div>
				</div>
			)}
		</div>
	);

};

export default React.memo( Viewport3D );
