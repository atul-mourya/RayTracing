/**
 * Backend Manager
 *
 * Manages switching between WebGL and WebGPU rendering backends.
 * Provides a unified interface for the UI to seamlessly switch backends
 * while preserving scene state, camera position, and rendering settings.
 *
 * Features:
 * - Automatic WebGPU support detection
 * - State preservation during backend switch
 * - Event-driven notifications for UI updates
 * - Fallback to WebGL when WebGPU unavailable
 */

/**
 * Supported backend types
 */
export const BackendType = {
	WEBGL: 'webgl',
	WEBGPU: 'webgpu'
};

/**
 * Backend status states
 */
export const BackendStatus = {
	READY: 'ready',
	INITIALIZING: 'initializing',
	ERROR: 'error',
	SWITCHING: 'switching'
};

/**
 * Backend Manager class
 */
export class BackendManager {

	constructor() {

		// Current backend state
		this.currentBackend = BackendType.WEBGL;
		this.status = BackendStatus.READY;
		this.error = null;

		// Backend instances
		this.webglApp = null;
		this.webgpuApp = null;

		// Canvas references for showing/hiding
		this.webglCanvasRef = null;
		this.webgpuCanvasRef = null;
		this.denoiserCanvasRef = null;

		// Capability detection
		this.isWebGPUSupported = false;
		this.webgpuInfo = null;

		// State to preserve during switch
		this.preservedState = null;

		// Event listeners
		this.listeners = new Map();

		// Initialize
		this.detectCapabilities();

	}

	/**
	 * Detects WebGPU capabilities.
	 */
	async detectCapabilities() {

		this.isWebGPUSupported = 'gpu' in navigator;

		if ( this.isWebGPUSupported ) {

			try {

				const adapter = await navigator.gpu.requestAdapter();

				if ( adapter ) {

					const info = adapter.info;
					this.webgpuInfo = {
						supported: true,
						vendor: info.vendor,
						architecture: info.architecture,
						device: info.device,
						description: info.description
					};

				} else {

					this.isWebGPUSupported = false;
					this.webgpuInfo = { supported: false, reason: 'No adapter available' };

				}

			} catch ( error ) {

				this.isWebGPUSupported = false;
				this.webgpuInfo = { supported: false, error: error.message };

			}

		} else {

			this.webgpuInfo = { supported: false, reason: 'WebGPU API not available' };

		}

		console.log( 'BackendManager: WebGPU supported:', this.isWebGPUSupported );
		if ( this.webgpuInfo ) {

			console.log( 'BackendManager: WebGPU info:', this.webgpuInfo );

		}

	}

	/**
	 * Sets the WebGL application instance.
	 * @param {PathTracerApp} app - WebGL path tracer application
	 */
	setWebGLApp( app ) {

		this.webglApp = app;
		console.log( 'BackendManager: WebGL app registered' );
		// Pause WebGL if it's not the current backend
		if ( this.currentBackend !== BackendType.WEBGL && app.pause ) {

			app.pause();
			console.log( 'BackendManager: Paused WebGL app (not active backend)' );

		}
	}

	/**
	 * Sets the WebGPU application instance.
	 * @param {WebGPUPathTracerApp} app - WebGPU path tracer application
	 */
	setWebGPUApp( app ) {

		this.webgpuApp = app;
		console.log( 'BackendManager: WebGPU app registered' );
		// Pause WebGPU if it's not the current backend
		if ( this.currentBackend !== BackendType.WEBGPU && app.pause ) {

			app.pause();
			console.log( 'BackendManager: Paused WebGPU app (not active backend)' );

		}
	}

	/**
	 * Sets the canvas references for showing/hiding on backend switch.
	 * @param {React.RefObject} webglCanvasRef - WebGL canvas ref
	 * @param {React.RefObject} webgpuCanvasRef - WebGPU canvas ref
	 * @param {React.RefObject} denoiserCanvasRef - Denoiser canvas ref
	 */
	setCanvasRefs( webglCanvasRef, webgpuCanvasRef, denoiserCanvasRef ) {

		this.webglCanvasRef = webglCanvasRef;
		this.webgpuCanvasRef = webgpuCanvasRef;
		this.denoiserCanvasRef = denoiserCanvasRef;
		console.log( 'BackendManager: Canvas refs registered' );

		// Set initial canvas visibility based on current backend
		this.toggleCanvasVisibility( this.currentBackend );

	}

	/**
	 * Gets the current active application.
	 * @returns {Object} Current application instance
	 */
	getCurrentApp() {

		return this.currentBackend === BackendType.WEBGL ? this.webglApp : this.webgpuApp;

	}

	/**
	 * Gets the current backend type.
	 * @returns {string} Current backend type
	 */
	getBackend() {

		return this.currentBackend;

	}

	/**
	 * Checks if WebGPU is available.
	 * @returns {boolean} True if WebGPU is supported
	 */
	canUseWebGPU() {

		return this.isWebGPUSupported;

	}

	/**
	 * Preserves the current rendering state before switching backends.
	 */
	preserveState() {

		const app = this.getCurrentApp();
		if ( ! app ) return;

		this.preservedState = {
			// Camera state
			camera: {
				position: app.camera?.position.clone(),
				rotation: app.camera?.rotation.clone(),
				fov: app.camera?.fov,
				near: app.camera?.near,
				far: app.camera?.far
			},

			// Render settings
			settings: {
				maxBounces: app.pathTracingPass?.material?.uniforms?.maxBounces?.value || 4,
				environmentIntensity: app.pathTracingPass?.material?.uniforms?.envIntensity?.value || 1.0,
				samplesPerPixel: app.pathTracingPass?.material?.uniforms?.samplesPerPixel?.value || 1
			},

			// Scene data references (textures)
			scene: {
				hasTriangles: !! app.triangleTexture,
				hasBVH: !! app.bvhTexture,
				hasMaterials: !! app.materialTexture,
				hasEnvironment: !! app.environmentTexture
			}
		};

		console.log( 'BackendManager: State preserved', this.preservedState );

	}

	/**
	 * Restores the preserved state to the new backend.
	 */
	restoreState() {

		const app = this.getCurrentApp();
		if ( ! app || ! this.preservedState ) return;

		// Restore camera
		if ( this.preservedState.camera && app.camera ) {

			if ( this.preservedState.camera.position ) {

				app.camera.position.copy( this.preservedState.camera.position );

			}

			if ( this.preservedState.camera.rotation ) {

				app.camera.rotation.copy( this.preservedState.camera.rotation );

			}

			if ( this.preservedState.camera.fov ) {

				app.camera.fov = this.preservedState.camera.fov;
				app.camera.updateProjectionMatrix();

			}

		}

		// Restore settings
		if ( this.preservedState.settings ) {

			if ( app.setMaxBounces ) {

				app.setMaxBounces( this.preservedState.settings.maxBounces );

			}

			if ( app.setEnvironmentIntensity ) {

				app.setEnvironmentIntensity( this.preservedState.settings.environmentIntensity );

			}

		}

		// Reset to start fresh accumulation
		if ( app.reset ) {

			app.reset();

		}

		console.log( 'BackendManager: State restored' );

	}

	/**
	 * Switches to the specified backend.
	 * @param {string} backend - Target backend (BackendType.WEBGL or BackendType.WEBGPU)
	 * @returns {Promise<boolean>} Success status
	 */
	async setBackend( backend ) {

		// Validate backend
		if ( backend !== BackendType.WEBGL && backend !== BackendType.WEBGPU ) {

			console.error( 'BackendManager: Invalid backend type:', backend );
			return false;

		}

		// Check if already using this backend
		if ( backend === this.currentBackend ) {

			console.log( 'BackendManager: Already using', backend );
			return true;

		}

		// Check WebGPU availability
		if ( backend === BackendType.WEBGPU && ! this.isWebGPUSupported ) {

			this.error = 'WebGPU is not supported in this browser';
			this.emit( 'error', { error: this.error } );
			console.error( 'BackendManager:', this.error );
			return false;

		}

		// Check if target backend app is available
		const targetApp = backend === BackendType.WEBGL ? this.webglApp : this.webgpuApp;
		if ( ! targetApp ) {

			this.error = `${backend} app not initialized`;
			this.emit( 'error', { error: this.error } );
			console.error( 'BackendManager:', this.error );
			return false;

		}

		console.log( `BackendManager: Switching from ${this.currentBackend} to ${backend}` );

		// Update status
		this.status = BackendStatus.SWITCHING;
		this.emit( 'switching', { from: this.currentBackend, to: backend } );

		try {

			// Preserve current state
			this.preserveState();

			// Pause current backend
			const currentApp = this.getCurrentApp();
			if ( currentApp && currentApp.pause ) {

				currentApp.pause();

			}

			// Switch backend
			const previousBackend = this.currentBackend;
			this.currentBackend = backend;

			// Toggle canvas visibility
			this.toggleCanvasVisibility( backend );

			// Restore state to new backend
			this.restoreState();

			// Start new backend
			if ( targetApp.resume ) {

				targetApp.resume();

			} else if ( targetApp.animate ) {

				targetApp.animate();

			}

			// Update status
			this.status = BackendStatus.READY;
			this.error = null;
			this.emit( 'switched', { from: previousBackend, to: backend } );

			console.log( `BackendManager: Successfully switched to ${backend}` );
			return true;

		} catch ( error ) {

			// Restore previous backend on error
			this.status = BackendStatus.ERROR;
			this.error = error.message;
			this.emit( 'error', { error: this.error } );

			console.error( 'BackendManager: Switch failed:', error );
			return false;

		}

	}

	/**
	 * Toggles canvas visibility based on active backend.
	 * @param {string} backend - Active backend type
	 */
	toggleCanvasVisibility( backend ) {

		if ( ! this.webglCanvasRef?.current || ! this.webgpuCanvasRef?.current ) {

			console.warn( 'BackendManager: Canvas refs not set, cannot toggle visibility' );
			return;

		}

		if ( backend === BackendType.WEBGL ) {

			// Show WebGL canvas, hide WebGPU canvas
			this.webglCanvasRef.current.style.display = '';
			this.webgpuCanvasRef.current.style.display = 'none';
			console.log( 'BackendManager: Showing WebGL canvas' );

		} else if ( backend === BackendType.WEBGPU ) {

			// Show WebGPU canvas, hide WebGL canvas
			this.webglCanvasRef.current.style.display = 'none';
			this.webgpuCanvasRef.current.style.display = '';
			console.log( 'BackendManager: Showing WebGPU canvas' );

		}

	}

	/**
	 * Toggles between WebGL and WebGPU backends.
	 * @returns {Promise<boolean>} Success status
	 */
	async toggleBackend() {

		const newBackend = this.currentBackend === BackendType.WEBGL
			? BackendType.WEBGPU
			: BackendType.WEBGL;

		return this.setBackend( newBackend );

	}

	/**
	 * Gets the status information.
	 * @returns {Object} Status information
	 */
	getStatus() {

		return {
			currentBackend: this.currentBackend,
			status: this.status,
			error: this.error,
			webglAvailable: !! this.webglApp,
			webgpuAvailable: !! this.webgpuApp && this.isWebGPUSupported,
			webgpuInfo: this.webgpuInfo
		};

	}

	/**
	 * Registers an event listener.
	 * @param {string} event - Event name
	 * @param {Function} callback - Callback function
	 */
	on( event, callback ) {

		if ( ! this.listeners.has( event ) ) {

			this.listeners.set( event, new Set() );

		}

		this.listeners.get( event ).add( callback );

	}

	/**
	 * Removes an event listener.
	 * @param {string} event - Event name
	 * @param {Function} callback - Callback function
	 */
	off( event, callback ) {

		if ( this.listeners.has( event ) ) {

			this.listeners.get( event ).delete( callback );

		}

	}

	/**
	 * Emits an event.
	 * @param {string} event - Event name
	 * @param {Object} data - Event data
	 */
	emit( event, data ) {

		if ( this.listeners.has( event ) ) {

			for ( const callback of this.listeners.get( event ) ) {

				callback( data );

			}

		}

	}

	/**
	 * Disposes of resources.
	 */
	dispose() {

		this.listeners.clear();
		this.webglApp = null;
		this.webgpuApp = null;
		this.preservedState = null;

	}

}

// Create singleton instance
let backendManagerInstance = null;

/**
 * Gets the singleton BackendManager instance.
 * @returns {BackendManager} Backend manager instance
 */
export function getBackendManager() {

	if ( ! backendManagerInstance ) {

		backendManagerInstance = new BackendManager();

	}

	return backendManagerInstance;

}

// Expose to window for debugging
if ( typeof window !== 'undefined' ) {

	window.BackendManager = {
		get: getBackendManager,
		BackendType,
		BackendStatus
	};

}
