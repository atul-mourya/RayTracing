import { useStore } from '@/store';
import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { getAllRenders, deleteRender } from '@/utils/database';
import { Calendar, Clock, Trash2, AlertTriangle } from 'lucide-react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Create a context ID to avoid duplicate instances
const INSTANCE_ID = Math.random().toString( 36 ).substring( 2, 9 );

// Using React.memo to prevent unnecessary re-renders from parent components
const Results = memo( () => {

	console.log( `Results component mounted (instance: ${INSTANCE_ID})` ); // Debug mount with instance ID

	// Use selective, stable subscriptions to Zustand store
	const appMode = useStore( state => state.appMode );
	const setSelectedResult = useStore( state => state.setSelectedResult );

	// State with initialization to reduce initial renders
	const [ state, setState ] = useState( {
		renderedImages: [],
		loading: true,
		error: null,
		selectedImageIndex: null,
		isFetching: false,
		deleteDialogOpen: false,
		renderToDelete: null,
		isDeleting: false
	} );

	// Extract state variables for readability
	const {
		renderedImages,
		loading,
		error,
		selectedImageIndex,
		isFetching,
		deleteDialogOpen,
		renderToDelete,
		isDeleting
	} = state;

	// Stable setter functions that don't change on re-render
	const updateState = useCallback( ( newState ) => {

		setState( current => ( { ...current, ...newState } ) );

	}, [] );

	// Determine if we're in the results tab - as a ref to avoid re-renders
	const isResultsTabRef = useRef( appMode === 'results' );

	// Track component mounted status to prevent updates after unmount
	const isMountedRef = useRef( true );

	// Set up mount/unmount tracking
	useEffect( () => {

		isMountedRef.current = true;

		return () => {

			console.log( `Results component unmounting (instance: ${INSTANCE_ID})` );
			isMountedRef.current = false;

		};

	}, [] );

	// Update the ref when appMode changes to keep it current
	useEffect( () => {

		if ( ! isMountedRef.current ) return;

		isResultsTabRef.current = appMode === 'results';

		// If switching to results tab, ensure we fetch data
		if ( appMode === 'results' && ! isFetching && renderedImages.length === 0 ) {

			fetchImages();

		}

	}, [ appMode, isFetching, renderedImages.length ] );

	// Memoize fetchImages with minimal dependencies
	const fetchImages = useCallback( async () => {

		// Prevent duplicate fetches
		if ( isFetching || ! isMountedRef.current ) return;

		try {

			console.log( `Fetching images (instance: ${INSTANCE_ID})` );
			updateState( { isFetching: true, loading: true, error: null } );

			const images = await getAllRenders();

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) {

				console.log( `Component unmounted during fetch, aborting (instance: ${INSTANCE_ID})` );
				return;

			}

			updateState( {
				renderedImages: images,
				loading: false,
				isFetching: false
			} );

			// Auto-select the first image if available and none selected
			if ( images.length > 0 && selectedImageIndex === null ) {

				updateState( { selectedImageIndex: 0 } );

				// Only update selected result if we're in results tab
				if ( isResultsTabRef.current ) {

					setSelectedResult( images[ 0 ] );

				}

			}

		} catch ( err ) {

			console.error( `Error fetching images (instance: ${INSTANCE_ID}):`, err );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			updateState( {
				error: err.message,
				loading: false,
				isFetching: false
			} );

		}

	}, [ selectedImageIndex, setSelectedResult, updateState ] );

	// Initial fetch - only run once using a ref flag
	const hasInitializedRef = useRef( false );
	useEffect( () => {

		if ( hasInitializedRef.current || ! isMountedRef.current ) return;

		hasInitializedRef.current = true;
		console.log( `Initial fetch triggered (instance: ${INSTANCE_ID})` );

		const initialFetchTimer = setTimeout( () => {

			if ( isMountedRef.current ) {

				fetchImages();

			}

		}, 500 );

		return () => clearTimeout( initialFetchTimer );

	}, [ fetchImages ] );

	// Set up event listeners for render-saved events - with cleanup
	useEffect( () => {

		if ( ! isMountedRef.current ) return;

		console.log( `Setting up render-saved event listener (instance: ${INSTANCE_ID})` );

		// Create a named handler for proper cleanup
		const handleRenderSaved = () => {

			console.log( `render-saved event received (instance: ${INSTANCE_ID})` );

			// If already fetching or component unmounted, don't queue another fetch
			if ( isFetching || ! isMountedRef.current ) return;

			// Use a ref to track the timeout for proper cleanup
			const timeoutRef = { current: null };

			timeoutRef.current = setTimeout( () => {

				if ( isMountedRef.current ) {

					fetchImages();

				}

			}, 100 );

		};

		window.addEventListener( 'render-saved', handleRenderSaved );

		// Clean up on unmount
		return () => {

			console.log( `Cleaning up render-saved event listener (instance: ${INSTANCE_ID})` );
			window.removeEventListener( 'render-saved', handleRenderSaved );

		};

	}, [ fetchImages, isFetching ] );

	// Handle selected image change
	useEffect( () => {

		if ( ! isMountedRef.current ) return;

		if ( selectedImageIndex !== null &&
			renderedImages.length > 0 &&
			isResultsTabRef.current ) {

			console.log( `Updating selected result (instance: ${INSTANCE_ID})` );
			setSelectedResult( renderedImages[ selectedImageIndex ] );

		}

	}, [ selectedImageIndex, renderedImages, setSelectedResult ] );

	// Handle image selection with stable reference
	const handleImageSelect = useCallback( ( index ) => {

		if ( ! isMountedRef.current ) return;

		console.log( `Image ${index} selected (instance: ${INSTANCE_ID})` );
		updateState( { selectedImageIndex: index } );

		if ( isResultsTabRef.current && renderedImages[ index ] ) {

			setSelectedResult( renderedImages[ index ] );

		}

	}, [ renderedImages, setSelectedResult, updateState ] );

	// Format date with stable reference
	const formatDate = useCallback( ( dateString ) => {

		const date = new Date( dateString );
		return {
			date: date.toLocaleDateString( undefined, {
				day: 'numeric',
				month: 'short',
				year: 'numeric'
			} ),
			time: date.toLocaleTimeString( undefined, {
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			} )
		};

	}, [] );

	// Handle image error with stable reference
	const handleImageError = useCallback( ( e ) => {

		e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23374151"/%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23F9FAFB"%3EImage Error%3C/text%3E%3C/svg%3E';

	}, [] );

	// --------- DELETE FUNCTIONALITY ---------

	// Handle opening the delete confirmation dialog
	const handleDeleteClick = useCallback( ( e, image, index ) => {

		e.stopPropagation(); // Prevent selecting the image when clicking delete

		if ( ! isMountedRef.current ) return;

		updateState( {
			deleteDialogOpen: true,
			renderToDelete: { image, index }
		} );

	}, [ updateState ] );

	// Handle confirming deletion
	const handleConfirmDelete = useCallback( async () => {

		if ( ! renderToDelete || ! renderToDelete.image || ! isMountedRef.current ) return;

		try {

			updateState( { isDeleting: true } );

			// Call the database function to delete the render
			await deleteRender( renderToDelete.image.id );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			// Force a refresh from the database to ensure consistency
			const freshImages = await getAllRenders();

			if ( ! isMountedRef.current ) return;

			// Calculate the new selected index
			let newSelectedIndex = selectedImageIndex;
			if ( freshImages.length === 0 ) {

				newSelectedIndex = null;

			} else if ( selectedImageIndex === renderToDelete.index ) {

				// If the deleted image was selected, select the next one or the last one
				newSelectedIndex = Math.min( selectedImageIndex, freshImages.length - 1 );
				// Update the selected result if we're in results tab
				if ( isResultsTabRef.current && freshImages[ newSelectedIndex ] ) {

					setSelectedResult( freshImages[ newSelectedIndex ] );

				}

			} else if ( selectedImageIndex > renderToDelete.index ) {

				// If the selected index is after the deleted one, decrement it
				newSelectedIndex = selectedImageIndex - 1;

			}

			// Update the complete state with fresh data
			updateState( {
				renderedImages: freshImages,
				selectedImageIndex: newSelectedIndex,
				deleteDialogOpen: false,
				renderToDelete: null,
				isDeleting: false
			} );

		} catch ( error ) {

			console.error( 'Error deleting render:', error );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			updateState( {
				error: `Failed to delete: ${error.message}`,
				isDeleting: false,
				deleteDialogOpen: false,
				renderToDelete: null
			} );

			// Trigger a refresh to ensure database and UI are in sync
			setTimeout( () => {

				if ( isMountedRef.current ) {

					fetchImages();

				}

			}, 500 );

		}

	}, [ renderToDelete, selectedImageIndex, setSelectedResult, updateState, fetchImages ] );

	// Handle canceling deletion
	const handleCancelDelete = useCallback( () => {

		if ( ! isMountedRef.current ) return;

		updateState( {
			deleteDialogOpen: false,
			renderToDelete: null
		} );

	}, [ updateState ] );

	return (
		<div className="h-full flex flex-col bg-slate-900 text-gray-200">
			{/* Delete Confirmation Dialog */}
			<AlertDialog open={deleteDialogOpen} onOpenChange={handleCancelDelete}>
				<AlertDialogContent className="bg-slate-800 border border-slate-700 text-gray-200">
					<AlertDialogHeader>
						<AlertDialogTitle className="text-white flex items-center gap-2">
							<AlertTriangle size={18} className="text-red-400" />
							Confirm Deletion
						</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete this render? This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							className="bg-transparent border border-slate-600 hover:bg-slate-700 text-gray-300"
							disabled={isDeleting}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							className="bg-red-500 hover:bg-red-600 text-white"
							onClick={handleConfirmDelete}
							disabled={isDeleting}
						>
							{isDeleting ? (
								<>
									<div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
									Deleting...
								</>
							) : (
								'Delete'
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<div className="p-4 border-b border-slate-700 bg-slate-800">
				<h2 className="text-lg font-semibold text-white">Saved Renders</h2>
				{! loading && ! error && renderedImages.length > 0 && (
					<p className="text-xs text-gray-400 mt-1">
						Showing {renderedImages.length} render{renderedImages.length !== 1 ? 's' : ''}
					</p>
				)}
			</div>

			{loading && (
				<div className="flex-1 flex items-center justify-center text-sm text-gray-400">
					<div className="flex flex-col items-center space-y-2">
						<div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full"></div>
						<span>Loading saved renders...</span>
					</div>
				</div>
			)}

			{error && (
				<div className="p-4 m-3 text-sm text-red-400 bg-red-900/20 rounded-md border border-red-800">
					<div className="font-medium mb-1">Error loading renders</div>
					{error}
				</div>
			)}

			{! loading && ! error && renderedImages.length === 0 && (
				<div className="flex-1 flex items-center justify-center p-4 text-sm text-gray-400">
					<div className="text-center">
						<div className="text-4xl mb-3">📷</div>
						<div className="font-medium">No rendered images available</div>
						<p className="text-xs mt-2 max-w-xs">Complete a render in the &quot;Final Render&quot; tab to see results here</p>
					</div>
				</div>
			)}

			{! loading && ! error && renderedImages.length > 0 && (
				<div className="flex-1 overflow-y-auto custom-scrollbar">
					<div className="grid grid-cols-1 gap-3 p-3">
						{renderedImages.map( ( image, index ) => {

							const formattedDate = formatDate( image.timestamp );
							return (
								<div
									key={`render-${image.timestamp || index}`}
									className={`overflow-hidden rounded-lg ${
										selectedImageIndex === index
											? 'ring-2 ring-blue-500 shadow-lg shadow-blue-500/20'
											: 'ring-1 ring-slate-700'
									}`}
									onClick={() => handleImageSelect( index )}
								>
									<div className="relative rounded-t-lg overflow-hidden bg-slate-800 cursor-pointer">
										<div className="aspect-w-16 aspect-h-9 w-full">
											<img
												src={image.image}
												alt={`Render ${index + 1}`}
												className="w-full h-full object-cover"
												onError={handleImageError}
											/>
										</div>

										{/* Add a small badge for the selected item */}
										{selectedImageIndex === index && (
											<div className="absolute top-2 right-2 bg-blue-500 text-white text-xs py-0.5 px-2 rounded-full">
												Selected
											</div>
										)}
									</div>

									<div className="bg-slate-800 p-3">
										<div className="flex justify-between items-center">
											<div className="flex items-center text-xs space-x-1 text-gray-300">
												<Calendar size={12} className="text-gray-400" />
												<span>{formattedDate.date}</span>
											</div>
											<div className="flex items-center text-xs space-x-1 text-gray-300">
												<Clock size={12} className="text-gray-400" />
												<span>{formattedDate.time}</span>
											</div>
											<div
												className="flex items-center justify-center p-1 rounded-full hover:bg-red-500/20 hover:text-red-400 transition-colors cursor-pointer"
												onClick={( e ) => handleDeleteClick( e, image, index )}
											>
												<Trash2 size={14} className="text-gray-400 hover:text-red-400" />
											</div>
										</div>
									</div>
								</div>
							);

						} )}
					</div>
				</div>
			)}
		</div>
	);

} );

// Add display name for debugging
Results.displayName = 'Results';

export default Results;
