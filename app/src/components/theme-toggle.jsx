import { Moon, Sun } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";

export function ThemeToggle() {

	const { setTheme } = useTheme();

	// Memoized theme change handlers
	const handleLightTheme = useCallback( () => setTheme( "light" ), [ setTheme ] );
	const handleDarkTheme = useCallback( () => setTheme( "dark" ), [ setTheme ] );
	const handleSystemTheme = useCallback( () => setTheme( "system" ), [ setTheme ] );

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon">
					<Sun size={14} className="rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
					<Moon size={14} className="absolute rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
					<span className="sr-only">Toggle theme</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={handleLightTheme}>
          Light
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleDarkTheme}>
          Dark
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleSystemTheme}>
          System
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);

}
