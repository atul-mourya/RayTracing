import { EnvironmentCatalog } from '@/components/ui/env-catalog';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';

const EnvironmentsTab = () => {

	const { selectedEnvironmentIndex } = useAssetsStore();
	const { loadEnvironment } = useAssetLoader();

	const getEnvironmentIndex = () => {

		return selectedEnvironmentIndex !== null && selectedEnvironmentIndex !== undefined
			? selectedEnvironmentIndex.toString()
			: null;

	};

	return (
		<EnvironmentCatalog
			value={getEnvironmentIndex()}
			onValueChange={loadEnvironment}
		/>
	);

};

export default EnvironmentsTab;
