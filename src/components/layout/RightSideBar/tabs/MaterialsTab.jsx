import { ItemsCatalog } from '@/components/ui/items-catalog';
import { useAssetsStore } from '@/store';
import { useMaterialApplicator } from '@/hooks/useMaterialApplicator';

const MaterialsTab = () => {

	const { materials, selectedMaterial } = useAssetsStore();
	const { applyMaterial } = useMaterialApplicator();

	const getMaterialValue = () => {

		return selectedMaterial !== null && selectedMaterial !== undefined ? selectedMaterial.toString() : null;

	};

	return (
		<ItemsCatalog
			data={materials}
			value={getMaterialValue()}
			onValueChange={applyMaterial}
		/>
	);

};

export default MaterialsTab;
