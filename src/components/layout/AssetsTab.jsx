import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HDR_FILES, MODEL_FILES, DEBUG_MODELS, DEFAULT_STATE } from '../../core/Processor/Constants';
import { useToast } from "@/hooks/use-toast";
import { create } from 'zustand';

const useAssetsStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	setActiveTab: ( tab ) => set( { activeTab: tab } ),
	setModel: ( model ) => set( { model } ),
	setEnvironment: ( env ) => set( { environment: env } ),
	setDebugModel: ( model ) => set( { debugModel: model } )
} ) );

const AssetsTab = () => {

	const { toast } = useToast();
	const {
		activeTab,
		model,
		environment,
		debugModel,
		setActiveTab,
		setModel,
		setEnvironment,
		setDebugModel
	} = useAssetsStore();

	const handleEnvironmentChange = ( value ) => {

		setEnvironment( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadEnvironment( value )
				.then( () => {

					toast( {
						title: "Environment Loaded Successfully",
						description: `${HDR_FILES[ value ].name}`,
					} );

				} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Environment",
						description: `${HDR_FILES[ value ].name}: ${error.message}`,
						variant: "destructive",
					} );

				} );

		}

	};

	const handleModelChange = ( value ) => {

		setModel( value );
		if ( window.pathTracerApp ) {

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

				} );

		}

	};

	const handleDebugModelChange = ( value ) => {

		setDebugModel( value );
		if ( window.pathTracerApp ) {

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

				} );

		}

	};

	return (
		<div className="absolute h-[calc(100%-48px)] w-full">
			<Separator className="bg-primary"/>
			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex flex-col h-full w-full"
			>
				<TabsList className="relative grid w-full grid-cols-3 h-auto p-0">
					<TabsTrigger value="models" className="text-xs truncate py-2">
            Models
					</TabsTrigger>
					<TabsTrigger value="environments" className="text-xs truncate py-2">
            Env
					</TabsTrigger>
					<TabsTrigger value="tests" className="text-xs truncate py-2">
            Tests
					</TabsTrigger>
				</TabsList>
				<TabsContent value="models" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog data={MODEL_FILES} value={model} onValueChange={handleModelChange}/>
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog data={HDR_FILES} value={environment} onValueChange={handleEnvironmentChange} />
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog data={DEBUG_MODELS} value={debugModel} onValueChange={handleDebugModelChange} />
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
