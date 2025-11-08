import * as THREE from 'three';

/**
 * SimpleSkyRenderer
 *
 * Dedicated off-screen renderer for generating simple sky textures (gradient and solid color).
 * Renders to equirectangular texture using GPU shaders for optimal performance.
 *
 * OPTIMIZATION: Returns GPU render target texture directly (no CPU readback).
 * EnvironmentCDFBuilder handles pixel reading on-demand only when needed.
 * This eliminates GPU → CPU → GPU round-trip for better performance.
 */
export class SimpleSkyRenderer {

	constructor( width = 512, height = 256, sharedRenderer = null ) {

		this.width = width;
		this.height = height;

		// Use shared renderer if provided, otherwise create off-screen renderer
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
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		// Create vertex shader (simple passthrough)
		const vertexShader = `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = vec4(position, 1.0);
			}
		`;

		// Create fragment shader for gradient and solid color
		const fragmentShader = `
			precision highp float;
			varying vec2 vUv;

			uniform int mode; // 0 = solid color, 1 = gradient
			uniform vec3 solidColor;
			uniform vec3 zenithColor;
			uniform vec3 horizonColor;
			uniform vec3 groundColor;

			void main() {
				vec3 color;

				if (mode == 0) {
					// Solid color mode
					color = solidColor;
				} else {
					// Gradient mode (vertical gradient for equirectangular)
					// Top half: zenith → horizon
					// Bottom half: horizon → ground
					float t = vUv.y;

					if (t > 0.5) {
						// Top half: zenith to horizon
						float blend = (t - 0.5) * 2.0; // 0 to 1
						color = mix(horizonColor, zenithColor, blend);
					} else {
						// Bottom half: horizon to ground
						float blend = t * 2.0; // 0 to 1
						color = mix(groundColor, horizonColor, blend);
					}
				}

				gl_FragColor = vec4(color, 1.0);
			}
		`;

		// Create shader material
		this.material = new THREE.ShaderMaterial( {
			uniforms: {
				mode: { value: 0 }, // 0 = solid, 1 = gradient
				solidColor: { value: new THREE.Vector3( 0.5, 0.5, 0.5 ) },
				zenithColor: { value: new THREE.Vector3( 0.2, 0.4, 0.8 ) },
				horizonColor: { value: new THREE.Vector3( 0.8, 0.8, 0.9 ) },
				groundColor: { value: new THREE.Vector3( 0.3, 0.2, 0.1 ) },
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
	 * Render gradient sky
	 * @param {Object} params - {zenithColor, horizonColor, groundColor}
	 * @returns {THREE.Texture} Generated gradient sky texture
	 */
	renderGradient( params ) {

		const startTime = performance.now();

		// Update uniforms
		this.material.uniforms.mode.value = 1; // Gradient mode
		this.material.uniforms.zenithColor.value.set( params.zenithColor.r, params.zenithColor.g, params.zenithColor.b );
		this.material.uniforms.horizonColor.value.set( params.horizonColor.r, params.horizonColor.g, params.horizonColor.b );
		this.material.uniforms.groundColor.value.set( params.groundColor.r, params.groundColor.g, params.groundColor.b );

		this.renderToTarget();

		this.lastRenderTime = performance.now() - startTime;

		return this.renderTarget.texture;

	}

	/**
	 * Render solid color sky
	 * @param {Object} params - {color}
	 * @returns {THREE.Texture} Generated solid color sky texture
	 */
	renderSolid( params ) {

		const startTime = performance.now();

		// Update uniforms
		this.material.uniforms.mode.value = 0; // Solid mode
		this.material.uniforms.solidColor.value.set( params.color.r, params.color.g, params.color.b );

		this.renderToTarget();

		this.lastRenderTime = performance.now() - startTime;

		return this.renderTarget.texture;

	}

	/**
	 * Internal render to target
	 */
	renderToTarget() {

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

		// Mark texture as updated
		this.renderTarget.texture.needsUpdate = true;

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
