/**
 * BuildTimer - Tracks and logs timing for all build pipeline steps.
 * Usage:
 *   const timer = new BuildTimer();
 *   timer.start('stepName');
 *   // ... work ...
 *   timer.end('stepName');
 *   timer.print(); // logs summary table
 */
export default class BuildTimer {

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

		const rows = this.order.map( name => {

			const entry = this.entries.get( name );
			const dur = entry?.duration ?? 0;
			const pct = totalDuration > 0 ? ( dur / totalDuration * 100 ).toFixed( 1 ) : '0.0';
			return { Step: name, 'Time (ms)': Math.round( dur ), '%': pct + '%' };

		} );

		rows.push( { Step: 'TOTAL', 'Time (ms)': Math.round( totalDuration ), '%': '100%' } );

		console.groupCollapsed( `⏱ ${this.label} Timing (${Math.round( totalDuration )}ms)` );
		console.table( rows );
		console.groupEnd();

		return { steps: Object.fromEntries( this.order.map( n => [ n, Math.round( this.entries.get( n )?.duration ?? 0 ) ] ) ), total: Math.round( totalDuration ) };

	}

}
