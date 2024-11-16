import { Sliders, Camera, Box, Sun } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SceneTab from './SceneTab';
import CameraTab from './CameraTab';
import LightsTab from './LightsTab';
import AssetsTab from './AssetsTab';
import PathTracerTab from './PathTracerTab';

const RightSidebar = () => {

	return (
		<div className="relative border-l flex flex-col overflow-hidden h-full w-full">
			<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
				<TabsList className="relative grid w-full grid-cols-5 h-12 p-0">
					<TabsTrigger value="pathtracer" className="flex flex-col items-center py-2">
						<Sliders size={12} />
						<span className="text-xs mt-1">Tracer</span>
					</TabsTrigger>
					<TabsTrigger value="scene" className="flex flex-col items-center py-2">
						<Box size={12} />
						<span className="text-xs mt-1">Scene</span>
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
				</TabsList>

				<TabsContent value="scene" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<SceneTab />
				</TabsContent>

				<TabsContent value="camera" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<CameraTab />
				</TabsContent>

				<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<PathTracerTab />
				</TabsContent>

				<TabsContent value="light" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<LightsTab />
				</TabsContent>

				<TabsContent value="assets" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col mt-0">
					<AssetsTab />
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default RightSidebar;
