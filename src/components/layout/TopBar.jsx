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

const TopBar = () => {

	const { toast } = useToast();
	const [ isPlaying, setIsPlaying ] = useState( false );
	const [ isImportModalOpen, setIsImportModalOpen ] = useState( false );
	const [ importUrl, setImportUrl ] = useState( '' );
	const [ isImporting, setIsImporting ] = useState( false );

	const handlePlayPauseClick = () => {

		setIsPlaying( ! isPlaying );
		if ( window.pathTracerApp ) {

			if ( isPlaying ) {

				window.pathTracerApp.pauseRendering = true;

			} else {

				window.pathTracerApp.pauseRendering = false;
				window.pathTracerApp.reset();

			}

		}

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

	useEffect( () => {

		const handleRenderComplete = () => {

			setIsPlaying( false );

		};

		const handleRenderReset = () => {

			setIsPlaying( true );

		};

		if ( window.pathTracerApp ) {

			window.pathTracerApp.addEventListener( 'RenderComplete', handleRenderComplete );
			window.pathTracerApp.addEventListener( 'RenderReset', handleRenderReset );

			return () => {

				window.pathTracerApp.removeEventListener( 'RenderComplete', handleRenderComplete );
				window.pathTracerApp.removeEventListener( 'RenderReset', handleRenderReset );

			};

		}

	}, [] );

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

					<div className="flex-grow" />

					<Button
						variant="default"
						size="sm"
						className="flex items-center space-x-1"
						onClick={handlePlayPauseClick}
					>
						{isPlaying ? <Pause size={14} /> : <Play size={14} />}
						<span>{isPlaying ? 'Pause' : 'Play'}</span>
					</Button>

					<div className="flex-grow" />
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
							<NavUser user={user} onLogout={handleSignOut}/> : (
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
