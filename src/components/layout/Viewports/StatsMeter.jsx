import { useState, useCallback, useEffect } from 'react';
import { useStore, usePathTracerStore } from '@/store';
import { getApp } from '@/core/appProxy';
import { StatusLabel } from '@/components/ui/status-label';
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

	// Store subscriptions
	const storeMaxSamples = usePathTracerStore( state => state.maxSamples );
	const setStoreMaxSamples = usePathTracerStore( state => state.setMaxSamples );
	const renderLimitMode = usePathTracerStore( state => state.renderLimitMode );
	const handleRenderLimitModeChange = usePathTracerStore( state => state.handleRenderLimitModeChange );
	const renderTimeLimit = usePathTracerStore( state => state.renderTimeLimit );
	const handleRenderTimeLimitChange = usePathTracerStore( state => state.handleRenderTimeLimitChange );

	const stats = useStore( state => state.stats );
	const isDenoising = useStore( state => state.isDenoising );
	const isUpscaling = useStore( state => state.isUpscaling );
	const upscalingProgress = useStore( state => state.upscalingProgress );

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

		setStoreMaxSamples( value );

		// Update app — setMaxSamples handles completion state internally, never resets
		const app = getApp();
		if ( app ) app.set( 'maxSamples', value );

	}, [ storeMaxSamples, setStoreMaxSamples ] );

	// Update based on viewport mode
	useEffect( () => {

		const app = getApp();
		if ( ! app ) return;

		const newMaxSamples = viewportMode === "preview" ? 60 : 30;

		app.set( 'maxSamples', newMaxSamples );
		setStoreMaxSamples( newMaxSamples );

	}, [ viewportMode, setStoreMaxSamples ] );


	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded flex flex-col gap-1">
			<div className="flex items-center gap-1">
				{sceneStats?.triangleCount > 0 && (
					<span className="mr-1">Triangles: <span className="text-white">{sceneStats.triangleCount.toLocaleString()}</span> |</span>
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
					<> / <EditableValue value={storeMaxSamples} onCommit={handleMaxSamplesEdit} /> </>
				)}
			</div>

			{isDenoising && (
				<StatusLabel label="Denoising" />
			)}

			{isUpscaling && (
				<StatusLabel
					label="Upscaling"
					percent={upscalingProgress * 100}
					onCancel={() => getApp()?.upscaler?.abort()}
				/>
			)}
		</div>
	);

};

export default StatsMeter;
