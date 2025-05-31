import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";

const MenuBar = ( { onOpenImportModal } ) => (
	<Menubar className="h-full border-none bg-none p-0 shadow-none">
		<MenubarMenu>
			<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">File</MenubarTrigger>
			<MenubarContent>
				<MenubarItem disabled className="flex items-center">Open</MenubarItem>
				<MenubarItem onSelect={onOpenImportModal} className="flex items-center">Import from URL</MenubarItem>
				<MenubarItem disabled className="flex items-center">Save</MenubarItem>
				<MenubarSeparator />
			</MenubarContent>
		</MenubarMenu>

		<MenubarMenu>
			<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">Edit</MenubarTrigger>
			<MenubarContent>
				<MenubarItem disabled className="flex items-center">Undo</MenubarItem>
				<MenubarItem disabled className="flex items-center">Redo</MenubarItem>
				<MenubarSeparator />
				<MenubarItem disabled className="flex items-center">Copy</MenubarItem>
				<MenubarItem disabled className="flex items-center">Paste</MenubarItem>
			</MenubarContent>
		</MenubarMenu>

		<MenubarMenu>
			<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">View</MenubarTrigger>
			<MenubarContent>
				<MenubarItem disabled className="flex items-center">Zoom In</MenubarItem>
				<MenubarItem disabled className="flex items-center">Zoom Out</MenubarItem>
				<MenubarItem disabled className="flex items-center">Reset View</MenubarItem>
			</MenubarContent>
		</MenubarMenu>
	</Menubar>
);

export default MenuBar;
