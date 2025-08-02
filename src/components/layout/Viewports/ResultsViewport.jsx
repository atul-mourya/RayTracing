import { useRef, useEffect, useState, forwardRef, useMemo, useCallback } from 'react';
import { RotateCcw, Save, Eye } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { ImageProcessorComposer } from '@/utils/ImageProcessor';
import ViewportToolbar from './ViewportToolbar';
import { deleteRender, saveRender } from '@/utils/database';
import { useAutoFitScale } from '@/hooks/useAutoFitScale';
import { generateViewportStyles } from '@/utils/viewport';

const ResultsViewport = forwardRef( function ResultsViewport( props, ref ) {

	// State from store
	const imageData = useStore( state => state.selectedResult );
	const imageProcessing = useStore( state => state.imageProcessing );

	// Hooks
	const { toast } = useToast();

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const imageProcessorRef = useRef( null );

	// Local state
	const [ actualCanvasSize ] = useState( 512 );
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );
	const [ viewingOriginal, setViewingOriginal ] = useState( false );
	const [ selectedImageId, setSelectedImageId ] = useState( null );
	const [ originalSettings, setOriginalSettings ] = useState( null );
	const [ longPressActive, setLongPressActive ] = useState( false );
	const longPressTimeoutRef = useRef( null );
	const [ isHovering, setIsHovering ] = useState( false );

	// Auto-fit scaling logic
	const {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit
	} = useAutoFitScale( {
		viewportRef,
		canvasSize: actualCanvasSize,
		padding: 80,
		minScale: 25,
		maxScale: 300
	} );

	// Calculate if changes have been made using useMemo for efficiency
	const hasChanges = useMemo( () => {

		if ( ! originalSettings || ! imageProcessing ) return false;

		// Check if any property is different from original
		return Object.keys( originalSettings ).some( key =>
			originalSettings[ key ] !== imageProcessing[ key ]
		);

	}, [ originalSettings, imageProcessing ] );

	// Screenshot handler - defined early to avoid reference issues
	const handleScreenshot = useCallback( () => {

		console.log( "Screenshot called in ResultsViewport" );

		// Check if we have image data
		if ( ! imageData ) {

			console.log( "No image data" );
			toast( {
				title: "No Image",
				description: "Please select an image first.",
				variant: "destructive",
			} );
			return;

		}

		// Determine which canvas to download
		const canvasToDownload = viewingOriginal ? originalCanvasRef.current : editedCanvasRef.current;

		console.log( "Canvas to download:", canvasToDownload, "viewingOriginal:", viewingOriginal );

		if ( ! canvasToDownload ) {

			console.log( "No canvas available" );
			toast( {
				title: "Error",
				description: "Canvas not available for screenshot.",
				variant: "destructive",
			} );
			return;

		}

		try {

			const link = document.createElement( 'a' );
			link.href = canvasToDownload.toDataURL( 'image/png' );
			link.download = `raycanvas-${viewingOriginal ? 'original' : 'edited'}-${new Date().getTime()}.png`;
			link.click();

			console.log( "Screenshot download triggered" );

			toast( {
				title: "Screenshot Saved",
				description: `${viewingOriginal ? 'Original' : 'Edited'} image has been downloaded.`,
			} );

		} catch ( error ) {

			console.error( "Screenshot error:", error );
			toast( {
				title: "Screenshot Failed",
				description: "There was an error taking the screenshot.",
				variant: "destructive",
			} );

		}

	}, [ imageData, viewingOriginal, toast ] );

	// Expose ref functions
	useEffect( () => {

		if ( ! ref ) return;

		// In React 19, update the ref directly instead of using useImperativeHandle
		ref.current = {
			getCanvas: () => originalCanvasRef.current,
			getEditedCanvas: () => editedCanvasRef.current,
			getImageProcessor: () => imageProcessorRef.current,
			takeScreenshot: handleScreenshot
		};

	}, [ ref, handleScreenshot ] );

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

		const { brightness, contrast, saturation, hue, exposure, gamma } = imageProcessing;

		// Update brightness/contrast pass
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'brightness' ].value = brightness / 100;
		imageProcessorRef.current.brightnessContrastPass.uniforms[ 'contrast' ].value = contrast / 100;

		// Update other shader passes
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'saturation' ].value = saturation / 100;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'hue' ].value = hue;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'exposure' ].value = exposure / 100;
		imageProcessorRef.current.colorAdjustmentPass.uniforms[ 'gamma' ].value = gamma;

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

			// Store the original color correction settings
			const settings = { ...imageData.colorCorrection, gamma: imageData.colorCorrection.gamma ?? 2.2 };
			setOriginalSettings( settings );

			// Update color correction parameters in the store
			Object.keys( settings ).forEach( param => {

				useStore.getState().setImageProcessingParam( param, settings[ param ] );

			} );

			// Default to edited view
			setViewingOriginal( false );

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

	// Long press handling for original/edited view toggling
	const startLongPress = useCallback( () => {

		// Clear any existing timeout
		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );

		}

		// Start a timeout to activate long press
		longPressTimeoutRef.current = setTimeout( () => {

			setViewingOriginal( true );
			setLongPressActive( true );

		}, 200 ); // 200ms delay for long press to activate

	}, [] );

	const endLongPress = useCallback( () => {

		// Clear the timeout
		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

		// If long press was active, switch back to edited view
		if ( longPressActive ) {

			setViewingOriginal( false );
			setLongPressActive( false );

		}

	}, [ longPressActive ] );

	// Cancel long press on mouse/touch move
	const cancelLongPress = useCallback( () => {

		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

	}, [] );

	// Cleanup timeout on unmount
	useEffect( () => {

		return () => {

			if ( longPressTimeoutRef.current ) {

				clearTimeout( longPressTimeoutRef.current );

			}

		};

	}, [] );

	// Memoize style objects
	const { wrapperStyle, containerStyle, canvasStyle } = useMemo( () =>
		generateViewportStyles( actualCanvasSize, viewportScale ),
	[ actualCanvasSize, viewportScale ]
	);

	// UI handlers
	const resetImageProcessing = () => {

		// Check if we have original settings to reset to
		if ( originalSettings ) {

			// Reset each parameter to its original value
			Object.keys( originalSettings ).forEach( param => {

				useStore.getState().setImageProcessingParam( param, originalSettings[ param ] );

			} );

			toast( {
				title: "Processing Reset",
				description: "Image processing parameters have been reset to original values.",
			} );

		} else {

			// If no original settings, use the default reset
			useStore.getState().resetImageProcessing();

			toast( {
				title: "Processing Reset",
				description: "Image processing parameters have been reset to defaults.",
			} );

		}

	};

	// Save edited image with color correction settings
	const saveEditedImage = async () => {

		if ( ! imageData || ! editedCanvasRef.current ) return;

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

			// Update originalSettings to match the newly saved settings
			setOriginalSettings( { ...colorCorrectionSettings } );

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

	// Create a mock app ref for ViewportToolbar compatibility
	const mockAppRef = useRef( null );

	// Update mockAppRef when handleScreenshot changes
	useEffect( () => {

		mockAppRef.current = {
			takeScreenshot: handleScreenshot
		};

	}, [ handleScreenshot ] );

	return (
		<div ref={viewportRef} className="flex justify-center items-center h-full z-10">
			{/* Long press hint - only shows when hovering over the canvas or actively viewing original */}
			{imageData && ( isHovering || viewingOriginal ) && (
				<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-20">
					<div className="px-2 py-1 bg-black/80 rounded-md text-xs text-gray-300 flex items-center gap-1 shadow-md">
						<Eye size={12} className="text-gray-400" />
						{viewingOriginal ? "Viewing Original" : "Press & Hold to See Original"}
					</div>
				</div>
			)}

			{/* Save button only appears when changes have been made */}
			{imageData && hasChanges && ! viewingOriginal && (
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

			{/* Reset Processing button - specific to image editing */}
			{imageData && hasChanges && ! viewingOriginal && (
				<div className="absolute bottom-2 left-2 z-20">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={resetImageProcessing}
									className="flex items-center justify-center bg-secondary hover:bg-secondary/90 text-foreground px-2 py-1 rounded-full text-xs h-8"
									disabled={! imageData || viewingOriginal || ! hasChanges}
								>
									<RotateCcw size={12} className={`${( ! imageData || viewingOriginal || ! hasChanges ) ? 'text-foreground/30' : 'text-foreground/70'}`} />
								</button>
							</TooltipTrigger>
							<TooltipContent>
								<p className="text-xs">Reset Processing</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			)}

			{/* Viewport wrapper */}
			<div
				ref={viewportWrapperRef}
				className="relative"
				style={wrapperStyle}
				onMouseDown={imageData ? startLongPress : undefined}
				onTouchStart={imageData ? startLongPress : undefined}
				onMouseUp={imageData ? endLongPress : undefined}
				onMouseLeave={( e ) => {

					imageData && endLongPress( e );
					setIsHovering( false );

				}}
				onTouchEnd={imageData ? endLongPress : undefined}
				onMouseMove={imageData ? cancelLongPress : undefined}
				onTouchMove={imageData ? cancelLongPress : undefined}
				onMouseEnter={() => setIsHovering( true )}
			>
				{/* Container with fixed size */}
				<div
					ref={containerRef}
					className="relative cursor-pointer"
					style={containerStyle}
				>
					{/* Canvas for edited image */}
					<canvas
						ref={editedCanvasRef}
						width="2048"
						height="2048"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: viewingOriginal ? 'none' : 'block'
						}}
					/>

					{/* Canvas for original image */}
					<canvas
						ref={originalCanvasRef}
						width="2048"
						height="2048"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: viewingOriginal ? 'block' : 'none'
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

			{/* ViewportToolbar - replaces the old custom controls */}
			<ViewportToolbar
				onResize={handleViewportResize}
				viewportWrapperRef={viewportRef}
				appRef={mockAppRef}
				position="bottom-right"
				defaultSize={100}
				minSize={25}
				maxSize={300}
				zoomStep={25}
				autoFitScale={autoFitScale}
				isManualScale={isManualScale}
				onResetToAutoFit={handleResetToAutoFit}
				controls={{
					resetZoom: true,
					zoomButtons: true,
					zoomSlider: true,
					screenshot: true,
					resetCamera: false, // Not applicable to static images
					fullscreen: true
				}}
			/>
		</div>
	);

} );

export default ResultsViewport;
