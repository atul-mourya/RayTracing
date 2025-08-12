import { useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useStore, useAssetsStore } from '@/store';
import { MaterialService } from '@/services/MaterialService';

/**
 * Custom hook for handling material application to objects
 */
export const useMaterialApplicator = () => {

	const { toast } = useToast();
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setLoading = useStore( ( state ) => state.setLoading );
	const { materials, setSelectedMaterial } = useAssetsStore();

	const applyMaterial = useCallback( ( value ) => {

		if ( ! selectedObject ) {

			toast( {
				title: "No Object Selected",
				description: "Please select an object to apply material to",
				variant: "destructive",
			} );
			return;

		}

		if ( ! selectedObject.material ) {

			toast( {
				title: "Invalid Object",
				description: "The selected object doesn't have a material property",
				variant: "destructive",
			} );
			return;

		}

		const materialIndex = parseInt( value );

		if ( materialIndex < 0 || materialIndex >= materials.length ) {

			toast( {
				title: "Invalid Material",
				description: "The selected material index is invalid",
				variant: "destructive",
			} );
			return;

		}

		// Track the selected material for highlighting
		setSelectedMaterial( materialIndex );

		setLoading( {
			isLoading: true,
			title: "Apply",
			status: "Processing Material...",
			progress: 0
		} );

		try {

			const materialData = materials[ materialIndex ];

			// Output debug info
			console.debug( 'Applying complete API material:', {
				materialIndex,
				materialData,
				targetObject: selectedObject,
				targetMaterial: selectedObject.material
			} );

			// Apply material properties to the Three.js material
			MaterialService.applyMaterialToObject( materialData, selectedObject.material );

			// Update path tracer with new material
			MaterialService.updatePathTracerMaterial( selectedObject );

			toast( {
				title: "Material Applied",
				description: materialData?.name || `Material #${materialIndex}`,
			} );

		} catch ( error ) {

			console.error( "Error applying material:", error );
			toast( {
				title: "Error Applying Material",
				description: error.message || "Unknown error occurred",
				variant: "destructive",
			} );

		} finally {

			useStore.getState().resetLoading();

		}

	}, [ selectedObject, materials, setSelectedMaterial, setLoading, toast ] );

	const canApplyMaterial = !! ( selectedObject && selectedObject.material );

	return {
		applyMaterial,
		canApplyMaterial,
		selectedObject
	};

};
