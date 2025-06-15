import { useState } from "react";
import { DraggableInput } from "./draggable-input"; // Import the DraggableInput component

const Vector3Component = ( {
	onValueChange,
	min = - Infinity,
	max = Infinity,
	step = 0.1,
	precision = 1,
	dragSensitivity = 1,
	...props
} ) => {

	const [ vector, setVector ] = useState( props.value || [ 0, 0, 0 ] );

	// Handle component change
	const handleComponentChange = ( index ) => ( value ) => {

		const newVector = [ ...vector ];
		newVector[ index ] = value;

		setVector( newVector );

		if ( onValueChange ) {

			onValueChange( newVector );

		}

	};

	// Define label components with colors
	const XLabel = () => <div className="text-xs text-red-500">X</div>;
	const YLabel = () => <div className="text-xs text-green-500">Y</div>;
	const ZLabel = () => <div className="text-xs text-blue-500">Z</div>;

	return (
		<>
			<div className="opacity-50 text-xs truncate">{props.label}</div>
			<div className="flex space-x-1.5 items-center justify-between">
				{/* X component */}
				<DraggableInput
					className="w-14"
					value={vector[ 0 ]}
					onChange={handleComponentChange( 0 )}
					min={min}
					max={max}
					step={step}
					precision={precision}
					dragSensitivity={dragSensitivity}
					icon={XLabel}
				/>

				{/* Y component */}
				<DraggableInput
					className="w-14"
					value={vector[ 1 ]}
					onChange={handleComponentChange( 1 )}
					min={min}
					max={max}
					step={step}
					precision={precision}
					dragSensitivity={dragSensitivity}
					icon={YLabel}
				/>

				{/* Z component */}
				<DraggableInput
					className="w-14"
					value={vector[ 2 ]}
					onChange={handleComponentChange( 2 )}
					min={min}
					max={max}
					step={step}
					precision={precision}
					dragSensitivity={dragSensitivity}
					icon={ZLabel}
				/>
			</div>
		</>
	);

};

export { Vector3Component };
