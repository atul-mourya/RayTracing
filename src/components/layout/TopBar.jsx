import { useState, useEffect } from 'react';
import { Menu, Play, Pause, Save, FolderOpen, Link, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Focus, Loader2, Github, ChevronDown } from 'lucide-react';
import { ThemeToggle } from '../theme-toggle';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from '@/hooks/use-toast';
import AuthProvider from './AuthProvider';
import { NavUser } from '@/components/ui/nav-user';
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore, usePathTracerStore } from '@/store';

const TopBar = () => {

	const { toast } = useToast();
	const [ isImportModalOpen, setIsImportModalOpen ] = useState( false );
	const [ importUrl, setImportUrl ] = useState( '' );
	const [ isImporting, setIsImporting ] = useState( false );

	// Viewport tab state (moved from ViewportTabs)
	const [ activeTab, setActiveTab ] = useState( "interactive" );
	const setAppMode = useStore( state => state.setAppMode );
	const setBounces = usePathTracerStore( state => state.setBounces );
	const setSamplesPerPixel = usePathTracerStore( state => state.setSamplesPerPixel );
	const setInteractionModeEnabled = usePathTracerStore( state => state.setInteractionModeEnabled );
	const setEnableOIDN = usePathTracerStore( state => state.setEnableOIDN );
	const setUseGBuffer = usePathTracerStore( state => state.setUseGBuffer );
	const setResolution = usePathTracerStore( state => state.setResolution );
	const setRenderMode = usePathTracerStore( state => state.setRenderMode );

	// Store the previous state to restore when switching back from results
	const [ prevState, setPrevState ] = useState( {
	    bounces: 2,
	    samplesPerPixel: 1,
	    interactionModeEnabled: true,
	    enableOIDN: false,
	    resolution: '1'
	} );

	// Update app mode when tab changes (moved from ViewportTabs)
	useEffect( () => {

		// Update our global mode state when tab changes
		setAppMode( activeTab );

		// Configure the renderer settings based on mode
		if ( activeTab === "interactive" ) {

			setBounces( 2 );
			setSamplesPerPixel( 1 );
			setInteractionModeEnabled( true );
			setEnableOIDN( false );
			setUseGBuffer( false );
			setResolution( '1' );
			setRenderMode( 0 );
			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = true;
				setTimeout( () => {

					window.pathTracerApp.denoiser.toggleUseGBuffer( false );
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 0.5 );

				}, 100 );

			}

		} else if ( activeTab === "final" ) {

			setBounces( 8 );
			setSamplesPerPixel( 4 );
			setInteractionModeEnabled( false );
			setEnableOIDN( true );
			setUseGBuffer( true );
			setResolution( '3' );
			setRenderMode( 1 );
			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = false;
				setTimeout( () => {

					window.pathTracerApp.denoiser.toggleUseGBuffer( true );
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 2.0 );

				}, 100 );

			}

		} else if ( activeTab === "results" ) {

			// Save current state before switching to results
			if ( activeTab !== "results" && window.pathTracerApp ) {

				setPrevState( {
					bounces: usePathTracerStore.getState().bounces,
					samplesPerPixel: usePathTracerStore.getState().samplesPerPixel,
					interactionModeEnabled: usePathTracerStore.getState().interactionModeEnabled,
					enableOIDN: usePathTracerStore.getState().enableOIDN,
					resolution: usePathTracerStore.getState().resolution
				} );

			}

			// Results mode - just hide the PathTracer output but don't destroy it
			if ( window.pathTracerApp ) {

				// Pause rendering to save resources
				window.pathTracerApp.pauseRendering = true;

				// Disable controls but keep the app instance
				window.pathTracerApp.controls.enabled = false;

				// Hide the canvas but don't destroy the app
				if ( window.pathTracerApp.renderer && window.pathTracerApp.renderer.domElement ) {

					window.pathTracerApp.renderer.domElement.style.display = 'none';

				}

				if ( window.pathTracerApp.denoiser && window.pathTracerApp.denoiser.output ) {

					window.pathTracerApp.denoiser.output.style.display = 'none';

				}

			}

		}

	}, [ activeTab, setAppMode, setBounces, setSamplesPerPixel, setInteractionModeEnabled, setEnableOIDN, setResolution ] );

	// When switching back from results, restore the canvas visibility
	useEffect( () => {

		if ( activeTab !== "results" && window.pathTracerApp ) {

			// Show canvases again
			if ( window.pathTracerApp.renderer && window.pathTracerApp.renderer.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'block';

			}

			if ( window.pathTracerApp.denoiser && window.pathTracerApp.denoiser.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'block';

			}

			// Resume rendering if coming from results tab
			if ( activeTab === "interactive" || activeTab === "final" ) {

				window.pathTracerApp.pauseRendering = false;
				window.pathTracerApp.reset();

			}

		}

	}, [ activeTab ] );

	const handleTabChange = ( value ) => {

		setActiveTab( value );

	};

	const validateUrl = ( url ) => {

		// url validation logic for valid model with extension
		if ( ! url ) return false;
		if ( ! url.startsWith( 'http' ) ) return false;
		if ( ! url.endsWith( '.glb' ) && ! url.endsWith( '.gltf' ) ) return false;
		try {

			new URL( url );
			return true;

		} catch {

			return false;

		}

	};

	const handleImportFromUrl = () => {

		if ( ! validateUrl( importUrl ) ) {

			toast( {
				title: "Invalid URL",
				description: "Please enter a valid URL.",
				variant: "destructive",
			} );
			return;

		}

		setIsImporting( true );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadModel( importUrl )
				.then( () => {

					setIsImporting( false );
					setImportUrl( '' );
					setIsImportModalOpen( false );
					toast( {
						title: "Model Loaded",
						description: "Successfully loaded model !!",
					} );

				} )
				.catch( ( error ) => {

					setIsImporting( false );
					toast( {
						title: "Error Loading Model",
						description: `${error}`,
						variant: "destructive",
					} );

				} );

		} else {

			setIsImporting( false );

		}

	};

	const handleGithubRedirection = () => {

		window.open( 'https://github.com/atul-mourya/RayTracing', '_blank' );

	};

	return (
		<AuthProvider>
			{( { user, handleLoginClick, handleSignOut } ) => (
				<div className="flex items-center h-[48px] border-b border-[#4a4a4a]">
					<div className="flex items-center space-x-2 mr-4 px-2">
						<Menu size={18} />
						<span className="font-semibold">RayCanvas</span>
					</div>

					<Menubar className="border-none">
						<MenubarMenu>
							<MenubarTrigger className="font-normal">File</MenubarTrigger>
							<MenubarContent>
								<MenubarItem disabled className="flex items-center">
									<FolderOpen className="mr-2 h-4 w-4" />
									<span>Open</span>
								</MenubarItem>
								<MenubarItem onSelect={() => setIsImportModalOpen( true )} className="flex items-center">
									<Link className="mr-2 h-4 w-4" />
									<span>Import from URL</span>
								</MenubarItem>
								<MenubarItem disabled className="flex items-center">
									<Save className="mr-2 h-4 w-4" />
									<span>Save</span>
								</MenubarItem>
								<MenubarSeparator />
								<MenubarItem disabled>Exit</MenubarItem>
							</MenubarContent>
						</MenubarMenu>

						<MenubarMenu>
							<MenubarTrigger className="font-normal">Edit</MenubarTrigger>
							<MenubarContent>
								<MenubarItem disabled className="flex items-center">
									<Undo className="mr-2 h-4 w-4" />
									<span>Undo</span>
								</MenubarItem>
								<MenubarItem disabled className="flex items-center">
									<Redo className="mr-2 h-4 w-4" />
									<span>Redo</span>
								</MenubarItem>
								<MenubarSeparator />
								<MenubarItem disabled className="flex items-center">
									<Copy className="mr-2 h-4 w-4" />
									<span>Copy</span>
								</MenubarItem>
								<MenubarItem disabled className="flex items-center">
									<ClipboardPaste className="mr-2 h-4 w-4" />
									<span>Paste</span>
								</MenubarItem>
							</MenubarContent>
						</MenubarMenu>

						<MenubarMenu>
							<MenubarTrigger className="font-normal">View</MenubarTrigger>
							<MenubarContent>
								<MenubarItem disabled className="flex items-center">
									<ZoomIn className="mr-2 h-4 w-4" />
									<span>Zoom In</span>
								</MenubarItem>
								<MenubarItem disabled className="flex items-center">
									<ZoomOut className="mr-2 h-4 w-4" />
									<span>Zoom Out</span>
								</MenubarItem>
								<MenubarItem disabled className="flex items-center">
									<Focus className="mr-2 h-4 w-4" />
									<span>Reset View</span>
								</MenubarItem>
							</MenubarContent>
						</MenubarMenu>
					</Menubar>

					<div className="grow" />

					{/* Viewport tabs with new Results tab */}
					<Tabs
						defaultValue="interactive"
						value={activeTab}
						onValueChange={handleTabChange}
					>
						<TabsList>
							<TabsTrigger value="interactive">Interactive</TabsTrigger>
							<TabsTrigger value="final">Final Render</TabsTrigger>
							<TabsTrigger value="results">Results</TabsTrigger>
						</TabsList>
					</Tabs>

					<div className="grow" />
					<div className="flex items-center px-2 space-x-2">
						<ThemeToggle />
						<div className="text-xs">v3.0</div>
						<ChevronDown size={14} />
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Github className="cursor-pointer" onClick={handleGithubRedirection} />
								</TooltipTrigger>
								<TooltipContent>View on GitHub</TooltipContent>
							</Tooltip>
						</TooltipProvider>
						{user ?
							<NavUser user={user} onLogout={handleSignOut} /> : (
								<Button variant="default" size="sm" onClick={handleLoginClick}>
                                    Login
								</Button>
							)}
					</div>

					{/* Import from URL Modal */}
					<Dialog open={isImportModalOpen} onOpenChange={setIsImportModalOpen}>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Import from URL</DialogTitle>
								<DialogDescription>
                                    Enter the URL of the GLB / GLTF file you want to import.
								</DialogDescription>
							</DialogHeader>
							<Input
								value={importUrl}
								onChange={( e ) => setImportUrl( e.target.value )}
								placeholder="Enter URL"
							/>
							<DialogFooter>
								<Button variant="outline" onClick={() => setIsImportModalOpen( false )} disabled={isImporting}>
                                    Cancel
								</Button>
								<Button onClick={handleImportFromUrl} disabled={isImporting}>
									{isImporting ? (
										<>
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Importing...
										</>
									) : (
										'Import'
									)}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</div>
			)}
		</AuthProvider>
	);

};

export default TopBar;
