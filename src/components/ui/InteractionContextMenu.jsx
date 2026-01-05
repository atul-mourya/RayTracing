import * as React from 'react';
import { cn } from '@/lib/utils';

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

	// Handle deselect action
	const handleDeselect = React.useCallback( () => {

		// Close menu
		setMenuState( prev => ( { ...prev, visible: false } ) );

		// Dispatch deselect event through InteractionManager
		// This triggers the proper event flow in PathTracerApp
		const app = appRef?.current;
		if ( app && app.interactionManager ) {

			app.interactionManager.dispatchEvent( {
				type: 'objectDeselected'
			} );

		}

	}, [ appRef ] );

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
			{/* Using exact same className as ContextMenuItem from context-menu.jsx */}
			<div
				onClick={handleDeselect}
				className={cn(
					'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
				)}
			>
				Deselect
			</div>
		</div>
	);

};

export default InteractionContextMenu;
