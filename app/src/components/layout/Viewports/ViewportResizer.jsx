import React, { useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

const ViewportResizer = ( { onResize } ) => {

	const [ size, setSize ] = useState( 100 );

	const handleSizeChange = ( newSize ) => {

		setSize( newSize[ 0 ] );
		onResize( newSize[ 0 ] );

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
		<div className="flex items-center space-x-2 bg-background/80 backdrop-blur px-3 py-1 rounded border border-border/50">

			<Button
				onClick={handleReset}
				variant="ghost"
				size="icon"
				className="h-6 w-6 p-0 hover:bg-muted/80"
			>
				<RotateCcw size={14} className="text-foreground/70" />
			</Button>

			<div className="w-px h-4 bg-border mx-1"></div>

			<Button
				onClick={handleZoomOut}
				variant="ghost"
				size="icon"
				className="h-6 w-6 p-0 hover:bg-muted/80"
			>
				<ZoomOut size={14} className="text-foreground/70" />
			</Button>

			<div className="relative w-24 flex items-center">
				<Slider
					value={[ size ]}
					min={25}
					max={200}
					step={5}
					onValueChange={handleSizeChange}
					className="w-full"
				/>
			</div>

			<Button
				onClick={handleZoomIn}
				variant="ghost"
				size="icon"
				className="h-6 w-6 p-0 hover:bg-muted/80"
			>
				<ZoomIn size={14} className="text-foreground/70" />
			</Button>
		</div>
	);

};

export default React.memo( ViewportResizer );
