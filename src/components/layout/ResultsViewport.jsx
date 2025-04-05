import React, { useRef, useEffect, useState, forwardRef } from 'react';
import { Camera, Maximize } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';

const ResultsViewport = forwardRef( ( props, ref ) => {

	const imageData = useStore( state => state.selectedResult );
	const { toast } = useToast();
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const canvasRef = useRef( null );
	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ actualCanvasSize ] = useState( 512 ); // Fixed canvas size
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );

	// Expose ref functions
	React.useImperativeHandle( ref, () => ( {
		getCanvas: () => canvasRef.current
	} ) );

	// Only redraw the canvas when imageData changes
	useEffect( () => {

		if ( ! canvasRef.current || ! imageData ) return;

		const canvas = canvasRef.current;
		const ctx = canvas.getContext( '2d' );

		// Clear the canvas
		ctx.clearRect( 0, 0, canvas.width, canvas.height );
		setIsImageDrawn( false );

		// Load the image
		const img = new Image();

		img.onload = () => {

			// Calculate dimensions to maintain aspect ratio
			const hRatio = canvas.width / img.width;
			const vRatio = canvas.height / img.height;
			const ratio = Math.min( hRatio, vRatio );

			// Center the image
			const centerX = ( canvas.width - img.width * ratio ) / 2;
			const centerY = ( canvas.height - img.height * ratio ) / 2;

			// Draw the image
			ctx.drawImage( img, 0, 0, img.width, img.height,
				centerX, centerY, img.width * ratio, img.height * ratio );

			setIsImageDrawn( true );

		};

		img.src = imageData;

		// Clean up function
		return () => {

			// Cancel any pending image loading
			img.onload = null;

		};

	}, [ imageData ] );

	const handleFullscreen = () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement ? document.exitFullscreen() : viewportWrapperRef.current.requestFullscreen();

	};

	const handleScreenshot = () => {

		if ( canvasRef.current && imageData ) {

			// Just download the original image
			const link = document.createElement( 'a' );
			link.href = imageData;
			link.download = `raycanvas-result-${new Date().getTime()}.png`;
			link.click();

			toast( {
				title: "Screenshot Saved",
				description: "Screenshot has been downloaded.",
			} );

		}

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
					{/* Canvas to display the result */}
					<canvas
						ref={canvasRef}
						width="1024"
						height="1024"
						style={{
							width: `${actualCanvasSize}px`,
							height: `${actualCanvasSize}px`,
							backgroundColor: 'black'
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
                            1024 × 1024 ({viewportScale}%)
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
