import { useCallback, useEffect, useState } from 'react';

function read( key, initialValue ) {

	if ( typeof window === 'undefined' ) return initialValue;

	try {

		const raw = window.localStorage.getItem( key );
		return raw === null ? initialValue : JSON.parse( raw );

	} catch {

		return initialValue;

	}

}

export function useLocalStorage( key, initialValue ) {

	const [ value, setStored ] = useState( () => read( key, initialValue ) );

	const setValue = useCallback( ( next ) => {

		setStored( ( prev ) => {

			const resolved = typeof next === 'function' ? next( prev ) : next;

			try {

				window.localStorage.setItem( key, JSON.stringify( resolved ) );

			} catch {
				// quota exceeded or storage disabled — keep state in memory
			}

			return resolved;

		} );

	}, [ key ] );

	useEffect( () => {

		const onStorage = ( e ) => {

			if ( e.key !== key || e.storageArea !== window.localStorage ) return;
			setStored( e.newValue === null ? initialValue : ( () => {

				try {

					return JSON.parse( e.newValue );

				} catch {

					return initialValue;

				}

			} )() );

		};

		window.addEventListener( 'storage', onStorage );
		return () => window.removeEventListener( 'storage', onStorage );

	}, [ key, initialValue ] );

	return [ value, setValue ];

}
