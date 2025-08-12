import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssetsStore } from '@/store';
import ModelsTab from './tabs/ModelsTab';
import MaterialsTab from './tabs/MaterialsTab';
import EnvironmentsTab from './tabs/EnvironmentsTab';
import TestsTab from './tabs/TestsTab';

const AssetsTab = () => {

	const { activeTab, setActiveTab } = useAssetsStore();

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
					<ModelsTab />
				</TabsContent>
				<TabsContent value="materials" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<MaterialsTab />
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<EnvironmentsTab />
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<TestsTab />
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
