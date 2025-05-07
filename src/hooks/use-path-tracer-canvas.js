import { useCallback, useState } from 'react';
import { usePathTracerStore } from '@/store';

export function usePathTracerCanvas() {

	// Store previous state when switching modes
	const [ prevState, setPrevState ] = useState( {
		bounces: 2,
		samplesPerPixel: 1,
		interactionModeEnabled: true,
		enableOIDN: false,
		oidnQuality: 'fast',
		resolution: '1'
	} );

	// Canvas visibility functions
	const showPathTracerCanvases = useCallback( () => {

		if ( window.pathTracerApp ) {

			if ( window.pathTracerApp.renderer?.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'block';

			}

			if ( window.pathTracerApp.denoiser?.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'block';

			}

		}

	}, [] );

	const hidePathTracerCanvases = useCallback( () => {

		if ( window.pathTracerApp ) {

			if ( window.pathTracerApp.renderer?.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'none';

			}

			if ( window.pathTracerApp.denoiser?.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'none';

			}

		}

	}, [] );

	// Mode configuration logic
	const configureForMode = useCallback( ( mode, pathTracerActions ) => {

		const {
			setBounces,
			setSamplesPerPixel,
			setInteractionModeEnabled,
			setEnableOIDN,
			setUseGBuffer,
			setResolution,
			setRenderMode,
			setOidnQuality
		} = pathTracerActions;

		if ( mode === "interactive" ) {

			setRenderMode( 0 );
			setInteractionModeEnabled( true );
			setBounces( 2 );
			setSamplesPerPixel( 1 );
			setEnableOIDN( false );
			setOidnQuality( 'fast' );
			setUseGBuffer( false );
			setResolution( '1' );

			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = true;

				requestAnimationFrame( () => {

					window.pathTracerApp.denoiser.enabled = false;
					window.pathTracerApp.denoiser.quality = 'fast';
					window.pathTracerApp.denoiser.hdr = false;
					window.pathTracerApp.denoiser.useGBuffer = false;
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 0.5 );

					// Show canvases again if coming from results tab
					showPathTracerCanvases();

					// Resume rendering
					window.pathTracerApp.pauseRendering = false;
					window.pathTracerApp.reset();

				} );

			}

		} else if ( mode === "final" ) {

			setRenderMode( 1 );
			setSamplesPerPixel( 1 );
			setInteractionModeEnabled( false );
			setEnableOIDN( true );
			setOidnQuality( 'balance' );
			setUseGBuffer( true );
			setResolution( '3' );
			setBounces( 8 );

			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = false;

				requestAnimationFrame( () => {

					window.pathTracerApp.denoiser.enabled = true;
					window.pathTracerApp.denoiser.quality = 'balance';
					window.pathTracerApp.denoiser.hdr = false;
					window.pathTracerApp.denoiser.useGBuffer = true;
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 2.0 );

					// Show canvases again if coming from results tab
					showPathTracerCanvases();

					// Resume rendering
					window.pathTracerApp.pauseRendering = false;
					window.pathTracerApp.reset();

				} );

			}

		} else if ( mode === "results" ) {

			// Save current state before switching to results
			if ( window.pathTracerApp ) {

				setPrevState( {
					bounces: usePathTracerStore.getState().bounces,
					samplesPerPixel: usePathTracerStore.getState().samplesPerPixel,
					interactionModeEnabled: usePathTracerStore.getState().interactionModeEnabled,
					enableOIDN: usePathTracerStore.getState().enableOIDN,
					resolution: usePathTracerStore.getState().resolution
				} );

				// Pause rendering to save resources
				window.pathTracerApp.pauseRendering = true;

				// Disable controls but keep the app instance
				window.pathTracerApp.controls.enabled = false;

				// Hide the canvas but don't destroy the app
				hidePathTracerCanvases();

			}

		}

	}, [ showPathTracerCanvases, hidePathTracerCanvases ] );

	return {
		prevState,
		configureForMode,
		showPathTracerCanvases,
		hidePathTracerCanvases
	};

}
