import {
	WebGLRenderTarget,
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * RenderTargetHelper - A component for displaying Three.js render targets or textures in a resizable window
 *
 * @param {THREE.WebGLRenderer} renderer - The renderer instance
 * @param {THREE.WebGLRenderTarget|THREE.Texture} renderTargetOrTexture - The render target or texture to display
 * @param {Object} options - Optional configuration
 * @param {number} options.width - Initial width of the view (default: 200)
 * @param {number} options.height - Initial height of the view (default: 200)
 * @param {string} options.position - Position on screen ('bottom-right', 'bottom-left', 'top-right', 'top-left') (default: 'bottom-right')
 * @param {boolean} options.flipX - Flip the image horizontally (default: true)
 * @param {boolean} options.flipY - Flip the image vertically (default: true)
 * @param {boolean} options.autoUpdate - Whether to automatically update on animation frames (default: false)
 * @param {string} options.title - Title to display in the header (default: 'Render Target')
 * @param {string} options.transform - Optional shader transform: 'normal-remap' remaps [0,1] to visible range
 * @returns {HTMLElement} The container element with attached methods
 */
function RenderTargetHelper( renderer, renderTargetOrTexture, options = {} ) {

	// Detect if input is a Texture or RenderTarget
	const isTexture = renderTargetOrTexture.isTexture === true;

	let renderTarget;
	let internalRenderTarget = null;
	let textureQuad = null;
	let textureMaterial = null;

	if ( isTexture ) {

		// Create internal render target for texture rendering
		const texture = renderTargetOrTexture;
		internalRenderTarget = new WebGLRenderTarget(
			texture.image?.width || 256,
			texture.image?.height || 256,
			{
				minFilter: LinearFilter,
				magFilter: LinearFilter,
				format: RGBAFormat,
				type: FloatType,
				depthBuffer: false
			}
		);

		// Create shader material based on transform option
		let fragmentShader;
		if ( options.transform === 'normal-remap' ) {

			// Remap normals from [0,1] to visible range for display
			fragmentShader = /* glsl */`
				uniform sampler2D tTexture;
				varying vec2 vUv;
				void main() {
					vec3 value = texture2D(tTexture, vUv).xyz;
					gl_FragColor = vec4(value * 0.5 + 0.5, 1.0);
				}
			`;

		} else {

			// Simple passthrough
			fragmentShader = /* glsl */`
				uniform sampler2D tTexture;
				varying vec2 vUv;
				void main() {
					vec4 value = texture2D(tTexture, vUv);
					gl_FragColor = vec4(value.rgb, 1.0);
				}
			`;

		}

		textureMaterial = new ShaderMaterial( {
			uniforms: {
				tTexture: { value: texture }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = vec4(position, 1.0);
				}
			`,
			fragmentShader
		} );

		textureQuad = new FullScreenQuad( textureMaterial );
		renderTarget = internalRenderTarget;

	} else {

		renderTarget = renderTargetOrTexture;

	}

	// Default options
	const config = {
		width: options.width || 200,
		height: options.height || 200,
		position: options.position || 'bottom-right',
		flipX: options.flipX !== undefined ? options.flipX : false,
		flipY: options.flipY !== undefined ? options.flipY : true,
		autoUpdate: options.autoUpdate || false,
		theme: options.theme || 'dark', // 'light' or 'dark' - changed default to dark to match the app's theme
		title: options.title || renderTarget.name || 'Render Target'
	};

	// Create container
	const container = document.createElement( 'div' );
	container.className = 'render-target-helper';

	// Apply styles based on position
	const positionStyles = {
		'bottom-right': { bottom: '48px', right: '10px' }, // Adjusted for stats position
		'bottom-left': { bottom: '10px', left: '10px' },
		'top-right': { top: '10px', right: '10px' },
		'top-left': { top: '10px', left: '10px' }
	};

	// Theme styles
	const themeStyles = {
		'light': {
			backgroundColor: 'white',
			border: '1px solid #ddd',
			color: '#333'
		},
		'dark': {
			backgroundColor: '#1e293b', // Match app's slate color
			border: '1px solid #334155',
			color: '#f8fafc'
		}
	};

	Object.assign( container.style, {
		display: 'flex',
		flexDirection: 'column',
		position: 'fixed',
		resize: 'both',
		overflow: 'hidden',
		padding: '8px',
		borderRadius: '4px',
		boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
		transition: 'opacity 0.2s ease',
		zIndex: '1000',
		minWidth: '100px',
		minHeight: '100px',
		maxWidth: '500px',
		maxHeight: '500px',
		width: `${config.width}px`,
		height: `${config.height}px`,
		...positionStyles[ config.position ],
		...themeStyles[ config.theme ]
	} );

	// Create title bar with controls
	const titleBar = document.createElement( 'div' );
	titleBar.style.display = 'flex';
	titleBar.style.justifyContent = 'space-between';
	titleBar.style.alignItems = 'center';
	titleBar.style.marginBottom = '4px';
	titleBar.style.cursor = 'move';
	titleBar.style.userSelect = 'none';

	// Title
	const title = document.createElement( 'span' );
	title.textContent = config.title;
	title.style.fontSize = '12px';
	title.style.fontFamily = 'monospace';
	title.style.color = themeStyles[ config.theme ].color;

	// Controls
	const controls = document.createElement( 'div' );

	// Close button
	const closeBtn = document.createElement( 'button' );
	closeBtn.innerHTML = '×';
	closeBtn.style.background = 'none';
	closeBtn.style.border = 'none';
	closeBtn.style.cursor = 'pointer';
	closeBtn.style.fontSize = '16px';
	closeBtn.style.color = themeStyles[ config.theme ].color;
	closeBtn.style.padding = '0 4px';
	closeBtn.title = 'Close';

	closeBtn.onclick = () => {

		container.style.display = 'none';
		if ( config.autoUpdate ) {

			cancelAnimationFrame( animFrameId );
			animFrameId = null;

		}

	};

	// Add refresh button
	const refreshBtn = document.createElement( 'button' );
	refreshBtn.innerHTML = '⟳';
	refreshBtn.style.background = 'none';
	refreshBtn.style.border = 'none';
	refreshBtn.style.cursor = 'pointer';
	refreshBtn.style.fontSize = '14px';
	refreshBtn.style.color = themeStyles[ config.theme ].color;
	refreshBtn.style.padding = '0 4px';
	refreshBtn.title = 'Refresh';

	refreshBtn.onclick = () => {

		container.update();

	};

	controls.appendChild( refreshBtn );
	controls.appendChild( closeBtn );
	titleBar.appendChild( title );
	titleBar.appendChild( controls );
	container.appendChild( titleBar );

	// Canvas for displaying the render target
	const domCanvas = document.createElement( 'canvas' );
	domCanvas.style.width = '100%';
	domCanvas.style.height = 'calc(100% - 20px)';


	// Apply flipping if needed
	let transform = '';
	if ( config.flipX ) transform += 'scaleX(-1) ';
	if ( config.flipY ) transform += 'scaleY(-1) ';
	domCanvas.style.transform = transform.trim();

	container.appendChild( domCanvas );

	// Get render target dimensions
	let width = renderTarget.width;
	let height = renderTarget.height;

	// Initialize canvas
	domCanvas.width = width;
	domCanvas.height = height;

	const context = domCanvas.getContext( '2d' );

	// Pixel data buffers
	let pixels = new Float32Array( 4 * width * height );
	let clampedPixels = new Uint8ClampedArray( 4 * width * height );

	// Make container draggable
	let isDragging = false;
	let dragOffsetX = 0;
	let dragOffsetY = 0;

	titleBar.addEventListener( 'pointerdown', ( e ) => {

		isDragging = true;
		dragOffsetX = e.clientX - container.offsetLeft;
		dragOffsetY = e.clientY - container.offsetTop;
		document.body.style.userSelect = 'none'; // Prevent text selection during drag

	} );

	window.addEventListener( 'pointermove', ( e ) => {

		if ( ! isDragging ) return;

		const newLeft = e.clientX - dragOffsetX;
		const newTop = e.clientY - dragOffsetY;

		// Keep within window bounds
		const maxX = window.innerWidth - container.offsetWidth;
		const maxY = window.innerHeight - container.offsetHeight;

		container.style.left = `${Math.max( 0, Math.min( newLeft, maxX ) )}px`;
		container.style.top = `${Math.max( 0, Math.min( newTop, maxY ) )}px`;

		// Reset position properties that would otherwise take precedence
		container.style.bottom = 'auto';
		container.style.right = 'auto';

	} );

	window.addEventListener( 'pointerup', () => {

		isDragging = false;
		document.body.style.userSelect = '';

	} );

	// Optimize resize handling
	function handleResize() {

		// Get current dimensions from source
		let currentWidth, currentHeight;
		if ( isTexture ) {

			// For textures, get dimensions from the texture's image
			const texture = renderTargetOrTexture;
			currentWidth = texture.image?.width || renderTarget.width;
			currentHeight = texture.image?.height || renderTarget.height;

		} else {

			currentWidth = renderTarget.width;
			currentHeight = renderTarget.height;

		}

		// Check if dimensions have changed
		if ( width !== currentWidth || height !== currentHeight ) {

			width = currentWidth;
			height = currentHeight;

			// Resize canvas to match dimensions
			domCanvas.width = width;
			domCanvas.height = height;

			// Resize internal render target if using texture
			if ( internalRenderTarget ) {

				internalRenderTarget.setSize( width, height );

			}

			// Recreate pixel buffers
			pixels = new Float32Array( 4 * width * height );
			clampedPixels = new Uint8ClampedArray( 4 * width * height );

		}

		// Update dimensions display
		title.textContent = `${config.title} (${width}×${height})`;

	}

	// Update the display with the current render target contents
	container.update = function update() {

		handleResize();

		try {

			// If using a texture, render it to the internal render target first
			if ( isTexture && textureQuad && internalRenderTarget ) {

				const currentRenderTarget = renderer.getRenderTarget();
				renderer.setRenderTarget( internalRenderTarget );
				textureQuad.render( renderer );
				renderer.setRenderTarget( currentRenderTarget );

			}

			// Read pixels from render target
			renderer.readRenderTargetPixels( renderTarget, 0, 0, width, height, pixels );

			// Convert float values to 8-bit using optimized loop
			for ( let i = 0; i < pixels.length; i ++ ) {

				clampedPixels[ i ] = Math.min( 255, Math.max( 0, pixels[ i ] * 255 ) );

			}

			// Create image data and draw to canvas
			const imageData = new ImageData( clampedPixels, width, height );
			context.putImageData( imageData, 0, 0 );

		} catch ( error ) {

			console.error( "Error updating render target helper:", error );

		}

	};

	// Handle resize events
	container.addEventListener( 'mousedown', () => {

		window.addEventListener( 'mousemove', handleResize );

	} );

	window.addEventListener( 'mouseup', () => {

		window.removeEventListener( 'mousemove', handleResize );

	} );

	window.addEventListener( 'resize', handleResize );

	// Auto-update animation frame
	let animFrameId = null;

	/**
     * Show the helper if hidden
     */
	container.show = function show() {

		container.style.display = 'flex';
		if ( config.autoUpdate && ! animFrameId ) {

			container.startAutoUpdate();

		}

	};

	/**
     * Hide the helper
     */
	container.hide = function hide() {

		container.style.display = 'none';
		if ( config.autoUpdate && animFrameId ) {

			cancelAnimationFrame( animFrameId );
			animFrameId = null;

		}

	};

	/**
     * Toggle visibility
     */
	container.toggle = function toggle() {

		if ( container.style.display === 'none' ) {

			container.show();

		} else {

			container.hide();

		}

		return container.style.display !== 'none';

	};

	/**
     * Start auto-updating
     */
	container.startAutoUpdate = function startAutoUpdate() {

		if ( animFrameId ) return;

		const updateLoop = () => {

			container.update();
			animFrameId = requestAnimationFrame( updateLoop );

		};

		animFrameId = requestAnimationFrame( updateLoop );

	};

	/**
     * Stop auto-updating
     */
	container.stopAutoUpdate = function stopAutoUpdate() {

		if ( animFrameId ) {

			cancelAnimationFrame( animFrameId );
			animFrameId = null;

		}

	};

	/**
     * Dispose and clean up resources
     */
	container.dispose = function dispose() {

		if ( config.autoUpdate && animFrameId ) {

			cancelAnimationFrame( animFrameId );

		}

		// Dispose internal texture rendering resources
		if ( internalRenderTarget ) {

			internalRenderTarget.dispose();
			internalRenderTarget = null;

		}

		if ( textureMaterial ) {

			textureMaterial.dispose();
			textureMaterial = null;

		}

		if ( textureQuad ) {

			textureQuad.dispose();
			textureQuad = null;

		}

		// Remove from DOM if attached
		if ( container.parentNode ) {

			container.parentNode.removeChild( container );

		}

		// Clear references
		pixels = null;
		clampedPixels = null;

	};

	// Start auto-update if configured
	if ( config.autoUpdate ) {

		container.startAutoUpdate();

	}

	// Maintain backward compatibility with original implementation
	if ( container.style.display === 'none' ) {

		container.style.display = 'flex';

	}

	return container;

}

export default RenderTargetHelper;
