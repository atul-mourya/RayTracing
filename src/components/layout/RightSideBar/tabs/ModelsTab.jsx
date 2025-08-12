import { ItemsCatalog } from '@/components/ui/items-catalog';
import { MODEL_FILES } from '@/Constants';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';

const ModelsTab = () => {

	const { model, setModel } = useAssetsStore();
	const { loadModel } = useAssetLoader();

	const handleModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setModel( modelIndex );
		await loadModel( value );

	};

	const getModelValue = () => {

		return model !== null && model !== undefined ? model.toString() : null;

	};

	return (
		<ItemsCatalog
			data={MODEL_FILES}
			value={getModelValue()}
			onValueChange={handleModelChange}
		/>
	);

};

export default ModelsTab;
