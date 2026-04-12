import { EventDispatcher, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EngineEvents, } from '../EngineEvents.js';
import { AF_DEFAULTS } from '../EngineDefaults.js';

/**
 * Manages camera creation, switching, auto-focus, and AF point placement.
 *
 * Owns the PerspectiveCamera and OrbitControls instances.
 * Dispatches events that PathTracerApp relays to external consumers.
 */
export class CameraManager extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for orbit controls
	 */
	constructor( canvas ) {

		super();

		const width = canvas.clientWidth;
		const height = canvas.clientHeight;

		this.camera = new PerspectiveCamera( 60, width / height || 1, 0.01, 1000 );
		this.camera.position.set( 0, 0, 5 );

		this.controls = new OrbitControls( this.camera, canvas );
		this.controls.screenSpacePanning = true;
		this.controls.zoomToCursor = true;
		this.controls.saveState();

		this.interactionManager = null;

		/** @type {import('three').PerspectiveCamera[]} */
		this.cameras = [ this.camera ];
		this.currentCameraIndex = 0;

		// Auto-focus state
		this.autoFocusMode = AF_DEFAULTS.SMOOTHING_FACTOR ? 'auto' : 'manual';
		this.afScreenPoint = { x: 0.5, y: 0.5 };
		this.afSmoothingFactor = AF_DEFAULTS.SMOOTHING_FACTOR;
		this._lastValidFocusDistance = null;
		this._smoothedFocusDistance = null;
		this._afPointDirty = false;

		// Saved state for default camera when switching to model cameras
		this._defaultCameraState = null;

		// Callbacks injected by PathTracerApp
		this._onResize = null;
		this._onReset = null;
		this._getSettings = null;

	}

	/**
	 * Sets the list of available cameras (default + extracted from model).
	 * @param {import('three').PerspectiveCamera[]} cameras
	 */
	setCameras( cameras ) {

		this.cameras = cameras;

	}

	/**
	 * Returns display names for all available cameras.
	 * @returns {string[]}
	 */
	getCameraNames() {

		if ( ! this.cameras || this.cameras.length === 0 ) return [ 'Default Camera' ];

		return this.cameras.map( ( cam, index ) => {

			if ( index === 0 ) return 'Default Camera';
			return cam.name || `Camera ${index}`;

		} );

	}

	/**
	 * Stores callbacks for camera operations (resize, reset, settings access).
	 * Call once after all managers are ready.
	 *
	 * @param {Object} callbacks
	 * @param {Function} callbacks.onResize   - Trigger viewport resize
	 * @param {Function} callbacks.onReset    - Trigger accumulation reset
	 * @param {Function} callbacks.getSettings - (key) => value
	 */
	initCallbacks( { onResize, onReset, getSettings } ) {

		this._onResize = onResize;
		this._onReset = onReset;
		this._getSettings = getSettings;

	}

	/**
	 * Switches the active camera by index.
	 * Uses stored callbacks from initCallbacks() for resize/reset.
	 * @param {number} index
	 * @param {number} [focusDistance] - Override focus distance (falls back to settings)
	 * @param {Function} [onResize]   - Override resize callback
	 * @param {Function} [onReset]    - Override reset callback
	 */
	switchCamera( index, focusDistance, onResize, onReset ) {

		// Use stored callbacks if not provided (backward-compatible signature)
		focusDistance = focusDistance ?? this._getSettings?.( 'focusDistance' );
		onResize = onResize ?? this._onResize;
		onReset = onReset ?? this._onReset;

		if ( ! this.cameras || this.cameras.length === 0 ) return;

		if ( index < 0 || index >= this.cameras.length ) {

			console.warn( `CameraManager: Invalid camera index ${index}. Using default camera.` );
			index = 0;

		}

		// Save default camera state before switching away from it
		if ( this.currentCameraIndex === 0 && index !== 0 ) {

			this._defaultCameraState = {
				position: this.camera.position.clone(),
				quaternion: this.camera.quaternion.clone(),
				fov: this.camera.fov,
				near: this.camera.near,
				far: this.camera.far,
				target: this.controls ? this.controls.target.clone() : null,
			};

		}

		this.currentCameraIndex = index;

		if ( index === 0 && this._defaultCameraState ) {

			// Restore the default camera to its state before the switch
			const s = this._defaultCameraState;
			this.camera.position.copy( s.position );
			this.camera.quaternion.copy( s.quaternion );
			this.camera.fov = s.fov;
			this.camera.near = s.near;
			this.camera.far = s.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			if ( this.controls && s.target ) {

				this.controls.target.copy( s.target );
				this.controls.update();

			}

		} else {

			const sourceCamera = this.cameras[ index ];

			this.camera.position.copy( sourceCamera.position );
			this.camera.quaternion.copy( sourceCamera.quaternion );
			this.camera.fov = sourceCamera.fov;
			this.camera.near = sourceCamera.near;
			this.camera.far = sourceCamera.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			// Place orbit target along forward direction
			if ( this.controls ) {

				const forward = new Vector3( 0, 0, - 1 ).applyQuaternion( sourceCamera.quaternion );
				const focusDist = focusDistance || 5.0;
				this.controls.target.copy( this.camera.position ).addScaledVector( forward, focusDist );
				this.controls.update();

			}

		}

		onResize?.();
		onReset?.();
		this.dispatchEvent( { type: 'CameraSwitched', cameraIndex: index } );

	}

	/**
	 * Focuses the orbit camera on a world-space point.
	 * @param {import('three').Vector3} center
	 */
	focusOn( center ) {

		if ( ! center || ! this.controls ) return;
		this.controls.target.copy( center );
		this.controls.update();
		this._onReset?.();

	}

	// ── Aliases (match Sub-API surface) ───────────────────────────

	/** The active Three.js PerspectiveCamera. */
	get active() {

		return this.camera;

	}

	/** @see getCameraNames */
	getNames() {

		return this.getCameraNames();

	}

	// ── Auto-Focus ────────────────────────────────────────────────

	setAutoFocusMode( mode ) {

		this.autoFocusMode = mode;

		if ( mode !== 'manual' ) {

			this._smoothedFocusDistance = null;
			this._afPointDirty = true;

		}

	}

	setAFScreenPoint( x, y ) {

		this.afScreenPoint = { x, y };
		this._afPointDirty = true;

	}

	enterAFPointPlacementMode() {

		if ( ! this.interactionManager ) return;
		this.interactionManager.enterAFPointPlacementMode();
		if ( this.controls ) this.controls.enabled = false;

	}

	exitAFPointPlacementMode() {

		if ( ! this.interactionManager ) return;
		this.interactionManager.exitAFPointPlacementMode();
		if ( this.controls ) this.controls.enabled = true;

	}

	/**
	 * Per-frame auto-focus update. Called in animate() before pipeline.render().
	 *
	 * @param {Object} params
	 * @param {import('three').Scene} params.meshScene
	 * @param {Object} params.assetLoader
	 * @param {import('three').Mesh} params.floorPlane
	 * @param {number} params.currentFocusDistance
	 * @param {import('./PathTracer.js').PathTracer} params.pathTracer
	 * @param {Function} params.setFocusDistance - Callback to update uniform + settings
	 * @param {Function} params.softReset       - Callback for soft accumulation reset
	 * @param {Function} params.hardReset       - Callback for hard accumulation reset
	 */
	updateAutoFocus( ctx ) {

		const { meshScene, assetLoader, floorPlane, currentFocusDistance, pathTracer, setFocusDistance, softReset, hardReset } = ctx || this._afContext || {};
		if ( ! meshScene ) return;

		if ( this.autoFocusMode === 'manual' ) return;

		// Lock focus during active tiled final rendering
		const stage = pathTracer;
		if ( stage?.isReady
			&& stage.renderMode?.value === 1
			&& stage.frameCount > 0
			&& ! stage.isComplete ) return;

		// Convert AF screen point (normalized 0-1) to NDC (-1 to 1)
		const ndcX = this.afScreenPoint.x * 2 - 1;
		const ndcY = - ( this.afScreenPoint.y * 2 - 1 );

		const raycaster = this.interactionManager?.raycaster;
		if ( ! raycaster ) return;

		raycaster.setFromCamera( { x: ndcX, y: ndcY }, this.camera );
		const intersects = raycaster.intersectObjects( meshScene.children, true );

		const validHit = intersects.find( hit =>
			hit.object !== this.interactionManager?.focusPointIndicator &&
			hit.object !== floorPlane &&
			! hit.object.name.includes( 'Helper' ) &&
			hit.object.type === 'Mesh'
		);

		let rawDistance;
		if ( validHit ) {

			rawDistance = validHit.distance;
			this._lastValidFocusDistance = rawDistance;

		} else {

			if ( this._lastValidFocusDistance !== null ) {

				rawDistance = this._lastValidFocusDistance;

			} else {

				const scale = assetLoader?.getSceneScale() || 1.0;
				rawDistance = AF_DEFAULTS.FALLBACK_DISTANCE * scale;
				this._lastValidFocusDistance = rawDistance;

			}

		}

		const forceReset = this._afPointDirty;
		this._afPointDirty = false;

		// Temporal smoothing
		if ( forceReset || this._smoothedFocusDistance === null || this._smoothedFocusDistance === 0 ) {

			this._smoothedFocusDistance = rawDistance;

		} else {

			const changeFraction = Math.abs( rawDistance - this._smoothedFocusDistance )
				/ this._smoothedFocusDistance;

			if ( changeFraction > AF_DEFAULTS.SNAP_THRESHOLD ) {

				this._smoothedFocusDistance = rawDistance;

			} else {

				this._smoothedFocusDistance += this.afSmoothingFactor
					* ( rawDistance - this._smoothedFocusDistance );

			}

		}

		const prevFocus = currentFocusDistance;
		const newFocus = this._smoothedFocusDistance;

		if ( forceReset || prevFocus === 0 || Math.abs( newFocus - prevFocus ) / Math.max( prevFocus, 0.001 ) > 0.001 ) {

			setFocusDistance( newFocus );

			// Update store for UI display (unscaled value)
			const scale = assetLoader?.getSceneScale() || 1.0;
			this.dispatchEvent( { type: EngineEvents.AUTO_FOCUS_UPDATED, distance: newFocus / scale } );

			const changeRatio = Math.abs( newFocus - prevFocus ) / Math.max( prevFocus, 0.001 );
			if ( forceReset ) {

				hardReset?.();

			} else if ( changeRatio > AF_DEFAULTS.RESET_THRESHOLD ) {

				softReset?.();

			}

		}

	}

	/**
	 * Deferred dependency injection — InteractionManager needs the camera
	 * in its constructor, so it can't be passed during CameraManager creation.
	 * @param {import('./InteractionManager.js').InteractionManager} interactionManager
	 */
	setInteractionManager( interactionManager ) {

		this.interactionManager = interactionManager;

	}

	/**
	 * Initialises the stable auto-focus context. Call once after all
	 * managers and stages are ready. CameraManager stores the context
	 * and `updateAutoFocus()` reads from it each frame — no per-frame allocation.
	 *
	 * @param {Object} deps
	 * @param {import('three').Scene}           deps.meshScene
	 * @param {import('../Processor/AssetLoader.js').AssetLoader} deps.assetLoader
	 * @param {import('three').Mesh}            deps.floorPlane
	 * @param {import('../Stages/PathTracer.js').PathTracer} deps.pathTracer
	 * @param {import('../RenderSettings.js').RenderSettings} deps.settings
	 * @param {Function}                        deps.softReset
	 * @param {Function}                        deps.hardReset
	 */
	initAutoFocus( { meshScene, assetLoader, floorPlane, pathTracer, settings, softReset, hardReset } ) {

		this._afContext = {
			meshScene,
			assetLoader,
			floorPlane,
			pathTracer,
			setFocusDistance: ( d ) => settings.set( 'focusDistance', d, { silent: true } ),
			softReset,
			hardReset,
		};

		// Live getter — reads current value without allocation
		Object.defineProperty( this._afContext, 'currentFocusDistance', {
			get: () => settings.get( 'focusDistance' ),
		} );

	}

	dispose() {

		this.controls?.dispose();

	}

}
