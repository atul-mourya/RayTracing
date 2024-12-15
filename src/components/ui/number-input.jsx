import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from "@/lib/utils";

export function NumberInput( {
	className = '',
	onValueChange,
	min = 0,
	max = 100,
	step = 1,
	...props
} ) {

	const [ isPressed, setIsPressed ] = useState( false );
	const [ arrowLength, setArrowLength ] = useState( 0 );
	const [ value, setValue ] = useState( props.value || min );
	const containerRef = useRef( null );
	const startXRef = useRef( 0 );
	const startValueRef = useRef( 0 );

	// Scale factor to convert pixels to value units
	const getScaleFactor = () => {

		const range = max - min;
		const maxPixels = 200; // Maximum pixels for full range
		return range / maxPixels;

	};

	const clampValue = ( val ) => {

		return Math.min( max, Math.max( min, Math.round( val / step ) * step ) );

	};

	const handleChange = ( event ) => {

		const newValue = clampValue( event.target.valueAsNumber );
		if ( ! isNaN( newValue ) ) {

			setValue( newValue );
			onValueChange?.( newValue );
			// Update arrow length based on value
			const scaleFactor = getScaleFactor();
			setArrowLength( ( newValue - min ) / scaleFactor );

		}

	};

	const handlePointerDown = ( event ) => {

		event.stopPropagation();
		setIsPressed( true );
		startXRef.current = event.clientX;
		startValueRef.current = value;

		const handlePointerMove = ( moveEvent ) => {

			const deltaX = moveEvent.clientX - startXRef.current;
			setArrowLength( deltaX );

			// Convert pixel movement to value change
			const scaleFactor = getScaleFactor();
			const newValue = clampValue( startValueRef.current + ( deltaX * scaleFactor ) );
			setValue( newValue );
			onValueChange?.( newValue );

		};

		const handlePointerUp = () => {

			setIsPressed( false );
			setArrowLength( 0 );
			window.removeEventListener( 'pointermove', handlePointerMove );
			window.removeEventListener( 'pointerup', handlePointerUp );

		};

		window.addEventListener( 'pointermove', handlePointerMove );
		window.addEventListener( 'pointerup', handlePointerUp );

	};

	// Initialize arrow length based on initial value
	useEffect( () => {

		if ( props.value !== undefined ) {

			setArrowLength( isPressed ? arrowLength : 0 );
			setValue( props.value );

		}

	}, [ props.value, min, max, isPressed ] );

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<div className={cn( "relative flex h-5 w-full select-none items-center max-w-28 cursor-ew-resize", className )} ref={containerRef}>
				<div
					className={cn(
						"absolute left-1 h-4 w-1 bg-primary hover:bg-primary/50 cursor-pointer rounded-full transition-all duration-150",
						{ 'h-1': isPressed }
					)}
					onPointerDown={handlePointerDown}
					aria-hidden="true"
				/>
				{isPressed && arrowLength !== 0 && (
					<svg
						className="absolute top-1/2 left-2 -translate-y-1/2 pointer-events-none select-none"
						width={Math.abs( arrowLength )}
						height="20"
						viewBox={`0 0 ${Math.abs( arrowLength )} 20`}
					>
						<line
							x1={arrowLength > 0 ? 0 : Math.abs( arrowLength )}
							y1={10}
							x2={arrowLength > 0 ? Math.abs( arrowLength ) - 5 : 5}
							y2={10}
							strokeWidth={1}
							strokeDasharray="1 2" // Updated to create an array of dots
							className="stroke-primary"
						/>
						<path
							d={arrowLength > 0
								? `M${Math.abs( arrowLength - 1 ) - 3.5},7.5 L${Math.abs( arrowLength - 1 )},10 L${Math.abs( arrowLength - 1 ) - 3.5},12.5`
								: `M3.5,7.5 L0,10 L3.5,12.5`}
							fill="none"
							strokeWidth={1}
							className="stroke-primary fill-none"
						/>
						<line
							x1={arrowLength > 0 ? Math.abs( arrowLength ) : 0}
							y1={5}
							x2={arrowLength > 0 ? Math.abs( arrowLength ) : 0}
							y2={15}
							strokeWidth={1}
							className='stroke-primary'
						/>
					</svg>
				)}
				<Input
					type="number"
					className={`pl-4 h-full rounded-full text-xs bg-primary/20 text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${className}`}
					onChange={handleChange}
					value={value}
					min={min}
					max={max}
					step={step}
					{...props}
				/>
			</div>
		</>
	);

}

export default NumberInput;
