import { useState, useEffect, useMemo, useCallback } from 'react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useAssetsStore, useStore } from '@/store';
import { PolyHavenService } from '@/services/PolyHavenService';
import { EnvironmentService } from '@/services/EnvironmentService';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Package } from 'lucide-react';

const HierarchicalEnvironmentsTab = () => {

	const { toast } = useToast();
	const { selectedEnvironmentIndex, setEnvironment, setSelectedEnvironmentIndex } = useAssetsStore();

	// Tab state
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );

	// PolyHaven hierarchical state
	const [ currentView, setCurrentView ] = useState( 'categories' ); // 'categories' or 'environments'
	const [ selectedCategory, setSelectedCategory ] = useState( null );
	const [ categories, setCategories ] = useState( [] );
	const [ categoryEnvironments, setCategoryEnvironments ] = useState( [] );

	// Current source hierarchical state
	const [ currentSourceView, setCurrentSourceView ] = useState( 'categories' ); // 'categories' or 'environments'
	const [ currentSourceSelectedCategory, setCurrentSourceSelectedCategory ] = useState( null );
	const [ currentSourceCategories, setCurrentSourceCategories ] = useState( [] );
	const [ currentSourceCategoryEnvironments, setCurrentSourceCategoryEnvironments ] = useState( [] );

	// Loading and error states
	const [ isLoadingCategories, setIsLoadingCategories ] = useState( false );
	const [ isLoadingEnvironments, setIsLoadingEnvironments ] = useState( false );
	const [ categoriesError, setCategoriesError ] = useState( null );
	const [ environmentsError, setEnvironmentsError ] = useState( null );

	// Current source loading states
	const [ isLoadingCurrentSourceCategories, setIsLoadingCurrentSourceCategories ] = useState( false );
	const [ isLoadingCurrentSourceEnvironments, setIsLoadingCurrentSourceEnvironments ] = useState( false );
	const [ currentSourceCategoriesError, setCurrentSourceCategoriesError ] = useState( null );
	const [ currentSourceEnvironmentsError, setCurrentSourceEnvironmentsError ] = useState( null );

	// Selection states
	const [ selectedPolyHavenEnvironment, setSelectedPolyHavenEnvironment ] = useState( null );
	const [ polyHavenResolution, setPolyHavenResolution ] = useState( '1k' );

	// Load categories when PolyHaven tab becomes active
	useEffect( () => {

		const loadCategories = async () => {

			if ( activeSourceTab !== 'polyhaven' || categories.length > 0 ) {

				return; // Don't load if not active or already loaded

			}

			setIsLoadingCategories( true );
			setCategoriesError( null );

			try {

				const categoriesData = await PolyHavenService.getCategories( 'hdris' );

				// Convert categories object to array format for display
				const categoryArray = await Promise.all(
					Object.entries( categoriesData )
						.filter( ( [ key ] ) => key !== 'all' ) // Exclude 'all' category
						.map( async ( [ name, count ] ) => {

							// Fetch a sample environment from this category for the preview
							let previewUrl = null;

							try {

								const sampleEnvironments = await PolyHavenService.getAssets( 'hdris', [ name.toLowerCase() ] );
								const envEntries = Object.entries( sampleEnvironments );

								if ( envEntries.length > 0 ) {

									const [ sampleId ] = envEntries[ 0 ];
									previewUrl = `https://cdn.polyhaven.com/asset_img/thumbs/${sampleId}.png?width=256&height=256`;

								}

							} catch ( error ) {

								console.warn( `Failed to fetch sample environment for category ${name}:`, error );

							}

							return {
								id: name,
								name: name.charAt( 0 ).toUpperCase() + name.slice( 1 ), // Capitalize first letter
								preview: previewUrl || `https://cdn.polyhaven.com/asset_img/thumbs/placeholder.png?width=256&height=256`, // Fallback
								count,
								category: [ 'environment-category' ],
								tags: [ name, 'category' ],
								description: `${count} environments available`
							};

						} )
				);

				// Sort by count, most popular first
				categoryArray.sort( ( a, b ) => b.count - a.count );

				setCategories( categoryArray );

				toast( {
					title: "Categories Loaded",
					description: `Loaded ${categoryArray.length} environment categories`,
				} );

			} catch ( error ) {

				console.error( 'Error loading PolyHaven categories:', error );
				setCategoriesError( error.message );

				toast( {
					title: "Error Loading Categories",
					description: error.message,
					variant: "destructive",
				} );

			} finally {

				setIsLoadingCategories( false );

			}

		};

		loadCategories();

	}, [ activeSourceTab, categories.length, toast ] );

	// Load current source categories when current tab becomes active
	useEffect( () => {

		const loadCurrentSourceCategories = async () => {

			if ( activeSourceTab !== 'current' || currentSourceCategories.length > 0 ) {

				return; // Don't load if not active or already loaded

			}

			setIsLoadingCurrentSourceCategories( true );
			setCurrentSourceCategoriesError( null );

			try {

				// Get all local environments and extract categories
				const allEnvironments = EnvironmentService.getLocalEnvironmentsByCategories();
				const categoriesData = EnvironmentService.extractCategoriesFromEnvironments( allEnvironments );

				// Convert categories object to array format for display
				const categoryArray = await Promise.all(
					Object.entries( categoriesData )
						.map( async ( [ name, count ] ) => {

							// Fetch a sample environment from this category for the preview
							let previewUrl = null;

							try {

								const sampleEnvironments = EnvironmentService.getLocalEnvironmentsByCategories( [ name ] );

								if ( sampleEnvironments.length > 0 && sampleEnvironments[ 0 ].preview ) {

									previewUrl = sampleEnvironments[ 0 ].preview;

								}

							} catch ( error ) {

								console.warn( `Failed to get sample environment for category ${name}:`, error );

							}

							return {
								id: name,
								name: name.charAt( 0 ).toUpperCase() + name.slice( 1 ), // Capitalize first letter
								preview: previewUrl || null,
								count,
								category: [ 'environment-category' ],
								tags: [ name, 'category' ],
								description: `${count} environments available`
							};

						} )
				);

				// Sort by count, most popular first
				categoryArray.sort( ( a, b ) => b.count - a.count );

				setCurrentSourceCategories( categoryArray );

				toast( {
					title: "Categories Loaded",
					description: `Loaded ${categoryArray.length} environment categories`,
				} );

			} catch ( error ) {

				console.error( 'Error loading current source categories:', error );
				setCurrentSourceCategoriesError( error.message );

				toast( {
					title: "Error Loading Categories",
					description: error.message,
					variant: "destructive",
				} );

			} finally {

				setIsLoadingCurrentSourceCategories( false );

			}

		};

		if ( activeSourceTab === 'current' ) {

			loadCurrentSourceCategories();

		}

	}, [ activeSourceTab, currentSourceCategories.length, toast ] );

	// Load environments for selected PolyHaven category
	const loadCategoryEnvironments = useCallback( async ( categoryName ) => {

		setIsLoadingEnvironments( true );
		setEnvironmentsError( null );

		try {

			// Fetch environments with category filter
			const assetsData = await PolyHavenService.getAssets( 'hdris', [ categoryName.toLowerCase() ] );

			// Process environments for display - we'll get the actual download URLs later
			const environments = Object.entries( assetsData )
				.map( ( [ id, info ] ) => ( {
					id,
					name: info.name,
					preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=170`,
					category: info.categories,
					tags: info.tags,
					redirection: `https://polyhaven.com/a/${id}`,
					// We'll resolve the actual URL when the environment is selected
					url: null,
					assetId: id, // Store the asset ID for URL resolution
					source: 'polyhaven',
					resolution: polyHavenResolution
				} ) );

			setCategoryEnvironments( environments );

			toast( {
				title: "Environments Loaded",
				description: `Loaded ${environments.length} environments from ${categoryName} category`,
			} );

		} catch ( error ) {

			console.error( 'Error loading category environments:', error );
			setEnvironmentsError( error.message );

			toast( {
				title: "Error Loading Environments",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			setIsLoadingEnvironments( false );

		}

	}, [ polyHavenResolution, toast ] );

	// Load current source environments for selected category
	const loadCurrentSourceCategoryEnvironments = useCallback( async ( categoryName ) => {

		setIsLoadingCurrentSourceEnvironments( true );
		setCurrentSourceEnvironmentsError( null );

		try {

			// Fetch environments with category filter
			const environments = EnvironmentService.getLocalEnvironmentsByCategories( [ categoryName ] );

			setCurrentSourceCategoryEnvironments( environments );

			toast( {
				title: "Environments Loaded",
				description: `Loaded ${environments.length} environments from ${categoryName} category`,
			} );

		} catch ( error ) {

			console.error( 'Error loading current source category environments:', error );
			setCurrentSourceEnvironmentsError( error.message );

			toast( {
				title: "Error Loading Environments",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			setIsLoadingCurrentSourceEnvironments( false );

		}

	}, [ toast ] );

	// Handle category selection
	const handleCategorySelection = useCallback( ( categoryId ) => {

		const category = categories.find( cat => cat.id === categoryId );
		if ( category ) {

			setSelectedCategory( category );
			setCurrentView( 'environments' );
			loadCategoryEnvironments( category.id );

		}

	}, [ categories, loadCategoryEnvironments ] );

	// Handle current source category selection
	const handleCurrentSourceCategorySelection = useCallback( ( categoryId ) => {

		const category = currentSourceCategories.find( cat => cat.id === categoryId );
		if ( category ) {

			setCurrentSourceSelectedCategory( category );
			setCurrentSourceView( 'environments' );
			loadCurrentSourceCategoryEnvironments( category.id );

		}

	}, [ currentSourceCategories, loadCurrentSourceCategoryEnvironments ] );

	// Handle back to categories
	const handleBackToCategories = useCallback( () => {

		setCurrentView( 'categories' );
		setSelectedCategory( null );
		setCategoryEnvironments( [] );
		setSelectedPolyHavenEnvironment( null );

	}, [] );

	// Handle back to current source categories
	const handleBackToCurrentSourceCategories = useCallback( () => {

		setCurrentSourceView( 'categories' );
		setCurrentSourceSelectedCategory( null );
		setCurrentSourceCategoryEnvironments( [] );

	}, [] );

	// Handle resolution change
	const handlePolyHavenResolutionChange = useCallback( ( newResolution ) => {

		setPolyHavenResolution( newResolution );

		// If we're currently viewing environments in a category, reload them with new resolution
		if ( currentView === 'environments' && selectedCategory ) {

			setCategoryEnvironments( [] ); // Clear current environments
			setSelectedPolyHavenEnvironment( null );
			loadCategoryEnvironments( selectedCategory.id );

		}

	}, [ currentView, selectedCategory, loadCategoryEnvironments ] );

	// Helper functions for environment selection
	const getEnvironmentValue = useCallback( () => {

		return selectedEnvironmentIndex !== null && selectedEnvironmentIndex !== undefined ? selectedEnvironmentIndex.toString() : null;

	}, [ selectedEnvironmentIndex ] );

	const getPolyHavenEnvironmentValue = useCallback( () => {

		return selectedPolyHavenEnvironment !== null && selectedPolyHavenEnvironment !== undefined ? selectedPolyHavenEnvironment.toString() : null;

	}, [ selectedPolyHavenEnvironment ] );

	const handlePolyHavenEnvironmentChange = useCallback( async ( value ) => {

		const environmentIndex = parseInt( value );
		setSelectedPolyHavenEnvironment( environmentIndex );

		if ( environmentIndex < 0 || environmentIndex >= categoryEnvironments.length ) {

			console.error( 'Invalid PolyHaven environment index:', environmentIndex );
			return;

		}

		const environmentData = categoryEnvironments[ environmentIndex ];

		// Get loading state
		const setLoading = useStore.getState().setLoading;

		setLoading( {
			isLoading: true,
			title: "Load",
			status: "Resolving HDRI URL...",
			progress: 25
		} );

		try {

			// Use the new service method to get the best available HDRI file
			const hdriFileInfo = await PolyHavenService.getAssetHDRIFile(
				environmentData.assetId,
				polyHavenResolution
			);

			setLoading( {
				isLoading: true,
				title: "Load",
				status: "Loading Environment...",
				progress: 75
			} );

			// Create the environment object with the resolved URL
			const resolvedEnvironmentData = {
				...environmentData,
				url: hdriFileInfo.url,
				actualResolution: hdriFileInfo.actualResolution,
				requestedResolution: hdriFileInfo.requestedResolution
			};

			await EnvironmentService.loadEnvironment( resolvedEnvironmentData );
			setEnvironment( resolvedEnvironmentData );

			setLoading( { isLoading: false } );

			// Show success message with resolution info
			const resolutionNote = hdriFileInfo.actualResolution !== polyHavenResolution
				? ` (${hdriFileInfo.actualResolution} resolution used)`
				: '';

			toast( {
				title: "Environment Loaded",
				description: `${environmentData?.name || `PolyHaven Environment #${environmentIndex}`}${resolutionNote}`,
			} );

		} catch ( error ) {

			console.error( "Error loading PolyHaven environment:", error );
			setLoading( { isLoading: false } );

			toast( {
				title: "Error Loading Environment",
				description: error.message,
				variant: "destructive",
			} );

		}

	}, [ categoryEnvironments, polyHavenResolution, toast, setEnvironment ] );

	// Handle current source environment selection
	const handleCurrentSourceEnvironmentChange = useCallback( async ( value ) => {

		const environmentIndex = parseInt( value );

		if ( environmentIndex < 0 || environmentIndex >= currentSourceCategoryEnvironments.length ) {

			console.error( 'Invalid current source environment index:', environmentIndex );
			return;

		}

		const environmentData = currentSourceCategoryEnvironments[ environmentIndex ];

		// Get loading state
		const setLoading = useStore.getState().setLoading;

		setLoading( {
			isLoading: true,
			title: "Load",
			status: "Loading Environment...",
			progress: 0
		} );

		try {

			await EnvironmentService.loadEnvironment( environmentData );
			setEnvironment( environmentData );
			setSelectedEnvironmentIndex( environmentIndex );

			setLoading( { isLoading: false } );

			toast( {
				title: "Environment Loaded",
				description: environmentData?.name || `Current Source Environment #${environmentIndex}`,
			} );

		} catch ( error ) {

			console.error( "Error loading current source environment:", error );
			setLoading( { isLoading: false } );

			toast( {
				title: "Error Loading Environment",
				description: error.message,
				variant: "destructive",
			} );

		}

	}, [ currentSourceCategoryEnvironments, toast, setEnvironment, setSelectedEnvironmentIndex ] );

	// Transform categories for ItemsCatalog display
	const categoriesForDisplay = useMemo( () => {

		// Categories already have preview URLs from their sample environments
		return categories;

	}, [ categories ] );

	// Transform current source categories for ItemsCatalog display
	const currentSourceCategoriesForDisplay = useMemo( () => {

		// Categories already have preview URLs from their sample environments
		return currentSourceCategories;

	}, [ currentSourceCategories ] );

	return (
		<div className="flex flex-col h-full">
			{/* Source tabs */}
			<Tabs
				value={activeSourceTab}
				onValueChange={setActiveSourceTab}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border">
					<TabsTrigger value="current" className="text-xs rounded-full">
						Featured
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="text-xs rounded-full">
						PolyHaven
					</TabsTrigger>
				</TabsList>

				{/* Current source hierarchical environments */}
				<TabsContent value="current" className="flex-1 min-h-0 mx-2 mt-0">
					<div className="flex flex-col h-full">
						{/* Header with navigation and controls */}
						<div className="flex items-center justify-between py-1 shrink-0 border-b">
							{currentSourceView === 'environments' && (
								<div className="flex justify-between w-full h-5">
									<Button
										variant="ghost"
										size="sm"
										onClick={handleBackToCurrentSourceCategories}
										className="h-full px-2 hover:cursor-pointer text-muted-foreground"
									>
										<ArrowLeft size={12} className="mr-1" />
										Back
									</Button>
									<div className="flex items-center text-center gap-1 text-xs text-primary">
										{currentSourceView !== 'categories' && (
											<>
												<Package size={12} />
												{currentSourceSelectedCategory?.name}
											</>
										)}
									</div>
								</div>
							)}
						</div>

						{/* Content area */}
						<div className="flex-1 min-h-0">
							{currentSourceView === 'categories' ? (
								<ItemsCatalog
									data={currentSourceCategoriesForDisplay}
									value={null} // No persistent selection for categories
									onValueChange={( index ) => {

										const categoryIndex = parseInt( index );
										const category = currentSourceCategories[ categoryIndex ];
										if ( category ) {

											handleCurrentSourceCategorySelection( category.id );

										}

									}}
									isLoading={isLoadingCurrentSourceCategories}
									error={currentSourceCategoriesError}
									catalogType="current-source-environment-categories"
									className="h-full"
								/>
							) : (
								<ItemsCatalog
									data={currentSourceCategoryEnvironments}
									value={getEnvironmentValue()}
									onValueChange={handleCurrentSourceEnvironmentChange}
									isLoading={isLoadingCurrentSourceEnvironments}
									error={currentSourceEnvironmentsError}
									catalogType="current-source-environments"
									className="h-full"
								/>
							)}
						</div>
					</div>
				</TabsContent>

				{/* PolyHaven hierarchical environments */}
				<TabsContent value="polyhaven" className="flex-1 min-h-0 mx-2 mt-0">
					<div className="flex flex-col h-full">
						{/* Header with navigation and controls */}
						<div className="flex items-center justify-between py-1 shrink-0 border-b">
							{currentView === 'environments' && (
								<div className="flex justify-between w-full h-5">
									<Button
										variant="ghost"
										size="sm"
										onClick={handleBackToCategories}
										className="h-full px-2 hover:cursor-pointer text-muted-foreground"
									>
										<ArrowLeft size={12} className="mr-1" />
										Back
									</Button>
									<div className="flex items-center text-center gap-1 text-xs text-primary">
										{currentView !== 'categories' && (
											<>
												<Package size={12} />
												{selectedCategory?.name}
											</>
										)}
									</div>

									{/* Resolution selector - only show when viewing environments */}
									<Select
										value={polyHavenResolution}
										onValueChange={handlePolyHavenResolutionChange}
									>
										<SelectTrigger className="max-w-15 h-full rounded-full text-xs hover:cursor-pointer">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="1k">1K</SelectItem>
											<SelectItem value="2k">2K</SelectItem>
											<SelectItem value="4k">4K</SelectItem>
										</SelectContent>
									</Select>

								</div>
							)}
						</div>

						{/* Content area */}
						<div className="flex-1 min-h-0">
							{currentView === 'categories' ? (
								<ItemsCatalog
									data={categoriesForDisplay}
									value={null} // No persistent selection for categories
									onValueChange={( index ) => {

										const categoryIndex = parseInt( index );
										const category = categories[ categoryIndex ];
										if ( category ) {

											handleCategorySelection( category.id );

										}

									}}
									isLoading={isLoadingCategories}
									error={categoriesError}
									catalogType="polyhaven-environment-categories"
									className="h-full"
								/>
							) : (
								<ItemsCatalog
									data={categoryEnvironments}
									value={getPolyHavenEnvironmentValue()}
									onValueChange={handlePolyHavenEnvironmentChange}
									isLoading={isLoadingEnvironments}
									error={environmentsError}
									catalogType="polyhaven-environments"
									className="h-full"
								/>
							)}
						</div>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default HierarchicalEnvironmentsTab;
