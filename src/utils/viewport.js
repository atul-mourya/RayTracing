/**
 * Calculate the best fit scale for a canvas within a viewport
 * @param {Element} viewportElement - The viewport container element
 * @param {number} canvasSize - Size of the canvas to fit
 * @param {Object} options - Configuration options
 * @param {number} options.padding - Padding around the canvas
 * @param {number} options.minScale - Minimum scale percentage
 * @param {number} options.maxScale - Maximum scale percentage
 * @returns {number} The calculated scale percentage
 */
export const calculateBestFitScale = ( viewportElement, canvasSize, options = {} ) => {

	const {
		padding = 40,
		minScale = 25,
		maxScale = 300
	} = options;

	if ( ! viewportElement ) return 100;

	const viewportRect = viewportElement.getBoundingClientRect();

	// Leave padding on each side
	const availableWidth = viewportRect.width - padding;
	const availableHeight = viewportRect.height - padding;

	// Calculate scale to fit both width and height
	const scaleX = ( availableWidth / canvasSize ) * 100;
	const scaleY = ( availableHeight / canvasSize ) * 100;

	// Use the smaller scale to ensure it fits in both dimensions
	const bestFitScale = Math.min( scaleX, scaleY, maxScale );

	return Math.max( bestFitScale, minScale );

};

/**
 * Generate memoized style objects for viewport components
 * @param {number} canvasSize - Size of the canvas
 * @param {number} viewportScale - Current viewport scale
 * @returns {Object} Style objects for wrapper, container, and canvas
 */
export const generateViewportStyles = ( canvasSize, viewportScale ) => {

	const wrapperStyle = {
		width: `${canvasSize}px`,
		height: `${canvasSize}px`,
		transform: `scale(${viewportScale / 100})`,
		transformOrigin: 'center center',
		transition: "transform 0.1s ease-out"
	};

	const containerStyle = {
		position: "relative",
		width: `${canvasSize}px`,
		height: `${canvasSize}px`,
		overflow: "hidden",
		background: "repeating-conic-gradient(rgb(128 128 128 / 20%) 0%, rgb(128 128 128 / 20%) 25%, transparent 0%, transparent 50%) 50% center / 20px 20px"
	};

	const canvasStyle = {
		width: `${canvasSize}px`,
		height: `${canvasSize}px`
	};

	return { wrapperStyle, containerStyle, canvasStyle };

};
