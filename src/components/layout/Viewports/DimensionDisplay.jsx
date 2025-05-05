import React, { useEffect, useState } from 'react';

const DimensionDisplay = ( { canvasRef, scale } ) => {

	const [ value, setValue ] = useState( {
		dimensions: { width: 512, height: 512 }
	} );
	const { width, height } = value.dimensions;

	useEffect( () => {

		const updateDimensions = () => {

			if ( canvasRef.current ) {

				const { width, height } = canvasRef.current;
				setValue( prev => ( { ...prev, dimensions: { width, height } } ) );

			}

		};

		window.addEventListener( 'resolution_changed', updateDimensions );
		return () => {

			window.removeEventListener( 'resolution_changed', updateDimensions );

		};

	}, [] );

	return (
		<div className="absolute left-0 bottom-0 right-0 text-center z-10">
			<div className="text-xs text-background">
				{width} × {height} ({scale}%)
			</div>
		</div>

	);

};

export default React.memo( DimensionDisplay );
