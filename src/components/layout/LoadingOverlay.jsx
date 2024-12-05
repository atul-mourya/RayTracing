
import { Loader2 } from "lucide-react";
import { useStore } from '@/store';

const LoadingOverlay = () => {

	const isLoading = useStore( ( state ) => state.isLoading );

	if ( ! isLoading ) return null;

	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
			<div className="flex flex-col items-center space-y-4">
				<Loader2 className="h-8 w-8 animate-spin text-primary" />
				<p className="text-lg font-medium text-foreground">Loading...</p>
			</div>
		</div>
	);

};

export default LoadingOverlay;
