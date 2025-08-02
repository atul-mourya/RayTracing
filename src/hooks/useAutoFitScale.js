import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Custom hook for auto-fit scaling functionality in viewports
 * @param {Object} options - Configuration options
 * @param {React.RefObject} options.viewportRef - Reference to the viewport container
 * @param {number} options.canvasSize - Size of the canvas to fit
 * @param {number} options.padding - Padding around the canvas (default: 40)
 * @param {number} options.minScale - Minimum scale percentage (default: 25)
 * @param {number} options.maxScale - Maximum scale percentage (default: 300)
 * @param {number} options.manualThreshold - Threshold for detecting manual scale changes (default: 5)
 * @param {boolean} options.enabled - Flag to enable or disable the hook (default: true)
 * @returns {Object} Auto-fit scale state and handlers
 */
export const useAutoFitScale = ( {
	viewportRef,
	canvasSize,
	padding = 40,
	minScale = 25,
	maxScale = 300,
	manualThreshold = 5,
	enabled = true // Add enabled flag
} ) => {

	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ autoFitScale, setAutoFitScale ] = useState( 100 );
	const [ isManualScale, setIsManualScale ] = useState( false );
	const resizeObserverRef = useRef( null );

	// Calculate best fit scale based on available space
	const calculateBestFitScale = useCallback( () => {

		if ( ! viewportRef.current || ! enabled ) return 100;

		const viewport = viewportRef.current;
		const viewportRect = viewport.getBoundingClientRect();

		// Leave padding on each side
		const availableWidth = viewportRect.width - padding;
		const availableHeight = viewportRect.height - padding;

		// Calculate scale to fit both width and height
		const scaleX = ( availableWidth / canvasSize ) * 100;
		const scaleY = ( availableHeight / canvasSize ) * 100;

		// Use the smaller scale to ensure it fits in both dimensions
		const bestFitScale = Math.min( scaleX, scaleY, maxScale );

		return Math.max( Math.ceil( bestFitScale ), minScale );

	}, [ viewportRef, canvasSize, padding, minScale, maxScale, enabled ] );

	// Update auto-fit scale when viewport resizes
	useEffect( () => {

		if ( ! viewportRef.current || ! enabled ) return;

		// Add a small delay to ensure DOM is stable
		const initTimer = setTimeout( () => {

			resizeObserverRef.current = new ResizeObserver( () => {

				const newAutoFitScale = calculateBestFitScale();
				setAutoFitScale( newAutoFitScale );

				// Only update viewport scale if not manually overridden
				if ( ! isManualScale ) {

					setViewportScale( newAutoFitScale );

				}

			} );

			resizeObserverRef.current.observe( viewportRef.current );

			// Initial calculation
			const initialScale = calculateBestFitScale();
			setAutoFitScale( initialScale );
			setViewportScale( initialScale );

		}, 50 );

		return () => {

			clearTimeout( initTimer );
			if ( resizeObserverRef.current ) {

				resizeObserverRef.current.disconnect();

			}

		};

	}, [ calculateBestFitScale, isManualScale, enabled ] );

	// Handle viewport resize with manual scale detection
	const handleViewportResize = useCallback( ( scale ) => {

		setViewportScale( scale );
		setIsManualScale( Math.abs( scale - autoFitScale ) > manualThreshold );

	}, [ autoFitScale, manualThreshold ] );

	// Reset to auto-fit function
	const handleResetToAutoFit = useCallback( () => {

		setViewportScale( autoFitScale );
		setIsManualScale( false );

	}, [ autoFitScale ] );

	return {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit,
		setViewportScale,
		setIsManualScale
	};

};
