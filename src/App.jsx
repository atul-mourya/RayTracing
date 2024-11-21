import TopBar from './components/layout/TopBar';
import LeftSidebar from '@/components/layout/LeftSidebar';
import MainViewport from './components/layout/MainViewport';
import RightSidebar from './components/layout/RightSidebar';
import { ThemeProvider } from "@/components/theme-provider";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useDebouncedCallback } from 'use-debounce';


const App = () => {

	const handleResize = useDebouncedCallback( () => window.dispatchEvent( new Event( 'resize' ) ), 500 );

	return (
		<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
			<div className="flex flex-col w-screen h-screen">
				<TopBar />
				<ResizablePanelGroup direction="horizontal" className="flex flex-1 overflow-hidden h-full">
					<ResizablePanel onResize={handleResize} className="min-w-[200px]" defaultSize={20}>
						<LeftSidebar />
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel className="min-w-[200px]" defaultSize={60}>
						<MainViewport />
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel onResize={handleResize} className="min-w-[200px] h-full" defaultSize={20}>
						<RightSidebar />
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</ThemeProvider>
	);

};

export default App;
