import { memo } from 'react';
import Viewport3D from './Viewport3D';

// MainViewport component now serves as a simple wrapper for Viewport3D
const MainViewport = ( { mode = "interactive" } ) => {

	console.log( 'MainViewport render' );

	return (
		<div className="w-full h-full relative">
			<Viewport3D viewportMode={mode} />
		</div>
	);

};

// Export a memoized version of the component
export default memo( MainViewport );
