import React, { useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";



const ViewportResizer = ( { onResize } ) => {

	const [ size, setSize ] = useState( 100 );

	const handleSizeChange = ( e ) => {

		const newSize = parseInt( e.target.value );
		setSize( newSize );
		onResize( newSize );

	};

	const handleZoomIn = () => {

		const newSize = Math.min( size + 25, 200 );
		setSize( newSize );
		onResize( newSize );

	};

	const handleZoomOut = () => {

		const newSize = Math.max( size - 25, 25 );
		setSize( newSize );
		onResize( newSize );

	};

	const handleReset = () => {

		setSize( 100 );
		onResize( 100 );

	};

	return (
		<div className="flex items-center space-x-2 bg-background/80 backdrop-blur-sm px-3 py-1 rounded border border-border/50">

			<div className="text-xs font-medium w-10 text-center">
				{size}%
			</div>

			<button onClick={handleReset} className="p-1 hover:bg-muted rounded">
				<RotateCcw size={12} className="bg-transparent border-white text-forground/50" />
			</button>

			<div className="w-px h-4 bg-border mx-1"></div>

			<button onClick={handleZoomOut} className="p-1 hover:bg-muted rounded">
				<ZoomOut size={12} className="bg-transparent border-white text-forground/50" />
			</button>

			<input
				type="range"
				min="25"
				max="200"
				step="5"
				value={size}
				onChange={handleSizeChange}
				className="w-24 h-1 bg-muted rounded-lg appearance-none cursor-pointer"
			/>

			<button onClick={handleZoomIn} className="p-1 hover:bg-muted rounded">
				<ZoomIn size={12} className="bg-transparent border-white text-forground/50"/>
			</button>

		</div>
	);

};

export default React.memo( ViewportResizer );
