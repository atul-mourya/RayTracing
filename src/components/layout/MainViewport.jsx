import { useState, useEffect, useRef } from 'react';
import Viewport3D from './Viewport3D';
import { Loader2, Check, X } from 'lucide-react'; // Import icons
import { usePathTracerStore } from '@/store'; // Import the store
import { saveRender } from '@/utils/database'; // Import the database utility

const MainViewport = ( { mode = "interactive" } ) => {

	const [ stats, setStats ] = useState( { timeElapsed: 0, samples: 0 } );
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( 0 );
	const [ isDenoising, setIsDenoising ] = useState( false );
	const [ renderComplete, setRenderComplete ] = useState( false );
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

		const newMaxSamples = mode === "interactive" ? 60 : 30; // Set maxSamples based on mode
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

	useEffect( () => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.addEventListener( 'RenderComplete', () => setRenderComplete( true ) );
			window.pathTracerApp.addEventListener( 'RenderReset', () => setRenderComplete( false ) );

		}

		return () => {

			if ( window.pathTracerApp ) {

				window.pathTracerApp.removeEventListener( 'RenderComplete', () => setRenderComplete( true ) );
				window.pathTracerApp.removeEventListener( 'RenderReset', () => setRenderComplete( false ) );

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

	const handleSave = async () => {

		if ( window.pathTracerApp ) {

			try {

				const canvas = window.pathTracerApp.denoiser.enabled && window.pathTracerApp.denoiser.output
					? window.pathTracerApp.denoiser.output
					: window.pathTracerApp.renderer.domElement;

				const imageData = canvas.toDataURL( 'image/png' );
				const saveData = {
					image: imageData,
					colorCorrection: {
						brightness: 0,
						contrast: 0,
						saturation: 0,
						hue: 0,
						exposure: 0,
					  },
					timestamp: new Date(),
					isEdited: true
				};
				const id = await saveRender( saveData );
				console.log( 'Render saved successfully with ID:', id );

				// Dispatch a custom event to notify other components
				window.dispatchEvent( new CustomEvent( 'render-saved', { detail: { id } } ) );

				// Only set render complete to false if save was successful
				setRenderComplete( false );

			} catch ( error ) {

				console.error( 'Failed to save render:', error );
				alert( 'Failed to save render. See console for details.' );

			}

		}

	};

	const handleDiscard = () => setRenderComplete( false );

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
				<div className={`${isDenoising ? 'visible' : 'invisible'} py-1 rounded-full flex items-center`}>
					<span className="mr-2">Denoising</span>
					<Loader2 className="h-5 w-5 animate-spin" />
				</div>
			</div>

			{renderComplete && stats.samples === maxSamples && mode === "final" && (
				<div className="absolute top-2 right-2 flex space-x-2">
					<button
						onClick={handleSave}
						className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-primary/90 transition-all cursor-pointer"
					>
						<Check size={14} className="mr-1" /> Save
					</button>
					<button
						onClick={handleDiscard}
						className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-secondary/90 transition-all cursor-pointer"
					>
						<X size={14} className="mr-1" /> Ignore
					</button>
				</div>
			)}
		</div>
	);

};

export default MainViewport;
