import { useStore } from '@/store';
import Outliner from './Outliner';
import Results from './Results';
import { memo } from 'react';

// Inner content component to prevent unnecessary re-renders
const SidebarContent = memo( ( { appMode } ) => (
	<>
		<div style={{
			display: appMode !== 'results' ? 'block' : 'none',
			height: '100%',
			visibility: appMode !== 'results' ? 'visible' : 'hidden'
		}}>
			{appMode !== 'results' && <Outliner />}
		</div>

		<div style={{
			display: appMode === 'results' ? 'block' : 'none',
			height: '100%',
			visibility: appMode === 'results' ? 'visible' : 'hidden'
		}}>
			{appMode === 'results' && <Results />}
		</div>
	</>
) );

SidebarContent.displayName = 'SidebarContent';

// Main LeftSidebar component
const LeftSidebar = memo( () => {

	const appMode = useStore( state => state.appMode );

	return (
		<div className="h-full">
			<SidebarContent appMode={appMode} />
		</div>
	);

} );

LeftSidebar.displayName = 'LeftSidebar';

export default LeftSidebar;
