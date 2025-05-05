import { memo } from 'react';
import { Check, X } from 'lucide-react';

const SaveControls = memo( ( { onSave, onDiscard } ) => {

	return (
		<div className="absolute top-2 right-2 flex space-x-2">
			<button
				onClick={onSave}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-primary/90 transition-all cursor-pointer"
			>
				<Check size={14} className="mr-1" /> Save
			</button>
			<button
				onClick={onDiscard}
				className="flex items-center bg-primary text-background text-xs px-3 py-1 rounded-full shadow-sm hover:bg-secondary/90 transition-all cursor-pointer"
			>
				<X size={14} className="mr-1" /> Ignore
			</button>
		</div>
	);

} );

SaveControls.displayName = 'SaveControls';

export default SaveControls;
