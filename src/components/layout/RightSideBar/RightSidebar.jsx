import { useMemo, memo, useCallback, lazy, Suspense } from 'react';
import { Sliders, Camera, Box, Sun, SwatchBook, Blend, PocketKnife, Bot } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from '@/components/ui/separator';
import { useStore } from '@/store';
import FinalRenderPanel from './FinalRenderPanel';

// Lazy load tab components for better initial performance
const CameraTab = lazy( () => import( './CameraTab' ) );
const LightsTab = lazy( () => import( './LightsTab' ) );
const AssetsTab = lazy( () => import( './AssetsTab' ) );
const PathTracerTab = lazy( () => import( './PathTracerTab' ) );
const MaterialTab = lazy( () => import( './MaterialTab' ) );
const ColorCorrectionsTab = lazy( () => import( './ColorCorrectionsTab' ) );
const AITab = lazy( () => import( './AITab' ) );

// Loading fallback component
const TabLoadingFallback = () => (
	<div className="flex items-center justify-center h-32">
		<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
	</div>
);

// Memoized tab content components to prevent unnecessary re-renders

const InteractiveModeTabs = memo( () => {

	const activeTab = useStore( state => state.activeTab );
	const setActiveTab = useStore( state => state.setActiveTab );

	return (
		<Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full w-full">
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
				<TabsTrigger value="material" className="flex flex-col items-center py-2">
					<SwatchBook size={12} />
					<span className="text-xs mt-1">Material</span>
				</TabsTrigger>
				<TabsTrigger value="assets" className="flex flex-col items-center py-2">
					<Box size={12} />
					<span className="text-xs mt-1">Assets</span>
				</TabsTrigger>
			</TabsList>

			<TabsContent value="camera" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<CameraTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<PathTracerTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="light" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<LightsTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="material" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<MaterialTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="assets" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<AssetsTab />
				</Suspense>
			</TabsContent>
		</Tabs>
	);

} );

InteractiveModeTabs.displayName = 'InteractiveModeTabs';

const FinalRenderModeTabs = memo( () => (
	<div className="flex flex-col h-full w-full">
		<FinalRenderPanel />
	</div>
) );

FinalRenderModeTabs.displayName = 'FinalRenderModeTabs';

const ResultsModeTabs = memo( () => (
	<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
		<TabsList className="relative grid w-full grid-cols-4 h-12 p-0">
			<TabsTrigger value="pathtracer" className="flex flex-col items-center py-2">
				<Sliders size={12} />
				<span className="text-xs mt-1">Adjust</span>
			</TabsTrigger>
			<TabsTrigger value="tool" className="flex flex-col items-center py-2">
				<PocketKnife size={12} />
				<span className="text-xs mt-1">Tool</span>
			</TabsTrigger>
			<TabsTrigger value="ai" className="flex flex-col items-center py-2">
				<Bot size={12} />
				<span className="text-xs mt-1">AI</span>
			</TabsTrigger>
			<TabsTrigger value="filters" className="flex flex-col items-center py-2">
				<Blend size={12} />
				<span className="text-xs mt-1">Filters</span>
			</TabsTrigger>
		</TabsList>

		<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<ColorCorrectionsTab />
			</Suspense>
		</TabsContent>

		<TabsContent value="tool" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<div><Separator className="bg-primary" /><p className="pt-4 text-sm text-center text-muted-foreground">Coming Soon !!</p></div>
		</TabsContent>

		<TabsContent value="ai" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<AITab />
			</Suspense>
		</TabsContent>

		<TabsContent value="filters" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<div><Separator className="bg-primary" /><p className="pt-4 text-sm text-center text-muted-foreground">Coming Soon !!</p></div>
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

			case 'preview':
				return <InteractiveModeTabs />;
			case 'results':
				return <ResultsModeTabs />;
			default: // 'final-render'
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
