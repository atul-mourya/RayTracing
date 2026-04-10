/**
 * Creates a debounced version of the given function that delays
 * invocation until `ms` milliseconds have elapsed since the last call.
 */
export function debounce( fn, ms ) {

	let timer;
	return function ( ...args ) {

		clearTimeout( timer );
		timer = setTimeout( () => fn.apply( this, args ), ms );

	};

}
