import { useState, useCallback } from 'react';

export function useToggle( initialValue = false ) {

	const [ value, setValue ] = useState( initialValue );

	const toggle = useCallback( ( next ) => {

		setValue( ( prev ) => ( typeof next === 'boolean' ? next : ! prev ) );

	}, [] );

	return [ value, toggle ];

}
