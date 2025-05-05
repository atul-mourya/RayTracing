import { useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Loader2 } from 'lucide-react';

const StatsMeter = forwardRef( ( { className = "", onMaxSamplesEdit }, ref ) => {

	// State for editing mode (minimal state that doesn't affect parent rendering)
	const [ isEditing, setIsEditing ] = useState( false );
	const [ inputValue, setInputValue ] = useState( "60" );

	// Create refs for DOM elements
	const containerRef = useRef( null );
	const timeElapsedRef = useRef( null );
	const samplesRef = useRef( null );
	const maxSamplesRef = useRef( null );
	const denoisingRef = useRef( null );

	// Stats data ref (not state)
	const statsDataRef = useRef( {
		timeElapsed: 0,
		samples: 0,
		maxSamples: 60,
		isDenoising: false
	} );

	// Handle input blur to submit value
	const handleInputBlur = useCallback( () => {

		setIsEditing( false );
		const numValue = Number( inputValue );
		if ( numValue !== statsDataRef.current.maxSamples && ! isNaN( numValue ) ) {

			// Call the parent callback with new value
			onMaxSamplesEdit && onMaxSamplesEdit( numValue );

		}

	}, [ inputValue, onMaxSamplesEdit ] );

	// Handle key press events
	const handleKeyDown = useCallback( ( e ) => {

		if ( e.key === 'Enter' ) {

			handleInputBlur();

		}

	}, [ handleInputBlur ] );

	// Handle input change
	const handleInputChange = useCallback( ( e ) => {

		setInputValue( e.target.value );

	}, [] );

	// Handle click to start editing
	const startEditing = useCallback( () => {

		setIsEditing( true );
		// Initialize input value from current stats
		setInputValue( String( statsDataRef.current.maxSamples ) );

	}, [] );

	// Expose methods to update stats without re-rendering
	useImperativeHandle( ref, () => ( {
		updateStats: ( newStats ) => {

			if ( ! containerRef.current ) return;

			// Update our internal ref data
			if ( newStats.timeElapsed !== undefined ) {

				statsDataRef.current.timeElapsed = newStats.timeElapsed;
				if ( timeElapsedRef.current ) {

					timeElapsedRef.current.textContent = newStats.timeElapsed.toFixed( 2 );

				}

			}

			if ( newStats.samples !== undefined ) {

				statsDataRef.current.samples = newStats.samples;
				if ( samplesRef.current ) {

					samplesRef.current.textContent = newStats.samples;

				}

			}

			if ( newStats.maxSamples !== undefined ) {

				statsDataRef.current.maxSamples = newStats.maxSamples;
				if ( maxSamplesRef.current && ! isEditing ) {

					maxSamplesRef.current.textContent = newStats.maxSamples;

				}

			}

			if ( newStats.isDenoising !== undefined ) {

				statsDataRef.current.isDenoising = newStats.isDenoising;
				if ( denoisingRef.current ) {

					denoisingRef.current.style.visibility = newStats.isDenoising ? 'visible' : 'hidden';

				}

			}

		},
		getStats: () => statsDataRef.current
	} ), [ isEditing ] );

	return (
		<div
			ref={containerRef}
			className={`absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded ${className}`}
		>
            Time: <span ref={timeElapsedRef}>0.00</span>s | Frames: <span ref={samplesRef}>0</span> /{' '}
			{isEditing ? (
				<input
					className="bg-transparent border-b border-white text-white w-12"
					type="number"
					value={inputValue}
					onChange={handleInputChange}
					onBlur={handleInputBlur}
					onKeyDown={handleKeyDown}
					autoFocus
				/>
			) : (
				<span
					ref={maxSamplesRef}
					onClick={startEditing}
					className="cursor-pointer border-b border-dotted border-white group-hover:border-blue-400 transition-colors duration-300"
				>
					{statsDataRef.current.maxSamples}
				</span>
			)}
			<div
				ref={denoisingRef}
				className="py-1 rounded-full flex items-center invisible"
			>
				<span className="mr-2">Denoising</span>
				<Loader2 className="h-5 w-5 animate-spin" />
			</div>
		</div>
	);

} );

StatsMeter.displayName = 'StatsMeter';

export default StatsMeter;
