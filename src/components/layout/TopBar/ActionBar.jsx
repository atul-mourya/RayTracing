import { Github, ChevronDown } from 'lucide-react';
import { ThemeToggle } from '../../theme-toggle';
import { Button } from "@/components/ui/button";
import { NavUser } from '@/components/ui/nav-user';
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";

const ActionBar = ( { user, onLoginClick, onSignOut, onGithubClick } ) => {

	return (
		<div className="flex items-center px-2 space-x-2">
			<ThemeToggle />
			<div className="text-xs">v0.0</div>
			<ChevronDown size={14} />
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Github className="cursor-pointer" onClick={onGithubClick} />
					</TooltipTrigger>
					<TooltipContent>View on GitHub</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			{user ? (
				<NavUser user={user} onLogout={onSignOut} />
			) : (
				<Button variant="default" size="sm" onClick={onLoginClick}>
                    Login
				</Button>
			)}
		</div>
	);

};

export default ActionBar;
