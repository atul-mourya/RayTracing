import React from 'react';
import { Upload } from 'lucide-react';

const DropzoneOverlay = ( { isActive } ) => {

	if ( ! isActive ) return null;

	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-xs">
			<div className="flex flex-col items-center space-y-4">
				<Upload className="h-16 w-16 text-primary" />
				<p className="text-xl font-medium text-foreground">Drop GLB model or HDR environment</p>
			</div>
		</div>
	);

};

export default React.memo( DropzoneOverlay );
