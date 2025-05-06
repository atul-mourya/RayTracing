import React, { useCallback } from 'react';
import { Maximize, Target, Camera } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import ViewportResizer from './ViewportResizer';

const ViewportControls = ( { onResize, viewportWrapperRef, appRef } ) => {


	const handleFullscreen = useCallback( () => {

		if ( ! viewportWrapperRef.current ) return;
		document.fullscreenElement
			? document.exitFullscreen()
			: viewportWrapperRef.current.requestFullscreen();

	}, [] );

	const handleResetCamera = useCallback( () => {

		appRef.current && appRef.current.controls.reset();

	}, [] );

	const handleScreenshot = useCallback( () => {

		appRef.current && appRef.current.takeScreenshot();

	}, [] );

	return (
		<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
			<TooltipProvider>
				<ViewportResizer onResize={onResize} />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							onClick={handleScreenshot}
							className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
						>
							<Camera size={12} className="bg-transparent border-white text-forground/50" />
						</button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Take Screenshot</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							onClick={handleResetCamera}
							className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
						>
							<Target size={12} className="bg-transparent border-white text-forground/50" />
						</button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Reset Camera</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							onClick={handleFullscreen}
							className="flex cursor-default select-none items-center rounded-sm px-2 py-1 hover:bg-primary/90 hover:scale-110"
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
	);

};

export default React.memo( ViewportControls );
