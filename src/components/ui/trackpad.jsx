import { useState, useEffect, useRef } from 'react';
import { cn } from "@/lib/utils";

const SNAP_THRESHOLD = 5; // Percentage of width/height to trigger snapping

export function Trackpad( { className, points = [], onMove, ...props } ) {

	const [ position, setPosition ] = useState( { x: 50, y: 50 } ); // Start in the center
	const [ isDragging, setIsDragging ] = useState( false );
	const [ snappedPoint, setSnappedPoint ] = useState( null );
	const svgRef = useRef( null );

	const handleMouseDown = ( event ) => {

		setIsDragging( true );
		updatePosition( event );

	};

	const handleMouseMove = ( event ) => {

		if ( isDragging ) {

			updatePosition( event );
			onMove && onMove( position );

		}

	};

	const handleMouseUp = () => {

		setIsDragging( false );
		if ( snappedPoint ) {

			snappedPoint.onClick && snappedPoint.onClick();
			setSnappedPoint( null );
			onMove && onMove( snappedPoint );


		}

	};

	const updatePosition = ( event ) => {

		if ( svgRef.current ) {

			const rect = svgRef.current.getBoundingClientRect();
			const x = ( ( event.clientX - rect.left ) / rect.width ) * 100;
			const y = ( ( event.clientY - rect.top ) / rect.height ) * 100;

			// Check for nearby points to snap to
			const nearestPoint = points.reduce( ( nearest, point ) => {

				const distance = Math.sqrt( Math.pow( x - point.x, 2 ) + Math.pow( y - point.y, 2 ) );
				return distance < SNAP_THRESHOLD && ( ! nearest || distance < nearest.distance )
					? { point, distance }
					: nearest;

			}, null );

			if ( nearestPoint ) {

				setPosition( { x: nearestPoint.point.x, y: nearestPoint.point.y } );
				setSnappedPoint( nearestPoint.point );

			} else {

				setPosition( { x, y } );
				setSnappedPoint( null );

			}

		}

	};

	useEffect( () => {

		const handleGlobalMouseUp = () => {

			setIsDragging( false );
			if ( snappedPoint ) {

				snappedPoint.onClick();
				setSnappedPoint( null );

			}

		};

		window.addEventListener( 'mouseup', handleGlobalMouseUp );
		return () => window.removeEventListener( 'mouseup', handleGlobalMouseUp );

	}, [ snappedPoint ] );

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<div className={cn( "w-full h-full", className )} {...props}>
				<svg
					ref={svgRef}
					viewBox="-3 -3 106 106" // Add some padding to the viewBox to avoid clipping the at edges
					className="w-full h-full border rounded-lg shadow-md"
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
					onMouseUp={handleMouseUp}
					role="application"
					aria-label="Trackpad">
					{/* Glow filter */}
					<defs>
						<filter id="glow" x="-150%" y="-150%" width="400%" height="400%">
							<feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
							<feMerge>
								<feMergeNode in="coloredBlur" />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
					</defs>

					<rect x="0" y="0" width="100" height="100" fill="transparent" />

					{/* Center lines */}
					<line x1="50" y1="0" x2="50" y2="100" className='stroke-primary opacity-30 [stroke-dasharray:2,2]' />
					<line x1="0" y1="50" x2="100" y2="50" className='stroke-primary opacity-30 [stroke-dasharray:2,2]' />

					{/* Guide lines (always visible) */}
					<line x1={position.x} y1="0" x2={position.x} y2="100" className='stroke-primary'/>
					<line x1="0" y1={position.y} x2="100" y2={position.y} className='stroke-primary'/>

					{/* Interactive points */}
					{points.map( ( point, index ) => (
						<circle key={index} cx={point.x} cy={point.y} r="3" className="stroke-primary fill-background cursor-pointer hover:fill-primary opacity-40" />
					) )}

					{/* Cursor circle */}
					<circle cx={position.x} cy={position.y} r="3" className="stroke-primary fill-primary pointer-events-none" style={{ filter: 'url(#glow)' }} />
				</svg>
			</div>
		</>
	);

}
