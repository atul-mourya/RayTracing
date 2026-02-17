import { useEffect, useCallback, useRef } from 'react';
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
import { useStore } from '@/store';
import { getApp } from '@/core/appProxy';

const App = () => {

	// Memoized debounced resize handler to prevent recreation on every render
	const timeoutRef = useRef( null );
	const handleResize = useCallback( () => {

		if ( timeoutRef.current ) {

			clearTimeout( timeoutRef.current );

		}

		timeoutRef.current = setTimeout( () => {

			window.dispatchEvent( new Event( 'resize' ) );

		}, 500 );

	}, [] );

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
					// Only trigger if no modifier keys are pressed
					if ( ! event.ctrlKey && ! event.altKey && ! event.shiftKey && ! event.metaKey ) {

						event.preventDefault();
						handleResetCamera();

					}

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

			const app = getApp();
			if ( app ) {

				// Deselect any selected object
				app.selectObject( null );
				app.refreshFrame?.();

				// Update the store to reflect deselection
				const { setSelectedObject } = useStore.getState();
				setSelectedObject( null );

			}

		};

		const handleResetCamera = () => {

			const app = getApp();
			if ( app?.controls ) {

				// Reset the orbit controls to their default state
				app.controls.reset();

			}

		};

		const handleTogglePlayPause = () => {

			const app = getApp();
			if ( app ) {

				const renderComplete = app.isComplete();

				if ( renderComplete ) {

					// If rendering is complete, always restart
					app.pauseRendering = false;
					app.reset();

				} else {

					// If rendering is in progress, toggle pause/resume
					const isCurrentlyPaused = app.pauseRendering;

					if ( isCurrentlyPaused ) {

						// Resume rendering from where it left off
						app.pauseRendering = false;

					} else {

						// Pause rendering
						app.pauseRendering = true;

					}

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
