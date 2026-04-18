"use client";

import { LogOut } from "lucide-react";

import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function NavUser( { user, onLogout } ) {

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Avatar className="h-6 w-6 rounded-full">
					<AvatarImage src={user.user_metadata.avatar_url} alt={user.user_metadata.name} />
					<AvatarFallback className="rounded-lg bg-primary/20">{user.user_metadata.name[ 0 ]}</AvatarFallback>
				</Avatar>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
				side={"right"}
				align="start"
				sideOffset={4}
			>
				<DropdownMenuLabel className="p-0 font-normal">
					<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
						<Avatar className="h-8 w-8 rounded-lg">
							<AvatarImage src={user.user_metadata.avatar_url} alt={user.user_metadata.name} />
							<AvatarFallback className="rounded-lg">{user.user_metadata.name[ 0 ]}</AvatarFallback>
						</Avatar>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<span className="truncate font-semibold">{user.user_metadata.name}</span>
							<span className="truncate text-xs">{user.email}</span>
						</div>
					</div>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem className="gap-2" onClick={onLogout}>
					<LogOut size={12} />
                    Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>

	);

}
