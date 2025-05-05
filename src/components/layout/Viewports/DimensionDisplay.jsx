import React from 'react';

const DimensionDisplay = ( { width, height, scale } ) => (
	<div className="absolute left-0 bottom-0 right-0 text-center z-10">
		<div className="text-xs text-background">
			{width} × {height} ({scale}%)
		</div>
	</div>
);

export default React.memo( DimensionDisplay );
