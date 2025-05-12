import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';

const StatsMeter = ( { viewportMode, appRef } ) => {

	// Get store state and actions
	const storeMaxSamples = usePathTracerStore( state => state.maxSamples );
	const setStoreMaxSamples = usePathTracerStore.getState().setMaxSamples;
	const stats = useStore( state => state.stats );
	const isDenoising = useStore( state => state.isDenoising );

	// Local state for UI editing
	const [ maxSamples, setMaxSamples ] = useState( storeMaxSamples );
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( String( storeMaxSamples ) );

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

	// Update based on viewport mode
	useEffect( () => {

		if ( ! appRef || ! appRef.current ) return;

		const newMaxSamples = viewportMode === "interactive" ? 60 : 30;
		const app = appRef.current;

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
			setStoreMaxSamples( newMaxSamples );
			setMaxSamples( newMaxSamples );

		}

	}, [ viewportMode, appRef, setStoreMaxSamples ] );

	// Update local maxSamples when store value changes
	useEffect( () => {

		setMaxSamples( storeMaxSamples );

	}, [ storeMaxSamples ] );

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
			Time: <span>{stats.timeElapsed.toFixed( 2 )}</span>s | Frames: <span>{stats.samples}</span> /{' '}
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
