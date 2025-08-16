import { useState, useEffect, useMemo, useCallback } from 'react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useAssetsStore, useStore } from '@/store';
import { usePolyHavenMaterialApplicator } from '@/hooks/usePolyHavenMaterialApplicator';
import { PolyHavenService } from '@/services/PolyHavenService';
import { AssetLoaderService } from '@/services/AssetLoaderService';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Package } from 'lucide-react';

const HierarchicalMaterialsTab = () => {

	const { toast } = useToast();
	const { selectedMaterial, setPolyHavenMaterials: setStorePolyHavenMaterials } = useAssetsStore();
	const { applyPolyHavenMaterial } = usePolyHavenMaterialApplicator();

	// Tab state
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );

	// PolyHaven hierarchical state
	const [ currentView, setCurrentView ] = useState( 'categories' ); // 'categories' or 'materials'
	const [ selectedCategory, setSelectedCategory ] = useState( null );
	const [ categories, setCategories ] = useState( [] );
	const [ categoryMaterials, setCategoryMaterials ] = useState( [] );

	// Current source hierarchical state
	const [ currentSourceView, setCurrentSourceView ] = useState( 'categories' ); // 'categories' or 'materials'
	const [ currentSourceSelectedCategory, setCurrentSourceSelectedCategory ] = useState( null );
	const [ currentSourceCategories, setCurrentSourceCategories ] = useState( [] );
	const [ currentSourceCategoryMaterials, setCurrentSourceCategoryMaterials ] = useState( [] );

	// Loading and error states
	const [ isLoadingCategories, setIsLoadingCategories ] = useState( false );
	const [ isLoadingMaterials, setIsLoadingMaterials ] = useState( false );
	const [ categoriesError, setCategoriesError ] = useState( null );
	const [ materialsError, setMaterialsError ] = useState( null );

	// Current source loading states
	const [ isLoadingCurrentSourceCategories, setIsLoadingCurrentSourceCategories ] = useState( false );
	const [ isLoadingCurrentSourceMaterials, setIsLoadingCurrentSourceMaterials ] = useState( false );
	const [ currentSourceCategoriesError, setCurrentSourceCategoriesError ] = useState( null );
	const [ currentSourceMaterialsError, setCurrentSourceMaterialsError ] = useState( null );

	// Selection states
	const [ selectedPolyHavenMaterial, setSelectedPolyHavenMaterial ] = useState( null );
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

				const categoriesData = await PolyHavenService.getCategories( 'textures' );

				// Convert categories object to array format for display
				const categoryArray = await Promise.all(
					Object.entries( categoriesData )
						.filter( ( [ key ] ) => key !== 'all' ) // Exclude 'all' category
						.map( async ( [ name, count ] ) => {

							// Fetch a sample material from this category for the preview
							let previewUrl = null;

							try {

								const sampleMaterials = await PolyHavenService.fetchTextureMaterials(
									'1k', // Use low resolution for faster loading
									[ name.toLowerCase() ],
									1 // Just get one material
								);

								if ( sampleMaterials.length > 0 ) {

									previewUrl = sampleMaterials[ 0 ].preview;

								}

							} catch ( error ) {

								console.warn( `Failed to fetch sample material for category ${name}:`, error );

							}

							return {
								id: name,
								name: name.charAt( 0 ).toUpperCase() + name.slice( 1 ), // Capitalize first letter
								preview: previewUrl || `https://cdn.polyhaven.com/asset_img/thumbs/placeholder.png?width=256&height=256`, // Fallback
								count,
								category: [ 'material-category' ],
								tags: [ name, 'category' ],
								description: `${count} materials available`
							};

						} )
				);

				// Sort by count, most popular first
				categoryArray.sort( ( a, b ) => b.count - a.count );

				setCategories( categoryArray );

				toast( {
					title: "Categories Loaded",
					description: `Loaded ${categoryArray.length} material categories`,
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

				// Fetch all materials and extract categories
				const allMaterials = await AssetLoaderService.fetchMaterialCatalog();
				const categoriesData = AssetLoaderService.extractCategoriesFromMaterials( allMaterials );

				// Convert categories object to array format for display
				const categoryArray = await Promise.all(
					Object.entries( categoriesData )
						.map( async ( [ name, count ] ) => {

							// Fetch a sample material from this category for the preview
							let previewUrl = null;

							try {

								const sampleMaterials = AssetLoaderService.filterMaterialsByCategories( allMaterials, [ name ] );

								if ( sampleMaterials.length > 0 && sampleMaterials[ 0 ].preview ) {

									previewUrl = sampleMaterials[ 0 ].preview;

								}

							} catch ( error ) {

								console.warn( `Failed to get sample material for category ${name}:`, error );

							}

							return {
								id: name,
								name: name.charAt( 0 ).toUpperCase() + name.slice( 1 ), // Capitalize first letter
								preview: previewUrl || null,
								count,
								category: [ 'material-category' ],
								tags: [ name, 'category' ],
								description: `${count} materials available`
							};

						} )
				);

				// Sort by count, most popular first
				categoryArray.sort( ( a, b ) => b.count - a.count );

				setCurrentSourceCategories( categoryArray );

				toast( {
					title: "Categories Loaded",
					description: `Loaded ${categoryArray.length} material categories`,
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

	// Load materials for selected category
	const loadCategoryMaterials = useCallback( async ( categoryName ) => {

		setIsLoadingMaterials( true );
		setMaterialsError( null );

		try {

			// Fetch materials with category filter
			const materials = await PolyHavenService.fetchTextureMaterials(
				polyHavenResolution,
				[ categoryName.toLowerCase() ], // Pass category as filter
				100 // Limit to 100 materials
			);

			setCategoryMaterials( materials );
			setStorePolyHavenMaterials( materials ); // Update the Zustand store as well

			toast( {
				title: "Materials Loaded",
				description: `Loaded ${materials.length} materials from ${categoryName} category`,
			} );

		} catch ( error ) {

			console.error( 'Error loading category materials:', error );
			setMaterialsError( error.message );

			toast( {
				title: "Error Loading Materials",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			setIsLoadingMaterials( false );

		}

	}, [ polyHavenResolution, toast, setStorePolyHavenMaterials ] );

	// Load current source materials for selected category
	const loadCurrentSourceCategoryMaterials = useCallback( async ( categoryName ) => {

		setIsLoadingCurrentSourceMaterials( true );
		setCurrentSourceMaterialsError( null );

		try {

			// Fetch materials with category filter
			const materials = await AssetLoaderService.fetchMaterialsByCategories(
				[ categoryName ], // Pass category as filter
				100 // Limit to 100 materials
			);

			setCurrentSourceCategoryMaterials( materials );

			toast( {
				title: "Materials Loaded",
				description: `Loaded ${materials.length} materials from ${categoryName} category`,
			} );

		} catch ( error ) {

			console.error( 'Error loading current source category materials:', error );
			setCurrentSourceMaterialsError( error.message );

			toast( {
				title: "Error Loading Materials",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			setIsLoadingCurrentSourceMaterials( false );

		}

	}, [ toast ] );

	// Handle category selection
	const handleCategorySelection = useCallback( ( categoryId ) => {

		const category = categories.find( cat => cat.id === categoryId );
		if ( category ) {

			setSelectedCategory( category );
			setCurrentView( 'materials' );
			loadCategoryMaterials( category.id );

		}

	}, [ categories, loadCategoryMaterials ] );

	// Handle current source category selection
	const handleCurrentSourceCategorySelection = useCallback( ( categoryId ) => {

		const category = currentSourceCategories.find( cat => cat.id === categoryId );
		if ( category ) {

			setCurrentSourceSelectedCategory( category );
			setCurrentSourceView( 'materials' );
			loadCurrentSourceCategoryMaterials( category.id );

		}

	}, [ currentSourceCategories, loadCurrentSourceCategoryMaterials ] );

	// Handle back to categories
	const handleBackToCategories = useCallback( () => {

		setCurrentView( 'categories' );
		setSelectedCategory( null );
		setCategoryMaterials( [] );
		setSelectedPolyHavenMaterial( null );

	}, [] );

	// Handle back to current source categories
	const handleBackToCurrentSourceCategories = useCallback( () => {

		setCurrentSourceView( 'categories' );
		setCurrentSourceSelectedCategory( null );
		setCurrentSourceCategoryMaterials( [] );

	}, [] );

	// Handle resolution change
	const handlePolyHavenResolutionChange = useCallback( ( newResolution ) => {

		setPolyHavenResolution( newResolution );

		// If we're currently viewing materials in a category, reload them with new resolution
		if ( currentView === 'materials' && selectedCategory ) {

			setCategoryMaterials( [] ); // Clear current materials
			setSelectedPolyHavenMaterial( null );
			loadCategoryMaterials( selectedCategory.id );

		}

	}, [ currentView, selectedCategory, loadCategoryMaterials ] );

	// Helper functions for material selection
	const getMaterialValue = useCallback( () => {

		return selectedMaterial !== null && selectedMaterial !== undefined ? selectedMaterial.toString() : null;

	}, [ selectedMaterial ] );

	const getPolyHavenMaterialValue = useCallback( () => {

		return selectedPolyHavenMaterial !== null && selectedPolyHavenMaterial !== undefined ? selectedPolyHavenMaterial.toString() : null;

	}, [ selectedPolyHavenMaterial ] );

	const handlePolyHavenMaterialChange = useCallback( ( value ) => {

		const materialIndex = parseInt( value );
		setSelectedPolyHavenMaterial( materialIndex );
		applyPolyHavenMaterial( value );

	}, [ applyPolyHavenMaterial ] );

	// Handle current source material selection
	const handleCurrentSourceMaterialChange = useCallback( async ( value ) => {

		const materialIndex = parseInt( value );

		if ( materialIndex < 0 || materialIndex >= currentSourceCategoryMaterials.length ) {

			console.error( 'Invalid current source material index:', materialIndex );
			return;

		}

		const materialData = currentSourceCategoryMaterials[ materialIndex ];

		// Get current selected object and loading state
		const selectedObject = useStore.getState().selectedObject;
		const setLoading = useStore.getState().setLoading;

		if ( ! selectedObject ) {

			toast( {
				title: "No Object Selected",
				description: "Please select an object to apply material to",
				variant: "destructive",
			} );
			return;

		}

		if ( ! selectedObject.material ) {

			toast( {
				title: "Invalid Object",
				description: "The selected object doesn't have a material property",
				variant: "destructive",
			} );
			return;

		}

		setLoading( {
			isLoading: true,
			title: "Apply",
			status: "Processing Material...",
			progress: 0
		} );

		try {

			// Import MaterialService
			const { MaterialService } = await import( '@/services/MaterialService' );

			// Apply material properties to the Three.js material
			MaterialService.applyMaterialToObject( materialData, selectedObject.material );

			// Update path tracer with new material
			MaterialService.updatePathTracerMaterial( selectedObject );

			setLoading( { isLoading: false } );

			toast( {
				title: "Material Applied",
				description: materialData?.name || `Current Source Material #${materialIndex}`,
			} );

		} catch ( error ) {

			console.error( "Error applying current source material:", error );
			setLoading( { isLoading: false } );

			toast( {
				title: "Error Applying Material",
				description: error.message,
				variant: "destructive",
			} );

		}

	}, [ currentSourceCategoryMaterials, toast ] );

	// Transform categories for ItemsCatalog display
	const categoriesForDisplay = useMemo( () => {

		// Categories already have preview URLs from their sample materials
		return categories;

	}, [ categories ] );

	// Transform current source categories for ItemsCatalog display
	const currentSourceCategoriesForDisplay = useMemo( () => {

		// Categories already have preview URLs from their sample materials
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
						Current Source
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="text-xs rounded-full">
						PolyHaven
					</TabsTrigger>
				</TabsList>

				{/* Current source hierarchical materials */}
				<TabsContent value="current" className="flex-1 min-h-0 mx-2 mt-0">
					<div className="flex flex-col h-full">
						{/* Header with navigation and controls */}
						<div className="flex items-center justify-between py-1 shrink-0 border-b">
							{currentSourceView === 'materials' && (
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
									catalogType="current-source-categories"
									className="h-full"
								/>
							) : (
								<ItemsCatalog
									data={currentSourceCategoryMaterials}
									value={getMaterialValue()}
									onValueChange={handleCurrentSourceMaterialChange}
									isLoading={isLoadingCurrentSourceMaterials}
									error={currentSourceMaterialsError}
									catalogType="current-source-materials"
									className="h-full"
								/>
							)}
						</div>
					</div>
				</TabsContent>

				{/* PolyHaven hierarchical materials */}
				<TabsContent value="polyhaven" className="flex-1 min-h-0 mx-2 mt-0">
					<div className="flex flex-col h-full">
						{/* Header with navigation and controls */}
						<div className="flex items-center justify-between py-1 shrink-0 border-b">
							{currentView === 'materials' && (
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

									{/* Resolution selector - only show when viewing materials */}
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
											<SelectItem value="8k">8K</SelectItem>
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
									catalogType="polyhaven-categories"
									className="h-full"
								/>
							) : (
								<ItemsCatalog
									data={categoryMaterials}
									value={getPolyHavenMaterialValue()}
									onValueChange={handlePolyHavenMaterialChange}
									isLoading={isLoadingMaterials}
									error={materialsError}
									catalogType="polyhaven-materials"
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

export default HierarchicalMaterialsTab;
