import { useEffect } from 'react';
import { initDatabase } from '@/utils/database';
import TopBar from './components/layout/TopBar/TopBar';
import LeftSidebar from '@/components/layout/LeftSideBar/LeftSidebar';
import ViewportTabs from './components/layout/Viewports/ViewportTabs';
import RightSidebar from './components/layout/RightSideBar/RightSidebar';
import { ThemeProvider } from "@/components/theme-provider";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useDebouncedCallback } from 'use-debounce';
import { useStore } from '@/store';

const App = () => {

	const handleResize = useDebouncedCallback( () => window.dispatchEvent( new Event( 'resize' ) ), 500 );

	useEffect( () => {

		const init = async () => {

		  try {

				await initDatabase();
				console.log( 'Database initialized successfully' );

			} catch ( error ) {

				console.error( 'Failed to initialize database:', error );

			}

		};

		init();

	}, [] );

	// Global keyboard shortcuts
	useEffect( () => {

		const handleKeyDown = ( event ) => {

			// Ignore shortcuts when typing in input fields
			if ( event.target.tagName === 'INPUT' ||
				 event.target.tagName === 'TEXTAREA' ||
				 event.target.contentEditable === 'true' ) {

				return;

			}

			// Prevent default behavior only for our specific shortcuts
			switch ( event.key ) {

				case 'Escape':
					event.preventDefault();
					handleDeselect();
					break;

				case 'r':
				case 'R':
					event.preventDefault();
					handleResetCamera();
					break;

				case ' ':
					event.preventDefault();
					handleTogglePlayPause();
					break;

				default:
					break;

			}

		};

		// Keyboard shortcut handlers
		const handleDeselect = () => {

			if ( window.pathTracerApp ) {

				// Deselect any selected object
				window.pathTracerApp.selectObject( null );
				window.pathTracerApp.refreshFrame?.();

				// Update the store to reflect deselection
				const { setSelectedObject } = useStore.getState();
				setSelectedObject( null );

			}

		};

		const handleResetCamera = () => {

			if ( window.pathTracerApp?.controls ) {

				// Reset the orbit controls to their default state
				window.pathTracerApp.controls.reset();

			}

		};

		const handleTogglePlayPause = () => {

			if ( window.pathTracerApp ) {

				// Toggle rendering pause state
				const isCurrentlyPaused = window.pathTracerApp.pauseRendering;

				if ( isCurrentlyPaused ) {

					// Resume rendering
					window.pathTracerApp.pauseRendering = false;
					window.pathTracerApp.reset();

				} else {

					// Pause rendering
					window.pathTracerApp.pauseRendering = true;

				}

			}

		};

		// Add event listener
		window.addEventListener( 'keydown', handleKeyDown );

		// Cleanup
		return () => {

			window.removeEventListener( 'keydown', handleKeyDown );

		};

	}, [] );

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
						<ViewportTabs />
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
