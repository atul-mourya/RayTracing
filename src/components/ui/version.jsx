import React from 'react';

export function Version( { className = "" } ) {

	return (
		<div className={`text-xs text-muted-foreground ${className}`}>
      v{__APP_VERSION__}
		</div>
	);

}
