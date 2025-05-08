import { useCallback, useState } from 'react';
import { usePathTracerStore } from '@/store';



const FINAL_RENDER_STATE = {
	maxSamples: 30,
	bounces: 20,
	samplesPerPixel: 1,
	renderMode: 1,
	tiles: 3,
	tilesHelper: true,
	resolution: 3,
	enableOIDN: true,
	oidnQuality: 'balance', // 'fast', 'balance', 'high'
	oidnHDR: false,
	useGBuffer: true,
	interactionModeEnabled: false,
};

export function usePathTracerCanvas() {

	// Store previous state when switching modes
	const [ prevState, setPrevState ] = useState( {
		maxSamples: 60,
		bounces: 2,
		samplesPerPixel: 1,
		renderMode: 0,
		tiles: 3,
		tilesHelper: false,
		resolution: 1,
		enableOIDN: false,
		oidnQuality: 'fast',
		oidnHDR: false,
		useGBuffer: true,
		interactionModeEnabled: true,
	} );

	// Canvas visibility functions
	const showPathTracerCanvases = useCallback( () => {

		if ( ! window.pathTracerApp ) return;

		if ( window.pathTracerApp.renderer?.domElement ) {

			window.pathTracerApp.renderer.domElement.style.display = 'block';

		}

		if ( window.pathTracerApp.denoiser?.output ) {

			window.pathTracerApp.denoiser.output.style.display = 'block';

		}

	}, [] );

	const hidePathTracerCanvases = useCallback( () => {

		if ( ! window.pathTracerApp ) return;

		if ( window.pathTracerApp.renderer?.domElement ) {

			window.pathTracerApp.renderer.domElement.style.display = 'none';

		}

		if ( window.pathTracerApp.denoiser?.output ) {

			window.pathTracerApp.denoiser.output.style.display = 'none';

		}


	}, [] );

	const configureForMode = useCallback( ( mode, pathTracerActions ) => {

		const {
			// setMaxSamples, // maxSamples value is conflicting with stats meter state
			setBounces,
			setSamplesPerPixel,
			setRenderMode,
			setTiles,
			setTilesHelper,
			setResolution,
			setEnableOIDN,
			setOidnQuality,
			setOidnHdr,
			setUseGBuffer,
			setInteractionModeEnabled,
		} = pathTracerActions;

		if ( mode === "interactive" ) {

			// setMaxSamples( 60 );
			setBounces( 2 );
			setSamplesPerPixel( 1 );
			setRenderMode( '0' );
			setTiles( 3 );
			setTilesHelper( false );
			setResolution( 1 );
			setEnableOIDN( false );
			setOidnQuality( 'fast' );
			setOidnHdr( false );
			setUseGBuffer( true );
			setInteractionModeEnabled( true );

			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = true;

				requestAnimationFrame( () => {

					// window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = 60;
					window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = 2;
					window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = 1;
					window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = 0;
					window.pathTracerApp.pathTracingPass.material.uniforms.tiles.value = 4;
					window.pathTracerApp.tileHighlightPass.enabled = false;

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

			// setMaxSamples( FINAL_RENDER_STATE.maxSamples );
			setBounces( FINAL_RENDER_STATE.bounces );
			setSamplesPerPixel( FINAL_RENDER_STATE.samplesPerPixel );
			setRenderMode( FINAL_RENDER_STATE.renderMode );
			setTiles( FINAL_RENDER_STATE.tiles );
			setTilesHelper( FINAL_RENDER_STATE.tilesHelper );
			setResolution( FINAL_RENDER_STATE.resolution );
			setEnableOIDN( FINAL_RENDER_STATE.enableOIDN );
			setOidnQuality( FINAL_RENDER_STATE.oidnQuality );
			setOidnHdr( FINAL_RENDER_STATE.oidnHDR );
			setUseGBuffer( FINAL_RENDER_STATE.useGBuffer );
			setInteractionModeEnabled( FINAL_RENDER_STATE.interactionModeEnabled );

			if ( window.pathTracerApp ) {

				// Disable controls in final render mode
				window.pathTracerApp.controls.enabled = false;

				requestAnimationFrame( () => {

					window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = FINAL_RENDER_STATE.maxSamples;
					window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = FINAL_RENDER_STATE.bounces;
					window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = FINAL_RENDER_STATE.samplesPerPixel;
					window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = FINAL_RENDER_STATE.renderMode;
					window.pathTracerApp.pathTracingPass.material.uniforms.tiles.value = FINAL_RENDER_STATE.tiles;
					window.pathTracerApp.tileHighlightPass.enabled = FINAL_RENDER_STATE.tilesHelper;

					window.pathTracerApp.denoiser.enabled = FINAL_RENDER_STATE.enableOIDN;
					window.pathTracerApp.denoiser.quality = FINAL_RENDER_STATE.oidnQuality;
					window.pathTracerApp.denoiser.hdr = FINAL_RENDER_STATE.oidnHDR;
					window.pathTracerApp.denoiser.useGBuffer = FINAL_RENDER_STATE.useGBuffer;

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
