import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MODEL_FILES, DEBUG_MODELS, DEFAULT_STATE } from '../../core/Processor/Constants';
import { EnvironmentCatalog } from '@/components/ui/env-catalog';
import { useToast } from "@/hooks/use-toast";
import { create } from 'zustand';
import { useEffect } from 'react';
import { useStore } from '@/store';

const useAssetsStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [], setMaterials: ( materials ) => set( { materials } ),
	setActiveTab: ( tab ) => set( { activeTab: tab } ),
	setModel: ( model ) => set( { model } ),
	setEnvironment: ( env ) => set( { environment: env } ),
	setDebugModel: ( model ) => set( { debugModel: model } ),
} ) );

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
		setActiveTab,
		setModel,
		setEnvironment,
		setDebugModel,
		setMaterials,
	} = useAssetsStore();

	useEffect( () => {

		const onMaterialFetch = ( data ) => {

			let materials = data.map( ( mData ) => ( {
				...mData,
				preview: mData.reference[ 0 ]

			} ) );
			setMaterials( materials );

		};

		fetch( 'https://api.physicallybased.info/materials' )
			.then( response => response.json() )
			.then( data => onMaterialFetch( data ) )
			.catch( error => console.error( 'Error fetching materials:', error ) );

	}, [] );

	const handleEnvironmentChange = async ( envData ) => {

		if ( ! envData || ! envData.url ) return;

		setEnvironment( envData );
		if ( window.pathTracerApp ) {

			setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 0 } );
			try {

				await window.pathTracerApp.loadEnvironment( envData.url );

				toast( {
					title: "Environment Loaded Successfully",
					description: envData.name,
				} );

			} catch ( error ) {

				toast( {
					title: "Error Loading Environment",
					description: `${envData.name}: ${error.message}`,
					variant: "destructive",
				} );

			} finally {

				window.pathTracerApp.reset();
				setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 100 } );
				setTimeout( () => useStore.getState().resetLoading(), 1000 );

			}

		}

	};

	const handleModelChange = ( value ) => {

		setModel( value );
		if ( window.pathTracerApp ) {

			setLoading( { isLoading: true, title: "Loading", status: "Loading Model..." } );
			window.pathTracerApp.loadExampleModels( value )
				.then( () => {

					toast( {
						title: "Model Loaded Successfully",
						description: `${MODEL_FILES[ value ].name}`,
					} );

				} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Model",
						description: `${MODEL_FILES[ value ].name}: ${error.message}`,
						variant: "destructive",
					} );

				} ).finally( () => {

					window.pathTracerApp.reset();
					setLoading( { isLoading: true, title: "Loading", status: "Model Loaded...", progress: 100 } );
					setTimeout( () => useStore.getState().resetLoading(), 1000 );

				} );

		}

	};

	const handleDebugModelChange = ( value ) => {

		setDebugModel( value );
		if ( window.pathTracerApp ) {

			setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 0 } );
			window.pathTracerApp.loadModel( DEBUG_MODELS[ value ].url )
				.then( () => {

					toast( {
						title: "Model Loaded Successfully",
						description: `${MODEL_FILES[ value ].name}`,
					} );

				} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Model",
						description: `${error.message}`,
						variant: "destructive",
					} );

				} ).finally( () => {

					window.pathTracerApp.reset();
					setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 100 } );
					setTimeout( () => useStore.getState().resetLoading(), 1000 );

				} );

		}

	};

	function applyMaterialInfo( info, material ) {

		// defaults
		material.color.set( 0xffffff );
		material.transmission = info.transmission ?? 0.0;
		material.attenuationDistance = Infinity;
		material.attenuationColor.set( 0xffffff );
		material.specularColor.set( 0xffffff );
		material.metalness = info.metalness ?? 0.0;
		material.roughness = info.roughness ?? 1.0;
		material.ior = info.ior ?? 1.5;
		material.thickness = 1.0;
		material.iridescence = 0.0;
		material.iridescenceIOR = 1.0;
		material.iridescenceThicknessRange = [ 100, 400 ];

		// apply database values
		if ( info.specularColor ) material.specularColor.setRGB( ...info.specularColor );
		if ( 'thinFilmThickness' in info ) {

			material.iridescence = 1.0;
			material.iridescenceIOR = info.thinFilmIor;
			material.iridescenceThicknessRange = [ info.thinFilmThickness, info.thinFilmThickness ];

		}

		if ( material.transmission ) {

			if ( info.color ) {

				material.attenuationColor.setRGB( ...info.color );

			}

			// Blender uses 1 / density when exporting volume transmission which doesn't look
			// exactly right. But because the scene is 1000x in size we multiply by 1000 here.
			material.attenuationDistance = 1000 / info.density;

		} else {

			if ( info.color ) {

				material.color.setRGB( ...info.color );

			}

		}

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

		setLoading( { isLoading: true, title: "Apply", status: "Processing Material...", progress: 0 } );
		applyMaterialInfo( materials[ value ], selectedObject.material );
		window.pathTracerApp.pathTracingPass.rebuildMaterialDataTexture( selectedObject.userData.materialIndex, selectedObject.material );
		window.pathTracerApp.reset();
		useStore.getState().resetLoading();

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
					<ItemsCatalog data={MODEL_FILES} value={model} onValueChange={handleModelChange} />
				</TabsContent>
				<TabsContent value="materials" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog data={materials} value={null} onValueChange={handleMaterialChange} />
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<EnvironmentCatalog value={environment?.id} onValueChange={handleEnvironmentChange} />
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog data={DEBUG_MODELS} value={debugModel} onValueChange={handleDebugModelChange} />
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
