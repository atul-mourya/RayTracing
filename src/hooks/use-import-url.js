import { useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';

export function useImportUrl() {

	const { toast } = useToast();

	const [ modalState, setModalState ] = useState( {
		isImportModalOpen: false,
		importUrl: '',
		isImporting: false
	} );

	const openImportModal = useCallback( () => {

		setModalState( prev => ( { ...prev, isImportModalOpen: true } ) );

	}, [] );

	const closeImportModal = useCallback( () => {

		setModalState( prev => ( { ...prev, isImportModalOpen: false } ) );

	}, [] );

	const setImportUrl = useCallback( ( url ) => {

		setModalState( prev => ( { ...prev, importUrl: url } ) );

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

		const { importUrl } = modalState;

		if ( ! validateUrl( importUrl ) ) {

			toast( {
				title: "Invalid URL",
				description: "Please enter a valid URL.",
				variant: "destructive",
			} );
			return;

		}

		setModalState( prev => ( { ...prev, isImporting: true } ) );

		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadModel( importUrl )
				.then( () => {

					setModalState( prev => ( {
						...prev,
						isImporting: false,
						importUrl: '',
						isImportModalOpen: false
					} ) );

					toast( {
						title: "Model Loaded",
						description: "Successfully loaded model !!",
					} );

				} )
				.catch( ( error ) => {

					setModalState( prev => ( { ...prev, isImporting: false } ) );

					toast( {
						title: "Error Loading Model",
						description: `${error}`,
						variant: "destructive",
					} );

				} );

		} else {

			setModalState( prev => ( { ...prev, isImporting: false } ) );

		}

	}, [ modalState, toast, validateUrl ] );

	return {
		modalState,
		openImportModal,
		closeImportModal,
		setImportUrl,
		handleImportFromUrl
	};

}
