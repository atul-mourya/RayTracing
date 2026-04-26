import * as React from "react";

import { cn } from "@/lib/utils";

const Progress = React.forwardRef( ( { className, value, ...props }, ref ) => {

	const pct = Math.max( 0, Math.min( 100, value || 0 ) );

	return (
		<div
			ref={ref}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={pct}
			className={cn(
				"relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
				className
			)}
			{...props}>
			<div
				className="h-full w-full flex-1 bg-primary transition-all"
				style={{ transform: `translateX(-${100 - pct}%)` }} />
		</div>
	);

} );
Progress.displayName = "Progress";

export { Progress };
