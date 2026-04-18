import Stats from 'stats-gl';

/**
 * Creates and configures a stats-gl performance panel.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {HTMLElement} [container=document.body] - DOM element to mount the stats panel
 * @returns {Stats}
 */
export function createStats( renderer, container ) {

	const stats = new Stats( { horizontal: true, trackGPU: true } );
	stats.dom.style.position = 'absolute';
	stats.dom.style.top = 'unset';
	stats.dom.style.bottom = '48px';

	stats.init( renderer );
	( container || document.body ).appendChild( stats.dom );

	const foregroundColor = '#ffffff';
	const backgroundColor = '#1e293b';

	const gradient = stats.fpsPanel.context.createLinearGradient(
		0, stats.fpsPanel.GRAPH_Y,
		0, stats.fpsPanel.GRAPH_Y + stats.fpsPanel.GRAPH_HEIGHT
	);
	gradient.addColorStop( 0, foregroundColor );

	stats.fpsPanel.fg = stats.msPanel.fg = foregroundColor;
	stats.fpsPanel.bg = stats.msPanel.bg = backgroundColor;
	stats.fpsPanel.gradient = stats.msPanel.gradient = gradient;

	if ( stats.gpuPanel ) {

		stats.gpuPanel.fg = foregroundColor;
		stats.gpuPanel.bg = backgroundColor;
		stats.gpuPanel.gradient = gradient;

	}

	stats.dom.style.display = '';

	return stats;

}
