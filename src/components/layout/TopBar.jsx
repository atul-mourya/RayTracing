import { useMemo, useCallback, useState } from 'react';
import { Menu, Save, FolderOpen, Link, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Focus, Loader2, Github, ChevronDown } from 'lucide-react';
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

// Memoized ImportUrlModal component to prevent unnecessary re-renders
const ImportUrlModal = ( {
	isOpen,
	onClose,
	importUrl,
	setImportUrl,
	onImport,
	isImporting
} ) => (
	<Dialog open={isOpen} onOpenChange={onClose}>
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
				<Button variant="outline" onClick={onClose} disabled={isImporting}>
					Cancel
				</Button>
				<Button onClick={onImport} disabled={isImporting}>
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
);

const TopBar = () => {

	const { toast } = useToast();

	// Group related state to reduce re-renders
	const [ modalState, setModalState ] = useState( {
		isImportModalOpen: false,
		importUrl: '',
		isImporting: false
	} );

	// Memoized selectors from the store to prevent unnecessary re-renders
	const appMode = useStore( state => state.appMode );
	const setAppMode = useStore( state => state.setAppMode );

	// Access the store actions directly to avoid recreating objects
	const pathTracerStore = usePathTracerStore();

	// Memoize the store actions to avoid infinite loops with getSnapshot
	const pathTracerActions = useMemo( () => ( {
		setBounces: pathTracerStore.setBounces,
		setSamplesPerPixel: pathTracerStore.setSamplesPerPixel,
		setInteractionModeEnabled: pathTracerStore.setInteractionModeEnabled,
		setEnableOIDN: pathTracerStore.setEnableOIDN,
		setUseGBuffer: pathTracerStore.setUseGBuffer,
		setResolution: pathTracerStore.setResolution,
		setRenderMode: pathTracerStore.setRenderMode
	} ), [ pathTracerStore ] );

	// Memoize the prev state object to prevent re-renders when it doesn't change
	const [ prevState, setPrevState ] = useState( {
		bounces: 2,
		samplesPerPixel: 1,
		interactionModeEnabled: true,
		enableOIDN: false,
		resolution: '1'
	} );

	// Memoized handlers
	const handleTabChange = useCallback( ( value ) => {

		// Only update if value has changed
		if ( value !== appMode ) {

			configureForMode( value );
			setAppMode( value );

		}

	}, [ appMode, setAppMode ] );

	const openImportModal = useCallback( () => {

		setModalState( prev => ( { ...prev, isImportModalOpen: true } ) );

	}, [] );

	const closeImportModal = useCallback( () => {

		setModalState( prev => ( { ...prev, isImportModalOpen: false } ) );

	}, [] );

	const setImportUrl = useCallback( ( url ) => {

		setModalState( prev => ( { ...prev, importUrl: url } ) );

	}, [] );

	const handleGithubRedirection = useCallback( () => {

		window.open( 'https://github.com/atul-mourya/RayTracing', '_blank' );

	}, [] );

	// Encapsulate the mode configuration logic
	const configureForMode = useCallback( ( mode ) => {

		// Access directly from the memoized object to avoid closure issues
		const {
			setBounces,
			setSamplesPerPixel,
			setInteractionModeEnabled,
			setEnableOIDN,
			setUseGBuffer,
			setResolution,
			setRenderMode
		} = pathTracerActions;

		if ( mode === "interactive" ) {

			setBounces( 2 );
			setSamplesPerPixel( 1 );
			setInteractionModeEnabled( true );
			setEnableOIDN( false );
			setUseGBuffer( false );
			setResolution( '1' );
			setRenderMode( 0 );

			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = true;

				// Use requestAnimationFrame to ensure this runs after all other updates
				requestAnimationFrame( () => {

					window.pathTracerApp.denoiser.toggleUseGBuffer( false );
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 0.5 );

					// Show canvases again if coming from results tab
					showPathTracerCanvases();

					// Resume rendering
					window.pathTracerApp.pauseRendering = false;
					window.pathTracerApp.reset();

				} );

			}

		} else if ( mode === "final" ) {

			setBounces( 8 );
			setSamplesPerPixel( 1 );
			setInteractionModeEnabled( false );
			setEnableOIDN( true );
			setUseGBuffer( true );
			setResolution( '3' );
			setRenderMode( 1 );

			if ( window.pathTracerApp ) {

				window.pathTracerApp.controls.enabled = false;

				requestAnimationFrame( () => {

					window.pathTracerApp.denoiser.toggleUseGBuffer( true );
					window.pathTracerApp.updateResolution( window.devicePixelRatio * 2.0 );

					// Show canvases again if coming from results tab
					showPathTracerCanvases();

					// Resume rendering
					window.pathTracerApp.pauseRendering = false;
					window.pathTracerApp.reset();

				} );

			}

		} else if ( mode === "results" ) {

			// Save current state before switching to results
			if ( window.pathTracerApp ) {

				setPrevState( {
					bounces: usePathTracerStore.getState().bounces,
					samplesPerPixel: usePathTracerStore.getState().samplesPerPixel,
					interactionModeEnabled: usePathTracerStore.getState().interactionModeEnabled,
					enableOIDN: usePathTracerStore.getState().enableOIDN,
					resolution: usePathTracerStore.getState().resolution
				} );

				// Pause rendering to save resources
				window.pathTracerApp.pauseRendering = true;

				// Disable controls but keep the app instance
				window.pathTracerApp.controls.enabled = false;

				// Hide the canvas but don't destroy the app
				hidePathTracerCanvases();

			}

		}

	}, [ pathTracerActions, setPrevState ] );

	// Extract canvas visibility functions
	const showPathTracerCanvases = useCallback( () => {

		if ( window.pathTracerApp ) {

			if ( window.pathTracerApp.renderer?.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'block';

			}

			if ( window.pathTracerApp.denoiser?.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'block';

			}

		}

	}, [] );

	const hidePathTracerCanvases = useCallback( () => {

		if ( window.pathTracerApp ) {

			if ( window.pathTracerApp.renderer?.domElement ) {

				window.pathTracerApp.renderer.domElement.style.display = 'none';

			}

			if ( window.pathTracerApp.denoiser?.output ) {

				window.pathTracerApp.denoiser.output.style.display = 'none';

			}

		}

	}, [] );

	// Memoized validation function
	const validateUrl = useCallback( ( url ) => {

		if ( ! url ) return false;
		if ( ! url.startsWith( 'http' ) ) return false;
		if ( ! url.endsWith( '.glb' ) && ! url.endsWith( '.gltf' ) ) return false;
		try {

			new URL( url );
			return true;

		} catch {

			return false;

		}

	}, [] );

	// Handler for model import
	const handleImportFromUrl = useCallback( () => {

		const { importUrl } = modalState;

		if ( ! validateUrl( importUrl ) ) {

			toast( {
				title: "Invalid URL",
				description: "Please enter a valid URL.",
				variant: "destructive",
			} );
			return;

		}

		setModalState( prev => ( { ...prev, isImporting: true } ) );

		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadModel( importUrl )
				.then( () => {

					setModalState( prev => ( {
						...prev,
						isImporting: false,
						importUrl: '',
						isImportModalOpen: false
					} ) );

					toast( {
						title: "Model Loaded",
						description: "Successfully loaded model !!",
					} );

				} )
				.catch( ( error ) => {

					setModalState( prev => ( { ...prev, isImporting: false } ) );

					toast( {
						title: "Error Loading Model",
						description: `${error}`,
						variant: "destructive",
					} );

				} );

		} else {

			setModalState( prev => ( { ...prev, isImporting: false } ) );

		}

	}, [ modalState, toast, validateUrl ] );

	// Memoize the menu items to prevent unnecessary re-renders
	const menuItems = useMemo( () => (
		<Menubar className="border-none">
			<MenubarMenu>
				<MenubarTrigger className="font-normal">File</MenubarTrigger>
				<MenubarContent>
					<MenubarItem disabled className="flex items-center">
						<FolderOpen className="mr-2 h-4 w-4" />
						<span>Open</span>
					</MenubarItem>
					<MenubarItem onSelect={openImportModal} className="flex items-center">
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
	), [ openImportModal ] );

	// Memoize the viewport tabs to prevent unnecessary re-renders
	const viewportTabs = useMemo( () => (
		<Tabs
			defaultValue="interactive"
			value={appMode}
			onValueChange={handleTabChange}
		>
			<TabsList>
				<TabsTrigger value="interactive">Preview</TabsTrigger>
				<TabsTrigger value="final">Render</TabsTrigger>
				<TabsTrigger value="results">Results</TabsTrigger>
			</TabsList>
		</Tabs>
	), [ appMode, handleTabChange ] );

	// Extract logo for better code organization
	const logo = useMemo( () => (
		<div className="flex items-center space-x-2 mr-4 px-2">
			<Menu size={18} />
			<span className="font-semibold">RayCanvas</span>
		</div>
	), [] );

	return (
		<AuthProvider>
			{( { user, handleLoginClick, handleSignOut } ) => (
				<div className="flex items-center h-[48px] border-b border-[#4a4a4a]">
					{logo}
					{menuItems}

					<div className="grow" />
					{viewportTabs}
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
						{user ? (
							<NavUser user={user} onLogout={handleSignOut} />
						) : (
							<Button variant="default" size="sm" onClick={handleLoginClick}>
								Login
							</Button>
						)}
					</div>

					<ImportUrlModal
						isOpen={modalState.isImportModalOpen}
						onClose={closeImportModal}
						importUrl={modalState.importUrl}
						setImportUrl={setImportUrl}
						onImport={handleImportFromUrl}
						isImporting={modalState.isImporting}
					/>
				</div>
			)}
		</AuthProvider>
	);

};

export default TopBar;
