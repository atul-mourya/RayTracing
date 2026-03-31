import { EventDispatcher, Vector3 } from 'three';
import { EngineEvents, } from '../EngineEvents.js';
import { AF_DEFAULTS } from '../EngineDefaults.js';

/**
 * Manages camera switching, auto-focus, and AF point placement.
 *
 * Extracted from PathTracerApp to keep the facade slim.
 * Dispatches events that PathTracerApp relays to external consumers.
 */
export class CameraManager extends EventDispatcher {

	/**
	 * @param {import('three').PerspectiveCamera} camera
	 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
	 * @param {import('./InteractionManager.js').InteractionManager} interactionManager
	 */
	constructor( camera, controls, interactionManager ) {

		super();

		this.camera = camera;
		this.controls = controls;
		this.interactionManager = interactionManager;

		/** @type {import('three').PerspectiveCamera[]} */
		this.cameras = [ camera ];
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
	 * Switches the active camera by index.
	 * @param {number} index
	 * @param {number} focusDistance - Current focus distance (for orbit target placement)
	 * @param {Function} onResize   - Callback to trigger resize after camera change
	 * @param {Function} onReset    - Callback to trigger accumulation reset
	 */
	switchCamera( index, focusDistance, onResize, onReset ) {

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
	 * @param {import('./PathTracingStage.js').PathTracingStage} params.pathTracingStage
	 * @param {Function} params.setFocusDistance - Callback to update uniform + settings
	 * @param {Function} params.softReset       - Callback for soft accumulation reset
	 * @param {Function} params.hardReset       - Callback for hard accumulation reset
	 */
	updateAutoFocus( { meshScene, assetLoader, floorPlane, currentFocusDistance, pathTracingStage, setFocusDistance, softReset, hardReset } ) {

		if ( this.autoFocusMode === 'manual' ) return;

		// Lock focus during active tiled final rendering
		const stage = pathTracingStage;
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

}
