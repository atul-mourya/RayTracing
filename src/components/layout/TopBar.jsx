import { useState, useEffect } from 'react';
import { Menu, Play, Pause, Save, FolderOpen, Link, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Focus, Loader2, Github, ChevronDown } from 'lucide-react';
import { ThemeToggle } from '../theme-toggle';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

		console.log( 'Importing from URL:', importUrl );
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
						description: `Successfully loaded model !!`,
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
		<div className="flex items-center px-2 h-12 border-b border-[#4a4a4a]">
			<div className="flex items-center space-x-2 mr-4">
				<Menu size={18} />
				<span className="font-semibold">RayCanvas</span>
			</div>
			<div className="flex space-x-2 text-sm">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" className="px-2 py-1">File</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem disabled onSelect={() => console.log( 'Open' )}>
							<FolderOpen className="mr-2 h-4 w-4" />
							<span>Open</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setIsImportModalOpen( true )}>
							<Link className="mr-2 h-4 w-4" />
							<span>Import from URL</span>
						</DropdownMenuItem>
						<DropdownMenuItem disabled onSelect={() => console.log( 'Save' )}>
							<Save className="mr-2 h-4 w-4" />
							<span>Save</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem disabled onSelect={() => console.log( 'Exit' )}>
              Exit
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>

				<DropdownMenu>
					<DropdownMenuTrigger disabled asChild>
						<Button variant="ghost" className="px-2 py-1">Edit</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem onSelect={() => console.log( 'Undo' )}>
							<Undo className="mr-2 h-4 w-4" />
							<span>Undo</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => console.log( 'Redo' )}>
							<Redo className="mr-2 h-4 w-4" />
							<span>Redo</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => console.log( 'Copy' )}>
							<Copy className="mr-2 h-4 w-4" />
							<span>Copy</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => console.log( 'Paste' )}>
							<ClipboardPaste className="mr-2 h-4 w-4" />
							<span>Paste</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>

				<DropdownMenu>
					<DropdownMenuTrigger disabled asChild>
						<Button variant="ghost" className="px-2 py-1">View</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem onSelect={() => console.log( 'Zoom In' )}>
							<ZoomIn className="mr-2 h-4 w-4" />
							<span>Zoom In</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => console.log( 'Zoom Out' )}>
							<ZoomOut className="mr-2 h-4 w-4" />
							<span>Zoom Out</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => console.log( 'Reset View' )}>
							<Focus className="mr-2 h-4 w-4" />
							<span>Reset View</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
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
			<ThemeToggle />
			<div className="pl-2 text-xs">v3.0</div>
			<ChevronDown size={14} className="pl-2"/>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Github className="pl-2 cursor-pointer" onClick={handleGithubRedirection} />
					</TooltipTrigger>
					<TooltipContent>View on GitHub</TooltipContent>
				</Tooltip>
			</TooltipProvider>

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
	);

};

export default TopBar;
