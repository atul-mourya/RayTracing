import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { InfoIcon, Search, Loader2, Filter, X } from 'lucide-react';
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

	const [ searchInput, setSearchInput ] = useState( '' );
	const [ debouncedSearchTerm, setDebouncedSearchTerm ] = useState( '' );
	const [ filterType, setFilterType ] = useState( '' );
	const [ filterValue, setFilterValue ] = useState( '' );

	// Refs for scroll functionality
	const scrollAreaRef = useRef( null );
	const itemRefs = useRef( {} );
	const debounceTimeoutRef = useRef( null );

	// Debounce search input
	useEffect( () => {

		if ( debounceTimeoutRef.current ) {

			clearTimeout( debounceTimeoutRef.current );

		}

		debounceTimeoutRef.current = setTimeout( () => {

			setDebouncedSearchTerm( searchInput );

		}, 150 );

		return () => {

			if ( debounceTimeoutRef.current ) {

				clearTimeout( debounceTimeoutRef.current );

			}

		};

	}, [ searchInput ] );

	const categories = useMemo( () => {

		return Array.from( new Set(
			data.flatMap( item => item.category || [] ).filter( Boolean )
		) );

	}, [ data ] );

	const tags = useMemo( () => {

		return Array.from( new Set(
			data.flatMap( item => item.tags || [] ).filter( Boolean )
		) );

	}, [ data ] );

	// Pre-process search strings for better performance
	const searchIndex = useMemo( () => {

		return data.map( item => {

			const searchableText = [
				item.name || '',
				item.label || '',
				...( item.category || [] ),
				...( item.tags || [] )
			].join( ' ' ).toLowerCase();

			return {
				item,
				searchableText,
				name: ( item.name || '' ).toLowerCase(),
				tags: ( item.tags || [] ).map( tag => tag.toLowerCase() ),
				categories: ( item.category || [] ).map( cat => cat.toLowerCase() )
			};

		} );

	}, [ data ] );

	// Optimized filtering with pre-computed search index
	const filteredItems = useMemo( () => {

		let results = searchIndex;

		// Apply search filter
		if ( debouncedSearchTerm ) {

			const searchLower = debouncedSearchTerm.toLowerCase();
			results = results.filter( ( { searchableText } ) =>
				searchableText.includes( searchLower )
			);

		}

		// Apply category/tag filters
		if ( filterType === 'category' && filterValue ) {

			results = results.filter( ( { categories } ) =>
				categories.includes( filterValue.toLowerCase() )
			);

		} else if ( filterType === 'tag' && filterValue ) {

			results = results.filter( ( { tags } ) =>
				tags.includes( filterValue.toLowerCase() )
			);

		}

		return results.map( ( { item } ) => item );

	}, [ searchIndex, debouncedSearchTerm, filterType, filterValue ] );

	const handleItemSelection = useCallback( ( name ) => {

		const index = data.findIndex( item => item.name === name );
		onValueChange( index.toString() );

	}, [ data, onValueChange ] );

	const handleFilterTypeChange = useCallback( ( newType ) => {

		setFilterType( newType );
		setFilterValue( '' );

	}, [] );

	const handleFilterValueChange = useCallback( ( newValue ) => {

		setFilterValue( newValue );

	}, [] );

	const handleClearSearch = useCallback( () => {

		setSearchInput( '' );
		setDebouncedSearchTerm( '' );

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
			const isItemVisible = filteredItems.some( item => item.name === selectedItem?.name );

			if ( selectedItem && isItemVisible && itemRefs.current[ selectedItem.name ] ) {

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

		const currentNames = new Set( data.map( item => item.name ) );
		Object.keys( itemRefs.current ).forEach( name => {

			if ( ! currentNames.has( name ) ) {

				delete itemRefs.current[ name ];

			}

		} );

	}, [ data ] );

	// Optimized highlight function - only compute when needed
	const highlightSearchTerm = useCallback( ( text, searchTerm ) => {

		if ( ! searchTerm || ! text || searchTerm.length < 2 ) return text;

		try {

			const regex = new RegExp( `(${searchTerm.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' )})`, 'gi' );
			const parts = text.split( regex );

			if ( parts.length === 1 ) return text;

			return parts.map( ( part, index ) =>
				regex.test( part ) ?
					<mark key={index} className="bg-yellow-200 dark:bg-yellow-800 px-0.5 rounded">{part}</mark> :
					part
			);

		} catch {

			return text;

		}

	}, [] );

	// Memoize search summary to avoid recalculation
	const searchSummary = useMemo( () => {

		if ( ! debouncedSearchTerm ) return null;

		const totalResults = filteredItems.length;
		const totalItems = data.length;

		if ( totalResults === 0 ) {

			return `No results found for "${debouncedSearchTerm}"`;

		}

		if ( totalResults === totalItems ) {

			return null;

		}

		return `Found ${totalResults} of ${totalItems} items`;

	}, [ debouncedSearchTerm, filteredItems.length, data.length ] );

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
							placeholder="Search items, tags, categories..."
							className="h-5 pl-5 pr-6 outline-hidden text-xs w-full rounded-full bg-primary/20"
							value={searchInput}
							onChange={( e ) => setSearchInput( e.target.value )}
							aria-label="Search items, tags, and categories"
						/>
						{searchInput && (
							<Button
								variant="ghost"
								size="icon"
								className="absolute right-0.5 top-1/2 transform -translate-y-1/2 h-4 w-4 rounded-full hover:bg-muted"
								onClick={handleClearSearch}
								aria-label="Clear search"
							>
								<X size={10} className="text-muted-foreground" />
							</Button>
						)}
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

				{/* Search summary */}
				{searchSummary && (
					<div className="mb-2">
						<p className="text-xs text-muted-foreground">{searchSummary}</p>
					</div>
				)}

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
							<div className="text-center">
								<p className="mb-2">No items found.</p>
								{debouncedSearchTerm && (
									<p className="text-xs">Try different keywords or check your spelling.</p>
								)}
								{! debouncedSearchTerm && ( filterType || filterValue ) && (
									<p className="text-xs">Try adjusting your filters.</p>
								)}
							</div>
						</div>
					) : (
						<div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-4">
							{filteredItems.map( ( item ) => {

								// Only compute matching data for items that will be highlighted
								const shouldHighlight = debouncedSearchTerm && debouncedSearchTerm.length >= 2;
								const matchingTags = shouldHighlight ?
									( item.tags || [] ).filter( tag => tag.toLowerCase().includes( debouncedSearchTerm.toLowerCase() ) ).slice( 0, 2 ) : [];
								const matchingCategories = shouldHighlight ?
									( item.category || [] ).filter( cat => cat.toLowerCase().includes( debouncedSearchTerm.toLowerCase() ) ).slice( 0, 2 ) : [];

								return (
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
													<p className="text-sm font-medium text-center truncate">
														{shouldHighlight ? highlightSearchTerm( item.name, debouncedSearchTerm ) : item.name}
													</p>

													{/* Show matching tags/categories when searching */}
													{shouldHighlight && ( matchingTags.length > 0 || matchingCategories.length > 0 ) && (
														<div className="mt-1 space-y-1">
															{matchingTags.length > 0 && (
																<div className="flex flex-wrap gap-1">
																	{matchingTags.map( tag => (
																		<Badge key={tag} variant="outline" className="text-xs px-1 py-0">
																			{highlightSearchTerm( tag, debouncedSearchTerm )}
																		</Badge>
																	) )}
																</div>
															)}
															{matchingCategories.length > 0 && (
																<div className="flex flex-wrap gap-1">
																	{matchingCategories.map( category => (
																		<Badge key={category} variant="secondary" className="text-xs px-1 py-0">
																			{highlightSearchTerm( category, debouncedSearchTerm )}
																		</Badge>
																	) )}
																</div>
															)}
														</div>
													)}
												</CardContent>
											</Card>
										</TooltipTrigger>
										<TooltipContent>
											<div>
												<p className="font-medium">{item.name}</p>
												{item.label && <p className="text-sm opacity-75">{item.label}</p>}
												{item.tags && item.tags.length > 0 && (
													<p className="text-xs opacity-75 mt-1">Tags: {item.tags.join( ', ' )}</p>
												)}
												{item.category && item.category.length > 0 && (
													<p className="text-xs opacity-75">Categories: {item.category.join( ', ' )}</p>
												)}
											</div>
										</TooltipContent>
									</Tooltip>
								);

							} )}
						</div>
					)}
				</ScrollArea>
			</div>
		</TooltipProvider>
	);

};

export default ItemsCatalog;
