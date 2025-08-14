import { useMemo, memo, useCallback } from 'react';
import { Sliders, Camera, Box, Sun, SwatchBook, Blend, PocketKnife } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from '@/store';
import CameraTab from './CameraTab';
import LightsTab from './LightsTab';
import AssetsTab from './AssetsTab';
import PathTracerTab from './PathTracerTab';
import FinalRenderPanel from './FinalRenderPanel';
import MaterialTab from './MaterialTab';
import ColorCorrectionsTab from './ColorCorrectionsTab';

// Memoized tab content components to prevent unnecessary re-renders

const InteractiveModeTabs = memo( () => (
	<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
		<TabsList className="relative grid w-full grid-cols-5 h-12 p-0">
			<TabsTrigger value="pathtracer" className="flex flex-col items-center py-2">
				<Sliders size={12} />
				<span className="text-xs mt-1">Tracer</span>
			</TabsTrigger>
			<TabsTrigger value="camera" className="flex flex-col items-center py-2">
				<Camera size={12} />
				<span className="text-xs mt-1">Camera</span>
			</TabsTrigger>
			<TabsTrigger value="light" className="flex flex-col items-center py-2">
				<Sun size={12} />
				<span className="text-xs mt-1">Light</span>
			</TabsTrigger>
			<TabsTrigger value="assets" className="flex flex-col items-center py-2">
				<Box size={12} />
				<span className="text-xs mt-1">Assets</span>
			</TabsTrigger>
			<TabsTrigger value="material" className="flex flex-col items-center py-2">
				<SwatchBook size={12} />
				<span className="text-xs mt-1">Material</span>
			</TabsTrigger>
		</TabsList>

		<TabsContent value="camera" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			<CameraTab />
		</TabsContent>

		<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			<PathTracerTab />
		</TabsContent>

		<TabsContent value="light" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			<LightsTab />
		</TabsContent>

		<TabsContent value="assets" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col mt-0 overflow-y-auto">
			<AssetsTab />
		</TabsContent>

		<TabsContent value="material" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			<MaterialTab />
		</TabsContent>
	</Tabs>
) );

InteractiveModeTabs.displayName = 'InteractiveModeTabs';

const FinalRenderModeTabs = memo( () => (
	<div className="flex flex-col h-full w-full">
		<FinalRenderPanel />
	</div>
) );

FinalRenderModeTabs.displayName = 'FinalRenderModeTabs';

const ResultsModeTabs = memo( () => (
	<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
		<TabsList className="relative grid w-full grid-cols-3 h-12 p-0">
			<TabsTrigger value="pathtracer" className="flex flex-col items-center py-2">
				<Sliders size={12} />
				<span className="text-xs mt-1">Adjust</span>
			</TabsTrigger>
			<TabsTrigger value="tool" className="flex flex-col items-center py-2">
				<PocketKnife size={12} />
				<span className="text-xs mt-1">Tool</span>
			</TabsTrigger>
			<TabsTrigger value="filters" className="flex flex-col items-center py-2">
				<Blend size={12} />
				<span className="text-xs mt-1">Filters</span>
			</TabsTrigger>
		</TabsList>

		<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			<ColorCorrectionsTab />
		</TabsContent>

		<TabsContent value="tool" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			Coming Soon !!
		</TabsContent>

		<TabsContent value="filters" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto">
			Coming Soon !!
		</TabsContent>
	</Tabs>
) );

ResultsModeTabs.displayName = 'ResultsModeTabs';

// Main RightSidebar component
const RightSidebar = () => {

	// Optimized store subscription - only subscribe to appMode
	const appMode = useStore( useCallback( state => state.appMode, [] ) );

	// Use useMemo to determine which component to render based on appMode
	const currentModeComponent = useMemo( () => {

		switch ( appMode ) {

			case 'interactive':
				return <InteractiveModeTabs />;
			case 'results':
				return <ResultsModeTabs />;
			default: // 'final'
				return <FinalRenderModeTabs />;

		}

	}, [ appMode ] );

	return (
		<div className="relative border-l flex flex-col overflow-hidden h-full w-full">
			{currentModeComponent}
		</div>
	);

};

// Export a memoized version of the component to prevent unnecessary re-renders
export default memo( RightSidebar );
