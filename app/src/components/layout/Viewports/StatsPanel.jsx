import { useEffect } from 'react';
import Stats from 'stats-gl';
import { EngineEvents } from 'rayzee';

const FG = '#ffffff';
const BG = '#1e293b';

function themePanel( panel ) {

	if ( ! panel ) return;
	const gradient = panel.context.createLinearGradient(
		0, panel.GRAPH_Y,
		0, panel.GRAPH_Y + panel.GRAPH_HEIGHT
	);
	gradient.addColorStop( 0, FG );
	panel.fg = FG;
	panel.bg = BG;
	panel.gradient = gradient;

}

/**
 * Mounts a stats-gl HUD against the engine's renderer and ticks it on
 * every engine FRAME event. The HUD is mounted into `container` (or the
 * canvas parent) and torn down on unmount.
 */
export default function StatsPanel( { app, container } ) {

	useEffect( () => {

		if ( ! app?.renderer ) return;

		const stats = new Stats( { horizontal: true, trackGPU: true } );
		stats.dom.style.position = 'absolute';
		stats.dom.style.top = 'unset';
		stats.dom.style.bottom = '48px';
		stats.init( app.renderer );

		const mount = container || app.canvas?.parentElement || document.body;
		mount.appendChild( stats.dom );

		themePanel( stats.fpsPanel );
		themePanel( stats.msPanel );
		themePanel( stats.gpuPanel );

		const onFrame = () => stats.update();
		app.addEventListener( EngineEvents.FRAME, onFrame );

		return () => {

			app.removeEventListener( EngineEvents.FRAME, onFrame );
			stats.dom.remove();

		};

	}, [ app, container ] );

	return null;

}
