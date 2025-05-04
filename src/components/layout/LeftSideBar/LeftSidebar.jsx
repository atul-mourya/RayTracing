import { useStore } from '@/store';
import Outliner from './Outliner';
import Results from './Results';
import { memo, useMemo, useState, useEffect } from 'react';

// Create a wrapped version of Outliner that only loads when needed
const LazyOutliner = memo( () => {

	// Track whether the component has been rendered at least once
	const [ hasRendered, setHasRendered ] = useState( false );

	useEffect( () => {

		if ( ! hasRendered ) {

			setHasRendered( true );

		}

	}, [ hasRendered ] );

	// Only render the component if it has already been shown before
	// This prevents expensive re-mounts and initialization
	return hasRendered ? <Outliner /> : null;

} );

LazyOutliner.displayName = 'LazyOutliner';

// Create a wrapped version of Results that only loads when needed
const LazyResults = memo( () => {

	// Track whether the component has been rendered at least once
	const [ hasRendered, setHasRendered ] = useState( false );

	useEffect( () => {

		if ( ! hasRendered ) {

			setHasRendered( true );

		}

	}, [ hasRendered ] );

	// Only render the component if it has already been shown before
	return hasRendered ? <Results /> : null;

} );

LazyResults.displayName = 'LazyResults';

// Inner content component to prevent unnecessary re-renders
const SidebarContent = memo( ( { appMode } ) => {

	// Use memoization to prevent unnecessary recreations of the UI structure
	return useMemo( () => (
		<>
			<div style={{
				display: appMode !== 'results' ? 'block' : 'none',
				height: '100%',
				visibility: appMode !== 'results' ? 'visible' : 'hidden'
			}}>
				{appMode !== 'results' && <LazyOutliner />}
			</div>

			<div style={{
				display: appMode === 'results' ? 'block' : 'none',
				height: '100%',
				visibility: appMode === 'results' ? 'visible' : 'hidden'
			}}>
				{appMode === 'results' && <LazyResults />}
			</div>
		</>
	), [ appMode ] );

} );

SidebarContent.displayName = 'SidebarContent';

// Main LeftSidebar component
const LeftSidebar = memo( () => {

	// Access store state with useMemo to prevent infinite loop issues
	const appMode = useStore( state => state.appMode );

	// Memoize the mode value to avoid unnecessary re-renders of children
	const memoizedMode = useMemo( () => appMode, [ appMode ] );

	return (
		<div className="h-full">
			<SidebarContent appMode={memoizedMode} />
		</div>
	);

} );

// Add display name for debugging
LeftSidebar.displayName = 'LeftSidebar';

export default LeftSidebar;
