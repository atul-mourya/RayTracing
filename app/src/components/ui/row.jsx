import { MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const Row = ( { className, children, more, ...props } ) => {

	if ( more == null || more === false ) {

		return (
			<div className={cn( "flex items-center justify-between", className )} {...props}>
				{children}
			</div>
		);

	}

	return (
		<div className={cn( "flex items-center", className )} {...props}>
			<div className="flex-1 flex items-center justify-between min-w-0">
				{children}
			</div>
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label="More options"
						className="ml-1 inline-flex items-center justify-center h-5 w-4 shrink-0 text-muted-foreground hover:text-foreground focus:outline-none"
					>
						<MoreVertical size={12} />
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					sideOffset={8}
					className="w-64 p-3 rounded-lg bg-primary-foreground dark:bg-slate-800 text-foreground border border-white/30 space-y-3 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.6),0_20px_40px_-8px_rgba(0,0,0,0.4)] dark:shadow-[0_20px_30px_0_rgba(0,0,0,1),0_40px_60px_0_rgba(0,0,0,1),0_60px_100px_0_rgba(0,0,0,0.95),0_80px_140px_0_rgba(0,0,0,0.85)] dark:[&_.bg-input]:bg-slate-950 [&_.bg-input]:bg-slate-200"
				>
					{more}
				</PopoverContent>
			</Popover>
		</div>
	);

};

export { Row };
