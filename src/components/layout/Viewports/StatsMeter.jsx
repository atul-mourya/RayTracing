import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { usePathTracerStore } from '@/store';

const StatsMeter = ( { viewportMode, appRef } ) => {

	// Get store state and actions
	const storeMaxSamples = usePathTracerStore( state => state.maxSamples );
	const setStoreMaxSamples = usePathTracerStore.getState().setMaxSamples;

	// Individual states for all metrics
	const [ timeElapsed, setTimeElapsed ] = useState( 0 );
	const [ samples, setSamples ] = useState( 0 );
	const [ maxSamples, setMaxSamples ] = useState( 60 );
	const [ isDenoising, setIsDenoising ] = useState( false );

	// Editing state
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( "60" );

	// Handle stats update from the path tracer
	const handleStatsUpdate = useCallback( ( newStats ) => {

		if ( newStats.timeElapsed !== undefined ) {

			setTimeElapsed( newStats.timeElapsed );

		}

		if ( newStats.samples !== undefined ) {

			setSamples( newStats.samples );

		}

	}, [] );

	// Handle editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		if ( value === storeMaxSamples ) return;

		// Update store
		setStoreMaxSamples( value );

		// Update local state
		setMaxSamples( value );

		// Update app
		const app = appRef.current;
		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = value;
			app.reset();

		}

	}, [ storeMaxSamples, setStoreMaxSamples, appRef ] );

	// Register stats update callback
	useEffect( () => {

		if ( ! appRef || ! appRef.current ) return;

		// Register the callback once
		appRef.current.setOnStatsUpdate( handleStatsUpdate );

	}, [ appRef, handleStatsUpdate ] );

	// Update based on viewport mode
	useEffect( () => {

		if ( ! appRef || ! appRef.current ) return;

		const newMaxSamples = viewportMode === "interactive" ? 60 : 30;
		const app = appRef.current;

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
			setStoreMaxSamples( newMaxSamples );
			setMaxSamples( newMaxSamples );
			setSamples( 0 );

		}

	}, [ viewportMode, appRef, setStoreMaxSamples ] );

	// Setup denoising event listeners
	useEffect( () => {

		if ( ! window.pathTracerApp ) return;

		if ( window.pathTracerApp.denoiser ) {

			window.pathTracerApp.denoiser.addEventListener( 'start', () => setIsDenoising( true ) );
			window.pathTracerApp.denoiser.addEventListener( 'end', () => setIsDenoising( false ) );

		}

		return () => {

			if ( window.pathTracerApp.denoiser ) {

				window.pathTracerApp.denoiser.removeEventListener( 'start', () => setIsDenoising( true ) );
				window.pathTracerApp.denoiser.removeEventListener( 'end', () => setIsDenoising( false ) );

			}

		};

	}, [] );

	// Input field handlers
	const handleInputBlur = useCallback( () => {

		setIsEditing( false );
		const numValue = Number( inputValue );
		if ( numValue !== maxSamples && ! isNaN( numValue ) ) {

			handleMaxSamplesEdit( numValue );

		}

	}, [ inputValue, maxSamples, handleMaxSamplesEdit ] );

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
		setInputValue( String( maxSamples ) );

	}, [ maxSamples ] );

	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded">
			Time: <span>{timeElapsed.toFixed( 2 )}</span>s | Frames: <span>{samples}</span> /{' '}
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
					className="cursor-pointer border-b border-dotted border-white hover:border-blue-400 transition-colors duration-300"
				>
					{maxSamples}
				</span>
			)}
			{isDenoising && (
				<div className="py-1 rounded-full flex items-center">
					<span className="mr-2">Denoising</span>
					<Loader2 className="h-5 w-5 animate-spin" />
				</div>
			)}
		</div>
	);

};

export default StatsMeter;
