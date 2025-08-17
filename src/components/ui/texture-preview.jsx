import { useState, useEffect, useCallback, useRef } from 'react';

const TexturePreview = ( { texture } ) => {

	const [ showLargePreview, setShowLargePreview ] = useState( false );
	const canvasRef = useRef( null );
	const largeCanvasRef = useRef( null );

	// Helper function to render texture to canvas (inspired by Three.js editor)
	const renderTextureToCanvas = useCallback( ( texture, canvas ) => {

		if ( ! canvas || ! texture ) return;

		const context = canvas.getContext( '2d' );
		if ( ! context ) return;

		// Clear canvas
		context.clearRect( 0, 0, canvas.width, canvas.height );

		if ( texture.image && texture.image.width > 0 ) {

			const image = texture.image;
			const scale = Math.min( canvas.width / image.width, canvas.height / image.height );
			const width = image.width * scale;
			const height = image.height * scale;
			const x = ( canvas.width - width ) / 2;
			const y = ( canvas.height - height ) / 2;

			try {

				if ( texture.isDataTexture || texture.isCompressedTexture ) {

					// For data textures, we need special handling
					// This is a simplified version - you might need more complex handling
					context.fillStyle = '#444';
					context.fillRect( x, y, width, height );
					context.fillStyle = '#fff';
					context.font = '8px Arial';
					context.textAlign = 'center';
					context.fillText( 'DATA', canvas.width / 2, canvas.height / 2 );

				} else {

					context.drawImage( image, x, y, width, height );

				}

			} catch ( error ) {

				// Fallback for CORS or other image loading issues
				context.fillStyle = '#333';
				context.fillRect( x, y, width, height );
				context.fillStyle = '#999';
				context.font = '8px Arial';
				context.textAlign = 'center';
				context.fillText( 'IMG', canvas.width / 2, canvas.height / 2 );

			}

		} else {

			// No valid image
			context.fillStyle = '#222';
			context.fillRect( 0, 0, canvas.width, canvas.height );
			context.fillStyle = '#666';
			context.font = '8px Arial';
			context.textAlign = 'center';
			context.fillText( '?', canvas.width / 2, canvas.height / 2 );

		}

	}, [] );

	// Update canvas when texture changes
	useEffect( () => {

		if ( canvasRef.current && texture ) {

			renderTextureToCanvas( texture, canvasRef.current );

		}

	}, [ texture, renderTextureToCanvas ] );

	// Update large canvas when shown
	useEffect( () => {

		if ( largeCanvasRef.current && texture && showLargePreview ) {

			renderTextureToCanvas( texture, largeCanvasRef.current );

		}

	}, [ texture, showLargePreview, renderTextureToCanvas ] );

	if ( ! texture ) {

		return (
			<div className="flex items-center justify-between">
				<span className="text-xs opacity-50">Texture Preview</span>
				<div className="w-8 h-8 bg-muted rounded border flex items-center justify-center">
					<span className="text-xs opacity-50">...</span>
				</div>
			</div>
		);

	}

	const getTextureInfo = () => {

		if ( ! texture.image ) return 'No Image';
		if ( texture.isDataTexture ) return 'Data Texture';
		if ( texture.isCompressedTexture ) return 'Compressed';
		return `${texture.image.width}×${texture.image.height}`;

	};

	return (
		<div className="relative">
			<div className="flex items-center justify-between">
				<span className="text-xs opacity-50">Texture Preview</span>
				<div
					className="relative w-8 h-8 border rounded overflow-hidden cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
					onMouseEnter={() => setShowLargePreview( true )}
					onMouseLeave={() => setShowLargePreview( false )}
					title={`${getTextureInfo()}`}
				>
					<canvas
						ref={canvasRef}
						width={32}
						height={32}
						className="w-full h-full"
						style={{ imageRendering: 'pixelated' }}
					/>
				</div>
			</div>

			{/* Large preview on hover */}
			{showLargePreview && (
				<div className="absolute right-0 top-0 z-50 bg-background border rounded-lg shadow-xl transform -translate-x-9 -translate-y-2">
					<canvas
						ref={largeCanvasRef}
						width={128}
						height={128}
						className="w-32 h-32 border rounded"
						style={{ imageRendering: 'pixelated' }}
					/>
				</div>
			)}
		</div>
	);

};

export { TexturePreview };
