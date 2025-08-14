import { useStore } from '@/store';
import { createContext, useContext, useEffect, useState, useCallback, useRef, memo, useMemo } from 'react';
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

// Create Context for sharing state across components
const ResultsContext = createContext( null );

// Custom hook to use the Results context
const useResultsContext = () => {

	const context = useContext( ResultsContext );
	if ( ! context ) {

		throw new Error( 'useResultsContext must be used within a ResultsProvider' );

	}

	return context;

};

// Custom hook for handling images data and selection
const useResultsData = () => {

	const isMountedRef = useRef( true );
	const isResultsTabRef = useRef( false );
	const initialFetchDoneRef = useRef( false ); // Add ref to track initial fetch

	const [ imagesState, setImagesState ] = useState( {
		renderedImages: [],
		selectedImageIndex: null,
		loading: true,
		error: null,
		isFetching: false
	} );

	// Access store with direct references to avoid re-renders
	const storeRef = useRef( null );
	const appMode = useStore( useCallback( state => {

		storeRef.current = state;
		return state.appMode;

	}, [] ) );

	// Extract setSelectedResult from store using ref
	const setSelectedResult = () => storeRef.current?.setSelectedResult || ( () => {} );

	// Update isResultsTab ref when appMode changes
	useEffect( () => {

		isResultsTabRef.current = appMode === 'results';

	}, [ appMode ] );

	// Set up mount/unmount tracking
	useEffect( () => {

		isMountedRef.current = true;
		return () => {

			isMountedRef.current = false;

		};

	}, [] );

	// Fetch images with proper state management
	const fetchImages = useCallback( async ( options = {} ) => {

		const { force = false } = options;

		// Get current state values instead of using dependencies
		const isFetching = imagesState.isFetching;

		// Prevent duplicate fetches
		if ( ( isFetching || ! isMountedRef.current ) && ! force ) return;

		try {

			setImagesState( prev => ( {
				...prev,
				isFetching: true,
				loading: prev.renderedImages.length === 0,
				error: null
			} ) );

			const images = await getAllRenders();

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			setImagesState( prev => {

				const newState = {
					...prev,
					renderedImages: images,
					loading: false,
					isFetching: false
				};

				// Auto-select the first image if available and none selected
				if ( images.length > 0 && prev.selectedImageIndex === null ) {

					newState.selectedImageIndex = 0;

					// Only update selected result if we're in results tab
					if ( isResultsTabRef.current ) {

						setSelectedResult()( images[ 0 ] );

					}

				} else if ( images.length === 0 ) {

					newState.selectedImageIndex = null;

					if ( isResultsTabRef.current ) {

						setSelectedResult()( null );

					}

				}

				return newState;

			} );

		} catch ( err ) {

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			setImagesState( prev => ( {
				...prev,
				error: err.message,
				loading: false,
				isFetching: false
			} ) );

		}

	}, [] ); // Remove dependency on imagesState.isFetching

	// Handle initial fetch - only run once
	useEffect( () => {

		// Only run if not already fetched
		if ( ! initialFetchDoneRef.current && isMountedRef.current ) {

			const initialFetchTimer = setTimeout( () => {

				if ( isMountedRef.current ) {

					initialFetchDoneRef.current = true; // Mark as fetched
					fetchImages();

				}

			}, 500 );

			return () => clearTimeout( initialFetchTimer );

		}

	}, [] );

	// Set up event listeners for render-saved events
	useEffect( () => {

		// Create a named handler for proper cleanup
		const handleRenderSaved = () => {

			if ( ! isMountedRef.current ) return;

			// Debounce the fetch to prevent multiple rapid fetches
			const timeoutId = setTimeout( () => {

				if ( isMountedRef.current ) {

					fetchImages( { force: true } );

				}

			}, 100 );

			return () => clearTimeout( timeoutId );

		};

		window.addEventListener( 'render-saved', handleRenderSaved );

		return () => {

			window.removeEventListener( 'render-saved', handleRenderSaved );

		};

	}, [] );

	// Handle selected image change
	useEffect( () => {

		if ( ! isMountedRef.current ) return;

		const { selectedImageIndex, renderedImages } = imagesState;

		if ( selectedImageIndex !== null &&
			renderedImages.length > 0 &&
			isResultsTabRef.current ) {

			setSelectedResult()( renderedImages[ selectedImageIndex ] );

		}

	}, [ imagesState.selectedImageIndex, imagesState.renderedImages ] );

	// Handle image selection
	const handleImageSelect = useCallback( ( index ) => {

		if ( ! isMountedRef.current ) return;
		setImagesState( prev => ( { ...prev, selectedImageIndex: index } ) );

	}, [] );

	return {
		...imagesState,
		isMountedRef,
		isResultsTabRef,
		fetchImages,
		handleImageSelect,
		setImagesState
	};

};

// Custom hook for handling image deletion
const useDeleteRender = ( imagesState, setImagesState, isMountedRef, isResultsTabRef ) => {

	const [ deleteState, setDeleteState ] = useState( {
		deleteDialogOpen: false,
		renderToDelete: null,
		isDeleting: false
	} );

	// Store reference for stable access
	const storeRef = useRef( null );
	useStore( useCallback( state => {

		storeRef.current = state;

	}, [] ) );

	// Extract setSelectedResult from store using ref
	const setSelectedResult = () => storeRef.current?.setSelectedResult || ( () => {} );

	// Handle opening the delete confirmation dialog
	const handleDeleteClick = useCallback( ( e, image, index ) => {

		e.stopPropagation(); // Prevent selecting the image when clicking delete

		if ( ! isMountedRef.current ) return;

		setDeleteState( {
			deleteDialogOpen: true,
			renderToDelete: { image, index },
			isDeleting: false
		} );

	}, [ isMountedRef ] );

	// Handle confirming deletion
	const handleConfirmDelete = useCallback( async () => {

		const { renderToDelete } = deleteState;
		const { selectedImageIndex } = imagesState;

		if ( ! renderToDelete || ! renderToDelete.image || ! isMountedRef.current ) return;

		try {

			setDeleteState( prev => ( { ...prev, isDeleting: true } ) );

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

					setSelectedResult()( freshImages[ newSelectedIndex ] );

				} else if ( freshImages.length === 0 ) {

					setSelectedResult()( null );

				}

			} else if ( selectedImageIndex > renderToDelete.index ) {

				// If the selected index is after the deleted one, decrement it
				newSelectedIndex = selectedImageIndex - 1;

			}

			// Update image state
			setImagesState( prev => ( {
				...prev,
				renderedImages: freshImages,
				selectedImageIndex: newSelectedIndex
			} ) );

			// Reset delete state
			setDeleteState( {
				deleteDialogOpen: false,
				renderToDelete: null,
				isDeleting: false
			} );

		} catch ( error ) {

			console.error( 'Error deleting render:', error );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			setImagesState( prev => ( {
				...prev,
				error: `Failed to delete: ${error.message}`
			} ) );

			setDeleteState( {
				deleteDialogOpen: false,
				renderToDelete: null,
				isDeleting: false
			} );

		}

	}, [ deleteState, imagesState.selectedImageIndex, isMountedRef, isResultsTabRef, setImagesState ] );

	// Handle canceling deletion
	const handleCancelDelete = useCallback( () => {

		if ( ! isMountedRef.current ) return;

		setDeleteState( {
			deleteDialogOpen: false,
			renderToDelete: null,
			isDeleting: false
		} );

	}, [ isMountedRef ] );

	return {
		...deleteState,
		handleDeleteClick,
		handleConfirmDelete,
		handleCancelDelete
	};

};

// Memoized utility function for date formatting
const useFormatDate = () => {

	return useCallback( ( dateString ) => {

		const date = new Date( dateString );
		return {
			date: date.toLocaleDateString( undefined, {
				day: 'numeric',
				month: 'numeric',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			} ),
		};

	}, [] );

};

// Memoized render item component to prevent unnecessary re-renders
const RenderItem = memo( ( {
	image,
	index,
	isSelected,
	formattedDate,
	onSelect,
	onDelete,
	handleImageError
} ) => {

	const handleClick = useCallback( () => onSelect( index ), [ onSelect, index ] );
	const handleDeleteClick = useCallback( ( e ) => {

		e.stopPropagation();
		onDelete( e, image, index );

	}, [ onDelete, image, index ] );

	return (
		<div
			key={`render-${image.timestamp || index}`}
			className={`overflow-hidden rounded-md transition-all ${isSelected
				? 'ring-2 ring-primary shadow-sm shadow-primary/20'
				: 'ring-1 ring-border hover:ring-border/90'
			}`}
			onClick={handleClick}
		>
			<div className="relative rounded-t-md overflow-hidden bg-black cursor-pointer group">
				<div className="aspect-w-16 aspect-h-9 w-full">
					<img
						src={image.image}
						alt={`Render ${index + 1}`}
						className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
						onError={handleImageError}
					/>
				</div>

				{/* Add a small badge for the selected item */}
				{isSelected && (
					<div className="absolute top-2 right-2 bg-primary text-primary-foreground text-xs py-0.5 px-2 rounded-full">
						Selected
					</div>
				)}
			</div>

			<div className="bg-card p-3">
				<div className="flex justify-between items-center">
					<div className="flex items-center text-xs space-x-1 text-muted-foreground">
						<span>{formattedDate.date}</span>
					</div>
					<div
						className="flex items-center justify-center p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
						onClick={handleDeleteClick}
						aria-label="Delete render"
					>
						<Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
					</div>
				</div>
			</div>
		</div>
	);

} );

RenderItem.displayName = 'RenderItem';

// Memoized delete confirmation dialog
const DeleteConfirmationDialog = memo( ( {
	open,
	onCancel,
	onConfirm,
	isDeleting
} ) => {

	if ( ! open ) return null;

	return (
		<AlertDialog open={open} onOpenChange={onCancel}>
			<AlertDialogContent className="border border-border">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<AlertTriangle size={18} className="text-destructive" />
						Confirm Deletion
					</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete this render? This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						className="bg-transparent border border-border hover:bg-muted"
						disabled={isDeleting}
					>
						Cancel
					</AlertDialogCancel>
					<AlertDialogAction
						className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
						onClick={onConfirm}
						disabled={isDeleting}
					>
						{isDeleting ? (
							<>
								<div className="animate-spin h-4 w-4 border-2 border-background border-t-transparent rounded-full mr-2"></div>
								Deleting...
							</>
						) : (
							'Delete'
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);

} );

DeleteConfirmationDialog.displayName = 'DeleteConfirmationDialog';

// Component for header section
const ResultsHeader = memo( ( { loading, error, renderedImages } ) => {

	return (
		<div className="p-4 border-b border-border bg-card">
			<h2 className="text-lg font-semibold">Saved Renders</h2>
			{! loading && ! error && renderedImages.length > 0 && (
				<p className="text-xs text-muted-foreground mt-1">
					Showing {renderedImages.length} render{renderedImages.length !== 1 ? 's' : ''}
				</p>
			)}
		</div>
	);

} );

ResultsHeader.displayName = 'ResultsHeader';

// Component for loading state
const LoadingState = memo( () => (
	<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
		<div className="flex flex-col items-center space-y-2">
			<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
			<span>Loading saved renders...</span>
		</div>
	</div>
) );

LoadingState.displayName = 'LoadingState';

// Component for error state
const ErrorState = memo( ( { error } ) => (
	<div className="p-4 m-3 text-sm text-destructive-foreground bg-destructive/10 rounded-md border border-destructive/20">
		<div className="font-medium mb-1">Error loading renders</div>
		{error}
	</div>
) );

ErrorState.displayName = 'ErrorState';

// Component for empty state
const EmptyState = memo( () => (
	<div className="flex-1 flex items-center justify-center p-4 text-sm text-muted-foreground">
		<div className="text-center">
			<div className="text-4xl mb-3">📷</div>
			<div className="font-medium">No rendered images available</div>
			<p className="text-xs mt-2 max-w-xs">Complete a render in the &quot;Final Render&quot; tab to see results here</p>
		</div>
	</div>
) );

EmptyState.displayName = 'EmptyState';

// Component for render gallery
const RenderGallery = memo( () => {

	const { renderedImages, selectedImageIndex, handleImageSelect } = useResultsContext();
	const formatDate = useFormatDate();
	const { handleDeleteClick } = useResultsContext();

	const handleImageError = useCallback( ( e ) => {

		e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23374151"/%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23F9FAFB"%3EImage Error%3C/text%3E%3C/svg%3E';

	}, [] );

	return (
		<div className="flex-1 overflow-y-auto custom-scrollbar">
			<div className="grid grid-cols-2 gap-3 p-3">
				{renderedImages.map( ( image, index ) => {

					const formattedDate = formatDate( image.timestamp );
					return (
						<RenderItem
							key={`render-${image.id || image.timestamp || index}`}
							image={image}
							index={index}
							isSelected={selectedImageIndex === index}
							formattedDate={formattedDate}
							onSelect={handleImageSelect}
							onDelete={handleDeleteClick}
							handleImageError={handleImageError}
						/>
					);

				} )}
			</div>
		</div>
	);

} );

RenderGallery.displayName = 'RenderGallery';

// Results provider component for context
const ResultsProvider = ( { children } ) => {

	const resultsData = useResultsData();
	const {
		renderedImages,
		selectedImageIndex,
		loading,
		error,
		isMountedRef,
		isResultsTabRef,
		setImagesState
	} = resultsData;

	const deleteHandler = useDeleteRender(
		{ renderedImages, selectedImageIndex },
		setImagesState,
		isMountedRef,
		isResultsTabRef
	);

	const contextValue = useMemo( () => ( {
		...resultsData,
		...deleteHandler
	} ), [ resultsData, deleteHandler ] );

	return (
		<ResultsContext.Provider value={contextValue}>
			{children}
		</ResultsContext.Provider>
	);

};

// Main Results component
const Results = memo( () => {

	return (
		<ResultsProvider>
			<ResultsContent />
		</ResultsProvider>
	);

} );

// Content component using the provided context
const ResultsContent = memo( () => {

	const {
		renderedImages,
		loading,
		error,
		deleteDialogOpen,
		handleCancelDelete,
		handleConfirmDelete,
		isDeleting
	} = useResultsContext();

	return (
		<div className="h-full flex flex-col bg-background text-foreground">
			{/* Delete Confirmation Dialog */}
			<DeleteConfirmationDialog
				open={deleteDialogOpen}
				onCancel={handleCancelDelete}
				onConfirm={handleConfirmDelete}
				isDeleting={isDeleting}
			/>

			<ResultsHeader loading={loading} error={error} renderedImages={renderedImages} />

			{loading && <LoadingState />}
			{error && <ErrorState error={error} />}
			{! loading && ! error && renderedImages.length === 0 && <EmptyState />}
			{! loading && ! error && renderedImages.length > 0 && <RenderGallery />}
		</div>
	);

} );

ResultsContent.displayName = 'ResultsContent';

// Add display name for debugging
Results.displayName = 'Results';

export default Results;
