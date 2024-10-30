import { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { InfoIcon, Search, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from "@/lib/utils";

const ItemsCatalog = ( {
	className,
	data = [],
	value,
	onValueChange,
	isLoading = false,
	error = null,
	...props
} ) => {

	const [ searchTerm, setSearchTerm ] = useState( '' );

	// Memoize filtered items for better performance
	const filteredItems = useMemo( () => {

		return data.filter( item =>
			item.name.toLowerCase().includes( searchTerm.toLowerCase() )
		);

	}, [ data, searchTerm ] );

	const handleMoreInfo = ( redirection, e ) => {

		e.stopPropagation(); // Prevent card selection when clicking info button
		if ( redirection ) {

			window.open( redirection, "_blank", "noopener noreferrer" );

		}

	};

	if ( error ) {

		return (
			<div className="flex items-center justify-center h-64 text-red-500">
				<p>{error}</p>
			</div>
		);

	}

	return (
		<div className={cn( "flex flex-col h-full px-1", className )} {...props}>
			<div className="flex items-center px-3 py-1 rounded-full bg-primary/20">
				<Search size={14} className="mx-2" />
				<input
					type="text"
					placeholder="Search"
					className="bg-transparent outline-none text-xs w-full"
					value={searchTerm}
					onChange={( e ) => setSearchTerm( e.target.value )}
				/>
			</div>
			<Separator className="my-2"/>
			<ScrollArea className="flex-1">
				{isLoading ? (
					<div className="flex items-center justify-center h-64">
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : filteredItems.length === 0 ? (
					<div className="flex items-center justify-center h-64 text-muted-foreground">
						<p className='opacity-50 text-xs truncate'>No items found</p>
					</div>
				) : (
					<div className="grid grid-cols-2 gap-4">
						{filteredItems.map( ( item, index ) => (
							<Card
								key={item.name}
								className={cn(
									"cursor-pointer transition-all hover:scale-105",
									index.toString() === value
										? "bg-primary/5"
										: "hover:bg-accent"
								)}
								onClick={() => onValueChange( index.toString() )}
								role="button"
								aria-pressed={index.toString() === value}
								tabIndex={0}
								onKeyDown={( e ) => {

									if ( e.key === 'Enter' || e.key === ' ' ) {

										e.preventDefault();
										onValueChange( index.toString() );

									}

								}}
							>
								<CardContent className="relative p-2">
									{item.redirection && (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														className="absolute right-1 top-1 h-6 w-6 bg-background/80 backdrop-blur-sm hover:bg-background/90"
														onClick={( e ) => handleMoreInfo( item.redirection, e )}
														aria-label={`More information about ${item.name}`}
													>
														<InfoIcon className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>View more information</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									)}
									<div className="relative aspect-square mb-2 rounded-sm overflow-hidden">
										<img
											src={item.preview}
											alt={item.name}
											className="w-full h-full object-cover transition-transform hover:scale-110"
											loading="lazy"
										/>
									</div>
									<p className="opacity-50 text-xs truncate text-center">
										{item.name}
									</p>
								</CardContent>
							</Card>
						) )}
					</div>
				)}
			</ScrollArea>
		</div>
	);

};

export { ItemsCatalog };
