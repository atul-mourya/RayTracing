import { useState, useEffect } from 'react';
import MainViewport from './MainViewport';
import { Play, Pause, SkipBack } from 'lucide-react';
import { useStore } from '@/store';
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";

const ViewportTabs = () => {

	const [ isPlaying, setIsPlaying ] = useState( false );
	const appMode = useStore( state => state.appMode );

	// Handle play button click
	const handlePlay = () => {

		if ( ! isPlaying && window.pathTracerApp ) {

			window.pathTracerApp.pauseRendering = false;
			window.pathTracerApp.reset();
			setIsPlaying( true );

		}

	};

	// Handle pause button click
	const handlePause = () => {

		if ( isPlaying && window.pathTracerApp ) {

			window.pathTracerApp.pauseRendering = true;
			setIsPlaying( false );

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

	}, [] );

	return (
		<div className="w-full h-full relative">
			{/* Single viewport that's always rendered */}
			<MainViewport mode={appMode} />

			{/* Unity-style controls overlay */}
			<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-10">
				<div className="flex bg-black/90 rounded overflow-hidden shadow-md"
					style={{ height: '32px', minWidth: '96px', border: '1px solid rgba(60, 60, 60, 0.8)' }}>
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									className={`flex items-center justify-center w-8 h-full transition-colors cursor-pointer ${! isPlaying ? 'bg-primary/20 text-primary' : 'text-gray-400 hover:text-white hover:bg-gray-700/50'}`}
									onClick={handlePlay}
								>
									<Play size={14} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Play</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>

					<div className="w-px bg-gray-700 h-full"></div>

					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									className={`flex items-center justify-center w-8 h-full transition-colors ${isPlaying ? 'cursor-pointer bg-primary/20 text-primary' : 'cursor-not-allowed text-gray-400 opacity-50'}`}
									onClick={handlePause}
									disabled={! isPlaying}
								>
									<Pause size={14} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Pause</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>

					<div className="w-px bg-gray-700 h-full"></div>

					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									className="flex items-center justify-center w-8 h-full cursor-pointer text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
									onClick={handleRestart}
								>
									<SkipBack size={14} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Restart</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			</div>
		</div>
	);

};

export default ViewportTabs;
