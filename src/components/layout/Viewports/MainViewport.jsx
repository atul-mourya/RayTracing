import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import Viewport3D from './Viewport3D';
import { usePathTracerStore } from '@/store';
import { saveRender } from '@/utils/database';
import StatsMeter from './StatsMeter';
import SaveControls from './SaveControls';

const MainViewport = ( { mode = "interactive" } ) => {

	// References
	const containerRef = useRef( null );
	const isFirstRender = useRef( true );
	const prevMode = useRef( mode );
	const statsRef = useRef( null );

	// Consolidated state for better management
	const [ viewportState, setViewportState ] = useState( {
		isDenoising: false,
		renderComplete: false
	} );

	// Destructure state for readability
	const { isDenoising, renderComplete } = viewportState;

	// Access store values directly to avoid infinite loops
	const pathTracerStore = usePathTracerStore();

	// Use useMemo to cache the extracted values
	const { maxSamples, setMaxSamples } = useMemo( () => ( {
		maxSamples: pathTracerStore.maxSamples,
		setMaxSamples: pathTracerStore.setMaxSamples
	} ), [ pathTracerStore.maxSamples, pathTracerStore.setMaxSamples ] );

	// Update stats efficiently without causing re-renders in the parent component
	const handleStatsUpdate = useCallback( ( newStats ) => {

		// Use the ref to update stats directly
		if ( statsRef.current ) {

			statsRef.current.updateStats( {
				timeElapsed: newStats.timeElapsed,
				samples: newStats.samples,
				maxSamples: maxSamples
			} );

		}

	}, [ maxSamples ] );

	// Update maxSamples when mode changes
	useEffect( () => {

		// Only perform update if mode has actually changed (not on first render)
		if ( isFirstRender.current ) {

			isFirstRender.current = false;
			return;

		}

		// Skip if mode hasn't changed
		if ( prevMode.current === mode ) {

			return;

		}

		prevMode.current = mode;
		const newMaxSamples = mode === "interactive" ? 60 : 30;

		if ( window.pathTracerApp ) {

			// Batch these operations to minimize render cycles
			window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = newMaxSamples;

			// Use functional update to guarantee we're working with latest state
			setMaxSamples( newMaxSamples );

			// Update the stats display through the ref
			if ( statsRef.current ) {

				statsRef.current.updateStats( { maxSamples: newMaxSamples, samples: 0 } );

			}

		}

	}, [ mode, setMaxSamples ] );

	// Set up event listeners for denoising and rendering
	useEffect( () => {

		// Define handlers outside to avoid recreating them on each render
		const handleDenoisingStart = () => {

			console.log( "Denoising started" );
			setViewportState( prev => ( { ...prev, isDenoising: true } ) );
			if ( statsRef.current ) {

				statsRef.current.updateStats( { isDenoising: true } );

			}

		};

		const handleDenoisingEnd = () => {

			console.log( "Denoising ended" );
			setViewportState( prev => ( { ...prev, isDenoising: false } ) );
			if ( statsRef.current ) {

				statsRef.current.updateStats( { isDenoising: false } );

			}

		};

		const handleRenderComplete = () => setViewportState( prev => ( { ...prev, renderComplete: true } ) );
		const handleRenderReset = () => setViewportState( prev => ( { ...prev, renderComplete: false } ) );

		const app = window.pathTracerApp;
		if ( app ) {

			if ( app.denoiser ) {

				app.denoiser.addEventListener( 'start', handleDenoisingStart );
				app.denoiser.addEventListener( 'end', handleDenoisingEnd );

			}

			app.addEventListener( 'RenderComplete', handleRenderComplete );
			app.addEventListener( 'RenderReset', handleRenderReset );

		}

		return () => {

			if ( app ) {

				if ( app.denoiser ) {

					app.denoiser.removeEventListener( 'start', handleDenoisingStart );
					app.denoiser.removeEventListener( 'end', handleDenoisingEnd );

				}

				app.removeEventListener( 'RenderComplete', handleRenderComplete );
				app.removeEventListener( 'RenderReset', handleRenderReset );

			}

		};

	}, [] );

	// Handler for editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		if ( value === maxSamples ) return; // Skip if value hasn't changed

		setMaxSamples( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = value;
			window.pathTracerApp.reset();

		}

		// Update the stats display through the ref
		if ( statsRef.current ) {

			statsRef.current.updateStats( { maxSamples: value } );

		}

	}, [ setMaxSamples, maxSamples ] );

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
	const shouldShowSaveControls = useMemo( () => {

		if ( isDenoising ) return false;
		// Get the current samples count from the stats ref
		const currentSamples = statsRef.current ? statsRef.current.getStats().samples : 0;
		return renderComplete && currentSamples === maxSamples && mode === "final";

	}, [ renderComplete, maxSamples, mode, isDenoising ] );

	console.log( 'Rendering' );
	console.log( 'renderComplete:', renderComplete );
	console.log( 'maxSamples:', maxSamples );
	console.log( 'isDenoising:', isDenoising );
	console.log( 'mode:', mode );

	return (
		<div ref={containerRef} className="w-full h-full relative">
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
