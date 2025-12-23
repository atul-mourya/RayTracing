import { useRef, useEffect, useState, forwardRef, useMemo, useCallback } from 'react';
import { debounce } from 'lodash';
import { RotateCcw, Save, Eye, Image as ImageIcon } from "lucide-react";
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

	// Access store values directly to avoid selector issues
	const imageData = useStore( state => state.selectedResult );
	const imageProcessing = useStore( state => state.imageProcessing );
	const setImageProcessingParam = useStore( state => state.setImageProcessingParam );

	// Hooks
	const { toast } = useToast();

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const aiCanvasRef = useRef( null );
	const imageProcessorRef = useRef( null );

	// Dynamic canvas size based on viewport and image quality
	const [ actualCanvasSize, setActualCanvasSize ] = useState( 512 );
	const [ imageLoadState, setImageLoadState ] = useState( { loaded: false, error: false } );
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );
	const [ viewingOriginal, setViewingOriginal ] = useState( false );
	const [ selectedImageId, setSelectedImageId ] = useState( null );
	const [ originalSettings, setOriginalSettings ] = useState( null );
	const [ longPressActive, setLongPressActive ] = useState( false );
	const longPressTimeoutRef = useRef( null );
	const [ isHovering, setIsHovering ] = useState( false );
	const [ viewingAIVariant, setViewingAIVariant ] = useState( false );

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

		// Also expose globally for real-time color correction
		window.resultsViewportRef = ref;

		// Cleanup global reference on unmount
		return () => {

			if ( window.resultsViewportRef === ref ) {

				window.resultsViewportRef = null;

			}

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
	const applyImageProcessing = useCallback( () => {

		if ( ! imageProcessorRef.current ) return;

		const { brightness, contrast, saturation, hue, exposure, gamma } = imageProcessing;

		// Update all parameters at once for better performance
		imageProcessorRef.current.setParameters( {
			brightness,
			contrast,
			saturation,
			hue,
			exposure,
			gamma
		} );

		// Render the result
		imageProcessorRef.current.render();

	}, [ imageProcessing ] );

	// Create debounced version using useEffect
	const debouncedApplyRef = useRef();
	useEffect( () => {

		debouncedApplyRef.current = debounce( () => {

			if ( ! imageProcessorRef.current ) return;

			const { brightness, contrast, saturation, hue, exposure, gamma } = useStore.getState().imageProcessing;
			imageProcessorRef.current.setParameters( {
				brightness,
				contrast,
				saturation,
				hue,
				exposure,
				gamma
			} );
			imageProcessorRef.current.render();

		}, 50 );

		return () => {

			debouncedApplyRef.current?.cancel();

		};

	}, [] );

	// Optimized image loading for 4K images
	useEffect( () => {

		if ( ! originalCanvasRef.current || ! editedCanvasRef.current || ! aiCanvasRef.current || ! imageData || ! imageData.image ) {

			console.log( 'Missing required data for image loading:', {
				originalCanvas: !! originalCanvasRef.current,
				editedCanvas: !! editedCanvasRef.current,
				aiCanvas: !! aiCanvasRef.current,
				imageData: !! imageData,
				imageDataImage: !! imageData?.image
			} );
			return;

		}

		const originalCanvas = originalCanvasRef.current;
		const aiCanvas = aiCanvasRef.current;
		const originalCtx = originalCanvas.getContext( '2d' );
		const aiCtx = aiCanvas.getContext( '2d' );
		const abortController = new AbortController();

		// Clear canvases and reset state
		originalCtx.clearRect( 0, 0, originalCanvas.width, originalCanvas.height );
		aiCtx.clearRect( 0, 0, aiCanvas.width, aiCanvas.height );
		setIsImageDrawn( false );
		setImageLoadState( { loaded: false, error: false } );
		setViewingAIVariant( false );

		// Helper function to draw image on canvas
		const drawImageOnCanvas = ( img, canvas, ctx ) => {

			const hRatio = canvas.width / img.width;
			const vRatio = canvas.height / img.height;
			const ratio = Math.min( hRatio, vRatio );

			const centerX = ( canvas.width - img.width * ratio ) / 2;
			const centerY = ( canvas.height - img.height * ratio ) / 2;

			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(
				img, 0, 0, img.width, img.height,
				centerX, centerY, img.width * ratio, img.height * ratio
			);
			ctx.imageSmoothingEnabled = true;

		};

		// Create image with optimized loading
		const img = new Image();
		img.crossOrigin = 'anonymous'; // Enable CORS for 4K images

		// Direct image loading without complex async wrapper
		img.onload = () => {

			if ( abortController.signal.aborted ) return;

			try {

				// Calculate optimal canvas size based on image and viewport
				const maxCanvasSize = Math.min( img.width, img.height, 2048 ); // Limit for 4K
				setActualCanvasSize( Math.min( maxCanvasSize, 1024 ) ); // Reasonable default

				// Draw the rendered image on original canvas
				drawImageOnCanvas( img, originalCanvas, originalCtx );

				// Load AI variant if it exists
				if ( imageData.aiGeneratedImage ) {

					const aiImg = new Image();
					aiImg.crossOrigin = 'anonymous';

					aiImg.onload = () => {

						if ( ! abortController.signal.aborted ) {

							drawImageOnCanvas( aiImg, aiCanvas, aiCtx );

						}

					};

					aiImg.onerror = ( error ) => {

						console.error( 'Failed to load AI variant image:', error );

					};

					aiImg.src = imageData.aiGeneratedImage;

				}

				setIsImageDrawn( true );
				setImageLoadState( { loaded: true, error: false } );

				// Initialize image processor with the new image
				if ( imageProcessorRef.current && ! abortController.signal.aborted ) {

					// Update the texture with the new image
					imageProcessorRef.current.quad.material.map.needsUpdate = true;
					// Note: processing will be applied automatically via the debounced effect

				}

				// Save the ID of the selected image for later use
				setSelectedImageId( imageData.id );

				// Store the original color correction settings
				const settings = { ...imageData.colorCorrection, gamma: imageData.colorCorrection.gamma ?? 2.2 };
				setOriginalSettings( settings );

				// Update color correction parameters in the store
				Object.keys( settings ).forEach( param => {

					setImageProcessingParam( param, settings[ param ] );

				} );

				// Default to edited view
				setViewingOriginal( false );

			} catch ( error ) {

				if ( ! abortController.signal.aborted ) {

					console.error( 'Error processing 4K image:', error );
					setImageLoadState( { loaded: false, error: true } );

				}

			}

		};

		img.onerror = ( error ) => {

			if ( ! abortController.signal.aborted ) {

				console.error( 'Failed to load 4K image:', imageData.image, error );
				setImageLoadState( { loaded: false, error: true } );

			}

		};

		img.src = imageData.image;

		return () => {

			abortController.abort();
			img.onload = null;
			img.onerror = null;

		};

	}, [ imageData, setImageProcessingParam ] );

	// Apply image processing when parameters change (debounced for 4K performance)
	useEffect( () => {

		if ( isImageDrawn && imageProcessorRef.current ) {

			// Use direct application for immediate updates (real-time handlers will bypass this)
			applyImageProcessing();

		}

		// Cleanup debounce on unmount
		return () => {

			debouncedApplyRef.current?.cancel();

		};

	}, [ imageProcessing, isImageDrawn, applyImageProcessing ] );

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
	const { wrapperStyle, containerStyle } = useMemo( () =>
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

			{/* AI/Render toggle button - appears when AI variant exists */}
			{imageData && imageData.aiGeneratedImage && ! viewingOriginal && (
				<div className="absolute top-2 right-2 z-20 flex space-x-2">
					<button
						onClick={() => setViewingAIVariant( ! viewingAIVariant )}
						className="flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white px-3 py-1 rounded-md text-xs"
					>
						<ImageIcon size={12} className="mr-1" />
						{viewingAIVariant ? 'Show Render' : 'Show AI'}
					</button>
				</div>
			)}

			{/* Save button only appears when changes have been made */}
			{imageData && hasChanges && ! viewingOriginal && ! viewingAIVariant && (
				<div className="absolute top-2 right-20 z-20 flex space-x-2">
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
					{/* Loading indicator for 4K images */}
					{imageData && ! imageLoadState.loaded && ! imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
							<div className="flex flex-col items-center space-y-2">
								<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
								<p className="text-sm">Loading 4K image...</p>
							</div>
						</div>
					)}

					{/* Error state for 4K image loading */}
					{imageData && imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
							<div className="text-center">
								<p className="text-sm text-red-400 mb-2">Failed to load 4K image</p>
								<p className="text-xs text-gray-400">The image may be corrupted or too large</p>
							</div>
						</div>
					)}

					{/* Canvas for edited image - optimized for 4K */}
					<canvas
						ref={editedCanvasRef}
						width="2048"
						height="2048"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: ( viewingOriginal || viewingAIVariant || ! imageLoadState.loaded ) ? 'none' : 'block',
							imageRendering: 'pixelated' // Better for 4K images
						}}
					/>

					{/* Canvas for original image - optimized for 4K */}
					<canvas
						ref={originalCanvasRef}
						width="2048"
						height="2048"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: ( viewingOriginal && imageLoadState.loaded && ! viewingAIVariant ) ? 'block' : 'none',
							imageRendering: 'pixelated' // Better for 4K images
						}}
					/>

					{/* Canvas for AI variant - optimized for 4K */}
					<canvas
						ref={aiCanvasRef}
						width="2048"
						height="2048"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black',
							display: ( viewingAIVariant && imageLoadState.loaded && ! viewingOriginal ) ? 'block' : 'none',
							imageRendering: 'pixelated' // Better for 4K images
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
