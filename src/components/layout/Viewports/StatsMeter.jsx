import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';
import { getApp } from '@/core/appProxy';
import { cn } from "@/lib/utils";

const EditableValue = ( { value, onCommit } ) => {

	const [ isEditing, setIsEditing ] = useState( false );
	const [ tempValue, setTempValue ] = useState( String( value ) );

	useEffect( () => {

		if ( ! isEditing ) setTempValue( String( value ) );

	}, [ value, isEditing ] );

	const commit = () => {

		setIsEditing( false );
		const num = Number( tempValue );
		if ( ! isNaN( num ) && num !== value ) {

			onCommit( num );

		} else {

			setTempValue( String( value ) );

		}

	};

	if ( isEditing ) {

		return (
			<input
				className="bg-transparent border-b border-white text-white w-12"
				type="number"
				value={tempValue}
				onChange={e => setTempValue( e.target.value )}
				onBlur={commit}
				onKeyDown={e => e.key === 'Enter' && commit()}
				autoFocus
			/>
		);

	}

	return (
		<span
			onClick={() => setIsEditing( true )}
			className="cursor-pointer border-b border-dotted border-white hover:border-blue-400 transition-colors duration-300"
		>
			{value}
		</span>
	);

};

const StatsMeter = ( { viewportMode } ) => {

	// Optimized store subscriptions
	const storeMaxSamples = usePathTracerStore( useCallback( state => state.maxSamples, [] ) );
	const setStoreMaxSamples = usePathTracerStore( useCallback( state => state.setMaxSamples, [] ) );

	const renderLimitMode = usePathTracerStore( useCallback( state => state.renderLimitMode, [] ) );
	const handleRenderLimitModeChange = usePathTracerStore( useCallback( state => state.handleRenderLimitModeChange, [] ) );
	const renderTimeLimit = usePathTracerStore( useCallback( state => state.renderTimeLimit, [] ) );
	const handleRenderTimeLimitChange = usePathTracerStore( useCallback( state => state.handleRenderTimeLimitChange, [] ) );

	const stats = useStore( useCallback( state => state.stats, [] ) );
	const isDenoising = useStore( useCallback( state => state.isDenoising, [] ) );
	const isUpscaling = useStore( useCallback( state => state.isUpscaling, [] ) );

	// Local state for maxSamples (legacy behavior support)
	const [ maxSamples, setMaxSamples ] = useState( storeMaxSamples );
	const [ sceneStats, setSceneStats ] = useState( null );

	// Get scene statistics from the active app via app-level API
	const updateSceneStats = useCallback( () => {

		const app = getApp();
		if ( app ) {

			try {

				const statistics = app.getSceneStatistics?.();
				setSceneStats( statistics ?? null );

			} catch ( error ) {

				console.warn( 'Could not get scene statistics:', error );
				setSceneStats( null );

			}

		}

	}, [] );

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

		// Update store and local state
		setStoreMaxSamples( value );
		setMaxSamples( value );

		// Update app — setMaxSamples handles completion state internally, never resets
		const app = getApp();
		if ( app ) app.setMaxSamples( value );

	}, [ storeMaxSamples, setStoreMaxSamples ] );

	// Update based on viewport mode
	useEffect( () => {

		const app = getApp();
		if ( ! app ) return;

		const newMaxSamples = viewportMode === "preview" ? 60 : 30;

		app.setMaxSamples( newMaxSamples );
		setStoreMaxSamples( newMaxSamples );
		setMaxSamples( newMaxSamples );

	}, [ viewportMode, setStoreMaxSamples ] );

	// Update local maxSamples when store value changes
	useEffect( () => {

		setMaxSamples( storeMaxSamples );

	}, [ storeMaxSamples ] );


	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded flex items-center gap-1">
			{sceneStats?.triangleCount > 0 && (
				<span className="mr-1">Triangles: <span className="text-white">{sceneStats.triangleCount.toLocaleString()}</span> | </span>
			)}

			{/* Time Control */}
			<span
				onClick={() => handleRenderLimitModeChange( 'time' )}
				className={cn( "cursor-pointer hover:text-white transition-colors", renderLimitMode === 'time' && "font-bold text-blue-400" )}
			>
				Time:
			</span>
			<span className="text-white">{stats.timeElapsed.toFixed( 2 )}</span>s
			{renderLimitMode === 'time' && (
				<> / <EditableValue value={renderTimeLimit} onCommit={handleRenderTimeLimitChange} />s </>
			)}

			<span className="mx-1">|</span>

			{/* Frames Control */}
			<span
				onClick={() => handleRenderLimitModeChange( 'frames' )}
				className={cn( "cursor-pointer hover:text-white transition-colors", renderLimitMode === 'frames' && "font-bold text-blue-400" )}
			>
				Frames:
			</span>
			<span className="text-white">{stats.samples}</span>
			{renderLimitMode === 'frames' && (
				<> / <EditableValue value={maxSamples} onCommit={handleMaxSamplesEdit} /> </>
			)}

			{isDenoising && (
				<div className="ml-2 py-1 rounded-full flex items-center">
					<span className="mr-2">Denoising</span>
					<Loader2 className="h-4 w-4 animate-spin text-blue-400" />
				</div>
			)}

			{isUpscaling && (
				<div className="ml-2 py-1 rounded-full flex items-center">
					<span className="mr-2">Upscaling</span>
					<Loader2 className="h-4 w-4 animate-spin text-blue-400" />
				</div>
			)}
		</div>
	);

};

export default StatsMeter;
