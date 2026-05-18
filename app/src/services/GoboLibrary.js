/**
 * Kenney's CC0 Light Masks pack
 * (https://kenney.nl/assets/light-masks). Files served from the shared
 * assets CDN under `lightmasks/`.
 */

import { ASSETS_BASE_URL } from '@/Constants';

const BASE = `${ASSETS_BASE_URL}/LightMasks/`;

export const GOBO_LIBRARY = [
	// Cones
	{ name: 'cone-soft', label: 'Cone — Soft', url: `${BASE}cone_a.png` },
	{ name: 'cone-a-noise', label: 'Cone — A (Noise)', url: `${BASE}cone_a_noise.png` },
	{ name: 'cone-a-blur', label: 'Cone — A (Blur)', url: `${BASE}cone_a_blur.png` },
	{ name: 'cone-a-blur-noise', label: 'Cone — A (Blur, Noise)', url: `${BASE}cone_a_blur_noise.png` },
	{ name: 'cone-b', label: 'Cone — B', url: `${BASE}cone_b.png` },
	{ name: 'cone-b-noise', label: 'Cone — B (Noise)', url: `${BASE}cone_b_noise.png` },
	{ name: 'cone-b-blur', label: 'Cone — B (Blur)', url: `${BASE}cone_b_blur.png` },
	{ name: 'cone-b-blur-noise', label: 'Cone — B (Blur, Noise)', url: `${BASE}cone_b_blur_noise.png` },
	{ name: 'cone-c', label: 'Cone — C', url: `${BASE}cone_c.png` },
	{ name: 'cone-c-noise', label: 'Cone — C (Noise)', url: `${BASE}cone_c_noise.png` },
	{ name: 'cone-c-blur', label: 'Cone — C (Blur)', url: `${BASE}cone_c_blur.png` },
	{ name: 'cone-c-blur-noise', label: 'Cone — C (Blur, Noise)', url: `${BASE}cone_c_blur_noise.png` },
	{ name: 'cone-d', label: 'Cone — D', url: `${BASE}cone_d.png` },
	{ name: 'cone-d-noise', label: 'Cone — D (Noise)', url: `${BASE}cone_d_noise.png` },
	{ name: 'cone-d-blur', label: 'Cone — D (Blur)', url: `${BASE}cone_d_blur.png` },
	{ name: 'cone-d-blur-noise', label: 'Cone — D (Blur, Noise)', url: `${BASE}cone_d_blur_noise.png` },
	{ name: 'cone-narrow', label: 'Cone — Narrow', url: `${BASE}cone_e.png` },
	{ name: 'cone-e-noise', label: 'Cone — E (Noise)', url: `${BASE}cone_e_noise.png` },
	{ name: 'cone-e-blur', label: 'Cone — E (Blur)', url: `${BASE}cone_e_blur.png` },
	{ name: 'cone-e-blur-noise', label: 'Cone — E (Blur, Noise)', url: `${BASE}cone_e_blur_noise.png` },

	// Cone Composed
	{ name: 'cone-composed-a', label: 'Cone Composed — A', url: `${BASE}cone_composed_a.png` },
	{ name: 'cone-composed-a-noise', label: 'Cone Composed — A (Noise)', url: `${BASE}cone_composed_a_noise.png` },
	{ name: 'cone-composed-b', label: 'Cone Composed — B', url: `${BASE}cone_composed_b.png` },
	{ name: 'cone-composed-b-noise', label: 'Cone Composed — B (Noise)', url: `${BASE}cone_composed_b_noise.png` },
	{ name: 'cone-composed-c', label: 'Cone Composed — C', url: `${BASE}cone_composed_c.png` },
	{ name: 'cone-composed-c-noise', label: 'Cone Composed — C (Noise)', url: `${BASE}cone_composed_c_noise.png` },
	{ name: 'cone-composed-d', label: 'Cone Composed — D', url: `${BASE}cone_composed_d.png` },
	{ name: 'cone-composed-d-noise', label: 'Cone Composed — D (Noise)', url: `${BASE}cone_composed_d_noise.png` },
	{ name: 'cone-composed-e', label: 'Cone Composed — E', url: `${BASE}cone_composed_e.png` },
	{ name: 'cone-composed-e-noise', label: 'Cone Composed — E (Noise)', url: `${BASE}cone_composed_e_noise.png` },
	{ name: 'cone-composed-f', label: 'Cone Composed — F', url: `${BASE}cone_composed_f.png` },
	{ name: 'cone-composed-f-noise', label: 'Cone Composed — F (Noise)', url: `${BASE}cone_composed_f_noise.png` },

	// Circles
	{ name: 'circle', label: 'Circle', url: `${BASE}circle_a.png` },
	{ name: 'circle-a-noise', label: 'Circle — A (Noise)', url: `${BASE}circle_a_noise.png` },
	{ name: 'circle-a-streaks', label: 'Circle — A (Streaks)', url: `${BASE}circle_a_streaks.png` },
	{ name: 'circle-a-streaks-noise', label: 'Circle — A (Streaks, Noise)', url: `${BASE}circle_a_streaks_noise.png` },
	{ name: 'circle-b', label: 'Circle — B', url: `${BASE}circle_b.png` },
	{ name: 'circle-b-noise', label: 'Circle — B (Noise)', url: `${BASE}circle_b_noise.png` },
	{ name: 'circle-b-streaks', label: 'Circle — B (Streaks)', url: `${BASE}circle_b_streaks.png` },
	{ name: 'circle-b-streaks-noise', label: 'Circle — B (Streaks, Noise)', url: `${BASE}circle_b_streaks_noise.png` },
	{ name: 'circle-c', label: 'Circle — C', url: `${BASE}circle_c.png` },
	{ name: 'circle-c-noise', label: 'Circle — C (Noise)', url: `${BASE}circle_c_noise.png` },
	{ name: 'circle-c-streaks', label: 'Circle — C (Streaks)', url: `${BASE}circle_c_streaks.png` },
	{ name: 'circle-c-streaks-noise', label: 'Circle — C (Streaks, Noise)', url: `${BASE}circle_c_streaks_noise.png` },
	{ name: 'circle-d', label: 'Circle — D', url: `${BASE}circle_d.png` },
	{ name: 'circle-d-noise', label: 'Circle — D (Noise)', url: `${BASE}circle_d_noise.png` },
	{ name: 'circle-d-streaks', label: 'Circle — D (Streaks)', url: `${BASE}circle_d_streaks.png` },
	{ name: 'circle-d-streaks-noise', label: 'Circle — D (Streaks, Noise)', url: `${BASE}circle_d_streaks_noise.png` },

	// Concentric Rings
	{ name: 'rings', label: 'Concentric Rings', url: `${BASE}circle_rings_a.png` },
	{ name: 'rings-a-noise', label: 'Concentric Rings — A (Noise)', url: `${BASE}circle_rings_a_noise.png` },
	{ name: 'rings-a-streaks', label: 'Concentric Rings — A (Streaks)', url: `${BASE}circle_rings_a_streaks.png` },
	{ name: 'rings-b', label: 'Concentric Rings — B', url: `${BASE}circle_rings_b.png` },
	{ name: 'rings-b-noise', label: 'Concentric Rings — B (Noise)', url: `${BASE}circle_rings_b_noise.png` },
	{ name: 'rings-b-streaks', label: 'Concentric Rings — B (Streaks)', url: `${BASE}circle_rings_b_streaks.png` },
	{ name: 'rings-c', label: 'Concentric Rings — C', url: `${BASE}circle_rings_c.png` },
	{ name: 'rings-c-noise', label: 'Concentric Rings — C (Noise)', url: `${BASE}circle_rings_c_noise.png` },
	{ name: 'rings-c-streaks', label: 'Concentric Rings — C (Streaks)', url: `${BASE}circle_rings_c_streaks.png` },
	{ name: 'rings-d', label: 'Concentric Rings — D', url: `${BASE}circle_rings_d.png` },
	{ name: 'rings-d-noise', label: 'Concentric Rings — D (Noise)', url: `${BASE}circle_rings_d_noise.png` },
	{ name: 'rings-d-streaks', label: 'Concentric Rings — D (Streaks)', url: `${BASE}circle_rings_d_streaks.png` },

	// Rings (single)
	{ name: 'ring-a', label: 'Ring — A', url: `${BASE}ring_a.png` },
	{ name: 'ring-a-noise', label: 'Ring — A (Noise)', url: `${BASE}ring_a_noise.png` },
	{ name: 'ring-a-streaks', label: 'Ring — A (Streaks)', url: `${BASE}ring_a_streaks.png` },
	{ name: 'ring-b', label: 'Ring — B', url: `${BASE}ring_b.png` },
	{ name: 'ring-b-noise', label: 'Ring — B (Noise)', url: `${BASE}ring_b_noise.png` },
	{ name: 'ring-b-streaks', label: 'Ring — B (Streaks)', url: `${BASE}ring_b_streaks.png` },
	{ name: 'ring-c', label: 'Ring — C', url: `${BASE}ring_c.png` },
	{ name: 'ring-c-noise', label: 'Ring — C (Noise)', url: `${BASE}ring_c_noise.png` },
	{ name: 'ring-c-streaks', label: 'Ring — C (Streaks)', url: `${BASE}ring_c_streaks.png` },

	// Streaks
	{ name: 'streaks', label: 'Light Streaks', url: `${BASE}streaks_composed_a.png` },
	{ name: 'streaks-a-noise', label: 'Streaks — A (Noise)', url: `${BASE}streaks_composed_a_noise.png` },
	{ name: 'streaks-b', label: 'Streaks — B', url: `${BASE}streaks_composed_b.png` },
	{ name: 'streaks-b-noise', label: 'Streaks — B (Noise)', url: `${BASE}streaks_composed_b_noise.png` },
	{ name: 'streaks-c', label: 'Streaks — C', url: `${BASE}streaks_composed_c.png` },
	{ name: 'streaks-c-noise', label: 'Streaks — C (Noise)', url: `${BASE}streaks_composed_c_noise.png` },
	{ name: 'streaks-d', label: 'Streaks — D', url: `${BASE}streaks_composed_d.png` },
	{ name: 'streaks-d-noise', label: 'Streaks — D (Noise)', url: `${BASE}streaks_composed_d_noise.png` },
	{ name: 'streaks-e', label: 'Streaks — E', url: `${BASE}streaks_composed_e.png` },
	{ name: 'streaks-e-noise', label: 'Streaks — E (Noise)', url: `${BASE}streaks_composed_e_noise.png` },
	{ name: 'streaks-f', label: 'Streaks — F', url: `${BASE}streaks_composed_f.png` },
	{ name: 'streaks-f-noise', label: 'Streaks — F (Noise)', url: `${BASE}streaks_composed_f_noise.png` },
	{ name: 'streaks-g', label: 'Streaks — G', url: `${BASE}streaks_composed_g.png` },
	{ name: 'streaks-g-noise', label: 'Streaks — G (Noise)', url: `${BASE}streaks_composed_g_noise.png` },
	{ name: 'streaks-h', label: 'Streaks — H', url: `${BASE}streaks_composed_h.png` },
	{ name: 'streaks-h-noise', label: 'Streaks — H (Noise)', url: `${BASE}streaks_composed_h_noise.png` },

	// Windows
	{ name: 'window-single', label: 'Window — Single', url: `${BASE}window_a.png` },
	{ name: 'window-a-blur', label: 'Window — A (Blur)', url: `${BASE}window_a_blur.png` },
	{ name: 'window-a-noise', label: 'Window — A (Noise)', url: `${BASE}window_a_noise.png` },
	{ name: 'window-b', label: 'Window — B', url: `${BASE}window_b.png` },
	{ name: 'window-b-blur', label: 'Window — B (Blur)', url: `${BASE}window_b_blur.png` },
	{ name: 'window-b-noise', label: 'Window — B (Noise)', url: `${BASE}window_b_noise.png` },
	{ name: 'window-c', label: 'Window — C', url: `${BASE}window_c.png` },
	{ name: 'window-c-blur', label: 'Window — C (Blur)', url: `${BASE}window_c_blur.png` },
	{ name: 'window-c-noise', label: 'Window — C (Noise)', url: `${BASE}window_c_noise.png` },
	{ name: 'window-grid', label: 'Window — Grid', url: `${BASE}window_d.png` },
	{ name: 'window-d-blur', label: 'Window — D (Blur)', url: `${BASE}window_d_blur.png` },
	{ name: 'window-d-noise', label: 'Window — D (Noise)', url: `${BASE}window_d_noise.png` },
	{ name: 'window-e', label: 'Window — E', url: `${BASE}window_e.png` },
	{ name: 'window-e-blur', label: 'Window — E (Blur)', url: `${BASE}window_e_blur.png` },
	{ name: 'window-e-noise', label: 'Window — E (Noise)', url: `${BASE}window_e_noise.png` },
	{ name: 'window-f', label: 'Window — F', url: `${BASE}window_f.png` },
	{ name: 'window-f-blur', label: 'Window — F (Blur)', url: `${BASE}window_f_blur.png` },
	{ name: 'window-f-noise', label: 'Window — F (Noise)', url: `${BASE}window_f_noise.png` },
	{ name: 'window-g', label: 'Window — G', url: `${BASE}window_g.png` },
	{ name: 'window-g-blur', label: 'Window — G (Blur)', url: `${BASE}window_g_blur.png` },
	{ name: 'window-g-noise', label: 'Window — G (Noise)', url: `${BASE}window_g_noise.png` },
	{ name: 'window-arched', label: 'Window — Arched', url: `${BASE}window_h.png` },
	{ name: 'window-h-blur', label: 'Window — H (Blur)', url: `${BASE}window_h_blur.png` },
	{ name: 'window-h-noise', label: 'Window — H (Noise)', url: `${BASE}window_h_noise.png` },
	{ name: 'window-i', label: 'Window — I', url: `${BASE}window_i.png` },
	{ name: 'window-i-blur', label: 'Window — I (Blur)', url: `${BASE}window_i_blur.png` },
	{ name: 'window-i-noise', label: 'Window — I (Noise)', url: `${BASE}window_i_noise.png` },
	{ name: 'window-j', label: 'Window — J', url: `${BASE}window_j.png` },
	{ name: 'window-j-blur', label: 'Window — J (Blur)', url: `${BASE}window_j_blur.png` },
	{ name: 'window-j-noise', label: 'Window — J (Noise)', url: `${BASE}window_j_noise.png` },
	{ name: 'window-k', label: 'Window — K', url: `${BASE}window_k.png` },
	{ name: 'window-k-blur', label: 'Window — K (Blur)', url: `${BASE}window_k_blur.png` },
	{ name: 'window-k-noise', label: 'Window — K (Noise)', url: `${BASE}window_k_noise.png` },

	// Foliage
	{ name: 'foliage-dense', label: 'Foliage — Dense', url: `${BASE}foliage_canopy_a.png` },
	{ name: 'foliage-a-blur', label: 'Foliage — A (Blur)', url: `${BASE}foliage_canopy_a_blur.png` },
	{ name: 'foliage-a-noise', label: 'Foliage — A (Noise)', url: `${BASE}foliage_canopy_a_noise.png` },
	{ name: 'foliage-sparse', label: 'Foliage — Sparse', url: `${BASE}foliage_canopy_b.png` },
	{ name: 'foliage-b-blur', label: 'Foliage — B (Blur)', url: `${BASE}foliage_canopy_b_blur.png` },
	{ name: 'foliage-b-noise', label: 'Foliage — B (Noise)', url: `${BASE}foliage_canopy_b_noise.png` },
	{ name: 'foliage-c', label: 'Foliage — C', url: `${BASE}foliage_canopy_c.png` },
	{ name: 'foliage-c-blur', label: 'Foliage — C (Blur)', url: `${BASE}foliage_canopy_c_blur.png` },
	{ name: 'foliage-c-noise', label: 'Foliage — C (Noise)', url: `${BASE}foliage_canopy_c_noise.png` },
	{ name: 'foliage-d', label: 'Foliage — D', url: `${BASE}foliage_canopy_d.png` },
	{ name: 'foliage-d-noise', label: 'Foliage — D (Noise)', url: `${BASE}foliage_canopy_d_noise.png` },

	// Caustics
	{ name: 'caustics-soft', label: 'Caustics — Soft', url: `${BASE}water_caustics_a.png` },
	{ name: 'caustics-b', label: 'Caustics — B', url: `${BASE}water_caustics_b.png` },
	{ name: 'caustics-sharp', label: 'Caustics — Sharp', url: `${BASE}water_caustics_c.png` },
	{ name: 'caustics-d', label: 'Caustics — D', url: `${BASE}water_caustics_d.png` },

	// Fans
	{ name: 'fan-4', label: 'Fan — 4 Blade', url: `${BASE}fan_a.png` },
	{ name: 'fan-a-blur', label: 'Fan — A (Blur)', url: `${BASE}fan_a_blur.png` },
	{ name: 'fan-a-gradient', label: 'Fan — A (Gradient)', url: `${BASE}fan_a_gradient.png` },
	{ name: 'fan-3', label: 'Fan — 3 Blade', url: `${BASE}fan_b.png` },
	{ name: 'fan-b-blur', label: 'Fan — B (Blur)', url: `${BASE}fan_b_blur.png` },
	{ name: 'fan-b-gradient', label: 'Fan — B (Gradient)', url: `${BASE}fan_b_gradient.png` },
	{ name: 'fan-c', label: 'Fan — C', url: `${BASE}fan_c.png` },
	{ name: 'fan-c-blur', label: 'Fan — C (Blur)', url: `${BASE}fan_c_blur.png` },
	{ name: 'fan-c-gradient', label: 'Fan — C (Gradient)', url: `${BASE}fan_c_gradient.png` },
	{ name: 'fan-d', label: 'Fan — D', url: `${BASE}fan_d.png` },
	{ name: 'fan-d-blur', label: 'Fan — D (Blur)', url: `${BASE}fan_d_blur.png` },
	{ name: 'fan-d-gradient', label: 'Fan — D (Gradient)', url: `${BASE}fan_d_gradient.png` },

	// Abstract Shapes
	{ name: 'shape-a', label: 'Shape — A', url: `${BASE}shape_a.png` },
	{ name: 'shape-b', label: 'Shape — B', url: `${BASE}shape_b.png` },
	{ name: 'shape-c', label: 'Shape — C', url: `${BASE}shape_c.png` },
	{ name: 'shape-d', label: 'Shape — D', url: `${BASE}shape_d.png` },
	{ name: 'shape-e', label: 'Shape — E', url: `${BASE}shape_e.png` },
	{ name: 'shape-f', label: 'Shape — F', url: `${BASE}shape_f.png` },
	{ name: 'shape-g', label: 'Shape — G', url: `${BASE}shape_g.png` },
];

export function getGoboLabel( name ) {

	return GOBO_LIBRARY.find( g => g.name === name )?.label || name;

}
