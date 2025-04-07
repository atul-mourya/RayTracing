import React, { useRef, useEffect, useState, forwardRef } from 'react';
import { Camera, Maximize, Edit, RotateCcw } from "lucide-react"; // Added RotateCcw for reset
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { ImageProcessorComposer } from '@/utils/ImageProcessor';

const ResultsViewport = forwardRef( ( props, ref ) => {

	const imageData = useStore( state => state.selectedResult );
	const imageProcessing = useStore( state => state.imageProcessing );
	const { toast } = useToast();
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize ] = useState( 512 );
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );
	const [ showEditedCanvas, setShowEditedCanvas ] = useState( false );
	const imageProcessorRef = useRef( null );

	// Expose ref functions
	React.useImperativeHandle( ref, () => ( {
		getCanvas: () => originalCanvasRef.current,
		getEditedCanvas: () => editedCanvasRef.current,
		getImageProcessor: () => imageProcessorRef.current
	} ) );

	const applyImageProcessing = () => {

		if ( ! imageProcessorRef.current ) return;

		// Update shader uniforms with current image processing parameters
		const { brightness, contrast, saturation, hue, exposure } = imageProcessing;

		// Update brightness/contrast pass
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'brightness' ].value = brightness / 100;
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'contrast' ].value = contrast / 100;

		// You would add other shader passes for saturation, hue, exposure, etc.
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'saturation' ].value = saturation / 100;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'hue' ].value = hue;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'exposure' ].value = exposure / 100;

		// Then render the result
		imageProcessorRef.current.render();

	};

	// Initialize image processor when canvases are ready
	useEffect( () => {

		if ( originalCanvasRef.current && editedCanvasRef.current && ! imageProcessorRef.current ) {

			imageProcessorRef.current = new ImageProcessorComposer(
				originalCanvasRef.current,
				editedCanvasRef.current
			);

		}

		return () => {

			if ( imageProcessorRef.current ) {

				imageProcessorRef.current.dispose();
				imageProcessorRef.current = null;

			}

		};

	}, [] );

	// Draw original image when image data changes
	useEffect( () => {

		if ( ! originalCanvasRef.current || ! editedCanvasRef.current || ! imageData ) return;

		const originalCanvas = originalCanvasRef.current;
		const originalCtx = originalCanvas.getContext( '2d' );

		// Clear canvases
		originalCtx.clearRect( 0, 0, originalCanvas.width, originalCanvas.height );
		setIsImageDrawn( false );

		// Load the image
		const img = new Image();
		img.onload = () => {

			// Calculate dimensions to maintain aspect ratio
			const hRatio = originalCanvas.width / img.width;
			const vRatio = originalCanvas.height / img.height;
			const ratio = Math.min( hRatio, vRatio );

			// Center the image
			const centerX = ( originalCanvas.width - img.width * ratio ) / 2;
			const centerY = ( originalCanvas.height - img.height * ratio ) / 2;

			// Draw the image on original canvas
			originalCtx.drawImage(
				img, 0, 0, img.width, img.height,
				centerX, centerY, img.width * ratio, img.height * ratio
			);

			setIsImageDrawn( true );

			// Initialize image processor with the new image
			if ( imageProcessorRef.current ) {

				// Update the texture with the new image
				imageProcessorRef.current.quad.material.map.needsUpdate = true;
				// Apply processing and render to edited canvas
				applyImageProcessing();

			}

		};

		img.src = imageData;

		return () => {

			img.onload = null;

		};

	}, [ imageData ] );

	// Apply image processing when parameters change
	useEffect( () => {

		if ( isImageDrawn && imageProcessorRef.current ) {

			applyImageProcessing();

		}

	}, [ imageProcessing, isImageDrawn ] );


	const handleFullscreen = () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement ? document.exitFullscreen() : viewportWrapperRef.current.requestFullscreen();

	};

	const handleScreenshot = () => {

		if ( ( showEditedCanvas ? editedCanvasRef.current : originalCanvasRef.current ) && imageData ) {

			const canvasToDownload = showEditedCanvas ? editedCanvasRef.current : originalCanvasRef.current;
			const link = document.createElement( 'a' );
			link.href = canvasToDownload.toDataURL( 'image/png' );
			link.download = `raycanvas-${showEditedCanvas ? 'edited' : 'original'}-${new Date().getTime()}.png`;
			link.click();

			toast( {
				title: "Screenshot Saved",
				description: `${showEditedCanvas ? 'Edited' : 'Original'} image has been downloaded.`,
			} );

		}

	};

	const toggleEditedView = () => {

		setShowEditedCanvas( ! showEditedCanvas );

	};

	const resetImageProcessing = () => {

		useStore.getState().resetImageProcessing();
		toast( {
			title: "Processing Reset",
			description: "Image processing parameters have been reset to defaults.",
		} );

	};

	return (
		<div className="flex justify-center items-center h-full z-10">
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
					className="relative"
					style={{
						position: "relative",
						width: `${actualCanvasSize}px`,
						height: `${actualCanvasSize}px`,
						overflow: "hidden",
						background: "repeating-conic-gradient(rgb(128 128 128 / 20%) 0%, rgb(128 128 128 / 20%) 25%, transparent 0%, transparent 50%) 50% center / 20px 20px"
					}}
				>
					{/* Canvas to display the edited image */}
					<canvas
						ref={originalCanvasRef}
						width="1024"
						height="1024"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: showEditedCanvas ? 'block' : 'none'
						}}
					/>

					{/* Canvas to display the original result */}
					<canvas
						ref={editedCanvasRef}
						width="1024"
						height="1024"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: showEditedCanvas ? 'none' : 'block'
						}}
					/>

					{/* Message when no image is selected */}
					{! imageData && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white">
							<p>Select a render from the Results panel</p>
						</div>
					)}

					{/* Dimensions display */}
					<div className="absolute left-0 bottom-0 right-0 text-center z-10">
						<div className="text-xs text-background">
                            1024 × 1024 ({viewportScale}%) - {showEditedCanvas ? 'Edited View' : 'Original View'}
						</div>
					</div>
				</div>
			</div>

			{/* Controls */}
			<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								onClick={toggleEditedView}
								className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
								disabled={! imageData}
							>
								<Edit size={12} className={`bg-transparent border-white ${showEditedCanvas ? 'text-primary' : 'text-forground/50'}`} />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>{showEditedCanvas ? 'Show Original' : 'Show Edited'}</p>
						</TooltipContent>
					</Tooltip>

					{showEditedCanvas && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={resetImageProcessing}
									className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
									disabled={! imageData}
								>
									<RotateCcw size={12} className="bg-transparent border-white text-forground/50" />
								</button>
							</TooltipTrigger>
							<TooltipContent>
								<p>Reset Processing</p>
							</TooltipContent>
						</Tooltip>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<button
								onClick={handleScreenshot}
								className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
								disabled={! imageData}
							>
								<Camera size={12} className="bg-transparent border-white text-forground/50" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Save Image</p>
						</TooltipContent>
					</Tooltip>

					<Tooltip>
						<TooltipTrigger asChild>
							<button
								onClick={handleFullscreen}
								className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
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
		</div>
	);

} );

ResultsViewport.displayName = 'ResultsViewport';

export default React.memo( ResultsViewport );
