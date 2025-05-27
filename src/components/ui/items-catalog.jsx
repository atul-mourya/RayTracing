import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { InfoIcon, Search, Loader2, Filter } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";


/** data []: Array of objects representing items to display in the catalog {
	// Required Properties
	name: string;      // Used for item identification and display
	preview: string;   // URL/path to item's preview image
	// Optional Properties
	label?: string;    // Alternative display text (shown in tooltip)
	category?: string[];  // Array of categories for filtering
	tags?: string[];      // Array of tags for filtering
	redirection?: string;  // URL for "More Info" button link
}
*/

export const ItemsCatalog = ( {
	className,
	data = [],
	value,
	onValueChange,
	isLoading = false,
	error = null,
	...props
} ) => {

	const [ searchTerm, setSearchTerm ] = useState( '' );
	const [ filterType, setFilterType ] = useState( '' );
	const [ filterValue, setFilterValue ] = useState( '' );

	// Refs for scroll functionality
	const scrollAreaRef = useRef( null );
	const itemRefs = useRef( {} );

	const categories = useMemo( () => {

		return Array.from( new Set( data.filter( item => item.category ).map( item => item.category ).flat() ) ).filter( tag => tag );

	}, [ data ] );

	const tags = useMemo( () => {

		return Array.from( new Set( data.filter( item => item.tags ).map( item => item.tags ).flat() ) ).filter( tag => tag );

	}, [ data ] );

	const filteredItems = useMemo( () => {

		return data.filter( item => {

			const matchesSearch = item.name.toLowerCase().includes( searchTerm.toLowerCase() );

			// If no filter is selected or filter type is 'all', only apply search
			if ( ! filterType || filterType === 'all' ) {

				return matchesSearch;

			}

			// Apply category filter
			if ( filterType === 'category' && filterValue ) {

				return matchesSearch && item.category?.includes( filterValue );

			}

			// Apply tag filter
			if ( filterType === 'tag' && filterValue ) {

				return matchesSearch && item.tags?.includes( filterValue );

			}

			return matchesSearch;

		} );

	}, [ data, searchTerm, filterType, filterValue ] );

	const handleItemSelection = useCallback( ( name ) => {

		const index = data.findIndex( item => item.name === name );
		onValueChange( index.toString() );

	}, [ data, onValueChange ] );

	const handleFilterTypeChange = useCallback( ( newType ) => {

		setFilterType( newType );
		setFilterValue( '' ); // Reset filter value when type changes

	}, [] );

	const handleFilterValueChange = useCallback( ( newValue ) => {

		setFilterValue( newValue );

	}, [] );

	// Helper function to check if an item is selected
	const isItemSelected = useCallback( ( item ) => {

		if ( value === null || value === undefined ) return false;
		const selectedIndex = parseInt( value );
		const selectedItem = data[ selectedIndex ];
		return selectedItem && selectedItem.name === item.name;

	}, [ value, data ] );

	// Auto-scroll to selected item
	useEffect( () => {

		if ( value !== null && value !== undefined && data.length > 0 ) {

			const selectedIndex = parseInt( value );
			const selectedItem = data[ selectedIndex ];

			// Check if the selected item is in the filtered results
			const isItemVisible = filteredItems.some( item => item.name === selectedItem?.name );

			if ( selectedItem && isItemVisible && itemRefs.current[ selectedItem.name ] ) {

				// Small delay to ensure the DOM is updated
				const timeoutId = setTimeout( () => {

					const element = itemRefs.current[ selectedItem.name ];
					if ( element && element.isConnected ) {

						element.scrollIntoView( {
							behavior: 'smooth',
							block: 'center',
							inline: 'nearest'
						} );

					}

				}, 50 );

				return () => clearTimeout( timeoutId );

			}

		}

	}, [ value, data, filteredItems ] );

	// Clean up refs when data changes
	useEffect( () => {

		// Remove refs for items that are no longer in the data
		const currentNames = new Set( data.map( item => item.name ) );
		Object.keys( itemRefs.current ).forEach( name => {

			if ( ! currentNames.has( name ) ) {

				delete itemRefs.current[ name ];

			}

		} );

	}, [ data ] );

	if ( error ) {

		return (
			<div className="flex items-center justify-center h-64 text-red-500" role="alert">
				<p>{error}</p>
			</div>
		);

	}

	const showFilters = categories.length > 0 || tags.length > 0;

	return (
		<TooltipProvider>
			<div className={cn( "flex flex-col h-full mx-2", className )} {...props}>
				<div className="flex items-center mb-2 gap-2">
					<div className="relative grow">
						<Search size={14} className="absolute left-1 top-1/2 transform -translate-y-1/2 text-muted-foreground" />
						<Input
							type="text"
							placeholder="Search items..."
							className="h-5 pl-5 outline-hidden text-xs w-full rounded-full bg-primary/20"
							value={searchTerm}
							onChange={( e ) => setSearchTerm( e.target.value )}
							aria-label="Search items"
						/>
					</div>
					{showFilters && (
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="outline" className="h-5 w-[120px] text-xs rounded-full">
									<Filter size={12} className="mr-2" />
									Filter
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-[200px] p-0" align="end">
								<div className="p-1 space-y-1">
									<Select value={filterType} onValueChange={handleFilterTypeChange}>
										<SelectTrigger aria-label="Filter type" className="h-5 rounded-full">
											<SelectValue placeholder="Filter by" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All</SelectItem>
											{categories.length > 0 && <SelectItem value="category">Category</SelectItem>}
											{tags.length > 0 && <SelectItem value="tag">Tag</SelectItem>}
										</SelectContent>
									</Select>
									{filterType && filterType !== 'all' && (
										<Select value={filterValue} onValueChange={handleFilterValueChange}>
											<SelectTrigger aria-label={`Select ${filterType}`} className="h-5 rounded-full">
												<SelectValue placeholder={`Select ${filterType}`} />
											</SelectTrigger>
											<SelectContent>
												{filterType === 'category'
													? categories.map( category => (
														<SelectItem key={category} value={category}>{category}</SelectItem>
													) )
													: tags.map( tag => (
														<SelectItem key={tag} value={tag}>{tag}</SelectItem>
													) )
												}
											</SelectContent>
										</Select>
									)}
								</div>
							</PopoverContent>
						</Popover>
					)}
				</div>
				{( filterType || filterValue ) && (
					<div className="flex items-center space-x-2 mb-2">
						<p className="text-xs text-muted-foreground">Active filters:</p>
						{filterType && (
							<Badge variant="secondary" className="text-xs">
								{filterType}: {filterValue || 'All'}
							</Badge>
						)}
					</div>
				)}
				<Separator className="mb-4" />
				<ScrollArea className="flex-1" ref={scrollAreaRef}>
					{isLoading ? (
						<div className="flex items-center justify-center h-64">
							<Loader2 className="h-8 w-8 animate-spin text-primary" />
						</div>
					) : filteredItems.length === 0 ? (
						<div className="flex items-center justify-center h-64 text-muted-foreground">
							<p className="text-center">No items found. Try adjusting your search or filters.</p>
						</div>
					) : (
						<div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-4">
							{filteredItems.map( ( item, index ) => (
								<Tooltip key={item.name}>
									<TooltipTrigger asChild>
										<Card
											ref={( el ) => {

												if ( el ) itemRefs.current[ item.name ] = el;

											}}
											className={cn(
												"cursor-pointer transition-all hover:shadow-md",
												isItemSelected( item )
													? "ring-2 ring-primary"
													: "hover:bg-accent/50"
											)}
											onClick={() => handleItemSelection( item.name )}
										>
											<CardContent className="p-3">
												<div className="relative aspect-square mb-2 rounded-md overflow-hidden">
													<img
														src={item.preview}
														alt={item.name}
														className="w-full h-full object-cover transition-transform hover:scale-105"
														loading="lazy"
													/>
													{item.redirection && (
														<Button
															variant="secondary"
															size="icon"
															className="absolute right-1 bottom-1 h-6 w-6 rounded-full opacity-80 hover:opacity-100"
															onClick={( e ) => {

																e.stopPropagation();
																window.open( item.redirection, "_blank", "noopener noreferrer" );

															}}
															aria-label={`More information about ${item.name}`}
														>
															<InfoIcon className="h-3 w-3" />
														</Button>
													)}
												</div>
												<p className="text-sm font-medium text-center truncate">{item.name}</p>
											</CardContent>
										</Card>
									</TooltipTrigger>
									<TooltipContent>
										<p>{item.name}</p>
									</TooltipContent>
								</Tooltip>
							) )}
						</div>
					)}
				</ScrollArea>
			</div>
		</TooltipProvider>
	);

};

export default ItemsCatalog;
