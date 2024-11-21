import { useState, useRef, useEffect } from 'react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Paintbrush } from "lucide-react";
import { cn } from "@/lib/utils";

const ColorInput = ( { onChange, className, value, ...props } ) => {

	const [ color, setColor ] = useState( value || "#000000" );
	const colorInputRef = useRef( null );

	useEffect( () => {

		setColor( value );

	}, [ value ] );

	const handleChange = ( event ) => {

		const newColor = event.target.value;
		setColor( newColor );
		if ( onChange ) onChange( newColor );

	};

	const openColorPicker = () => {

		colorInputRef.current.click();

	};

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<div className={cn( "relative flex h-5 w-full touch-none select-none items-center max-w-32", className )}>
				<div className="relative h-full w-full grow overflow-hidden rounded-full bg-primary/20">
					<Input
						type="text"
						value={color}
						onChange={handleChange}
						className="absolute h-full bg-primary pl-8 pr-10 rounded-full"
					/>
					<span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
						#
					</span>
					<div
						className="absolute left-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full cursor-pointer"
						style={{ backgroundColor: color }}
					/>
					<Button
						variant="ghost"
						size="icon"
						className="h-full w-8 absolute right-0 top-0"
						onClick={openColorPicker}
					>
						<Paintbrush className="h-4 w-4" />
					</Button>
				</div>
				<input
					ref={colorInputRef}
					type="color"
					value={color}
					onChange={handleChange}
					className="sr-only bottom-0"
				/>
			</div>
		</>
	);

};

export { ColorInput };
