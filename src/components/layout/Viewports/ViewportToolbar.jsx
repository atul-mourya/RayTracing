import React, { useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize, Target, Camera } from "lucide-react";
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipProvider
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * ViewportToolbar - A customizable toolbar component for viewport controls
 *
 * @param {Object} props - Component props
 * @param {Function} props.onResize - Callback fired when viewport size changes
 * @param {React.RefObject} props.viewportWrapperRef - Ref to the viewport wrapper element
 * @param {React.RefObject} props.appRef - Ref to the app component with controls
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.position - Position of the toolbar (top-left, top-right, bottom-left, bottom-right)
 * @param {string} props.buttonVariant - Button variant from UI library
 * @param {string} props.buttonSize - Button size from UI library
 * @param {number} props.iconSize - Size of icons in pixels
 * @param {number} props.minSize - Minimum zoom percentage
 * @param {number} props.maxSize - Maximum zoom percentage
 * @param {number} props.step - Step size for zoom slider
 * @param {number} props.zoomStep - Step size for zoom buttons
 * @param {number} props.defaultSize - Default zoom percentage
 */
const ViewportToolbar = ( {
	// Core functionality
	onResize,
	viewportWrapperRef,
	appRef,

	// Appearance
	className,
	position = "bottom-right",

	// Button and icon styling
	buttonVariant = "ghost",
	buttonSize = "icon",
	iconSize = 14,

	// Zoom settings
	minSize = 25,
	maxSize = 200,
	step = 5,
	zoomStep = 25,
	defaultSize = 100,

} ) => {

	// Size state for resizer
	const [ size, setSize ] = useState( defaultSize );

	// Define position classes based on position prop
	const positionClasses = {
		"top-left": "top-2 left-2",
		"top-right": "top-2 right-2",
		"bottom-left": "bottom-2 left-2",
		"bottom-right": "bottom-2 right-2"
	};

	// Resizer handlers
	const handleSizeChange = ( newSize ) => {

		setSize( newSize[ 0 ] );
		onResize?.( newSize[ 0 ] );

	};

	const handleZoomIn = () => {

		const newSize = Math.min( size + zoomStep, maxSize );
		setSize( newSize );
		onResize?.( newSize );

	};

	const handleZoomOut = () => {

		const newSize = Math.max( size - zoomStep, minSize );
		setSize( newSize );
		onResize?.( newSize );

	};

	const handleResetZoom = () => {

		setSize( defaultSize );
		onResize?.( defaultSize );

	};

	// Control handlers
	const handleFullscreen = useCallback( () => {

		if ( ! viewportWrapperRef?.current ) return;
		document.fullscreenElement
			? document.exitFullscreen()
			: viewportWrapperRef.current.requestFullscreen();

	}, [ viewportWrapperRef ] );

	const handleResetCamera = useCallback( () => {

		appRef?.current?.controls?.reset();

	}, [ appRef ] );

	const handleScreenshot = useCallback( () => {

		appRef?.current?.takeScreenshot();

	}, [ appRef ] );

	// Control button with different hover style
	const ControlButton = ( { onClick, tooltip, icon } ) => (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					onClick={onClick}
					variant={buttonVariant}
					size={buttonSize}
					className="h-6 w-6 p-1 hover:bg-primary/20 hover:scale-105 mx-1 rounded-full"
				>
					{React.cloneElement( icon, { size: iconSize, className: "text-foreground/70" } )}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p className="text-xs">{tooltip}</p>
			</TooltipContent>
		</Tooltip>
	);

	return (
		<div className={cn(
			"flex absolute h-8 text-xs text-foreground rounded-full bg-secondary backdrop-blur items-center",
			positionClasses[ position ],
			className
		)}>
			<TooltipProvider>
				<ControlButton onClick={handleResetZoom} tooltip="Reset Zoom" icon={<RotateCcw />}/>
				<ControlButton onClick={handleZoomOut} tooltip="Zoom Out" icon={<ZoomOut />}/>
				<Slider value={[ size ]} min={minSize} max={maxSize} step={step} onValueChange={handleSizeChange} className="w-30" />
				<ControlButton onClick={handleZoomIn} icon={<ZoomIn />}/>
				<Separator orientation="vertical" className="h-5 mx-1 my-1 bg-foreground/10" />
				<ControlButton onClick={handleScreenshot} tooltip="Take Screenshot" icon={<Camera />}/>
				<ControlButton onClick={handleResetCamera} tooltip="Reset Camera" icon={<Target />}/>
				<ControlButton onClick={handleFullscreen} tooltip="Fullscreen" icon={<Maximize />}/>
			</TooltipProvider>
		</div>
	);

};

export default React.memo( ViewportToolbar );
