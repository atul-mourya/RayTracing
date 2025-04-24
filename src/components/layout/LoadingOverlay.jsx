import React, { useState, useEffect } from 'react';
import { Loader2 } from "lucide-react";
import { useStore } from '@/store';
import { Progress } from "@/components/ui/progress";

const LoadingOverlay = ( {
	showProgress = true,
	showStatus = true
} ) => {

	const loading = useStore( ( state ) => state.loading );
	const [ progressAnimation, setProgressAnimation ] = useState( 0 );

	// Smoothly animate progress
	useEffect( () => {

		if ( loading.isLoading && loading.progress > progressAnimation ) {

			const timer = setTimeout( () => {

				setProgressAnimation( prev => Math.min( prev + 1, loading.progress ) );

			}, 20 );
			return () => clearTimeout( timer );

		} else if ( ! loading.isLoading ) {

			setProgressAnimation( 0 );

		}

	}, [ progressAnimation, loading.isLoading, loading.progress ] );

	// Calculate time elapsed since loading started
	const [ elapsedTime, setElapsedTime ] = useState( 0 );

	useEffect( () => {

		let intervalId;

		if ( loading.isLoading ) {

			const startTime = Date.now();
			intervalId = setInterval( () => {

				setElapsedTime( Math.floor( ( Date.now() - startTime ) / 1000 ) );

			}, 1000 );

		} else {

			setElapsedTime( 0 );

		}

		return () => {

			if ( intervalId ) clearInterval( intervalId );

		};

	}, [ loading.isLoading ] );

	// Format elapsed time in MM:SS format
	const formatElapsedTime = ( seconds ) => {

		const mins = Math.floor( seconds / 60 );
		const secs = seconds % 60;
		return `${mins.toString().padStart( 2, '0' )}:${secs.toString().padStart( 2, '0' )}`;

	};

	if ( ! loading.isLoading ) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div className="absolute inset-0 bg-background/80 backdrop-blur-xs" />
			<div className="relative flex flex-col items-center space-y-6 p-6 rounded-lg bg-card shadow-lg">
				<div className="relative">
					<div className="absolute -inset-1 bg-linear-to-r from-primary to-primary-foreground opacity-75 blur-lg" />
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
							<Progress value={progressAnimation} className="h-2" />
							<div className="flex justify-between text-xs text-muted-foreground mt-2 w-full">
								<p>{progressAnimation}%</p>
								<p>Time: {formatElapsedTime( elapsedTime )}</p>
							</div>
						</div>
					)}

					{/* Show estimated time remaining for BVH building */}
					{loading.status && loading.status.includes( 'Building BVH' ) && (
						<p className="text-xs text-muted-foreground mt-1">
							{loading.progress < 100
								? "This may take a while for large models..."
								: "Almost done..."}
						</p>
					)}
				</div>
			</div>
		</div>
	);

};

export default LoadingOverlay;
