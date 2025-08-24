/**
 * RenderTargetManager.js
 * Manages render targets, MRT textures, and efficient copying operations
 */

import {
	WebGLRenderTarget,
	FloatType,
	NearestFilter,
	LinearSRGBColorSpace,
	ShaderMaterial,
	Vector2
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class RenderTargetManager {

	constructor( width, height, renderer ) {

		this.width = width;
		this.height = height;
		this.renderer = renderer;

		// Initialize targets to null first
		this.currentTarget = null;
		this.previousTarget = null;

		// Copy material for efficient final output
		this.copyMaterial = null;
		this.copyQuad = null;

		// Performance cache for MRT textures
		this.mrtTexturesCache = { color: null, normalDepth: null };

		// Create ping-pong MRT targets immediately
		this.createTargets( width, height );

		// Verify targets were created successfully
		if ( ! this.currentTarget || ! this.previousTarget ) {

			console.error( 'RenderTargetManager: Failed to create render targets!' );
			// Create simple fallback targets without MRT
			this.createFallbackTargets( width, height );

		}

	}

	/**
     * Create unified render targets with MRT support
     * @param {number} width - Target width
     * @param {number} height - Target height
     */
	createTargets( width, height ) {

		try {

			const targetOptions = {
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				type: FloatType,
				colorSpace: LinearSRGBColorSpace,
				depthBuffer: false,
				count: 2, // Always MRT: Color + NormalDepth
				samples: 0 // IMPORTANT: No multisampling to avoid blitFramebuffer issues
			};

			// Dispose existing targets if they exist
			if ( this.currentTarget ) {

				this.currentTarget.dispose();

			}

			if ( this.previousTarget ) {

				this.previousTarget.dispose();

			}

			// Create new targets
			this.currentTarget = new WebGLRenderTarget( width, height, targetOptions );
			this.previousTarget = new WebGLRenderTarget( width, height, targetOptions );

			// Verify targets have textures
			if ( ! this.currentTarget.textures || this.currentTarget.textures.length !== 2 ) {

				throw new Error( 'Current target missing MRT textures' );

			}

			if ( ! this.previousTarget.textures || this.previousTarget.textures.length !== 2 ) {

				throw new Error( 'Previous target missing MRT textures' );

			}

			// Set texture names for debugging
			this.currentTarget.textures[ 0 ].name = 'CurrentColor';
			this.currentTarget.textures[ 1 ].name = 'CurrentNormalDepth';
			this.previousTarget.textures[ 0 ].name = 'PreviousColor';
			this.previousTarget.textures[ 1 ].name = 'PreviousNormalDepth';

		} catch ( error ) {

			console.error( 'RenderTargetManager: Error creating MRT targets:', error );
			this.currentTarget = null;
			this.previousTarget = null;

		}

	}

	/**
     * Create fallback render targets without MRT if main creation fails
     * @param {number} width - Target width
     * @param {number} height - Target height
     */
	createFallbackTargets( width, height ) {

		try {

			console.warn( 'RenderTargetManager: Creating fallback targets without MRT' );

			const fallbackOptions = {
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				type: FloatType,
				colorSpace: LinearSRGBColorSpace,
				depthBuffer: false,
				samples: 0
			};

			this.currentTarget = new WebGLRenderTarget( width, height, fallbackOptions );
			this.previousTarget = new WebGLRenderTarget( width, height, fallbackOptions );

			// Create dummy second textures for MRT compatibility
			this.currentTarget.textures = [ this.currentTarget.texture, this.currentTarget.texture ];
			this.previousTarget.textures = [ this.previousTarget.texture, this.previousTarget.texture ];

			this.currentTarget.textures[ 0 ].name = 'CurrentColor';
			this.currentTarget.textures[ 1 ].name = 'CurrentNormalDepth';
			this.previousTarget.textures[ 0 ].name = 'PreviousColor';
			this.previousTarget.textures[ 1 ].name = 'PreviousNormalDepth';

			console.log( 'RenderTargetManager: Fallback targets created successfully' );

		} catch ( error ) {

			console.error( 'RenderTargetManager: Failed to create even fallback targets:', error );

		}

	}

	/**
     * Get current accumulated render target
     * @returns {WebGLRenderTarget} - Current accumulation target
     */
	getCurrentAccumulation() {

		this.ensureTargetsReady();
		return this.currentTarget;

	}

	/**
     * Get current raw sample render target
     * @returns {WebGLRenderTarget} - Current raw sample target
     */
	getCurrentRawSample() {

		this.ensureTargetsReady();
		return this.currentTarget;

	}

	/**
     * Get MRT textures (color and normal/depth)
     * @returns {Object} - Object containing color and normalDepth textures
     */
	getMRTTextures() {

		if ( ! this.ensureTargetsReady() ) {

			return {
				color: null,
				normalDepth: null
			};

		}

		// Reuse cached object to avoid allocation
		this.mrtTexturesCache.color = this.currentTarget.textures[ 0 ];
		this.mrtTexturesCache.normalDepth = this.currentTarget.textures[ 1 ];
		return this.mrtTexturesCache;

	}

	/**
     * Get previous frame textures
     * @returns {Object} - Object containing previous frame textures
     */
	getPreviousTextures() {

		if ( ! this.ensureTargetsReady() ) {

			return {
				color: null,
				normalDepth: null
			};

		}

		return {
			color: this.previousTarget.textures[ 0 ],
			normalDepth: this.previousTarget.textures[ 1 ]
		};

	}

	/**
     * Swap current and previous targets
     */
	swapTargets() {

		if ( ! this.ensureTargetsReady() ) {

			return;

		}

		[ this.currentTarget, this.previousTarget ] = [ this.previousTarget, this.currentTarget ];

	}

	/**
     * Clear both render targets
     */
	clearTargets() {

		if ( ! this.ensureTargetsReady() ) {

			return;

		}

		const currentRenderTarget = this.renderer.getRenderTarget();

		this.renderer.setRenderTarget( this.currentTarget );
		this.renderer.clear();
		this.renderer.setRenderTarget( this.previousTarget );
		this.renderer.clear();

		this.renderer.setRenderTarget( currentRenderTarget );

	}

	/**
     * Efficiently copy color output to destination target
     * @param {WebGLRenderer} renderer - Three.js renderer
     * @param {WebGLRenderTarget|null} writeBuffer - Destination target (null for screen)
     * @param {boolean} renderToScreen - Whether to render to screen
     */
	efficientCopyColorOutput( renderer, writeBuffer, renderToScreen = false ) {

		if ( ! this.ensureTargetsReady() ) {

			return;

		}

		// Lazy create copy material and quad
		if ( ! this.copyMaterial ) {

			this.copyMaterial = new ShaderMaterial( {
				uniforms: {
					tDiffuse: { value: null }
				},

				vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
                    }
                `,

				fragmentShader: `
                    uniform sampler2D tDiffuse;
                    varying vec2 vUv;
                    void main() {
                        gl_FragColor = texture2D( tDiffuse, vUv );
                    }
                `,

				depthTest: false,
				depthWrite: false,
				transparent: false,
			} );

			this.copyQuad = new FullScreenQuad( this.copyMaterial );

		}

		// Set source texture (color output from our MRT)
		this.copyMaterial.uniforms.tDiffuse.value = this.currentTarget.textures[ 0 ];

		// Render to destination
		renderer.setRenderTarget( renderToScreen ? null : writeBuffer );
		this.copyQuad.render( renderer );

	}

	/**
     * Copy specific MRT texture to destination
     * @param {WebGLRenderer} renderer - Three.js renderer
     * @param {number} textureIndex - Index of texture to copy (0 = color, 1 = normal/depth)
     * @param {WebGLRenderTarget|null} writeBuffer - Destination target
     */
	copyMRTTexture( renderer, textureIndex, writeBuffer ) {

		if ( ! this.ensureTargetsReady() ) {

			return;

		}

		if ( ! this.copyMaterial ) {

			this.efficientCopyColorOutput( renderer, null, false ); // Initialize copy material

		}

		this.copyMaterial.uniforms.tDiffuse.value = this.currentTarget.textures[ textureIndex ];
		renderer.setRenderTarget( writeBuffer );
		this.copyQuad.render( renderer );

	}

	/**
     * Resize render targets
     * @param {number} width - New width
     * @param {number} height - New height
     */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Recreate targets with new size
		this.createTargets( width, height );

		// Verify creation was successful
		if ( ! this.isValid() ) {

			console.warn( 'RenderTargetManager: Failed to resize targets, creating fallback...' );
			this.createFallbackTargets( width, height );

		}

	}

	/**
     * Get target dimensions
     * @returns {Object} - Object containing width and height
     */
	getSize() {

		return {
			width: this.width,
			height: this.height
		};

	}

	/**
     * Check if targets are valid and properly sized
     * @returns {boolean} - True if targets are valid
     */
	isValid() {

		return this.currentTarget &&
               this.previousTarget &&
               this.currentTarget.textures &&
               this.previousTarget.textures &&
               this.currentTarget.width === this.width &&
               this.currentTarget.height === this.height &&
               this.previousTarget.width === this.width &&
               this.previousTarget.height === this.height;

	}

	/**
     * Ensure targets are ready before operations
     * @returns {boolean} - True if targets are ready
     */
	ensureTargetsReady() {

		if ( ! this.isValid() ) {

			console.warn( 'RenderTargetManager: Targets not ready, attempting to recreate...' );
			this.createTargets( this.width, this.height );

			if ( ! this.isValid() ) {

				this.createFallbackTargets( this.width, this.height );

			}

		}

		return this.isValid();

	}

	/**
     * Get memory usage information
     * @returns {Object} - Memory usage statistics
     */
	getMemoryUsage() {

		const bytesPerPixel = 16; // 4 channels * 4 bytes (Float32) per channel
		const pixelsPerTarget = this.width * this.height;
		const texturesPerTarget = 2; // MRT: color + normal/depth
		const targetCount = 2; // current + previous

		const totalBytes = pixelsPerTarget * bytesPerPixel * texturesPerTarget * targetCount;

		return {
			totalBytes,
			totalMB: totalBytes / ( 1024 * 1024 ),
			perTargetMB: ( totalBytes / targetCount ) / ( 1024 * 1024 ),
			width: this.width,
			height: this.height,
			textureCount: texturesPerTarget * targetCount
		};

	}

	/**
     * Create debug info for render targets
     * @returns {Object} - Debug information
     */
	getDebugInfo() {

		return {
			currentTarget: {
				width: this.currentTarget.width,
				height: this.currentTarget.height,
				textureCount: this.currentTarget.textures.length,
				textureNames: this.currentTarget.textures.map( tex => tex.name )
			},
			previousTarget: {
				width: this.previousTarget.width,
				height: this.previousTarget.height,
				textureCount: this.previousTarget.textures.length,
				textureNames: this.previousTarget.textures.map( tex => tex.name )
			},
			memoryUsage: this.getMemoryUsage()
		};

	}

	/**
     * Dispose of all resources
     */
	dispose() {

		// Dispose render targets
		if ( this.currentTarget ) {

			this.currentTarget.dispose();
			this.currentTarget = null;

		}

		if ( this.previousTarget ) {

			this.previousTarget.dispose();
			this.previousTarget = null;

		}

		// Dispose copy materials
		if ( this.copyMaterial ) {

			this.copyMaterial.dispose();
			this.copyMaterial = null;

		}

		if ( this.copyQuad ) {

			this.copyQuad.dispose();
			this.copyQuad = null;

		}

		// Clear caches
		this.mrtTexturesCache = { color: null, normalDepth: null };

	}

}
