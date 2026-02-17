import { useEffect, useRef } from 'react';
import { getApp } from '@/core/appProxy';
import { getBackendManager } from '@/core/BackendManager';

/**
 * React hook that subscribes to an event on the active backend app.
 * Automatically re-subscribes when the backend switches.
 *
 * @param {string} eventName - The event name to listen for (e.g., 'RenderComplete')
 * @param {Function} handler - The callback to invoke when the event fires
 */
export function useBackendEvent( eventName, handler ) {

	const handlerRef = useRef( handler );
	handlerRef.current = handler;

	useEffect( () => {

		const stableHandler = ( event ) => handlerRef.current( event );

		// Subscribe to the current app
		const app = getApp();
		if ( app ) {

			app.addEventListener( eventName, stableHandler );

		}

		// Listen for backend switches to re-subscribe
		const backendManager = getBackendManager();
		const handleSwitch = () => {

			// Unsubscribe from old app (may already be gone)
			const oldApp = getApp();
			// Re-subscribe after a microtask to let the switch settle
			queueMicrotask( () => {

				const newApp = getApp();
				if ( newApp ) {

					newApp.addEventListener( eventName, stableHandler );

				}

			} );

		};

		if ( backendManager ) {

			backendManager.on( 'switched', handleSwitch );

		}

		return () => {

			const app = getApp();
			if ( app ) {

				app.removeEventListener( eventName, stableHandler );

			}

			if ( backendManager ) {

				backendManager.off( 'switched', handleSwitch );

			}

		};

	}, [ eventName ] );

}
