import React from 'react';
import { Maximize, Target, Camera } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import ViewportResizer from './ViewportResizer';

const ViewportControls = ( { onScreenshot, onResetCamera, onFullscreen } ) => (
	<div className="flex absolute bottom-2 right-2 text-xs text-foreground p-1 rounded bg-background/80 backdrop-blur-xs">
		<TooltipProvider>
			<ViewportResizer onResize={onFullscreen} />
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						onClick={onScreenshot}
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
						onClick={onResetCamera}
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
						onClick={onFullscreen}
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

export default React.memo( ViewportControls );
