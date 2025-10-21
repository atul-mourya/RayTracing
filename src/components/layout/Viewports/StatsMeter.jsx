import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';

const StatsMeter = ( { viewportMode, appRef } ) => {

	// Optimized store subscriptions - only subscribe to specific values
	const storeMaxSamples = usePathTracerStore( useCallback( state => state.maxSamples, [] ) );
	const setStoreMaxSamples = usePathTracerStore( useCallback( state => state.setMaxSamples, [] ) );
	const stats = useStore( useCallback( state => state.stats, [] ) );
	const isDenoising = useStore( useCallback( state => state.isDenoising, [] ) );

	// Local state for UI editing
	const [ maxSamples, setMaxSamples ] = useState( storeMaxSamples );
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( String( storeMaxSamples ) );
	const [ sceneStats, setSceneStats ] = useState( null );

	// Get scene statistics from the path tracer
	const updateSceneStats = useCallback( () => {

		const app = appRef.current;
		if ( app?.pathTracingPass?.sdfs ) {

			try {

				const statistics = app.pathTracingPass.sdfs.getStatistics();
				setSceneStats( statistics );

			} catch ( error ) {

				console.warn( 'Could not get scene statistics:', error );
				setSceneStats( null );

			}

		}

	}, [ appRef ] );

	// Update scene stats when the scene changes
	useEffect( () => {

		const handleSceneUpdate = () => updateSceneStats();

		// Listen for scene rebuild events
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );

		// Initial update
		updateSceneStats();

		return () => {

			window.removeEventListener( 'SceneRebuild', handleSceneUpdate );

		};

	}, [ updateSceneStats ] );

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

		const newMaxSamples = viewportMode === "preview" ? 60 : 30;
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
			{sceneStats?.triangleCount > 0 && (
				<span>Triangles: <span>{sceneStats.triangleCount.toLocaleString()}</span> | </span>
			)}
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
