import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ViewportTabs = ( { currentMode, onModeChange } ) => {

	return (
		<Tabs
			defaultValue="interactive"
			value={currentMode}
			onValueChange={onModeChange}
		>
			<TabsList>
				<TabsTrigger value="interactive">Preview</TabsTrigger>
				<TabsTrigger value="final">Render</TabsTrigger>
				<TabsTrigger value="results">Results</TabsTrigger>
			</TabsList>
		</Tabs>
	);

};

export default ViewportTabs;
