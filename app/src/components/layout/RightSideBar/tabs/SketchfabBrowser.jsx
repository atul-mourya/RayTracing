import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Loader2, ExternalLink, ArrowLeft, Package } from 'lucide-react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SketchfabService } from '@/services/SketchfabService';
import { useToast } from '@/hooks/use-toast';

/**
 * Reusable Sketchfab browse surface. Category-first (like PolyHaven): the primary
 * listing is model categories; selecting one shows that category's models with a
 * within-category search. Resolves a selected model's GLB URL and hands it to
 * `onSelect(url, name, item)` — the caller decides replace vs append.
 *
 * @param {(url:string, name:string, item:object) => Promise<any>} onSelect
 * @param {string} [actionLabel='Load'] - Label for the confirm button.
 */
const SketchfabBrowser = ( { onSelect, actionLabel = 'Load' } ) => {

	const { toast } = useToast();

	// Categories (landing view)
	const [ categories, setCategories ] = useState( [] );
	const [ isLoadingCategories, setIsLoadingCategories ] = useState( false );
	const [ categoriesError, setCategoriesError ] = useState( null );
	const [ selectedCategory, setSelectedCategory ] = useState( null ); // { slug, name }

	// Models (drill-down view)
	const [ query, setQuery ] = useState( '' );
	const [ items, setItems ] = useState( [] );
	const [ cursor, setCursor ] = useState( null );
	const [ isSearching, setIsSearching ] = useState( false );
	const [ isLoadingMore, setIsLoadingMore ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ selectedIndex, setSelectedIndex ] = useState( null );
	const [ isBusy, setIsBusy ] = useState( false );

	const hasToken = !! SketchfabService.getToken();
	const debounceRef = useRef( null );

	// Load categories once (the primary listing).
	useEffect( () => {

		let cancelled = false;
		setIsLoadingCategories( true );
		setCategoriesError( null );
		SketchfabService.getCategories()
			.then( cats => {

				if ( ! cancelled ) setCategories( cats );

			} )
			.catch( e => {

				if ( ! cancelled ) setCategoriesError( e.message );

			} )
			.finally( () => {

				if ( ! cancelled ) setIsLoadingCategories( false );

			} );
		return () => {

			cancelled = true;

		};

	}, [] );

	// Fetch models whenever a category is open (and re-fetch on within-category query change).
	useEffect( () => {

		if ( ! selectedCategory ) return undefined;

		let cancelled = false;
		if ( debounceRef.current ) clearTimeout( debounceRef.current );
		debounceRef.current = setTimeout( async () => {

			setIsSearching( true );
			setError( null );
			setSelectedIndex( null );
			try {

				const { items: results, nextCursor } = await SketchfabService.search( { query, category: selectedCategory.slug } );
				if ( cancelled ) return; // a newer category/query superseded this request
				setItems( results );
				setCursor( nextCursor );

			} catch ( e ) {

				if ( cancelled ) return;
				setError( e.message );
				setItems( [] );
				setCursor( null );

			} finally {

				if ( ! cancelled ) setIsSearching( false );

			}

		}, 350 );

		return () => {

			cancelled = true;
			clearTimeout( debounceRef.current );

		};

	}, [ selectedCategory, query ] );

	const handlePickCategory = useCallback( ( indexStr ) => {

		const c = categories[ parseInt( indexStr ) ];
		if ( ! c ) return;
		setSelectedCategory( { slug: c.slug, name: c.name } );
		setQuery( '' );
		setItems( [] );
		setCursor( null );
		setSelectedIndex( null );

	}, [ categories ] );

	const handleBack = useCallback( () => {

		setSelectedCategory( null );
		setQuery( '' );
		setItems( [] );
		setCursor( null );
		setSelectedIndex( null );

	}, [] );

	const handleLoadMore = useCallback( async () => {

		if ( ! cursor || isLoadingMore || ! selectedCategory ) return;
		setIsLoadingMore( true );
		try {

			const { items: more, nextCursor } = await SketchfabService.search( { query, category: selectedCategory.slug, cursor } );
			setItems( prev => [ ...prev, ...more ] );
			setCursor( nextCursor );

		} catch ( e ) {

			toast( { title: 'Sketchfab', description: e.message, variant: 'destructive' } );

		} finally {

			setIsLoadingMore( false );

		}

	}, [ cursor, isLoadingMore, query, selectedCategory, toast ] );

	const pendingItem = selectedIndex != null ? items[ selectedIndex ] : null;

	const handleConfirm = useCallback( async () => {

		if ( ! pendingItem ) return;

		if ( ! hasToken ) {

			toast( {
				title: 'Sketchfab token required',
				description: 'Set VITE_SKETCHFAB_TOKEN to download models.',
				variant: 'destructive',
			} );
			return;

		}

		setIsBusy( true );
		try {

			const download = await SketchfabService.getDownload( pendingItem.uid );
			const picked = SketchfabService.pickDownloadUrl( download );

			if ( picked.url ) {

				await onSelect( picked.url, pendingItem.name, pendingItem );

			} else {

				toast( {
					title: 'Not available as GLB',
					description: 'This model only ships as a glTF archive, which is not yet supported.',
					variant: 'destructive',
				} );

			}

		} catch ( e ) {

			toast( {
				title: e.code === 'SKETCHFAB_NO_TOKEN' ? 'Sketchfab token required' : 'Error loading model',
				description: e.message,
				variant: 'destructive',
			} );

		} finally {

			setIsBusy( false );

		}

	}, [ pendingItem, hasToken, onSelect, toast ] );

	const handleValueChange = useCallback( ( indexStr ) => setSelectedIndex( parseInt( indexStr ) ), [] );

	return (
		<div className="flex flex-col h-full w-full">

			{ ! hasToken && (
				<p className="px-2 pt-2 text-[10px] leading-tight text-muted-foreground">
					Browse only — set <code className="text-[10px]">VITE_SKETCHFAB_TOKEN</code> to download models.
				</p>
			)}

			{ ! selectedCategory ? (
				/* Primary listing: categories */
				<div className="flex-1 min-h-0 mt-2">
					<ItemsCatalog
						data={categories}
						value={null}
						onValueChange={handlePickCategory}
						isLoading={isLoadingCategories}
						error={categoriesError}
						catalogType="sketchfab-categories"
					/>
				</div>
			) : (
				/* Drill-down: models within the selected category */
				<div className="flex flex-col h-full min-h-0">
					<div className="flex items-center gap-1 px-2 py-1 border-b border-border">
						<Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={handleBack}>
							<ArrowLeft size={12} className="mr-1" /> Back
						</Button>
						<div className="flex items-center gap-1 text-xs text-primary ml-auto">
							<Package size={12} />
							{selectedCategory.name}
						</div>
					</div>

					<div className="px-2 pt-2">
						<div className="relative">
							<Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
							<Input
								type="text"
								value={query}
								onChange={( e ) => setQuery( e.target.value )}
								placeholder={`Search in ${selectedCategory.name}…`}
								className="h-7 pl-7 text-xs rounded-full bg-primary/20"
								aria-label="Search within category"
							/>
						</div>
					</div>

					<div className="flex-1 min-h-0 mt-2">
						<ItemsCatalog
							data={items}
							value={selectedIndex != null ? selectedIndex.toString() : null}
							onValueChange={handleValueChange}
							isLoading={isSearching}
							error={error}
							hideSearch
							catalogType="sketchfab"
						/>
					</div>

					<div className="px-2 py-2 border-t border-border space-y-2">
						{cursor && ! isSearching && (
							<Button
								variant="outline"
								size="sm"
								className="w-full h-7 text-xs"
								onClick={handleLoadMore}
								disabled={isLoadingMore}
							>
								{isLoadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Load more'}
							</Button>
						)}

						{pendingItem && (
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1">
									<p className="text-xs truncate" title={pendingItem.name}>{pendingItem.name}</p>
									<div className="flex items-center gap-1">
										{pendingItem.license?.slug && (
											<Badge variant="secondary" className="text-[9px] px-1 py-0">{pendingItem.license.slug}</Badge>
										)}
										<a
											href={pendingItem.redirection}
											target="_blank"
											rel="noopener noreferrer"
											className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5 hover:text-foreground"
										>
											View <ExternalLink size={9} />
										</a>
									</div>
								</div>
								<Button
									size="sm"
									className="h-7 text-xs shrink-0"
									onClick={handleConfirm}
									disabled={isBusy || ! hasToken || ! pendingItem.isDownloadable}
								>
									{isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : actionLabel}
								</Button>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);

};

export default SketchfabBrowser;
