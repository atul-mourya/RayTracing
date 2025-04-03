import { useState, useEffect, useRef } from 'react';
import Viewport3D from './Viewport3D';
import { Loader2 } from 'lucide-react';
import { usePathTracerStore } from '@/store'; // Import the store

const MainViewport = ( { mode = "interactive" } ) => {

	const [ stats, setStats ] = useState( { timeElapsed: 0, samples: 0 } );
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( 0 );
	const [ isDenoising, setIsDenoising ] = useState( false );
	const containerRef = useRef( null );
	const isFirstRender = useRef( true );

	// Access maxSamples from the store
	const maxSamples = usePathTracerStore( ( state ) => state.maxSamples );
	const setMaxSamples = usePathTracerStore( ( state ) => state.setMaxSamples );

	// Update inputValue when maxSamples changes
	useEffect( () => {

		setInputValue( maxSamples );

	}, [ maxSamples ] );

	// Update maxSamples when mode changes
	useEffect( () => {

		if ( isFirstRender.current ) {

			isFirstRender.current = false;
			return;

		}

		const newMaxSamples = mode === "interactive" ? 30 : 100; // Set maxSamples based on mode
		window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
		setMaxSamples( newMaxSamples );

		// If not first render, we're changing modes - update the stats display
		if ( window.pathTracerApp ) {

			// Reset the samples counter in our local state
			setStats( prev => ( { ...prev, samples: 0 } ) );

		}

	}, [ mode, setMaxSamples ] );

	useEffect( () => {

		const handleDenoisingStart = () => setIsDenoising( true );
		const handleDenoisingEnd = () => setIsDenoising( false );

		if ( window.pathTracerApp && window.pathTracerApp.denoiser ) {

			window.pathTracerApp.denoiser.addEventListener( 'start', handleDenoisingStart );
			window.pathTracerApp.denoiser.addEventListener( 'end', handleDenoisingEnd );

		}

		return () => {

			if ( window.pathTracerApp && window.pathTracerApp.denoiser ) {

				window.pathTracerApp.denoiser.removeEventListener( 'start', handleDenoisingStart );
				window.pathTracerApp.denoiser.removeEventListener( 'end', handleDenoisingEnd );

			}

		};

	}, [] );

	const handleInputBlur = () => {

		setIsEditing( false );
		if ( inputValue !== maxSamples ) {

			const value = Number( inputValue );
			setMaxSamples( value );
			if ( window.pathTracerApp ) {

				window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = value;
				window.pathTracerApp.reset();

			}

		}

	};

	return (
		<div ref={containerRef} className="w-full h-full relative">
			<Viewport3D onStatsUpdate={setStats} viewportMode={mode} />
			<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded">
				Time: {stats.timeElapsed.toFixed( 2 )}s | Frames: {stats.samples} /{' '}
				{isEditing ? (
					<input
						className="bg-transparent border-b border-white text-white w-12"
						type="number"
						value={inputValue}
						onChange={( e ) => setInputValue( e.target.value )}
						onBlur={handleInputBlur}
						onKeyDown={( e ) => e.key === 'Enter' && handleInputBlur()}
						autoFocus
					/>
				) : (
					<span onClick={() => setIsEditing( true )} className="cursor-pointer border-b border-dotted border-white group-hover:border-blue-400 transition-colors duration-300">
						{maxSamples}
					</span>
				)}
			</div>

			{isDenoising && (
				<div className="absolute top-2 left-1/2 transform -translate-x-1/2">
					<div className="bg-background opacity-50 text-xs text-foreground px-1 py-0 rounded-full flex items-center">
						<span className="mr-2">Denoising</span>
						<Loader2 className="h-5 w-5 animate-spin" />
					</div>
				</div>
			)}
		</div>
	);

};

export default MainViewport;
