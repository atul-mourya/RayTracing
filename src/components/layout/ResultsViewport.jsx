import { useRef, useEffect, useState, forwardRef } from 'react';
import { Camera, Maximize, RotateCcw, Save } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { ImageProcessorComposer } from '@/utils/ImageProcessor';
import ViewportResizer from './ViewportResizer';
import { deleteRender, saveRender } from '@/utils/database';

const ResultsViewport = forwardRef( function ResultsViewport( props, ref ) {

	// State from store
	const imageData = useStore( state => state.selectedResult );
	const imageProcessing = useStore( state => state.imageProcessing );

	// Hooks
	const { toast } = useToast();

	// Refs
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const imageProcessorRef = useRef( null );

	// Local state
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize ] = useState( 512 );
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );
	const [ showEditedCanvas, setShowEditedCanvas ] = useState( false );
	const [ selectedImageId, setSelectedImageId ] = useState( null );

	// Expose ref functions
	useEffect( () => {

		if ( ! ref ) return;

		// In React 19, update the ref directly instead of using useImperativeHandle
		ref.current = {
			getCanvas: () => originalCanvasRef.current,
			getEditedCanvas: () => editedCanvasRef.current,
			getImageProcessor: () => imageProcessorRef.current
		};

	}, [ ref ] );

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

	// Apply current image processing settings
	const applyImageProcessing = () => {

		if ( ! imageProcessorRef.current ) return;

		const { brightness, contrast, saturation, hue, exposure } = imageProcessing;

		// Update brightness/contrast pass
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'brightness' ].value = brightness / 100;
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'contrast' ].value = contrast / 100;

		// Update other shader passes
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'saturation' ].value = saturation / 100;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'hue' ].value = hue;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'exposure' ].value = exposure / 100;

		// Render the result
		imageProcessorRef.current.render();

	};

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

		img.onload = async () => {

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

			// Save the ID of the selected image for later use
			setSelectedImageId( imageData.id );

			// Apply the stored color correction settings
			const settings = imageData.colorCorrection;

			// Update color correction parameters in the store
			Object.keys( settings ).forEach( param => {

				useStore.getState().setImageProcessingParam( param, settings[ param ] );

			} );

			// Show the edited view
			setShowEditedCanvas( true );

		};

		img.src = imageData.image;

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

	// UI handlers
	const handleViewportResize = ( scale ) => setViewportScale( scale );

	const handleFullscreen = () => {

		if ( ! viewportWrapperRef.current ) return;

		if ( document.fullscreenElement ) {

			document.exitFullscreen();

		} else {

			viewportWrapperRef.current.requestFullscreen();

		}

	};

	const handleScreenshot = () => {

		if ( ! ( showEditedCanvas ? editedCanvasRef.current : originalCanvasRef.current ) || ! imageData ) return;

		const canvasToDownload = showEditedCanvas ? editedCanvasRef.current : originalCanvasRef.current;
		const link = document.createElement( 'a' );
		link.href = canvasToDownload.toDataURL( 'image/png' );
		link.download = `raycanvas-${showEditedCanvas ? 'edited' : 'original'}-${new Date().getTime()}.png`;
		link.click();

		toast( {
			title: "Screenshot Saved",
			description: `${showEditedCanvas ? 'Edited' : 'Original'} image has been downloaded.`,
		} );

	};

	const resetImageProcessing = () => {

		useStore.getState().resetImageProcessing();
		toast( {
			title: "Processing Reset",
			description: "Image processing parameters have been reset to defaults.",
		} );

	};

	// Save edited image with color correction settings
	const saveEditedImage = async () => {

		if ( ! imageData || ! showEditedCanvas || ! editedCanvasRef.current ) return;

		try {

			// Get the current color correction settings
			const colorCorrectionSettings = { ...imageProcessing };

			// Delete any existing edit of this image first
			await deleteRender( selectedImageId );

			// Create a new edit record
			const saveData = {
				image: imageData.image,
				colorCorrection: colorCorrectionSettings,
				timestamp: new Date(),
				isEdited: true
			};

			const newId = await saveRender( saveData );

			// Update the selectedImageId with the new record's ID
			setSelectedImageId( newId );

			toast( {
				title: "Edited Image Saved",
				description: "Image with color correction settings has been saved.",
			} );

			// Dispatch event to refresh the results panel
			window.dispatchEvent( new Event( 'render-saved' ) );

		} catch ( error ) {

			console.error( "Error saving edited image:", error );
			toast( {
				title: "Error Saving Image",
				description: "There was a problem saving your edited image.",
				variant: "destructive",
			} );

		}

	};

	return (
		<div className="flex justify-center items-center h-full z-10">
			{/* View mode tabs */}
			<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-20">
				<div className="flex bg-black/80 rounded-md overflow-hidden shadow-md" style={{ border: '1px solid rgba(60, 60, 60, 0.8)' }}>
					<button
						onClick={() => setShowEditedCanvas( false )}
						className={`px-4 py-2 text-xs font-medium transition-colors ${! showEditedCanvas ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
						disabled={! imageData}
					>
						Original
					</button>
					<button
						onClick={() => setShowEditedCanvas( true )}
						className={`px-4 py-2 text-xs font-medium transition-colors ${showEditedCanvas ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
						disabled={! imageData}
					>
						Edited
					</button>
				</div>
			</div>

			{/* Save button when in edited view */}
			{showEditedCanvas && imageData && (
				<div className="absolute top-2 right-2 z-20 flex space-x-2">
					<button
						onClick={saveEditedImage}
						className="flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1 rounded-md text-xs"
					>
						<Save size={12} className="mr-1" />
						Save
					</button>
				</div>
			)}

			{/* Viewport wrapper */}
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
					{/* Canvas for edited image */}
					<canvas
						ref={editedCanvasRef}
						width="1024"
						height="1024"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: showEditedCanvas ? 'block' : 'none'
						}}
					/>

					{/* Canvas for original image */}
					<canvas
						ref={originalCanvasRef}
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
				</div>
			</div>

			{/* Controls */}
			<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
				<TooltipProvider>
					<ViewportResizer onResize={handleViewportResize} />

					<Tooltip>
						<TooltipTrigger asChild>
							<button
								onClick={resetImageProcessing}
								className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
								disabled={! imageData || ! showEditedCanvas}
							>
								<RotateCcw size={12} className="bg-transparent border-white text-forground/50" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Reset Processing</p>
						</TooltipContent>
					</Tooltip>

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

export default ResultsViewport;
