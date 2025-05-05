import { memo, useRef } from 'react';
import Viewport3D from './Viewport3D';

// MainViewport component now serves as a simple wrapper for Viewport3D
const MainViewport = ( { mode = "interactive" } ) => {

	// Reference to the Viewport3D component
	const viewport3DRef = useRef( null );

	console.log( 'MainViewport render' );

	return (
		<div className="w-full h-full relative">
			<Viewport3D
				ref={viewport3DRef}
				viewportMode={mode}
			/>
		</div>
	);

};

// Export a memoized version of the component
export default memo( MainViewport );
