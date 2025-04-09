import { useRef, useEffect, useState, forwardRef } from 'react';
import { Camera, Maximize, RotateCcw, Save, X } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { ImageProcessorComposer } from '@/utils/ImageProcessor';
import ViewportResizer from './ViewportResizer';
import { getDatabase, deleteRender, saveRender, getRenderById, getAllRenders } from '@/utils/database';

const ResultsViewport = forwardRef( function ResultsViewport( props, ref ) {

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
	const [ selectedImageId, setSelectedImageId ] = useState( null );

	// Expose ref functions with useImperativeHandle
	useEffect( () => {

		if ( ! ref ) return;

		// In React 19, we update the ref directly instead of using useImperativeHandle
		ref.current = {
			getCanvas: () => originalCanvasRef.current,
			getEditedCanvas: () => editedCanvasRef.current,
			getImageProcessor: () => imageProcessorRef.current
		};

	}, [ ref ] );

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

			// Check if this image has color correction data in the database
			checkForColorCorrectionData();

		};

		img.src = imageData;

		return () => {

			img.onload = null;

		};

	}, [ imageData ] );

	// Check if the selected image has color correction data in the database
	const checkForColorCorrectionData = async () => {

		if ( ! imageData ) return;

		try {

			// Get database instance
			const db = await getDatabase();

			// Create a transaction and get the store
			const transaction = db.transaction( 'renders', 'readonly' );
			const store = transaction.objectStore( 'renders' );

			// Get all renders to search for this image
			const renders = await new Promise( ( resolve, reject ) => {

				const request = store.getAll();
				request.onsuccess = () => resolve( request.result );
				request.onerror = ( event ) => reject( event.target.error );

			} );

			// First check for exact image match with color correction data
			const exactMatch = renders.find( render =>
				render.image === imageData &&
				render.colorCorrection &&
				render.isEdited
			);

			// Then check for matched original image
			const originalMatch = renders.find( render =>
				render.originalImage === imageData &&
				render.colorCorrection &&
				render.isEdited
			);

			if ( exactMatch && exactMatch.colorCorrection ) {

				// Save the ID of the selected image for later use
				setSelectedImageId( exactMatch.id );

				// Apply the stored color correction settings
				console.log( 'Found color correction data for this image, applying settings' );
				const settings = exactMatch.colorCorrection;

				// Update color correction parameters in the store
				Object.keys( settings ).forEach( param => {

					useStore.getState().setImageProcessingParam( param, settings[ param ] );

				} );

				// Show the edited view
				setShowEditedCanvas( true );

			} else if ( originalMatch && originalMatch.colorCorrection ) {

				// Save the ID of the matched original for later use
				setSelectedImageId( originalMatch.id );

				// Apply color correction from a render that used this as the original
				console.log( 'Found color correction data from a previous edit, applying settings' );
				const settings = originalMatch.colorCorrection;

				// Update color correction parameters in the store
				Object.keys( settings ).forEach( param => {

					useStore.getState().setImageProcessingParam( param, settings[ param ] );

				} );

				// Show the edited view
				setShowEditedCanvas( true );

			} else {

				// Get the ID of the current image
				const currentImage = renders.find( render =>
					render.image === imageData
				);

				if ( currentImage && currentImage.id ) {

					setSelectedImageId( currentImage.id );

				} else {

					setSelectedImageId( null );

				}

				// No color correction data found, use defaults
				console.log( 'No color correction data found for this image, using defaults' );
				useStore.getState().resetImageProcessing();
				setShowEditedCanvas( false );

			}

		} catch ( error ) {

			console.error( 'Error accessing database:', error );
			// Use defaults if there's an error
			useStore.getState().resetImageProcessing();
			setShowEditedCanvas( false );

		}

	};

	// Apply image processing when parameters change
	useEffect( () => {

		if ( isImageDrawn && imageProcessorRef.current ) {

			applyImageProcessing();

		}

	}, [ imageProcessing, isImageDrawn ] );

	// Handle viewport scale change from ViewportResizer
	const handleViewportResize = ( scale ) => {

		setViewportScale( scale );

	};

	const handleFullscreen = () => {

		if ( ! viewportWrapperRef.current ) return;

		if ( document.fullscreenElement ) {

			document.exitFullscreen();

		} else {

			viewportWrapperRef.current.requestFullscreen();

		}

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

			console.log( 'Checking for existing edits to delete first' );

			// Delete any existing edit of this image first
			await deleteRender( selectedImageId );


			// Now create a new record
			const db = await getDatabase();
			const transaction = db.transaction( 'renders', 'readwrite' );
			const store = transaction.objectStore( 'renders' );

			// Create a new edit record
			const saveData = {
				image: imageData,
				colorCorrection: colorCorrectionSettings,
				timestamp: new Date(),
				isEdited: true
			};

			console.log( 'Creating new record after deleting any existing edits' );

			// Add the new record
			const newId = await new Promise( ( resolve, reject ) => {

				const addRequest = store.add( saveData );
				addRequest.onsuccess = ( event ) => resolve( event.target.result );
				addRequest.onerror = ( event ) => reject( event.target.error );

			} );

			console.log( 'New record created with ID:', newId );

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

	// Ignore edits and reset image processing
	const ignoreEdits = () => {

		useStore.getState().resetImageProcessing();
		setShowEditedCanvas( false );

		toast( {
			title: "Edits Discarded",
			description: "All color correction settings have been reset.",
		} );

	};

	return (
		<div className="flex justify-center items-center h-full z-10">
			{/* View mode tabs at the top */}
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

			{/* Add Save/Ignore buttons when in edited view */}
			{showEditedCanvas && imageData && (
				<div className="absolute top-2 right-2 z-20 flex space-x-2">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={saveEditedImage}
									className="flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1 rounded-md text-xs"
								>
									<Save size={12} className="mr-1" />
									Save
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Save edited image</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>

					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={ignoreEdits}
									className="flex items-center justify-center bg-destructive hover:bg-destructive/90 text-destructive-foreground px-3 py-1 rounded-md text-xs"
								>
									<X size={12} className="mr-1" />
									Ignore
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Discard all changes</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			)}

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

					{/* Canvas to display the original result */}
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
					{/* Add ViewportResizer component */}
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

// No need for displayName in React 19 when using the named function in forwardRef

export default ResultsViewport;
