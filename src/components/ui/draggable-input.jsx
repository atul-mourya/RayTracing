import * as React from "react";
import { cn } from "@/lib/utils";

export function DraggableInput( {
	className,
	type,
	label,
	onValueChange,
	...props
} ) {

	const [ value, setValue ] = React.useState( props.value || props.defaultValue || 0 );
	const [ isDragging, setIsDragging ] = React.useState( false );
	const [ startX, setStartX ] = React.useState( 0 );
	const inputRef = React.useRef( null );

	const handleMouseDown = ( e ) => {

		setIsDragging( true );
		setStartX( e.clientX );

	};

	const handleMouseMove = ( e ) => {

		if ( ! isDragging ) return;

		const diff = e.clientX - startX;
		const newValue = Number( value ) + Math.round( diff / 5 );
		updateValue( newValue );
		setStartX( e.clientX );

	};

	const handleMouseUp = () => {

		setIsDragging( false );

	};

	const updateValue = ( newValue ) => {

		const clampedValue = Math.max( Number( props.min || 0 ), Math.min( Number( props.max || 100 ), newValue ) );
		setValue( clampedValue );
		onValueChange?.( clampedValue );

	};

	React.useEffect( () => {

		if ( isDragging ) {

			window.addEventListener( 'mousemove', handleMouseMove );
			window.addEventListener( 'mouseup', handleMouseUp );

		}

		return () => {

			window.removeEventListener( 'mousemove', handleMouseMove );
			window.removeEventListener( 'mouseup', handleMouseUp );

		};

	}, [ isDragging ] );

	return (
		<>
			{label && <span className="opacity-50 text-xs truncate mb-1">{label}</span>}
			<input
				type={type || "number"}
				className={cn(
					"flex h-5 w-full max-w-28 px-3 text-right rounded-full border border-input bg-primary/20 text-xs shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
					isDragging && "cursor-ew-resize",
					className
				)}
				ref={inputRef}
				value={value}
				onChange={( e ) => updateValue( Number( e.target.value ) )}
				onMouseDown={handleMouseDown}
				{...props} />
		</>
	);

}

DraggableInput.displayName = "DraggableInput";

