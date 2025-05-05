import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import Viewport3D from './Viewport3D';
import { usePathTracerStore } from '@/store';
import { saveRender } from '@/utils/database';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';

// Extracted helper functions for better organization
const getPathTracerApp = () => window.pathTracerApp;

const MainViewport = ( { mode = "interactive" } ) => {

	// References
	const statsRef = useRef( null );
	const isFirstRender = useRef( true );
	const prevMode = useRef( mode );

	// State management
	const [ isDenoising, setIsDenoising ] = useState( false );
	const [ renderComplete, setRenderComplete ] = useState( false );

	// Properly cache store access to prevent infinite loops in React 19
	// Access reactive state with individual selectors
	const maxSamples = usePathTracerStore( state => state.maxSamples );
	// Get the setter function directly without subscription
	const setMaxSamples = usePathTracerStore.getState().setMaxSamples;

	// Effect: Handle mode changes and update maxSamples
	useEffect( () => {

		if ( isFirstRender.current ) {

			isFirstRender.current = false;
			return;

		}

		if ( prevMode.current === mode ) return;

		prevMode.current = mode;
		const newMaxSamples = mode === "interactive" ? 60 : 30;
		const app = getPathTracerApp();

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;
			setMaxSamples( newMaxSamples );
			updateStatsRef( { maxSamples: newMaxSamples, samples: 0 } );

		}

	}, [ mode, setMaxSamples ] );

	// Effect: Set up event listeners for denoising and rendering
	useEffect( () => {

		const app = getPathTracerApp();
		if ( ! app ) return;

		const handleDenoisingStart = () => {

			setIsDenoising( true );
			updateStatsRef( { isDenoising: true } );

		};

		const handleDenoisingEnd = () => {

			setIsDenoising( false );
			updateStatsRef( { isDenoising: false } );

		};

		if ( app.denoiser ) {

			app.denoiser.addEventListener( 'start', handleDenoisingStart );
			app.denoiser.addEventListener( 'end', handleDenoisingEnd );

		}

		app.addEventListener( 'RenderComplete', () => setRenderComplete( true ) );
		app.addEventListener( 'RenderReset', () => setRenderComplete( false ) );

		return () => {

			if ( app.denoiser ) {

				app.denoiser.removeEventListener( 'start', handleDenoisingStart );
				app.denoiser.removeEventListener( 'end', handleDenoisingEnd );

			}

			app.removeEventListener( 'RenderComplete', () => setRenderComplete( true ) );
			app.removeEventListener( 'RenderReset', () => setRenderComplete( false ) );

		};

	}, [] );

	// Helper function to update stats reference
	const updateStatsRef = useCallback( ( newStats ) => {

		if ( statsRef.current ) {

			statsRef.current.updateStats( newStats );

		}

	}, [] );

	// Handler for stats updates from child components
	const handleStatsUpdate = useCallback( ( newStats ) => {

		updateStatsRef( {
			timeElapsed: newStats.timeElapsed,
			samples: newStats.samples,
			maxSamples
		} );

	}, [ maxSamples, updateStatsRef ] );

	// Handler for editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		if ( value === maxSamples ) return;

		setMaxSamples( value );
		const app = getPathTracerApp();

		if ( app ) {

			app.pathTracingPass.material.uniforms.maxFrames.value = value;
			app.reset();
			updateStatsRef( { maxSamples: value } );

		}

	}, [ maxSamples, setMaxSamples, updateStatsRef ] );

	// Handler for saving renders
	const handleSave = useCallback( async () => {

		const app = getPathTracerApp();
		if ( ! app ) return;

		try {

			const canvas = app.denoiser.enabled && app.denoiser.output
				? app.denoiser.output
				: app.renderer.domElement;

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
			window.dispatchEvent( new CustomEvent( 'render-saved', { detail: { id } } ) );
			setRenderComplete( false );

		} catch ( error ) {

			console.error( 'Failed to save render:', error );
			alert( 'Failed to save render. See console for details.' );

		}

	}, [] );

	// Handler for discarding renders
	const handleDiscard = useCallback( () => {

		setRenderComplete( false );

	}, [] );

	// Compute whether to show save controls - moved to a separate function
	const shouldShowSaveControls = useMemo( () => {

		if ( isDenoising ) return false;
		const currentSamples = statsRef.current ? statsRef.current.getStats().samples : 0;
		return renderComplete && currentSamples === maxSamples && mode === "final";

	}, [ renderComplete, maxSamples, mode, isDenoising ] );

	console.log( 'MainViewport render' );

	return (
		<div className="w-full h-full relative">
			<Viewport3D
				onStatsUpdate={handleStatsUpdate}
				viewportMode={mode}
			/>

			<StatsMeter
				ref={statsRef}
				onMaxSamplesEdit={handleMaxSamplesEdit}
			/>

			{shouldShowSaveControls && (
				<SaveControls
					onSave={handleSave}
					onDiscard={handleDiscard}
				/>
			)}
		</div>
	);

};

// Export a memoized version of the component
export default memo( MainViewport );
