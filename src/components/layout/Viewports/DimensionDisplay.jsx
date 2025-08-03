import React from 'react';

const DimensionDisplay = ( { dimension } ) => {

	const { width, height } = dimension || { width: 512, height: 512 };

	return (
		<div className="absolute left-0 bottom-0 right-0 text-center z-10">
			<div className="text-xs text-background">
				{width} × {height}
			</div>
		</div>

	);

};

export default React.memo( DimensionDisplay );
