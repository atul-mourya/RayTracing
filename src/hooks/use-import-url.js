import { useState, useCallback } from 'react';
import { useToggle } from '@uidotdev/usehooks';
import { useToast } from '@/hooks/use-toast';

export function useImportUrl() {

	const { toast } = useToast();
	const [ isImportModalOpen, toggleImportModal ] = useToggle( false );
	const [ importUrl, setImportUrl ] = useState( '' );
	const [ isImporting, setIsImporting ] = useState( false );

	const openImportModal = useCallback( () => {

		toggleImportModal( true );

	}, [ toggleImportModal ] );

	const closeImportModal = useCallback( () => {

		toggleImportModal( false );

	}, [ toggleImportModal ] );

	const setImportUrlValue = useCallback( ( url ) => {

		setImportUrl( url );

	}, [] );

	// Validate URL
	const validateUrl = useCallback( ( url ) => {

		if ( ! url ) return false;
		if ( ! url.startsWith( 'http' ) ) return false;
		if ( ! url.endsWith( '.glb' ) && ! url.endsWith( '.gltf' ) ) return false;
		try {

			new URL( url );
			return true;

		} catch {

			return false;

		}

	}, [] );

	// Handle import from URL
	const handleImportFromUrl = useCallback( () => {

		if ( ! validateUrl( importUrl ) ) {

			toast( {
				title: "Invalid URL",
				description: "Please enter a valid URL.",
				variant: "destructive",
			} );
			return;

		}

		setIsImporting( true );

		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadModel( importUrl )
				.then( () => {

					setIsImporting( false );
					setImportUrl( '' );
					toggleImportModal( false );

					toast( {
						title: "Model Loaded",
						description: "Successfully loaded model !!",
					} );

				} )
				.catch( ( error ) => {

					setIsImporting( false );

					toast( {
						title: "Error Loading Model",
						description: `${error}`,
						variant: "destructive",
					} );

				} );

		} else {

			setIsImporting( false );

		}

	}, [ importUrl, toast, validateUrl, toggleImportModal ] );

	return {
		modalState: {
			isImportModalOpen,
			importUrl,
			isImporting
		},
		openImportModal,
		closeImportModal,
		setImportUrl: setImportUrlValue,
		handleImportFromUrl
	};

}
