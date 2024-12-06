import React, { useRef, useEffect, useState, useCallback } from 'react';
import PathTracerApp from '../../core/main';
import { Upload } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import LoadingOverlay from './LoadingOverlay';

const Viewport3D = ( { onStatsUpdate } ) => {

	const { toast } = useToast();
	const containerRef = useRef( null );
	const appRef = useRef( null );
	const setLoading = useStore( ( state ) => state.setLoading );
	const [ isDragging, setIsDragging ] = useState( false );

	useEffect( () => {

		if ( appRef.current ) return;

		if ( containerRef.current ) {

			appRef.current = new PathTracerApp( containerRef.current );
			window.pathTracerApp = appRef.current;
			appRef.current.setOnStatsUpdate( onStatsUpdate );

			setLoading( { isLoading: true, title: "Starting", status: "Setting up Scene...", progress: 0 } );
			appRef.current.init().catch( ( err ) => {

				console.error( "Error initializing PathTracerApp:", err );
				toast( {
					title: "Failed to load application",
					description: "Uh oh!! Something went wrong. Please try again.",
					variant: "destructive",
				} );

			} ).finally( () => {

				setLoading( { isLoading: true, title: "Starting", status: "Setting up Complete !", progress: 100 } );
				setTimeout( () => useStore.getState().resetLoading(), 1000 );
				window.pathTracerApp.reset();

			} );

		}

	}, [ onStatsUpdate, setLoading, toast ] );

	const handleDragOver = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( true );

	}, [] );

	const handleDragLeave = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

	}, [] );

	const handleDrop = useCallback( ( e ) => {

		e.preventDefault();
		setIsDragging( false );

		const file = e.dataTransfer.files[ 0 ];
		if ( file && file.name.toLowerCase().endsWith( '.glb' ) ) {

			setLoading( { isLoading: true, title: "Loading", status: "Processing Model...", progress: 0 } );
			const reader = new FileReader();
			reader.onload = ( event ) => {

				const arrayBuffer = event.target.result;
				if ( appRef.current && appRef.current.loadGLBFromArrayBuffer ) {

					appRef.current.loadGLBFromArrayBuffer( arrayBuffer )
						.then( () => {

							toast( {
								title: "Model Loaded",
								description: `Successfully loaded model !!`,
							} );

						} )
						.catch( ( err ) => {

							console.error( "Error loading GLB file:", err );
							toast( {
								title: "Failed to load GLB file",
								description: "Please try again.",
								variant: "destructive",
							} );

						} ).finally( () => {

							setLoading( { isLoading: true, title: "Loading", status: "Loading Complete !", progress: 100 } );
							setTimeout( () => useStore.getState().resetLoading(), 1000 );

						} );

				}

			};

			reader.readAsArrayBuffer( file );

		} else {

			toast( {
				title: "Invalid File",
				description: "Please drop a valid GLB file.",
				variant: "destructive",
			} );

		}

	}, [ setLoading, toast ] );

	return (
		<div
			className={`relative w-full h-full ${isDragging ? 'bg-primary/10' : ''}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div ref={containerRef} className="w-full h-full" />
			<Toaster />
			<LoadingOverlay />
			{isDragging && (
				<div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
					<div className="flex flex-col items-center space-y-4">
						<Upload className="h-16 w-16 text-primary" />
						<p className="text-xl font-medium text-foreground">Drop GLB file here</p>
					</div>
				</div>
			)}
		</div>
	);

};

export default React.memo( Viewport3D );
