import { ItemsCatalog } from '@/components/ui/items-catalog';
import { DEBUG_MODELS } from '@/Constants';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';

const TestsTab = () => {

	const { debugModel, setDebugModel } = useAssetsStore();
	const { loadDebugModel } = useAssetLoader();

	const handleDebugModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setDebugModel( modelIndex );
		await loadDebugModel( value );

	};

	const getDebugModelValue = () => {

		return debugModel !== null && debugModel !== undefined ? debugModel.toString() : null;

	};

	return (
		<ItemsCatalog
			data={DEBUG_MODELS}
			value={getDebugModelValue()}
			onValueChange={handleDebugModelChange}
		/>
	);

};

export default TestsTab;
