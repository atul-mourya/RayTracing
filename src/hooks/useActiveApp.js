import { useState, useEffect, useSyncExternalStore } from 'react';
import { getApp, getBackend, supportsFeature } from '@/core/appProxy';

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

		const backendManager = getBackend();
		if ( backendManager ) {

			const handleSwitch = () => {

				queueMicrotask( () => setApp( getApp() ) );

			};

			backendManager.on( 'switched', handleSwitch );
			return () => backendManager.off( 'switched', handleSwitch );

		}

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

		const backendManager = getBackend();
		if ( backendManager ) {

			const handleSwitch = () => {

				queueMicrotask( () => setSupported( supportsFeature( featureName ) ) );

			};

			backendManager.on( 'switched', handleSwitch );
			return () => backendManager.off( 'switched', handleSwitch );

		}

	}, [ featureName ] );

	return supported;

}
