import * as THREE from 'three';
import PrethamSkyShader from '../Shaders/preetham_sky.glsl';

/**
 * ProceduralSkyRenderer
 *
 * Dedicated off-screen renderer for generating Preetham sky textures.
 * Renders physically-based atmospheric scattering to equirectangular texture.
 *
 * The generated texture can be used as an environment map for path tracing,
 * providing realistic sky lighting with proper importance sampling via CDF.
 *
 * OPTIMIZATION: Returns GPU render target texture directly (no CPU readback).
 * EquirectHdrInfo handles CDF generation for importance sampling when needed.
 * This eliminates GPU → CPU → GPU round-trip for better performance.
 */
export class ProceduralSkyRenderer {

	constructor( width = 512, height = 256, sharedRenderer = null ) {

		this.width = width;
		this.height = height;

		// Use shared renderer if provided, otherwise create off-screen renderer
		// Sharing the renderer ensures textures are properly registered in the property system
		if ( sharedRenderer ) {

			this.renderer = sharedRenderer;
			this.usingSharedRenderer = true;

		} else {

			// Create off-screen WebGL renderer (legacy mode)
			this.renderer = new THREE.WebGLRenderer( {
				antialias: false,
				alpha: false,
			} );
			this.renderer.setSize( width, height );
			this.renderer.setClearColor( 0x000000, 1 );
			this.usingSharedRenderer = false;

		}

		// Create scene with fullscreen quad
		this.scene = new THREE.Scene();

		// Use standard orthographic camera
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		// Create vertex shader (simple passthrough)
		const vertexShader = `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = vec4(position, 1.0);
			}
		`;

		// Create fragment shader that uses Preetham algorithm
		const fragmentShader = `
			precision highp float;
			varying vec2 vUv;

			${PrethamSkyShader}

			void main() {
				vec3 skyColor = computePrethamSkyColor(vUv);
				gl_FragColor = vec4(skyColor, 1.0);
			}
		`;

		// Create shader material
		this.material = new THREE.ShaderMaterial( {
			uniforms: {
				// Sun properties
				sunDirection: { value: new THREE.Vector3( 0, 1, 0 ) },
				sunIntensity: { value: 1.0 },

				// Atmospheric properties (Preetham model)
				rayleighDensity: { value: 1.0 }, // Rayleigh scattering multiplier
				mieDensity: { value: 0.005 }, // Mie scattering multiplier
				mieAnisotropy: { value: 0.8 }, // Mie directional g
				turbidity: { value: 2.0 }, // Atmospheric turbidity (1-10)

			},
			vertexShader: vertexShader,
			fragmentShader: fragmentShader,
			depthTest: false,
			depthWrite: false,
		} );

		// Force compilation to catch errors early
		this.renderer.compile( this.scene, this.camera );

		// Create standard fullscreen quad
		const geometry = new THREE.PlaneGeometry( 2, 2 );
		const quad = new THREE.Mesh( geometry, this.material );
		this.scene.add( quad );

		// Create HDR render target
		this.renderTarget = new THREE.WebGLRenderTarget( width, height, {
			format: THREE.RGBAFormat,
			type: THREE.FloatType, // HDR support
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping,
			wrapT: THREE.ClampToEdgeWrapping,
			generateMipmaps: false,
			depthBuffer: false,
			stencilBuffer: false,
		} );

		// Configure the render target's texture for environment mapping
		this.renderTarget.texture.mapping = THREE.EquirectangularReflectionMapping;
		this.renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

		// Ensure the texture has an image property with dimensions (needed for CDF builder)
		if ( ! this.renderTarget.texture.image ) {

			this.renderTarget.texture.image = { width, height };

		}

		// Performance tracking
		this.lastRenderTime = 0;

	}

	/**
	 * Render Preetham sky with given parameters
	 * @param {Object} params - Sky parameters
	 * @returns {THREE.Texture} Generated equirectangular sky texture (render target texture - stays on GPU)
	 */
	render( params ) {

		const startTime = performance.now();

		// Update uniforms from parameters
		// Ensure sun direction is normalized
		const sunDir = params.sunDirection.clone().normalize();
		this.material.uniforms.sunDirection.value.copy( sunDir );
		this.material.uniforms.sunIntensity.value = params.sunIntensity || 1.0;
		this.material.uniforms.rayleighDensity.value = params.rayleighDensity || 2.0;
		this.material.uniforms.mieDensity.value = params.mieDensity || 0.005;
		this.material.uniforms.mieAnisotropy.value = params.mieAnisotropy || 0.8;
		this.material.uniforms.turbidity.value = params.turbidity || 2.0;

		// Save renderer state if using shared renderer
		let previousRenderTarget = null;
		if ( this.usingSharedRenderer ) {

			previousRenderTarget = this.renderer.getRenderTarget();

		}

		// Render to texture
		this.renderer.setRenderTarget( this.renderTarget );
		this.renderer.render( this.scene, this.camera );

		// Restore renderer state if using shared renderer
		if ( this.usingSharedRenderer ) {

			this.renderer.setRenderTarget( previousRenderTarget );

		} else {

			this.renderer.setRenderTarget( null );

		}

		// Track performance
		this.lastRenderTime = performance.now() - startTime;

		// Mark texture as updated (necessary for proper rendering)
		this.renderTarget.texture.needsUpdate = true;

		// Return render target texture directly (stays on GPU - no readPixels!)
		// EquirectHdrInfo will handle CDF generation when needed
		return this.renderTarget.texture;

	}

	/**
	 * Update rendering resolution
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setResolution( width, height ) {

		if ( this.width === width && this.height === height ) return;

		this.width = width;
		this.height = height;

		// Only resize renderer if we own it
		if ( ! this.usingSharedRenderer ) {

			this.renderer.setSize( width, height );

		}

		this.renderTarget.setSize( width, height );

		// Update texture image dimensions
		if ( this.renderTarget.texture.image ) {

			this.renderTarget.texture.image.width = width;
			this.renderTarget.texture.image.height = height;

		}

	}

	/**
	 * Get last render time in milliseconds
	 * @returns {number} Render time in ms
	 */
	getLastRenderTime() {

		return this.lastRenderTime;

	}

	/**
	 * Clean up resources
	 */
	dispose() {

		// Only dispose renderer if we created it (not shared)
		if ( ! this.usingSharedRenderer ) {

			this.renderer.dispose();

		}

		this.renderTarget.dispose();
		this.material.dispose();
		this.scene.clear();

	}

}
