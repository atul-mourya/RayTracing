import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn( ...inputs ) {

	return twMerge( clsx( inputs ) );

}

// remap a value from one range to another
export function remap( value, fromLow, fromHigh, toLow, toHigh ) {

	return toLow + ( value - fromLow ) * ( toHigh - toLow ) / ( fromHigh - fromLow );

}
