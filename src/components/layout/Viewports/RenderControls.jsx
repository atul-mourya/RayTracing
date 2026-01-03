import { useState, useEffect } from 'react';
import { Play, Pause, SkipBack, MousePointer2 } from 'lucide-react';
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore, useCameraStore } from '@/store';

// Reusable control button component using shadcn Button
const ControlButton = ( { icon, label, onClick, isActive, disabled } ) => (
	<Tooltip>
		<TooltipTrigger asChild>
			<Button
				variant="ghost"
				size="icon"
				className={cn(
					"w-8 h-full border-0",
					isActive && "bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary",
					! isActive && ! disabled && "text-muted-foreground hover:text-foreground hover:bg-accent/50",
					disabled && "opacity-50"
				)}
				onClick={onClick}
				disabled={disabled}
			>
				{icon}
			</Button>
		</TooltipTrigger>
		<TooltipContent side="bottom">
			<p>{label}</p>
		</TooltipContent>
	</Tooltip>
);

const RenderControls = () => {

	const [ isPlaying, setIsPlaying ] = useState( false );
	const selectMode = useCameraStore( state => state.selectMode );
	const handleToggleSelectMode = useCameraStore( state => state.handleToggleSelectMode );
	const appMode = useStore( state => state.appMode );

	// Handle toggle play/pause
	const handleTogglePlay = () => {

		if ( ! window.pathTracerApp ) return;

		if ( isPlaying ) {

			window.pathTracerApp.pauseRendering = true;
			setIsPlaying( false );

		} else {

			window.pathTracerApp.pauseRendering = false;

			// Only reset if render is complete
			if ( window.pathTracerApp.pathTracingPass?.isComplete ) {

				window.pathTracerApp.reset();

			}

			setIsPlaying( true );

		}

	};

	// Handle restart button click
	const handleRestart = () => {

		if ( window.pathTracerApp ) {

			// First pause if playing
			window.pathTracerApp.pauseRendering = true;

			// Then reset and resume
			setTimeout( () => {

				window.pathTracerApp.reset();
				window.pathTracerApp.pauseRendering = false;
				setIsPlaying( true );

			}, 100 );

		}

	};

	useEffect( () => {

		const handleRenderComplete = () => setIsPlaying( false );
		const handleRenderReset = () => setIsPlaying( true );

		if ( window.pathTracerApp ) {

			window.pathTracerApp.addEventListener( 'RenderComplete', handleRenderComplete );
			window.pathTracerApp.addEventListener( 'RenderReset', handleRenderReset );

		}

		return () => {

			if ( window.pathTracerApp ) {

				window.pathTracerApp.removeEventListener( 'RenderComplete', handleRenderComplete );
				window.pathTracerApp.removeEventListener( 'RenderReset', handleRenderReset );

			}

		};

	}, [] ); // Only run on mount/unmount - window.pathTracerApp is checked inside

	// Control button definitions
	const controls = [
		{
			icon: isPlaying ? <Pause size={14} /> : <Play size={14} />,
			label: isPlaying ? 'Pause' : 'Play',
			onClick: handleTogglePlay,
			isActive: false,
			disabled: false
		},
		{
			icon: <SkipBack size={14} />,
			label: 'Restart',
			onClick: handleRestart,
			isActive: false,
			disabled: false
		},
		// Only show select mode button in preview mode
		...( appMode === 'preview' ? [ {
			icon: <MousePointer2 size={14} />,
			label: 'Click to Select',
			onClick: handleToggleSelectMode,
			isActive: selectMode,
			disabled: false
		} ] : [] )
	];

	return (
		<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-10">
			<div className="flex h-8 bg-background/90 rounded-full overflow-hidden shadow-md border border-border">
				<TooltipProvider>
					{controls.map( ( control, index ) => (
						<div key={control.label} className="flex items-center">
							{index > 0 && <div className="w-px bg-muted h-8"></div>}
							<ControlButton {...control} />
						</div>
					) )}
				</TooltipProvider>
			</div>
		</div>
	);

};

export default RenderControls;
