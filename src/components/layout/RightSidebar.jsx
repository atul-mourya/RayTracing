import { Sliders, Camera, Box, Sun, SwatchBook } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from '@/store'; // Import the path tracer store
import CameraTab from './CameraTab';
import LightsTab from './LightsTab';
import AssetsTab from './AssetsTab';
import PathTracerTab from './PathTracerTab';
import FinalRenderPanel from './FinalRenderPanel';
import MaterialTab from './MaterialTab';

const RightSidebar = () => {

	const appMode = useStore( state => state.appMode );

	const interactiveModeMenu = () => {

		return (
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
		);

	};

	const finalRenderModeMenu = () => {

		return (
			<div className="flex flex-col h-full w-full">
				<FinalRenderPanel />
			</div>
		);

	};

	return (
		<div className="relative border-l flex flex-col overflow-hidden h-full w-full">
			{appMode === 'interactive' ? interactiveModeMenu() : finalRenderModeMenu() }
		</div>
	);

};

export default RightSidebar;
