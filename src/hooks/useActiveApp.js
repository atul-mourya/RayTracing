import { useState, useEffect } from 'react';
import { getApp } from '@/core/appProxy';

/**
 * React hook that returns the path tracer app instance.
 *
 * @returns {Object|null} The app instance
 */
export function useActiveApp() {

	const [ app, setApp ] = useState( () => getApp() );

	useEffect( () => {

		// Update on mount in case app initialized after first render
		setApp( getApp() );

	}, [] );

	return app;

}

