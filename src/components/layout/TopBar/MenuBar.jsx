import { FolderOpen, Save, Link, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Focus } from 'lucide-react';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";

const MenuBar = ( { onOpenImportModal } ) => (
	<Menubar className="border-none">
		<MenubarMenu>
			<MenubarTrigger className="font-normal">File</MenubarTrigger>
			<MenubarContent>
				<MenubarItem disabled className="flex items-center">
					<FolderOpen className="mr-2 h-4 w-4" />
					<span>Open</span>
				</MenubarItem>
				<MenubarItem onSelect={onOpenImportModal} className="flex items-center">
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
);

export default MenuBar;
