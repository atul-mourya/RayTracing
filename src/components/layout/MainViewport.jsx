import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Viewport3D from './Viewport3D';
import { Loader2, Check, X } from 'lucide-react';
import { usePathTracerStore } from '@/store';
import { saveRender } from '@/utils/database';

// Create a separate StatsDisplay component to prevent re-renders
const StatsDisplay = ( { timeElapsed, samples, maxSamples, isDenoising, onMaxSamplesEdit } ) => {

	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( maxSamples );

	useEffect( () => {

		setInputValue( maxSamples );

	}, [ maxSamples ] );

	const handleInputBlur = () => {

		setIsEditing( false );
		if ( inputValue !== maxSamples ) {

			onMaxSamplesEdit( Number( inputValue ) );

		}

	};

	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded">
      Time: {timeElapsed.toFixed( 2 )}s | Frames: {samples} /{' '}
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
				<span
					onClick={() => setIsEditing( true )}
					className="cursor-pointer border-b border-dotted border-white group-hover:border-blue-400 transition-colors duration-300"
				>
					{maxSamples}
				</span>
			)}
			<div className={`${isDenoising ? 'visible' : 'invisible'} py-1 rounded-full flex items-center`}>
				<span className="mr-2">Denoising</span>
				<Loader2 className="h-5 w-5 animate-spin" />
			</div>
		</div>
	);

};

// Create a separate component for the save/discard buttons
const RenderControls = ( { onSave, onDiscard } ) => {

	return (
		<div className="absolute top-2 right-2 flex space-x-2">
			<button
				onClick={onSave}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-primary/90 transition-all cursor-pointer"
			>
				<Check size={14} className="mr-1" /> Save
			</button>
			<button
				onClick={onDiscard}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-secondary/90 transition-all cursor-pointer"
			>
				<X size={14} className="mr-1" /> Ignore
			</button>
		</div>
	);

};

const MainViewport = ( { mode = "interactive" } ) => {

	const [ stats, setStats ] = useState( { timeElapsed: 0, samples: 0 } );
	const [ isDenoising, setIsDenoising ] = useState( false );
	const [ renderComplete, setRenderComplete ] = useState( false );
	const containerRef = useRef( null );
	const isFirstRender = useRef( true );

	// Access maxSamples from the store
	const maxSamples = usePathTracerStore( ( state ) => state.maxSamples );
	const setMaxSamples = usePathTracerStore( ( state ) => state.setMaxSamples );

	// Memoize the stats updater function to prevent unnecessary renders
	const handleStatsUpdate = useCallback( ( newStats ) => {

		setStats( prevStats => {

			// Only update if the values have actually changed to avoid unnecessary renders
			if ( prevStats.timeElapsed !== newStats.timeElapsed || prevStats.samples !== newStats.samples ) {

				return newStats;

			}

			return prevStats;

		} );

	}, [] );

	// Update maxSamples when mode changes
	useEffect( () => {

		if ( isFirstRender.current ) {

			isFirstRender.current = false;
			return;

		}

		const newMaxSamples = mode === "interactive" ? 60 : 30;
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
			setMaxSamples( newMaxSamples );
			setStats( prev => ( { ...prev, samples: 0 } ) );

		}

	}, [ mode, setMaxSamples ] );

	useEffect( () => {

		const handleDenoisingStart = () => setIsDenoising( true );
		const handleDenoisingEnd = () => setIsDenoising( false );
		const handleRenderComplete = () => setRenderComplete( true );
		const handleRenderReset = () => setRenderComplete( false );

		if ( window.pathTracerApp ) {

			if ( window.pathTracerApp.denoiser ) {

				window.pathTracerApp.denoiser.addEventListener( 'start', handleDenoisingStart );
				window.pathTracerApp.denoiser.addEventListener( 'end', handleDenoisingEnd );

			}

			window.pathTracerApp.addEventListener( 'RenderComplete', handleRenderComplete );
			window.pathTracerApp.addEventListener( 'RenderReset', handleRenderReset );

		}

		return () => {

			if ( window.pathTracerApp ) {

				if ( window.pathTracerApp.denoiser ) {

					window.pathTracerApp.denoiser.removeEventListener( 'start', handleDenoisingStart );
					window.pathTracerApp.denoiser.removeEventListener( 'end', handleDenoisingEnd );

				}

				window.pathTracerApp.removeEventListener( 'RenderComplete', handleRenderComplete );
				window.pathTracerApp.removeEventListener( 'RenderReset', handleRenderReset );

			}

		};

	}, [] );

	const handleMaxSamplesEdit = useCallback( ( value ) => {

		setMaxSamples( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = value;
			window.pathTracerApp.reset();

		}

	}, [ setMaxSamples ] );

	const handleSave = useCallback( async () => {

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

				window.dispatchEvent( new CustomEvent( 'render-saved', { detail: { id } } ) );
				setRenderComplete( false );

			} catch ( error ) {

				console.error( 'Failed to save render:', error );
				alert( 'Failed to save render. See console for details.' );

			}

		}

	}, [] );

	const handleDiscard = useCallback( () => setRenderComplete( false ), [] );

	// The shouldShowRenderControls calculation is memoized to avoid recalculation on every render
	const shouldShowRenderControls = useMemo( () => {

		return renderComplete && stats.samples === maxSamples && mode === "final";

	}, [ renderComplete, stats.samples, maxSamples, mode ] );

	return (
		<div ref={containerRef} className="w-full h-full relative">
			<Viewport3D onStatsUpdate={handleStatsUpdate} viewportMode={mode} />

			<StatsDisplay
				timeElapsed={stats.timeElapsed}
				samples={stats.samples}
				maxSamples={maxSamples}
				isDenoising={isDenoising}
				onMaxSamplesEdit={handleMaxSamplesEdit}
			/>

			{shouldShowRenderControls && (
				<RenderControls onSave={handleSave} onDiscard={handleDiscard} />
			)}
		</div>
	);

};

export default MainViewport;
