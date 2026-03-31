import {
	EventDispatcher,
	Raycaster,
	SphereGeometry,
	Mesh,
	MeshBasicMaterial
} from 'three';

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
export class InteractionManager extends EventDispatcher {

	constructor( { scene, camera, canvas, assetLoader, pathTracer, floorPlane } ) {

		super();

		// Core dependencies
		this.scene = scene;
		this.camera = camera;
		this.canvas = canvas;
		this.assetLoader = assetLoader;
		this.pathTracer = pathTracer;
		this.floorPlane = floorPlane;

		// Raycaster for intersection detection
		this.raycaster = new Raycaster();

		// Focus mode state
		this.focusMode = false;
		this.focusPointIndicator = null;

		// AF point placement state
		this.afPointPlacementMode = false;
		this.handleAFPointClick = this.handleAFPointClick.bind( this );

		// Select mode state
		this.selectedObject = null; // Tracked internally, synced by PathTracerApp
		this.selectMode = false;
		this.clickTimeout = null;
		this.mouseDownPosition = null; // Track mousedown position to detect drags
		this.dragThreshold = 5; // Pixels of movement to consider it a drag

		// Bind event handlers to maintain 'this' context
		this.handleFocusClick = this.handleFocusClick.bind( this );
		this.handleSelectClick = this.handleSelectClick.bind( this );
		this.handleSelectDoubleClick = this.handleSelectDoubleClick.bind( this );
		this.handleMouseDown = this.handleMouseDown.bind( this );
		this.handleMouseUp = this.handleMouseUp.bind( this );
		this.handleContextMenu = this.handleContextMenu.bind( this );
		this.handleContextPointerDown = this.handleContextPointerDown.bind( this );
		this.handleContextPointerUp = this.handleContextPointerUp.bind( this );

		// Context menu right-click detection is always active (not gated by select mode)
		// Uses pointer events to avoid suppression from OrbitControls preventDefault on pointerdown
		this.contextPointerDownPosition = null;
		this.canvas.addEventListener( 'pointerdown', this.handleContextPointerDown );
		this.canvas.addEventListener( 'pointerup', this.handleContextPointerUp );
		this.canvas.addEventListener( 'contextmenu', this.handleContextMenu );

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

	// ==================== AF POINT PLACEMENT ====================

	/**
	 * Enter AF point placement mode for screen-point auto-focus.
	 */
	enterAFPointPlacementMode() {

		this.afPointPlacementMode = true;
		this.canvas.style.cursor = 'crosshair';
		this.canvas.addEventListener( 'click', this.handleAFPointClick );

	}

	/**
	 * Exit AF point placement mode.
	 */
	exitAFPointPlacementMode() {

		this.afPointPlacementMode = false;
		this.canvas.style.cursor = 'auto';
		this.canvas.removeEventListener( 'click', this.handleAFPointClick );

	}

	/**
	 * Handle click to place AF point.
	 * @private
	 */
	handleAFPointClick( event ) {

		const rect = this.canvas.getBoundingClientRect();
		// Normalized screen coordinates (0-1)
		const x = ( event.clientX - rect.left ) / rect.width;
		const y = ( event.clientY - rect.top ) / rect.height;

		// Exit placement mode
		this.exitAFPointPlacementMode();

		// Dispatch event
		this.dispatchEvent( {
			type: 'afPointPlaced',
			point: { x, y }
		} );

	}

	// ==================== SELECT MODE ====================

	/**
	 * Toggle select mode for object selection
	 * Only available in preview mode
	 * @returns {boolean} New select mode state
	 */
	toggleSelectMode() {

		this.selectMode = ! this.selectMode;

		// Update cursor
		this.canvas.style.cursor = this.selectMode ? 'pointer' : 'auto';

		// Manage event listeners
		if ( this.selectMode ) {

			this.canvas.addEventListener( 'mousedown', this.handleMouseDown );
			this.canvas.addEventListener( 'mouseup', this.handleMouseUp );
			this.canvas.addEventListener( 'click', this.handleSelectClick );
			this.canvas.addEventListener( 'dblclick', this.handleSelectDoubleClick );

		} else {

			this.canvas.removeEventListener( 'mousedown', this.handleMouseDown );
			this.canvas.removeEventListener( 'mouseup', this.handleMouseUp );
			this.canvas.removeEventListener( 'click', this.handleSelectClick );
			this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );

			// Clear pending click timeout
			if ( this.clickTimeout ) {

				clearTimeout( this.clickTimeout );
				this.clickTimeout = null;

			}

			// Clear mousedown position
			this.mouseDownPosition = null;

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

		// Remove event listeners (context menu listeners stay active)
		this.canvas.removeEventListener( 'mousedown', this.handleMouseDown );
		this.canvas.removeEventListener( 'mouseup', this.handleMouseUp );
		this.canvas.removeEventListener( 'click', this.handleSelectClick );
		this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );

		// Clear timeout
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

		// Clear mousedown position
		this.mouseDownPosition = null;

		// Emit event
		this.dispatchEvent( {
			type: 'selectModeChanged',
			enabled: false
		} );

	}

	/**
	 * Record mouse position on mousedown to detect drag operations
	 * @private
	 */
	handleMouseDown( event ) {

		// Record position for all mouse buttons (especially right-click for context menu)
		this.mouseDownPosition = {
			x: event.clientX,
			y: event.clientY,
			button: event.button // 0=left, 1=middle, 2=right
		};

	}

	/**
	 * Check if mouse moved significantly between mousedown and mouseup
	 * @private
	 */
	wasMouseDragged( event ) {

		if ( ! this.mouseDownPosition ) return false;

		const deltaX = Math.abs( event.clientX - this.mouseDownPosition.x );
		const deltaY = Math.abs( event.clientY - this.mouseDownPosition.y );
		const distance = Math.sqrt( deltaX * deltaX + deltaY * deltaY );

		// Check if mouse moved beyond threshold
		return distance > this.dragThreshold;

	}

	/**
	 * Handle single click for object selection
	 * Includes debouncing to prevent firing on double-click
	 * Only triggers if mouse wasn't dragged (camera movement)
	 * @private
	 */
	handleSelectClick( event ) {

		// Ignore clicks that are actually drags (camera movement)
		if ( this.wasMouseDragged( event ) ) {

			this.mouseDownPosition = null;
			return;

		}

		this.mouseDownPosition = null;

		// Clear existing timeout to prevent single-click on double-click
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;
			return;

		}

		// Debounce to distinguish single from double click
		this.clickTimeout = setTimeout( () => {

			this.clickTimeout = null;

			// Perform raycast
			const mouseCoords = this.getMouseCoordinates( event );
			this.raycaster.setFromCamera( mouseCoords, this.camera );

			const intersects = this.raycaster.intersectObjects( this.scene.children, true );
			const validIntersects = this.filterValidIntersects( intersects );

			if ( validIntersects.length > 0 ) {

				const object = validIntersects[ 0 ].object;
				const currentlySelectedObject = this.selectedObject;
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

		// Ignore double-clicks that are actually drags
		if ( this.wasMouseDragged( event ) ) {

			this.mouseDownPosition = null;
			return;

		}

		this.mouseDownPosition = null;

		// Clear single-click timeout
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

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

	// ==================== CONTEXT MENU ====================

	/**
	 * Handle mouseup for select mode (no longer handles context menu)
	 * @private
	 */
	handleMouseUp() {

		// Context menu is now handled by handleContextPointerUp (always active)

	}

	/**
	 * Track right-click pointer down for context menu drag detection.
	 * Uses pointer events (always active) to avoid suppression by OrbitControls.
	 * @private
	 */
	handleContextPointerDown( event ) {

		if ( event.button !== 2 ) return;

		this.contextPointerDownPosition = {
			x: event.clientX,
			y: event.clientY
		};

	}

	/**
	 * Handle right-click pointer up to show context menu.
	 * Always active regardless of select mode — works for objects selected
	 * via outliner, canvas click-to-select, or any other method.
	 * @private
	 */
	handleContextPointerUp( event ) {

		if ( event.button !== 2 ) return;

		// Check if this was a drag operation
		if ( this.contextPointerDownPosition ) {

			const deltaX = Math.abs( event.clientX - this.contextPointerDownPosition.x );
			const deltaY = Math.abs( event.clientY - this.contextPointerDownPosition.y );
			const distance = Math.sqrt( deltaX * deltaX + deltaY * deltaY );

			if ( distance > this.dragThreshold ) {

				this.contextPointerDownPosition = null;
				return;

			}

		} else {

			return;

		}

		this.contextPointerDownPosition = null;

		// Only show context menu if an object is selected
		const selectedObject = this.selectedObject;
		if ( ! selectedObject ) return;

		// Dispatch event for React component to handle
		this.dispatchEvent( {
			type: 'contextMenuRequested',
			x: event.clientX,
			y: event.clientY,
			selectedObject: selectedObject
		} );

	}

	/**
	 * Prevent default context menu from showing
	 * @private
	 */
	handleContextMenu( event ) {

		// Always prevent default context menu
		event.preventDefault();

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
		this.canvas.removeEventListener( 'click', this.handleAFPointClick );
		this.canvas.removeEventListener( 'click', this.handleFocusClick );
		this.canvas.removeEventListener( 'mousedown', this.handleMouseDown );
		this.canvas.removeEventListener( 'mouseup', this.handleMouseUp );
		this.canvas.removeEventListener( 'click', this.handleSelectClick );
		this.canvas.removeEventListener( 'dblclick', this.handleSelectDoubleClick );
		this.canvas.removeEventListener( 'contextmenu', this.handleContextMenu );
		this.canvas.removeEventListener( 'pointerdown', this.handleContextPointerDown );
		this.canvas.removeEventListener( 'pointerup', this.handleContextPointerUp );

		// Clear timeouts
		if ( this.clickTimeout ) {

			clearTimeout( this.clickTimeout );
			this.clickTimeout = null;

		}

		// Clear mousedown position
		this.mouseDownPosition = null;
		this.contextPointerDownPosition = null;

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
		this.pathTracer = null;
		this.floorPlane = null;
		this.raycaster = null;

	}

}

