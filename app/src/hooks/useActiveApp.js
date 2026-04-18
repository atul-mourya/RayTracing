import { useState, useEffect } from 'react';
import { getApp, subscribeApp } from '@/lib/appProxy';

/**
 * React hook that returns the path tracer app instance.
 * Subscribes to appProxy so it re-renders when the app is registered.
 *
 * @returns {Object|null} The app instance
 */
export function useActiveApp() {

	const [ app, setApp ] = useState( () => getApp() );

	useEffect( () => {

		// Pick up the app if it was already set before this effect ran
		setApp( getApp() );

		// Subscribe to future changes (e.g., app initialization or disposal)
		return subscribeApp( ( newApp ) => setApp( newApp ) );

	}, [] );

	return app;

}
