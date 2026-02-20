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

		// Initialize — store the promise so consumers can await detection
		this.capabilitiesReady = this.detectCapabilities();

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
	 * Alias for getCurrentApp() — preferred name in new code.
	 * @returns {Object} Current application instance
	 */
	getActiveApp() {

		return this.getCurrentApp();

	}

	/**
	 * Checks whether the active backend supports a given feature.
	 * Delegates to the app's supportsFeature() method.
	 * @param {string} featureName
	 * @returns {boolean}
	 */
	supportsFeature( featureName ) {

		const app = this.getCurrentApp();
		if ( app && typeof app.supportsFeature === 'function' ) {

			return app.supportsFeature( featureName );

		}

		return false;

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
	 * Uses getter / public properties rather than reaching into internals.
	 */
	preserveState() {

		const app = this.getCurrentApp();
		if ( ! app ) return;

		this.preservedState = {
			// Camera state
			camera: {
				position: app.camera?.position.clone(),
				rotation: app.camera?.rotation.clone(),
				quaternion: app.camera?.quaternion.clone(),
				fov: app.camera?.fov,
				near: app.camera?.near,
				far: app.camera?.far,
				target: app.controls?.target?.clone()
			},

			// Render settings (use app's own property values)
			settings: {
				maxBounces: app.maxBounces,
				samplesPerPixel: app.samplesPerPixel,
				maxSamples: app.maxSamples,
				transmissiveBounces: app.transmissiveBounces,
				environmentIntensity: app.environmentIntensity,
				backgroundIntensity: app.backgroundIntensity,
				showBackground: app.showBackground,
				enableEnvironment: app.enableEnvironment,
				globalIlluminationIntensity: app.globalIlluminationIntensity,
				exposure: app.exposure,
				enableDOF: app.enableDOF,
				focusDistance: app.focusDistance,
				focalLength: app.focalLength,
				aperture: app.aperture,
				apertureScale: app.apertureScale,
				samplingTechnique: app.samplingTechnique,
				useAdaptiveSampling: app.useAdaptiveSampling,
				adaptiveSamplingMax: app.adaptiveSamplingMax,
				fireflyThreshold: app.fireflyThreshold,
				enableEmissiveTriangleSampling: app.enableEmissiveTriangleSampling,
				emissiveBoost: app.emissiveBoost,
				visMode: app.visMode,
				debugVisScale: app.debugVisScale,
			},

			// Target resolution
			targetResolution: app.targetResolution,

			// Environment state
			environment: {
				environmentUrl: app.environmentUrl,
				environmentRotation: app.environmentRotation,
			},

			// Tone mapping
			toneMapping: app.renderer?.toneMapping,
			toneMappingExposure: app.renderer?.toneMappingExposure,
		};

		console.log( 'BackendManager: State preserved' );

	}

	/**
	 * Restores the preserved state to the new backend via setter API.
	 */
	restoreState() {

		const app = this.getCurrentApp();
		if ( ! app || ! this.preservedState ) return;

		// Restore camera
		const cam = this.preservedState.camera;
		if ( cam && app.camera ) {

			if ( cam.position ) app.camera.position.copy( cam.position );
			if ( cam.quaternion ) app.camera.quaternion.copy( cam.quaternion );
			if ( cam.fov ) {

				app.camera.fov = cam.fov;
				app.camera.updateProjectionMatrix();

			}

			// Update controls target if available
			if ( cam.target && app.controls?.target ) {

				app.controls.target.copy( cam.target );
				app.controls.update();

			} else if ( app.controls?.target ) {

				app.controls.update();

			}

			// Save state so controls.reset() reflects the restored position
			if ( app.controls?.saveState ) {

				app.controls.saveState();

			}

		}

		// Restore render settings via the common setter API
		const s = this.preservedState.settings;
		if ( s ) {

			const setters = {
				setMaxBounces: s.maxBounces,
				setSamplesPerPixel: s.samplesPerPixel,
				setMaxSamples: s.maxSamples,
				setTransmissiveBounces: s.transmissiveBounces,
				setEnvironmentIntensity: s.environmentIntensity,
				setBackgroundIntensity: s.backgroundIntensity,
				setShowBackground: s.showBackground,
				setEnableEnvironment: s.enableEnvironment,
				setGlobalIlluminationIntensity: s.globalIlluminationIntensity,
				setExposure: s.exposure,
				setEnableDOF: s.enableDOF,
				setFocusDistance: s.focusDistance,
				setFocalLength: s.focalLength,
				setAperture: s.aperture,
				setApertureScale: s.apertureScale,
				setSamplingTechnique: s.samplingTechnique,
				setUseAdaptiveSampling: s.useAdaptiveSampling,
				setAdaptiveSamplingMax: s.adaptiveSamplingMax,
				setFireflyThreshold: s.fireflyThreshold,
				setEnableEmissiveTriangleSampling: s.enableEmissiveTriangleSampling,
				setEmissiveBoost: s.emissiveBoost,
				setVisMode: s.visMode,
				setDebugVisScale: s.debugVisScale,
			};

			for ( const [ method, value ] of Object.entries( setters ) ) {

				if ( value !== undefined && typeof app[ method ] === 'function' ) {

					app[ method ]( value );

				}

			}

		}

		// Restore resolution
		if ( this.preservedState.targetResolution !== undefined && app.updateResolution ) {

			app.updateResolution( this.preservedState.targetResolution );

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

			// Ensure the app's animation loop is running (may not be started yet during init)
			const targetApp = backend === BackendType.WEBGL ? this.webglApp : this.webgpuApp;
			if ( targetApp && targetApp.resume ) {

				targetApp.resume();

			}

			this.toggleCanvasVisibility( backend );
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

			// Also dispatch a window event so UI components can react
			window.dispatchEvent( new CustomEvent( 'BackendSwitched', {
				detail: { from: previousBackend, to: backend }
			} ) );

			console.log( `BackendManager: Successfully switched to ${backend}` );
			return true;

		} catch ( error ) {

			// Restore previous backend on error
			console.error( 'BackendManager: Switch failed:', error );

			// Try to revert to the previous backend
			const previousBackend = this.currentBackend === backend
				? ( backend === BackendType.WEBGL ? BackendType.WEBGPU : BackendType.WEBGL )
				: this.currentBackend;

			try {

				// Revert canvas visibility
				this.toggleCanvasVisibility( previousBackend );

				// Resume previous app
				const previousApp = previousBackend === BackendType.WEBGL ? this.webglApp : this.webgpuApp;
				if ( previousApp ) {

					this.currentBackend = previousBackend;
					if ( previousApp.resume ) {

						previousApp.resume();

					}

				}

			} catch ( revertError ) {

				console.error( 'BackendManager: Revert also failed:', revertError );

			}

			this.status = BackendStatus.ERROR;
			this.error = error.message;
			this.emit( 'error', { error: this.error, fallbackBackend: previousBackend } );

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
