import React from 'react';
import { Loader2 } from "lucide-react";
import { useStore } from '@/store';
import { Progress } from "@/components/ui/progress";

const LoadingOverlay = ( {
	showProgress = true,
	showStatus = true
} ) => {

	const loading = useStore( ( state ) => state.loading );

	if ( ! loading.isLoading ) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
			<div className="relative flex flex-col items-center space-y-6 p-6 rounded-lg bg-card shadow-lg">
				<div className="relative">
					<div className="absolute -inset-1 bg-gradient-to-r from-primary to-primary-foreground opacity-75 blur-lg" />
					<Loader2 className="relative h-12 w-12 animate-spin text-primary" />
				</div>

				<div className="flex flex-col items-center gap-4">
					<p className="text-xl font-semibold text-foreground animate-pulse">
						{loading.title || 'Loading...'}
					</p>

					{showStatus && loading.status && (
						<p className="text-sm text-muted-foreground text-center max-w-xs">
							{loading.status}
						</p>
					)}

					{showProgress && loading.progress > 0 && (
						<div className="w-64">
							<Progress value={loading.progress} className="h-2" />
							<p className="text-xs text-muted-foreground text-center mt-2">
								{loading.progress}%
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);

};

export default LoadingOverlay;
