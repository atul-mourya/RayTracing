import { useState, useEffect, useSyncExternalStore } from 'react';
import { getApp, supportsFeature } from '@/core/appProxy';
import { getBackendManager } from '@/core/BackendManager';

/**
 * React hook that returns the currently active backend app.
 * Re-renders the component when the backend switches.
 *
 * @returns {Object|null} The active app instance
 */
export function useActiveApp() {

	const [ app, setApp ] = useState( () => getApp() );

	useEffect( () => {

		// Update on mount in case app initialized after first render
		setApp( getApp() );

		const handleSwitch = () => {

			queueMicrotask( () => setApp( getApp() ) );

		};

		const backendManager = getBackendManager();
		if ( backendManager ) {

			backendManager.on( 'switched', handleSwitch );

		}

		// Also listen for the window event (fires reliably regardless of timing)
		window.addEventListener( 'BackendSwitched', handleSwitch );

		return () => {

			if ( backendManager ) backendManager.off( 'switched', handleSwitch );
			window.removeEventListener( 'BackendSwitched', handleSwitch );

		};

	}, [] );

	return app;

}

/**
 * React hook that checks if a feature is supported by the current backend.
 * Re-evaluates when the backend switches.
 *
 * @param {string} featureName - The feature to check
 * @returns {boolean} Whether the feature is supported
 */
export function useBackendFeature( featureName ) {

	const [ supported, setSupported ] = useState( () => supportsFeature( featureName ) );

	useEffect( () => {

		setSupported( supportsFeature( featureName ) );

		const handleSwitch = () => {

			queueMicrotask( () => setSupported( supportsFeature( featureName ) ) );

		};

		const backendManager = getBackendManager();
		if ( backendManager ) {

			backendManager.on( 'switched', handleSwitch );

		}

		// Also listen for the window event (fires reliably regardless of timing)
		window.addEventListener( 'BackendSwitched', handleSwitch );

		return () => {

			if ( backendManager ) backendManager.off( 'switched', handleSwitch );
			window.removeEventListener( 'BackendSwitched', handleSwitch );

		};

	}, [ featureName ] );

	return supported;

}
