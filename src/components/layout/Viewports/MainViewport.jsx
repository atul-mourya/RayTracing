import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import Viewport3D from './Viewport3D';
import { Loader2, Check, X } from 'lucide-react';
import { usePathTracerStore } from '@/store';
import { saveRender } from '@/utils/database';

// Separate StatsDisplay component with memoization
const StatsDisplay = memo( ( {
	timeElapsed,
	samples,
	maxSamples,
	isDenoising,
	onMaxSamplesEdit
} ) => {

	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( maxSamples );

	// Update input value when maxSamples changes
	useEffect( () => {

		setInputValue( maxSamples );

	}, [ maxSamples ] );

	const handleInputBlur = useCallback( () => {

		setIsEditing( false );
		if ( inputValue !== maxSamples ) {

			onMaxSamplesEdit( Number( inputValue ) );

		}

	}, [ inputValue, maxSamples, onMaxSamplesEdit ] );

	const handleKeyDown = useCallback( ( e ) => {

		if ( e.key === 'Enter' ) {

			handleInputBlur();

		}

	}, [ handleInputBlur ] );

	const handleInputChange = useCallback( ( e ) => {

		setInputValue( e.target.value );

	}, [] );

	const startEditing = useCallback( () => {

		setIsEditing( true );

	}, [] );

	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded">
			Time: {timeElapsed.toFixed( 2 )}s | Frames: {samples} /{' '}
			{isEditing ? (
				<input
					className="bg-transparent border-b border-white text-white w-12"
					type="number"
					value={inputValue}
					onChange={handleInputChange}
					onBlur={handleInputBlur}
					onKeyDown={handleKeyDown}
					autoFocus
				/>
			) : (
				<span
					onClick={startEditing}
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

} );

StatsDisplay.displayName = 'StatsDisplay';

// Separate RenderControls component with memoization
const RenderControls = memo( ( { onSave, onDiscard } ) => {

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

} );

RenderControls.displayName = 'RenderControls';

const MainViewport = ( { mode = "interactive" } ) => {

	// References
	const containerRef = useRef( null );
	const isFirstRender = useRef( true );

	// Consolidated state for better management
	const [ viewportState, setViewportState ] = useState( {
		stats: { timeElapsed: 0, samples: 0 },
		isDenoising: false,
		renderComplete: false
	} );

	// Destructure state for readability
	const { stats, isDenoising, renderComplete } = viewportState;

	// Access store values directly to avoid infinite loops
	const pathTracerStore = usePathTracerStore();

	// Use useMemo to cache the extracted values
	const { maxSamples, setMaxSamples } = useMemo( () => ( {
		maxSamples: pathTracerStore.maxSamples,
		setMaxSamples: pathTracerStore.setMaxSamples
	} ), [ pathTracerStore.maxSamples, pathTracerStore.setMaxSamples ] );

	// Update stats efficiently to avoid unnecessary re-renders
	const handleStatsUpdate = useCallback( ( newStats ) => {

		setViewportState( prev => {

			// Only update if values have changed
			if ( prev.stats.timeElapsed !== newStats.timeElapsed ||
				prev.stats.samples !== newStats.samples ) {

				return { ...prev, stats: newStats };

			}

			return prev;

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
			setViewportState( prev => ( { ...prev, stats: { ...prev.stats, samples: 0 } } ) );

		}

	}, [ mode, setMaxSamples ] );

	// Set up event listeners for denoising and rendering
	useEffect( () => {

		const handleDenoisingStart = () => setViewportState( prev => ( { ...prev, isDenoising: true } ) );
		const handleDenoisingEnd = () => setViewportState( prev => ( { ...prev, isDenoising: false } ) );
		const handleRenderComplete = () => setViewportState( prev => ( { ...prev, renderComplete: true } ) );
		const handleRenderReset = () => setViewportState( prev => ( { ...prev, renderComplete: false } ) );

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

	// Handler for editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		setMaxSamples( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = value;
			window.pathTracerApp.reset();

		}

	}, [ setMaxSamples ] );

	// Handler for saving renders
	const handleSave = useCallback( async () => {

		if ( ! window.pathTracerApp ) return;

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
			setViewportState( prev => ( { ...prev, renderComplete: false } ) );

		} catch ( error ) {

			console.error( 'Failed to save render:', error );
			alert( 'Failed to save render. See console for details.' );

		}

	}, [] );

	// Handler for discarding renders
	const handleDiscard = useCallback( () => {

		setViewportState( prev => ( { ...prev, renderComplete: false } ) );

	}, [] );

	// Memoize whether to show render controls
	const shouldShowRenderControls = useMemo( () => {

		return renderComplete && stats.samples === maxSamples && mode === "final";

	}, [ renderComplete, stats.samples, maxSamples, mode ] );

	return (
		<div ref={containerRef} className="w-full h-full relative">
			<Viewport3D
				onStatsUpdate={handleStatsUpdate}
				viewportMode={mode}
			/>

			<StatsDisplay
				timeElapsed={stats.timeElapsed}
				samples={stats.samples}
				maxSamples={maxSamples}
				isDenoising={isDenoising}
				onMaxSamplesEdit={handleMaxSamplesEdit}
			/>

			{shouldShowRenderControls && (
				<RenderControls
					onSave={handleSave}
					onDiscard={handleDiscard}
				/>
			)}
		</div>
	);

};

// Export a memoized version of the component
export default memo( MainViewport );
