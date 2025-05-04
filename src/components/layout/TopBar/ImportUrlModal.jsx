import { Loader2 } from 'lucide-react';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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

export default ImportUrlModal;
