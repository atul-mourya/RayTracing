import React from 'react';

const DimensionDisplay = ( { dimension } ) => {

	const { width, height } = dimension;

	return (
		<div className="absolute left-0 bottom-2 right-0 text-center z-10 pointer-events-none">
			<div className="inline-block text-xs text-foreground bg-background/50 px-2 py-0.5 rounded">
				{width} × {height}
			</div>
		</div>

	);

};

export default React.memo( DimensionDisplay );
