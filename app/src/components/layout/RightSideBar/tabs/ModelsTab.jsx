import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { MODEL_FILES } from '@/Constants';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';
import SketchfabBrowser from './SketchfabBrowser';

const ModelsTab = () => {

	const { model, setModel, modelsSource, setModelsSource, modelsAction, setModelsAction } = useAssetsStore();
	const { loadModel, loadModelUrl, addModel, appendCatalogModel } = useAssetLoader();

	const isAdd = modelsAction === 'add';

	// Featured catalog: replace the scene or append to it, per the action toggle.
	const handleModelChange = async ( value ) => {

		if ( isAdd ) {

			await appendCatalogModel( value );

		} else {

			setModel( parseInt( value ) );
			await loadModel( value );

		}

	};

	const getModelValue = () => {

		// Highlight reflects the replace-loaded base model; in add mode there's no single selection.
		return ( ! isAdd && model !== null && model !== undefined ) ? model.toString() : null;

	};

	// Sketchfab: the confirm button either replaces the scene or appends, per the toggle.
	const handleSketchfabSelect = useCallback(
		( url, name ) => ( isAdd ? addModel( url, name ) : loadModelUrl( url, name ) ),
		[ isAdd, addModel, loadModelUrl ]
	);

	return (
		<div className="flex flex-col h-full">
			<Tabs
				value={modelsSource}
				onValueChange={setModelsSource}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border">
					<TabsTrigger value="featured" className="text-xs rounded-full">
						Featured
					</TabsTrigger>
					<TabsTrigger value="sketchfab" className="text-xs rounded-full">
						Sketchfab
					</TabsTrigger>
				</TabsList>

				{/* Action toggle — applies to both sources */}
				<div className="flex items-center gap-2 px-2 pt-2">
					<span className="text-[10px] text-muted-foreground shrink-0">On select</span>
					<Tabs value={modelsAction} onValueChange={setModelsAction}>
						<TabsList className="h-auto p-0.5 bg-primary/20">
							<TabsTrigger value="replace" className="text-[11px] px-2 py-0.5 rounded-full">
								Replace
							</TabsTrigger>
							<TabsTrigger value="add" className="text-[11px] px-2 py-0.5 rounded-full">
								Add
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>

				<TabsContent value="featured" className="flex-1 min-h-0 mt-2">
					<ItemsCatalog
						data={MODEL_FILES}
						value={getModelValue()}
						onValueChange={handleModelChange}
						catalogType="models"
					/>
				</TabsContent>

				<TabsContent value="sketchfab" className="flex-1 min-h-0 mt-2">
					<SketchfabBrowser onSelect={handleSketchfabSelect} actionLabel={isAdd ? 'Add to scene' : 'Load'} />
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default ModelsTab;
