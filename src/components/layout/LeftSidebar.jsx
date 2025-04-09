import { useStore } from '@/store';
import Outliner from './Outliner';
import Results from './Results';
import { memo } from 'react';

// Use memo to prevent unnecessary renders
const LeftSidebar = memo( () => {

	const appMode = useStore( state => state.appMode );
	console.log( 'LeftSidebar component rendered' ); // Changed from "mounted" to "rendered"

	// Instead of conditionally mounting and unmounting components,
	// render them all but hide the inactive ones
	return (
		<div className="h-full">
			<div style={{ display: appMode !== 'results' ? 'block' : 'none', height: '100%' }}>
				<Outliner />
			</div>

			<div style={{ display: appMode === 'results' ? 'block' : 'none', height: '100%' }}>
				<Results />
			</div>
		</div>
	);

} );

// Add display name for debugging
LeftSidebar.displayName = 'LeftSidebar';

export default LeftSidebar;
