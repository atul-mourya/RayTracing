import {
	EventDispatcher,
	Raycaster,
	SphereGeometry,
	Mesh,
	MeshBasicMaterial
} from 'three';
import { useStore, useCameraStore } from '@/store';

/**
 * InteractionManager
 *
 * Manages all mouse-based interactions in the path tracer:
 * - Click-to-focus for depth of field
 * - Click-to-select for object selection
 * - Double-click to open material editor
 *
 * Event-driven architecture with clean separation from main app
 */
class InteractionManager extends EventDispatcher {

	constructor( { scene, camera, canvas, assetLoader, pathTracingPass, floorPlane } ) {

		super();

		// Core dependencies
		this.scene = scene;
		this.camera = camera;
		this.canvas = canvas;
		this.assetLoader = assetLoader;
		this.pathTracingPass = pathTracingPass;
		this.floorPlane = floorPlane;

		// Raycaster for intersection detection
		this.raycaster = new Raycaster();

		// Focus mode state
		this.focusMode = false;
		this.focusPointIndicator = null;

		// Select mode state
		this.selectMode = false;
		this.clickTimeout = null;

		// Bind event handlers to maintain 'this' context
		this.handleFocusClick = this.handleFocusClick.bind( this );
		this.handleSelectClick = this.handleSelectClick.bind( this );
		this.handleSelectDoubleClick = this.handleSelectDoubleClick.bind( this );

	}

	// ==================== FOCUS MODE ====================

	/**
	 * Toggle focus mode for click-to-focus depth of field
	 * @returns {boolean} New focus mode state
	 */
	toggleFocusMode() {

		this.focusMode = ! this.focusMode;

		// Update cursor to indicate mode
		this.canvas.style.cursor = this.focusMode ? 'crosshair' : 'auto';

		// Manage event listeners
		if ( this.focusMode ) {

			this.canvas.addEventListener( 'click', this.handleFocusClick );

		} else {

			this.canvas.removeEventListener( 'click', this.handleFocusClick );

		}

		// Emit event for external listeners
		this.dispatchEvent( {
			type: 'focusModeChanged',
			enabled: this.focusMode
		} );

		return this.focusMode;

	}

	/**
	 * Handle click when in focus mode
	 * @private
	 */
	handleFocusClick( event ) {

		const mouseCoords = this.getMouseCoordinates( event );
		this.raycaster.setFromCamera( mouseCoords, this.camera );

		const intersects = this.raycaster.intersectObjects( this.scene.children, true );

		if ( intersects.length > 0 ) {

			const intersection = intersects[ 0 ];
			const distance = intersection.distance;

			// Show visual indicator at focus point
			this.showFocusPoint( intersection.point );

			// Exit focus mode automatically
			this.toggleFocusMode();

			// Dispatch event with focus distance
			this.dispatchEvent( {
				type: 'focusChanged',
				distance: distance / this.assetLoader.getSceneScale(),
				worldDistance: distance
			} );

		}

	}

	/**
	 * Display a temporary visual indicator at the focus point
	 * @private
	 */
	showFocusPoint( point ) {

		// Remove existing indicator
		if ( this.focusPointIndicator ) {

			this.scene.remove( this.focusPointIndicator );

		}

		// Create indicator sphere
		const sphereSize = this.assetLoader.getSceneScale() * 0.02;
		const geometry = new SphereGeometry( sphereSize, 16, 16 );
		const material = new MeshBasicMaterial( {
			color: 0x00ff00,
			transparent: true,
			opacity: 0.8,
			depthTest: false
		} );

		this.focusPointIndicator = new Mesh( geometry, material );
		this.focusPointIndicator.position.copy( point );
		this.scene.add( this.focusPointIndicator );

		// Auto-remove after 2 seconds
		setTimeout( () => {

			if ( this.focusPointIndicator ) {

				this.scene.remove( this.focusPointIndicator );
				this.focusPointIndicator = null;

			}

		}, 2000 );

	}

	// ==================== SELECT MODE ====================

	/**
	 * Toggle select mode for object selection
	 * Only available in preview mode
	 * @returns {boolean} New select mode state
	 */
	toggleSelectMode() {

		// Only allow in preview mode
		const appMode = useStore.getState().appMode;
		if ( appMode !== 'preview' ) {

			return false;

		}

		this.selectMode = ! this.selectMode;

		// Update cursor
		this.canvas.style.cursor = this.selectMode ? 'pointer' : 'auto';

		// Manage event listeners
		if ( this.selectMode ) {

			this.canvas.addEventListener( 'click', this.handleSelectClick );
			this.canvas.addEventListener( 'dblclick', this.handleSelectDoubleClick );

		} else {

			this.canvas.removeEventListener( 'click', this.handleSelectClick );
			this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );

			// Clear pending click timeout
			if ( this.clickTimeout ) {

				clearTimeout( this.clickTimeout );
				this.clickTimeout = null;

			}

		}

		// Emit event
		this.dispatchEvent( {
			type: 'selectModeChanged',
			enabled: this.selectMode
		} );

		return this.selectMode;

	}

	/**
	 * Disable select mode (called when leaving preview mode)
	 */
	disableSelectMode() {

		if ( ! this.selectMode ) return;

		this.selectMode = false;

		// Restore cursor
		this.canvas.style.cursor = 'auto';

		// Remove event listeners
		this.canvas.removeEventListener( 'click', this.handleSelectClick );
		this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );

		// Clear timeout
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

		// Update store
		useCameraStore.getState().setSelectMode( false );

		// Emit event
		this.dispatchEvent( {
			type: 'selectModeChanged',
			enabled: false
		} );

	}

	/**
	 * Handle single click for object selection
	 * Includes debouncing to prevent firing on double-click
	 * @private
	 */
	handleSelectClick( event ) {

		// Clear existing timeout to prevent single-click on double-click
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;
			return;

		}

		// Debounce to distinguish single from double click
		this.clickTimeout = setTimeout( () => {

			this.clickTimeout = null;

			// Verify still in preview mode
			const appMode = useStore.getState().appMode;
			if ( appMode !== 'preview' ) return;

			// Perform raycast
			const mouseCoords = this.getMouseCoordinates( event );
			this.raycaster.setFromCamera( mouseCoords, this.camera );

			const intersects = this.raycaster.intersectObjects( this.scene.children, true );
			const validIntersects = this.filterValidIntersects( intersects );

			if ( validIntersects.length > 0 ) {

				const object = validIntersects[ 0 ].object;
				const currentlySelectedObject = useStore.getState().selectedObject;
				const isAlreadySelected = currentlySelectedObject && currentlySelectedObject.uuid === object.uuid;

				if ( isAlreadySelected ) {

					// Deselect (toggle behavior)
					this.dispatchEvent( {
						type: 'objectDeselected',
						object: object,
						uuid: object.uuid
					} );

				} else {

					// Select new object
					this.dispatchEvent( {
						type: 'objectSelected',
						object: object,
						uuid: object.uuid
					} );

				}

			} else {

				// No valid object clicked - deselect
				this.dispatchEvent( {
					type: 'objectDeselected'
				} );

			}

		}, 250 ); // 250ms delay for double-click detection

	}

	/**
	 * Handle double-click for opening material editor
	 * @private
	 */
	handleSelectDoubleClick( event ) {

		// Clear single-click timeout
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

		// Verify in preview mode
		const appMode = useStore.getState().appMode;
		if ( appMode !== 'preview' ) return;

		// Perform raycast
		const mouseCoords = this.getMouseCoordinates( event );
		this.raycaster.setFromCamera( mouseCoords, this.camera );

		const intersects = this.raycaster.intersectObjects( this.scene.children, true );
		const validIntersects = this.filterValidIntersects( intersects );

		if ( validIntersects.length > 0 ) {

			const object = validIntersects[ 0 ].object;

			// Dispatch double-click event
			this.dispatchEvent( {
				type: 'objectDoubleClicked',
				object: object,
				uuid: object.uuid
			} );

		}

	}

	// ==================== UTILITY METHODS ====================

	/**
	 * Calculate normalized device coordinates from mouse event
	 * @private
	 */
	getMouseCoordinates( event ) {

		const rect = this.canvas.getBoundingClientRect();
		const x = ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1;
		const y = - ( ( event.clientY - rect.top ) / rect.height ) * 2 + 1;

		return { x, y };

	}

	/**
	 * Filter intersections to exclude helper objects and floor plane
	 * @private
	 */
	filterValidIntersects( intersects ) {

		return intersects.filter( intersect => {

			const object = intersect.object;
			return object !== this.focusPointIndicator &&
				object !== this.floorPlane &&
				! object.name.includes( 'Helper' ) &&
				object.type === 'Mesh';

		} );

	}

	/**
	 * Update dependencies (useful when scene/camera changes)
	 */
	updateDependencies( { scene, camera, floorPlane } ) {

		if ( scene ) this.scene = scene;
		if ( camera ) this.camera = camera;
		if ( floorPlane ) this.floorPlane = floorPlane;

	}

	// ==================== LIFECYCLE ====================

	/**
	 * Clean up all event listeners and state
	 */
	dispose() {

		// Remove all event listeners
		this.canvas.removeEventListener( 'click', this.handleFocusClick );
		this.canvas.removeEventListener( 'click', this.handleSelectClick );
		this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );

		// Clear timeouts
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

		// Remove focus indicator from scene
		if ( this.focusPointIndicator ) {

			this.scene.remove( this.focusPointIndicator );
			this.focusPointIndicator = null;

		}

		// Restore cursor
		this.canvas.style.cursor = 'auto';

		// Clear references
		this.scene = null;
		this.camera = null;
		this.canvas = null;
		this.assetLoader = null;
		this.pathTracingPass = null;
		this.floorPlane = null;
		this.raycaster = null;

	}

}

export default InteractionManager;
