import { useStore } from '@/store';
import { useEffect, useState, useRef } from 'react';
import { getAllRenders } from '@/utils/database';

const Results = () => {

	const appMode = useStore( state => state.appMode );
	const setSelectedResult = useStore( state => state.setSelectedResult );
	const [ renderedImages, setRenderedImages ] = useState( [] );
	const [ loading, setLoading ] = useState( true );
	const [ error, setError ] = useState( null );
	const [ selectedImage, setSelectedImage ] = useState( null );
	const fetchingRef = useRef( false );
	const isResultsTab = appMode === 'results';
	const initialLoadRef = useRef( true );

	const fetchImages = async () => {

		if ( fetchingRef.current ) return;

		try {

			fetchingRef.current = true;
			setLoading( true );
			setError( null );

			const images = await getAllRenders();
			setRenderedImages( images );

			// Auto-select the first image if available and none selected
			if ( images.length > 0 && selectedImage === null ) {

				setSelectedImage( 0 );
				if ( isResultsTab ) {

					setSelectedResult( images[ 0 ].image );

				}

			}

		} catch ( error ) {

			console.error( 'Error fetching images:', error );
			setError( error.message );

		} finally {

			setLoading( false );
			fetchingRef.current = false;

		}

	};

	// Initial fetch and set up event listeners
	useEffect( () => {

		const initialFetchTimer = setTimeout( () => {

			fetchImages();

		}, 500 );

		const handleRenderSaved = () => {

			// Debounce the fetch to avoid rapid state updates
			setTimeout( () => {

				if ( ! fetchingRef.current ) {

					fetchImages();

				}

			}, 100 );

		};

		window.addEventListener( 'render-saved', handleRenderSaved );

		return () => {

			clearTimeout( initialFetchTimer );
			window.removeEventListener( 'render-saved', handleRenderSaved );

		};

	}, [] );

	// Additional effect for appMode changes - with safeguards
	useEffect( () => {

		// Only fetch images once per mode change, not on every render
		if ( appMode !== 'interactive' && ! fetchingRef.current ) {

			fetchImages();

		}

		// When first switching to results tab and we have images, select the currently selected image
		if ( appMode === 'results' && selectedImage !== null && renderedImages.length > 0 ) {

			// Set the selected result only if not already set to reduce renders
			setSelectedResult( renderedImages[ selectedImage ].image );

		}

	}, [ appMode ] );

	// Handle selected image change
	useEffect( () => {

		if ( selectedImage !== null && renderedImages.length > 0 && isResultsTab ) {

			setSelectedResult( renderedImages[ selectedImage ].image );

		}

	}, [ selectedImage, isResultsTab ] );

	// Format date to a cleaner format
	const formatDate = ( dateString ) => {

		const date = new Date( dateString );
		return date.toLocaleString( undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		} );

	};

	return (
		<div className="h-full flex flex-col bg-slate-900 text-gray-200">
			<div className="p-3 border-b border-slate-700">
				<h2 className="text-sm font-semibold text-white">Saved Renders</h2>
				{! loading && ! error && renderedImages.length > 0 && (
					<p className="text-xs text-gray-400 mt-1">
						Showing {renderedImages.length} render{renderedImages.length !== 1 ? 's' : ''}
					</p>
				)}
			</div>

			{loading && (
				<div className="flex items-center justify-center h-16 text-sm text-gray-400">
					Loading saved renders...
				</div>
			)}

			{error && (
				<div className="p-3 text-sm text-red-400">
					Error: {error}
				</div>
			)}

			{! loading && ! error && renderedImages.length === 0 && (
				<div className="p-3 text-sm text-gray-400">
					No rendered images available
				</div>
			)}

			{! loading && ! error && renderedImages.length > 0 && (
				<div className="flex-1 overflow-y-auto custom-scrollbar">
					<div className="flex flex-col gap-2 p-2">
						{renderedImages.map( ( image, index ) => (
							<div
								key={index}
								className={`relative overflow-hidden rounded-md ${
									selectedImage === index ? 'ring-2 ring-blue-500' : ''
								}`}
								onClick={() => {

									setSelectedImage( index );
									// Only update the store if we're in results tab to avoid unnecessary renders
									if ( isResultsTab ) {

										setSelectedResult( image.image );

									}

								}}
							>
								<div className="flex items-center">
									<div className="relative h-16 w-16 bg-slate-800 overflow-hidden">
										<img
											src={image.image}
											alt={`Render ${index}`}
											className="w-full h-full object-cover"
											onError={( e ) => {

												e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23374151"/%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23F9FAFB"%3EImage Error%3C/text%3E%3C/svg%3E';

											}}
										/>
									</div>
									<div className="p-2 flex-1 bg-slate-800 text-xs h-16">
										<div className="font-medium text-white truncate">
											Saved on: {formatDate( image.timestamp )}
										</div>
									</div>
								</div>
							</div>
						) )}
					</div>
				</div>
			)}
		</div>
	);

};

export default Results;
