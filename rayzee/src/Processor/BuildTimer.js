/**
 * BuildTimer - Tracks and logs timing for all build pipeline steps.
 * Usage:
 *   const timer = new BuildTimer();
 *   timer.start('stepName');
 *   // ... work ...
 *   timer.end('stepName');
 *   timer.print(); // logs summary table
 */
export class BuildTimer {

	constructor( label = 'Build' ) {

		this.label = label;
		this.entries = new Map();
		this.order = [];
		this.totalStart = performance.now();

	}

	start( name ) {

		this.entries.set( name, { start: performance.now(), end: null } );
		if ( ! this.order.includes( name ) ) this.order.push( name );
		return this;

	}

	end( name ) {

		const entry = this.entries.get( name );
		if ( entry ) {

			entry.end = performance.now();
			entry.duration = entry.end - entry.start;

		}

		return this;

	}

	getDuration( name ) {

		const entry = this.entries.get( name );
		return entry?.duration ?? 0;

	}

	print() {

		const totalDuration = performance.now() - this.totalStart;

		const parts = this.order
			.map( name => {

				const dur = this.entries.get( name )?.duration ?? 0;
				return dur >= 1 ? `${name} ${Math.round( dur )}ms` : null;

			} )
			.filter( Boolean );

		console.log( `[${this.label}] ${Math.round( totalDuration )}ms` + ( parts.length ? ` | ${parts.join( ' · ' )}` : '' ) );

		return { steps: Object.fromEntries( this.order.map( n => [ n, Math.round( this.entries.get( n )?.duration ?? 0 ) ] ) ), total: Math.round( totalDuration ) };

	}

}
