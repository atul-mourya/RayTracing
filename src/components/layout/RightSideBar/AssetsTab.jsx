import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MODEL_FILES, DEBUG_MODELS } from '../../../Constants';
import { EnvironmentCatalog } from '@/components/ui/env-catalog';
import { useToast } from "@/hooks/use-toast";
import { useAssetsStore } from '@/store';
import { useEffect } from 'react';
import { useStore, useEnvironmentStore } from '@/store';
import { Color } from 'three';

const AssetsTab = () => {

	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setLoading = useStore( ( state ) => state.setLoading );
	const { toast } = useToast();
	const {
		activeTab,
		model,
		environment,
		debugModel,
		materials,
		selectedMaterial,
		selectedEnvironmentIndex,
		setActiveTab,
		setModel,
		setEnvironment,
		setDebugModel,
		setMaterials,
		setSelectedMaterial,
		setSelectedEnvironmentIndex,
	} = useAssetsStore();

	// Fetch material catalog on component mount
	useEffect( () => {

		const fetchMaterials = async () => {

			try {

				const response = await fetch( 'https://api.physicallybased.info/materials' );
				const data = await response.json();

				const processedMaterials = data.map( ( mData ) => ( {
					...mData,
					preview: mData.reference[ 0 ]
				} ) );

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

	}, [] );

	// Fix for environments - use stored environment index
	const getEnvironmentIndex = () => {

		return selectedEnvironmentIndex !== null && selectedEnvironmentIndex !== undefined
			? selectedEnvironmentIndex.toString()
			: null;

	};

	const handleEnvironmentChange = async ( envData ) => {

		if ( ! envData || ! envData.url ) return;

		// Update both environment and its index
		setEnvironment( envData );

		// Find and set the environment index
		const environmentStore = useEnvironmentStore.getState();
		const environments = environmentStore.environments || [];
		const index = environments.findIndex( env => env.id === envData.id );
		setSelectedEnvironmentIndex( index >= 0 ? index : null );

		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 0 } );

		try {

			// Handle custom environment uploads
			if ( envData.id === 'custom-upload' && envData.name ) {

				window.uploadedEnvironmentFileInfo = {
					name: envData.name,
					url: envData.url
				};

			}

			await window.pathTracerApp.loadEnvironment( envData.url );

			toast( {
				title: "Environment Loaded Successfully",
				description: envData.name,
			} );

		} catch ( error ) {

			console.error( "Environment loading error:", error );
			toast( {
				title: "Error Loading Environment",
				description: `${envData.name}: ${error.message || "Unknown error"}`,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	const handleModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setModel( modelIndex );
		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Model..." } );

		try {

			await window.pathTracerApp.loadExampleModels( modelIndex );
			toast( {
				title: "Model Loaded Successfully",
				description: MODEL_FILES[ modelIndex ].name,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: `${MODEL_FILES[ modelIndex ].name}: ${error.message}`,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Model Loaded...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	const handleDebugModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setDebugModel( modelIndex );
		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 0 } );

		try {

			await window.pathTracerApp.loadModel( DEBUG_MODELS[ modelIndex ].url );
			toast( {
				title: "Model Loaded Successfully",
				description: DEBUG_MODELS[ modelIndex ].name,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	// Helper method to create complete material object with defaults (similar to GeometryExtractor)
	const createCompleteMaterialFromAPI = ( apiMaterialInfo ) => {

		// Default values matching GeometryExtractor's getPhysicalDefaults
		const defaults = {
			color: [ 1, 1, 1 ], // white
			emissive: [ 0, 0, 0 ], // black
			emissiveIntensity: 1.0,
			roughness: 1.0,
			metalness: 0.0,
			ior: 1.5,
			opacity: 1.0,
			transmission: 0.0,
			thickness: 0.1,
			attenuationColor: [ 1, 1, 1 ], // white
			attenuationDistance: Infinity,
			dispersion: 0.0,
			sheen: 0.0,
			sheenRoughness: 1.0,
			sheenColor: [ 0, 0, 0 ], // black
			specularIntensity: 1.0,
			specularColor: [ 1, 1, 1 ], // white
			clearcoat: 0.0,
			clearcoatRoughness: 0.0,
			iridescence: 0.0,
			iridescenceIOR: 1.3,
			iridescenceThicknessRange: [ 100, 400 ],
			visible: 1,
			transparent: 0,
			alphaTest: 0.0,
			side: 0 // FrontSide
		};

		// Create complete material by merging API data with defaults
		const completeMaterial = { ...defaults };

		// Apply API properties if they exist
		if ( apiMaterialInfo.color ) completeMaterial.color = apiMaterialInfo.color;
		if ( typeof apiMaterialInfo.metalness === 'number' ) completeMaterial.metalness = apiMaterialInfo.metalness;
		if ( typeof apiMaterialInfo.roughness === 'number' ) completeMaterial.roughness = Math.max( 0.05, apiMaterialInfo.roughness );
		if ( typeof apiMaterialInfo.ior === 'number' ) completeMaterial.ior = apiMaterialInfo.ior;
		if ( typeof apiMaterialInfo.transmission === 'number' ) completeMaterial.transmission = apiMaterialInfo.transmission;

		// Handle density -> attenuationDistance conversion
		if ( typeof apiMaterialInfo.density === 'number' && apiMaterialInfo.density > 0 ) {

			completeMaterial.attenuationDistance = 1000 / apiMaterialInfo.density;

		}

		// Handle transmission materials - set appropriate properties
		if ( completeMaterial.transmission > 0 ) {

			completeMaterial.transparent = 1;
			completeMaterial.side = 2; // DoubleSide for transmissive materials

			// For transmissive materials, use color as attenuation color
			if ( completeMaterial.color ) {

				completeMaterial.attenuationColor = [ ...completeMaterial.color ];

			}

		}

		// Handle thin film properties
		if ( typeof apiMaterialInfo.thinFilmThickness === 'number' ) {

			completeMaterial.iridescence = 1.0;
			completeMaterial.iridescenceThicknessRange = [ apiMaterialInfo.thinFilmThickness, apiMaterialInfo.thinFilmThickness ];

			if ( typeof apiMaterialInfo.thinFilmIor === 'number' ) {

				completeMaterial.iridescenceIOR = apiMaterialInfo.thinFilmIor;

			}

		}

		return completeMaterial;

	};

	function applyMaterialInfo( materialInfo, mat ) {

		if ( ! mat ) return console.error( "Invalid material object provided" );

		// Helper function to ensure property exists and set it
		const ensureAndSet = ( obj, prop, value ) => {

			if ( ! ( prop in obj ) ) {

				// Create the property if it doesn't exist
				obj[ prop ] = value;

			} else {

				obj[ prop ] = value;

			}

		};

		// Helper function for color properties
		const ensureAndSetColor = ( obj, prop, colorArray ) => {

			if ( Array.isArray( colorArray ) && colorArray.length >= 3 ) {

				if ( ! ( prop in obj ) ) {

					// Create Color object if property doesn't exist
					obj[ prop ] = new Color();

				}

				if ( obj[ prop ]?.setRGB ) {

					obj[ prop ].setRGB( colorArray[ 0 ], colorArray[ 1 ], colorArray[ 2 ] );

				}

			}

		};

		// Create complete material with defaults first
		const completeMaterial = createCompleteMaterialFromAPI( materialInfo );

		// Ensure and set all material properties to create a complete PBR material
		// Base colors
		ensureAndSetColor( mat, 'color', completeMaterial.color );
		ensureAndSetColor( mat, 'emissive', completeMaterial.emissive );
		ensureAndSetColor( mat, 'attenuationColor', completeMaterial.attenuationColor );
		ensureAndSetColor( mat, 'specularColor', completeMaterial.specularColor );
		ensureAndSetColor( mat, 'sheenColor', completeMaterial.sheenColor );

		// Basic material properties
		ensureAndSet( mat, 'emissiveIntensity', completeMaterial.emissiveIntensity );
		ensureAndSet( mat, 'roughness', completeMaterial.roughness );
		ensureAndSet( mat, 'metalness', completeMaterial.metalness );
		ensureAndSet( mat, 'ior', completeMaterial.ior );
		ensureAndSet( mat, 'opacity', completeMaterial.opacity );

		// Transmission properties
		ensureAndSet( mat, 'transmission', completeMaterial.transmission );
		ensureAndSet( mat, 'thickness', completeMaterial.thickness );
		ensureAndSet( mat, 'attenuationDistance', completeMaterial.attenuationDistance );

		// Advanced properties
		ensureAndSet( mat, 'dispersion', completeMaterial.dispersion );
		ensureAndSet( mat, 'sheen', completeMaterial.sheen );
		ensureAndSet( mat, 'sheenRoughness', completeMaterial.sheenRoughness );
		ensureAndSet( mat, 'specularIntensity', completeMaterial.specularIntensity );
		ensureAndSet( mat, 'clearcoat', completeMaterial.clearcoat );
		ensureAndSet( mat, 'clearcoatRoughness', completeMaterial.clearcoatRoughness );

		// Iridescence properties
		ensureAndSet( mat, 'iridescence', completeMaterial.iridescence );
		ensureAndSet( mat, 'iridescenceIOR', completeMaterial.iridescenceIOR );
		ensureAndSet( mat, 'iridescenceThicknessRange', completeMaterial.iridescenceThicknessRange );

		// Rendering properties
		ensureAndSet( mat, 'transparent', completeMaterial.transparent > 0 );
		ensureAndSet( mat, 'alphaTest', completeMaterial.alphaTest );
		ensureAndSet( mat, 'visible', completeMaterial.visible > 0 );

		// Handle side property (convert number to Three.js constants)
		const sideMap = { 0: 0, 1: 1, 2: 2 }; // FrontSide, BackSide, DoubleSide
		ensureAndSet( mat, 'side', sideMap[ completeMaterial.side ] ?? 0 );

		// Ensure needsUpdate exists and set it
		ensureAndSet( mat, 'needsUpdate', true );

	}

	const handleMaterialChange = ( value ) => {

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

		// Track the selected material for highlighting
		setSelectedMaterial( materialIndex );

		setLoading( {
			isLoading: true,
			title: "Apply",
			status: "Processing Material...",
			progress: 0
		} );

		try {

			// Output debug info
			console.debug( 'Applying complete API material:', {
				materialIndex,
				materialData: materials[ materialIndex ],
				targetObject: selectedObject,
				targetMaterial: selectedObject.material
			} );

			// Apply material properties to the Three.js material
			applyMaterialInfo( materials[ materialIndex ], selectedObject.material );

			// Check if the material index exists
			if ( selectedObject.userData?.materialIndex === undefined ) {

				console.warn( 'Material index not found on selected object, using default index 0' );

			}

			const objMaterialIndex = selectedObject.userData?.materialIndex ?? 0;

			// For API materials, we need to use the complete material update (updateMaterial)
			// because API materials only have partial properties
			if ( window.pathTracerApp?.pathTracingPass?.updateMaterial ) {

				// Use updateMaterial for complete material reconstruction from API data
				window.pathTracerApp.pathTracingPass.updateMaterial(
					objMaterialIndex,
					selectedObject.material
				);

			} else if ( window.pathTracerApp?.pathTracingPass?.rebuildMaterialDataTexture ) {

				// Legacy fallback
				window.pathTracerApp.pathTracingPass.rebuildMaterialDataTexture(
					objMaterialIndex,
					selectedObject.material
				);

			} else {

				console.warn( 'PathTracer material update function not found' );

			}

			// Reset renderer to apply changes
			if ( window.pathTracerApp?.reset ) {

				window.pathTracerApp.reset();

			}

			toast( {
				title: "Material Applied",
				description: materials[ materialIndex ]?.name || `Material #${materialIndex}`,
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

	};

	// Helper function to get safe string values for ItemsCatalog
	const getModelValue = () => {

		return model !== null && model !== undefined ? model.toString() : null;

	};

	const getMaterialValue = () => {

		return selectedMaterial !== null && selectedMaterial !== undefined ? selectedMaterial.toString() : null;

	};

	const getDebugModelValue = () => {

		return debugModel !== null && debugModel !== undefined ? debugModel.toString() : null;

	};

	return (
		<div className="absolute h-[calc(100%-48px)] w-full">
			<Separator className="bg-primary" />
			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex flex-col h-full w-full"
			>
				<TabsList className="relative grid w-full grid-cols-4 h-auto p-0">
					<TabsTrigger value="models" className="text-xs truncate py-2">
                        Models
					</TabsTrigger>
					<TabsTrigger value="materials" className="text-xs truncate py-2">
                        Materials
					</TabsTrigger>
					<TabsTrigger value="environments" className="text-xs truncate py-2">
                        Env
					</TabsTrigger>
					<TabsTrigger value="tests" className="text-xs truncate py-2">
                        Tests
					</TabsTrigger>
				</TabsList>
				<TabsContent value="models" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={MODEL_FILES}
						value={getModelValue()}
						onValueChange={handleModelChange}
					/>
				</TabsContent>
				<TabsContent value="materials" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={materials}
						value={getMaterialValue()}
						onValueChange={handleMaterialChange}
					/>
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<EnvironmentCatalog
						value={getEnvironmentIndex()}
						onValueChange={handleEnvironmentChange}
					/>
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={DEBUG_MODELS}
						value={getDebugModelValue()}
						onValueChange={handleDebugModelChange}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
