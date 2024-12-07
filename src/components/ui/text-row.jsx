import { cn } from "@/lib/utils";

const TextRow = ( { className, ...props } ) => {

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<div className={cn( "relative flex h-5 w-full items-center max-w-32 opacity-50 text-xs truncate", className )}>
				{props.text}
			</div>
		</>
	);

};

export { TextRow };
