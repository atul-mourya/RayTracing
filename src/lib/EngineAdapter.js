/**
 * EngineAdapter — bridges engine events to Zustand stores.
 *
 * This is the ONLY file that wires the framework-agnostic engine events
 * to the React/Zustand UI layer. If you're using a different UI framework,
 * replace this adapter with your own.
 */
import { EngineEvents } from '@/core/EngineEvents.js';

/**
 * Subscribe to engine events and dispatch corresponding Zustand store updates.
 * @param {PathTracerApp} engine - The engine instance (extends EventDispatcher)
 * @param {Object} stores - Zustand stores { useStore, useCameraStore, usePathTracerStore }
 * @returns {Function} cleanup - Call to unsubscribe all listeners
 */
export function connectEngineToStore( engine, { useStore, useCameraStore, usePathTracerStore } ) {

	const handlers = [];

	function on( type, fn ) {

		engine.addEventListener( type, fn );
		handlers.push( [ type, fn ] );

	}

	// ── Render lifecycle ─────────────────────────────────────
	on( EngineEvents.RENDER_COMPLETE, () => {

		useStore.getState().setIsRenderComplete( true );
		useStore.getState().setIsRendering( false );

	} );

	on( EngineEvents.RENDER_RESET, () => {

		useStore.getState().setIsRenderComplete( false );
		useStore.getState().setIsRendering( true );

	} );

	// ── Denoiser ─────────────────────────────────────────────
	on( EngineEvents.DENOISING_START, () => useStore.getState().setIsDenoising( true ) );
	on( EngineEvents.DENOISING_END, () => useStore.getState().setIsDenoising( false ) );

	// ── Upscaler ─────────────────────────────────────────────
	on( EngineEvents.UPSCALING_START, () => {

		useStore.getState().setIsUpscaling( true );
		useStore.getState().setUpscalingProgress( 0 );

	} );

	on( EngineEvents.UPSCALING_PROGRESS, ( e ) => {

		useStore.getState().setUpscalingProgress( e.progress );

	} );

	on( EngineEvents.UPSCALING_END, () => {

		useStore.getState().setIsUpscaling( false );
		useStore.getState().setUpscalingProgress( 0 );

	} );

	// ── Loading & stats ──────────────────────────────────────
	on( EngineEvents.LOADING_RESET, () => useStore.getState().resetLoading() );

	on( EngineEvents.LOADING_UPDATE, ( e ) => {

		const { type: _type, target: _target, ...loadingState } = e;
		const state = useStore.getState();
		state.setLoading( { ...state.loading, ...loadingState } );

	} );

	on( EngineEvents.STATS_UPDATE, ( e ) => {

		const { type: _type, target: _target, ...statsUpdate } = e;
		const state = useStore.getState();
		state.setStats( { ...( state.stats || {} ), ...statsUpdate } );

	} );

	// ── Selection & interaction ──────────────────────────────
	on( EngineEvents.OBJECT_SELECTED, ( e ) => {

		useStore.getState().setSelectedObject( e.object );

	} );

	on( EngineEvents.OBJECT_DOUBLE_CLICKED, () => {

		useStore.getState().setActiveTab( 'material' );

	} );

	on( EngineEvents.SELECT_MODE_CHANGED, ( e ) => {

		useCameraStore.getState().setSelectMode( e.enabled );

	} );

	// ── Camera ───────────────────────────────────────────────
	on( EngineEvents.AF_POINT_PLACED, ( e ) => {

		useCameraStore.getState().handleAFScreenPointChange( e.point );

	} );

	on( EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => {

		useCameraStore.getState().setAutoFocusDistance( e.distance );

	} );

	on( EngineEvents.AUTO_EXPOSURE_UPDATED, ( e ) => {

		usePathTracerStore.getState().setCurrentAutoExposure( e.exposure );
		usePathTracerStore.getState().setCurrentAvgLuminance( e.luminance );

	} );

	// ── Window event forwarding (backward compat for components listening on window) ──
	on( 'SceneRebuild', () => {

		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

	} );

	on( 'resolution_changed', ( e ) => {

		window.dispatchEvent( new CustomEvent( 'resolution_changed', {
			detail: { width: e.width, height: e.height }
		} ) );

	} );

	// ── Cleanup ──────────────────────────────────────────────
	return () => {

		handlers.forEach( ( [ type, fn ] ) => engine.removeEventListener( type, fn ) );
		handlers.length = 0;

	};

}
