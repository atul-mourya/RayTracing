import { useCallback, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useStore, useAssetsStore, useEnvironmentStore } from '@/store';
import { AssetLoaderService } from '@/services/AssetLoaderService';
import { MODEL_FILES, DEBUG_MODELS } from '@/Constants';

/**
 * Custom hook for handling asset loading operations
 */
export const useAssetLoader = () => {

	const { toast } = useToast();
	const setLoading = useStore( ( state ) => state.setLoading );
	const {
		setMaterials,
		setSelectedEnvironmentIndex,
		setEnvironment
	} = useAssetsStore();

	// Initialize materials on mount
	useEffect( () => {

		const fetchMaterials = async () => {

			try {

				const processedMaterials = await AssetLoaderService.fetchMaterialCatalog();
				setMaterials( processedMaterials );

			} catch ( error ) {

				console.error( 'Error fetching materials:', error );
				toast( {
					title: "Error Loading Materials",
					description: "Failed to load material catalog",
					variant: "destructive",
				} );

			}

		};

		fetchMaterials();

	}, [ setMaterials, toast ] );

	const loadModel = useCallback( async ( value ) => {

		const modelIndex = parseInt( value );
		setLoading( { isLoading: true, title: "Loading", status: "Loading Model..." } );

		try {

			const result = await AssetLoaderService.loadExampleModel( modelIndex, MODEL_FILES );

			toast( {
				title: "Model Loaded Successfully",
				description: result.modelName,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: error.message,
				variant: "destructive",
			} );
			useStore.getState().resetLoading();

		}

	}, [ setLoading, toast ] );

	const loadDebugModel = useCallback( async ( value ) => {

		const modelIndex = parseInt( value );
		setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 0 } );

		try {

			const result = await AssetLoaderService.loadDebugModel( modelIndex, DEBUG_MODELS );

			toast( {
				title: "Model Loaded Successfully",
				description: result.modelName,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: error.message,
				variant: "destructive",
			} );
			useStore.getState().resetLoading();

		}

	}, [ setLoading, toast ] );

	const loadEnvironment = useCallback( async ( envData ) => {

		if ( ! envData || ! envData.url ) return;

		// Update both environment and its index
		setEnvironment( envData );

		// Find and set the environment index
		const environmentStore = useEnvironmentStore.getState();
		const environments = environmentStore.environments || [];
		const index = environments.findIndex( env => env.id === envData.id );
		setSelectedEnvironmentIndex( index >= 0 ? index : null );

		setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 0 } );

		try {

			const result = await AssetLoaderService.loadEnvironment( envData );

			toast( {
				title: "Environment Loaded Successfully",
				description: result.environmentName,
			} );
			useStore.getState().resetLoading();

		} catch ( error ) {

			console.error( "Environment loading error:", error );
			toast( {
				title: "Error Loading Environment",
				description: error.message,
				variant: "destructive",
			} );
			useStore.getState().resetLoading();

		}

	}, [ setEnvironment, setSelectedEnvironmentIndex, setLoading, toast ] );

	return {
		loadModel,
		loadDebugModel,
		loadEnvironment
	};

};
