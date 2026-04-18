/**
 * Creates a debounced version of the given function that delays
 * invocation until `ms` milliseconds have elapsed since the last call.
 * The returned function has a `.cancel()` method to abort pending calls.
 */
export function debounce( fn, ms ) {

	let timer;
	function debounced( ...args ) {

		clearTimeout( timer );
		timer = setTimeout( () => fn.apply( this, args ), ms );

	}

	debounced.cancel = () => clearTimeout( timer );

	return debounced;

}
