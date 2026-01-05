import * as React from 'react';
import { cn } from '@/lib/utils';
import { Box3, Vector3 } from 'three';
import { Eye, EyeOff, Focus, Layers, Copy, Clipboard, Grid3x3 } from 'lucide-react';
import { useStore } from '@/store';

/**
 * InteractionContextMenu
 *
 * A context menu that appears when right-clicking on selected objects
 * Listens to events from InteractionManager and renders a styled menu
 * Uses the same styling classes as context-menu.jsx for consistency
 */
const InteractionContextMenu = ( { appRef, isAppInitialized } ) => {

	const [ menuState, setMenuState ] = React.useState( {
		visible: false,
		x: 0,
		y: 0,
		selectedObject: null
	} );

	const [ copiedMaterial, setCopiedMaterial ] = React.useState( null );
	const [ isIsolated, setIsIsolated ] = React.useState( false );
	const isolatedObjectRef = React.useRef( null );
	const visibilityStateBeforeIsolate = React.useRef( null ); // Store visibility state before isolation

	// Get visibility methods from store for synchronized visibility management
	const toggleMeshVisibility = useStore( ( state ) => state.toggleMeshVisibility );
	const setMeshVisibility = useStore( ( state ) => state.setMeshVisibility );

	// Close menu helper
	const closeMenu = React.useCallback( () => {

		setMenuState( prev => ( { ...prev, visible: false } ) );

	}, [] );

	// Handle hide action
	const handleHide = React.useCallback( () => {

		const object = menuState.selectedObject;

		if ( ! object ) return;

		// Use store's toggleMeshVisibility for synchronized visibility management
		// This ensures Outliner and other components stay in sync
		toggleMeshVisibility( object.uuid );

		// Deselect the object
		const app = appRef?.current;
		app?.interactionManager?.dispatchEvent( {
			type: 'objectDeselected'
		} );

		closeMenu();

	}, [ menuState.selectedObject, toggleMeshVisibility, appRef, closeMenu ] );

	// Handle focus action
	const handleFocus = React.useCallback( () => {

		const app = appRef?.current;
		const object = menuState.selectedObject;

		if ( ! app || ! object || ! app.controls ) return;

		// Compute bounding box and get center
		const box = new Box3().setFromObject( object );
		const center = new Vector3();
		box.getCenter( center );

		// Set orbit controls target to object center
		app.controls.target.copy( center );
		app.controls.update();

		// Trigger path tracer reset for camera change
		app.reset();

		closeMenu();

	}, [ appRef, menuState.selectedObject, closeMenu ] );

	// Handle isolate/un-isolate toggle
	const handleIsolateToggle = React.useCallback( () => {

		const app = appRef?.current;
		const selectedObject = menuState.selectedObject;

		if ( ! app || ! selectedObject ) return;

		if ( isIsolated ) {

			// Un-isolate: restore previous visibility state
			if ( visibilityStateBeforeIsolate.current ) {

				app.scene.traverse( ( child ) => {

					if ( child.isMesh && visibilityStateBeforeIsolate.current.has( child.uuid ) ) {

						// Restore the saved visibility state using store method for synchronization
						const wasVisible = visibilityStateBeforeIsolate.current.get( child.uuid );
						setMeshVisibility( child.uuid, wasVisible );

					}

				} );

			}

			setIsIsolated( false );
			isolatedObjectRef.current = null;
			visibilityStateBeforeIsolate.current = null; // Clear saved state

		} else {

			// Isolate: save current visibility state then hide all except selected
			const visibilityMap = new Map();

			app.scene.traverse( ( child ) => {

				if ( child.isMesh ) {

					// Skip floor plane and helper objects - they should not be affected by isolate
					const isFloorPlane = child === app.floorPlane || child.name === 'Ground';
					const isHelper = child.name.includes( 'Helper' );

					if ( isFloorPlane || isHelper ) {

						return; // Don't save or modify floor plane/helpers

					}

					// Save current visibility state
					visibilityMap.set( child.uuid, child.visible );

					// Hide all meshes except the selected one using store method for synchronization
					if ( child.uuid !== selectedObject.uuid ) {

						setMeshVisibility( child.uuid, false );

					}

				}

			} );

			// Store the visibility state for later restoration
			visibilityStateBeforeIsolate.current = visibilityMap;

			setIsIsolated( true );
			isolatedObjectRef.current = selectedObject.uuid;

		}

		closeMenu();

	}, [ appRef, menuState.selectedObject, isIsolated, setMeshVisibility, closeMenu ] );

	// Handle copy material action
	const handleCopyMaterial = React.useCallback( () => {

		const object = menuState.selectedObject;

		if ( ! object || ! object.material ) return;

		const material = object.material;

		// Extract material properties
		const materialData = {
			color: material.color?.getHex(),
			metalness: material.metalness,
			roughness: material.roughness,
			opacity: material.opacity,
			transparent: material.transparent,
			emissive: material.emissive?.getHex(),
			emissiveIntensity: material.emissiveIntensity,
			clearcoat: material.clearcoat,
			clearcoatRoughness: material.clearcoatRoughness,
			ior: material.ior,
			transmission: material.transmission,
			thickness: material.thickness,
			specularIntensity: material.specularIntensity,
			specularColor: material.specularColor?.getHex(),
			sheen: material.sheen,
			sheenRoughness: material.sheenRoughness,
			sheenColor: material.sheenColor?.getHex(),
			iridescence: material.iridescence,
			iridescenceIOR: material.iridescenceIOR,
			normalScale: material.normalScale?.x,
			bumpScale: material.bumpScale,
			// Store reference for paste validation
			_objectUUID: object.uuid
		};

		// Store in component state
		setCopiedMaterial( materialData );

		// Also copy to clipboard as JSON
		navigator.clipboard.writeText( JSON.stringify( materialData, null, 2 ) )
			.catch( err => console.error( 'Failed to copy material to clipboard:', err ) );

		closeMenu();

	}, [ menuState.selectedObject, closeMenu ] );

	// Handle paste material action
	const handlePasteMaterial = React.useCallback( () => {

		const app = appRef?.current;
		const object = menuState.selectedObject;

		if ( ! app || ! object || ! object.material || ! copiedMaterial ) return;

		const material = object.material;
		const pt = app.pathTracingPass;

		// Apply material properties
		if ( copiedMaterial.color !== undefined && material.color ) {

			material.color.setHex( copiedMaterial.color );
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'color', material.color );

		}

		if ( copiedMaterial.metalness !== undefined ) {

			material.metalness = copiedMaterial.metalness;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'metalness', copiedMaterial.metalness );

		}

		if ( copiedMaterial.roughness !== undefined ) {

			material.roughness = copiedMaterial.roughness;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'roughness', copiedMaterial.roughness );

		}

		if ( copiedMaterial.opacity !== undefined ) {

			material.opacity = copiedMaterial.opacity;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'opacity', copiedMaterial.opacity );

		}

		if ( copiedMaterial.emissive !== undefined && material.emissive ) {

			material.emissive.setHex( copiedMaterial.emissive );
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'emissive', material.emissive );

		}

		if ( copiedMaterial.emissiveIntensity !== undefined ) {

			material.emissiveIntensity = copiedMaterial.emissiveIntensity;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'emissiveIntensity', copiedMaterial.emissiveIntensity );

		}

		if ( copiedMaterial.clearcoat !== undefined ) {

			material.clearcoat = copiedMaterial.clearcoat;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'clearcoat', copiedMaterial.clearcoat );

		}

		if ( copiedMaterial.clearcoatRoughness !== undefined ) {

			material.clearcoatRoughness = copiedMaterial.clearcoatRoughness;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'clearcoatRoughness', copiedMaterial.clearcoatRoughness );

		}

		if ( copiedMaterial.ior !== undefined ) {

			material.ior = copiedMaterial.ior;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'ior', copiedMaterial.ior );

		}

		if ( copiedMaterial.transmission !== undefined ) {

			material.transmission = copiedMaterial.transmission;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'transmission', copiedMaterial.transmission );

		}

		if ( copiedMaterial.thickness !== undefined ) {

			material.thickness = copiedMaterial.thickness;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'thickness', copiedMaterial.thickness );

		}

		if ( copiedMaterial.specularIntensity !== undefined ) {

			material.specularIntensity = copiedMaterial.specularIntensity;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'specularIntensity', copiedMaterial.specularIntensity );

		}

		if ( copiedMaterial.specularColor !== undefined && material.specularColor ) {

			material.specularColor.setHex( copiedMaterial.specularColor );
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'specularColor', material.specularColor );

		}

		if ( copiedMaterial.sheen !== undefined ) {

			material.sheen = copiedMaterial.sheen;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'sheen', copiedMaterial.sheen );

		}

		if ( copiedMaterial.sheenRoughness !== undefined ) {

			material.sheenRoughness = copiedMaterial.sheenRoughness;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'sheenRoughness', copiedMaterial.sheenRoughness );

		}

		if ( copiedMaterial.sheenColor !== undefined && material.sheenColor ) {

			material.sheenColor.setHex( copiedMaterial.sheenColor );
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'sheenColor', material.sheenColor );

		}

		if ( copiedMaterial.iridescence !== undefined ) {

			material.iridescence = copiedMaterial.iridescence;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'iridescence', copiedMaterial.iridescence );

		}

		if ( copiedMaterial.iridescenceIOR !== undefined ) {

			material.iridescenceIOR = copiedMaterial.iridescenceIOR;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'iridescenceIOR', copiedMaterial.iridescenceIOR );

		}

		if ( copiedMaterial.normalScale !== undefined && material.normalScale ) {

			material.normalScale.set( copiedMaterial.normalScale, copiedMaterial.normalScale );
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'normalScale', copiedMaterial.normalScale );

		}

		if ( copiedMaterial.bumpScale !== undefined ) {

			material.bumpScale = copiedMaterial.bumpScale;
			pt?.updateMaterialProperty( object.userData?.materialIndex ?? 0, 'bumpScale', copiedMaterial.bumpScale );

		}

		// Mark material as needing update
		material.needsUpdate = true;

		// Reset path tracer to see changes
		app.reset();

		closeMenu();

	}, [ appRef, menuState.selectedObject, copiedMaterial, closeMenu ] );

	// Handle deselect action
	const handleDeselect = React.useCallback( () => {

		closeMenu();

		// Dispatch deselect event through InteractionManager
		// This triggers the proper event flow in PathTracerApp
		const app = appRef?.current;
		if ( app && app.interactionManager ) {

			app.interactionManager.dispatchEvent( {
				type: 'objectDeselected'
			} );

		}

		// Note: We keep the isolated state even when deselecting
		// This allows the user to keep objects isolated while exploring

	}, [ appRef, closeMenu ] );

	// Reset isolate state when new model is loaded
	React.useEffect( () => {

		const app = appRef?.current;
		if ( ! app ) return;

		const handleModelLoaded = () => {

			// Reset isolate state when a new model is loaded
			setIsIsolated( false );
			isolatedObjectRef.current = null;
			visibilityStateBeforeIsolate.current = null; // Clear saved visibility state

		};

		// Listen for model load events
		app.addEventListener( 'ModelLoaded', handleModelLoaded );

		return () => {

			if ( app ) {

				app.removeEventListener( 'ModelLoaded', handleModelLoaded );

			}

		};

	}, [ appRef, isAppInitialized ] );

	// Handle context menu request from InteractionManager
	React.useEffect( () => {

		const app = appRef?.current;
		if ( ! app || ! app.interactionManager ) return;

		const handleContextMenuRequested = ( event ) => {

			setMenuState( {
				visible: true,
				x: event.x,
				y: event.y,
				selectedObject: event.selectedObject
			} );

		};

		// Listen for context menu events
		app.interactionManager.addEventListener( 'contextMenuRequested', handleContextMenuRequested );

		return () => {

			if ( app?.interactionManager ) {

				app.interactionManager.removeEventListener( 'contextMenuRequested', handleContextMenuRequested );

			}

		};

	}, [ appRef, isAppInitialized ] );

	// Close menu when clicking outside
	React.useEffect( () => {

		if ( ! menuState.visible ) return;

		const handleClickOutside = ( event ) => {

			// Check if click is outside the menu
			const menuElement = document.getElementById( 'interaction-context-menu' );
			if ( menuElement && ! menuElement.contains( event.target ) ) {

				setMenuState( prev => ( { ...prev, visible: false } ) );

			}

		};

		// Add listener with a small delay to prevent immediate closure
		const timer = setTimeout( () => {

			document.addEventListener( 'click', handleClickOutside );

		}, 0 );

		return () => {

			clearTimeout( timer );
			document.removeEventListener( 'click', handleClickOutside );

		};

	}, [ menuState.visible ] );

	// Don't render if not visible
	if ( ! menuState.visible ) return null;

	const menuItemClass = cn(
		'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
	);

	// Using exact same className as ContextMenuContent from context-menu.jsx
	return (
		<div
			id="interaction-context-menu"
			className={cn(
				'z-50 max-h-[--radix-context-menu-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-context-menu-content-transform-origin]'
			)}
			data-state="open"
			style={{
				position: 'fixed',
				left: `${menuState.x}px`,
				top: `${menuState.y}px`,
			}}
		>
			{/* Hide */}
			<div onClick={handleHide} className={menuItemClass}>
				<EyeOff className="h-4 w-4" />
				Hide
			</div>

			{/* Focus */}
			<div onClick={handleFocus} className={menuItemClass}>
				<Focus className="h-4 w-4" />
				Focus
			</div>

			{/* Isolate/Un-isolate toggle */}
			<div onClick={handleIsolateToggle} className={menuItemClass}>
				{isIsolated ? (
					<>
						<Grid3x3 className="h-4 w-4" />
						Un-isolate
					</>
				) : (
					<>
						<Layers className="h-4 w-4" />
						Isolate
					</>
				)}
			</div>

			{/* Separator */}
			<div className="-mx-1 my-1 h-px bg-border" />

			{/* Copy Material */}
			<div onClick={handleCopyMaterial} className={menuItemClass}>
				<Copy className="h-4 w-4" />
				Copy Material
			</div>

			{/* Paste Material */}
			<div
				onClick={handlePasteMaterial}
				className={cn(
					menuItemClass,
					! copiedMaterial && 'opacity-50 cursor-not-allowed'
				)}
				style={{ pointerEvents: copiedMaterial ? 'auto' : 'none' }}
			>
				<Clipboard className="h-4 w-4" />
				Paste Material
			</div>

			{/* Separator */}
			<div className="-mx-1 my-1 h-px bg-border" />

			{/* Deselect */}
			<div onClick={handleDeselect} className={menuItemClass}>
				<Eye className="h-4 w-4" />
				Deselect
			</div>
		</div>
	);

};

export default InteractionContextMenu;
