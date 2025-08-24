import { useState, useEffect, useCallback, memo, useMemo } from 'react';
import { Plus, Search, Box, Circle, Cylinder, Camera, ChevronRight, ChevronDown, Sun, Flashlight, Boxes, Folder, Shapes, Triangle, LampDesk, Eye, EyeOff } from 'lucide-react';
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useStore } from '@/store';

import { cn } from "@/lib/utils";

// Extract the icon component into its own component
const ObjectIcon = memo( ( { object } ) => {

	const iconProps = {
		size: 10,
		className: "text-muted-foreground/70"
	};

	if ( object.type === 'Group' || object.type === 'Object3D' ) return <Folder {...iconProps} />;
	if ( object.type === 'Scene' ) return <Boxes {...iconProps} />;

	if ( object.type === 'Mesh' ) {

		const geometryType = object.geometry?.constructor?.name || '';

		if ( geometryType.includes( 'BoxGeometry' ) ) return <Box {...iconProps} />;
		if ( geometryType.includes( 'SphereGeometry' ) ) return <Circle {...iconProps} />;
		if ( geometryType.includes( 'CylinderGeometry' ) ) return <Cylinder {...iconProps} />;
		if ( geometryType.includes( 'ConeGeometry' ) ) return <Triangle {...iconProps} />;
		return <Shapes {...iconProps} />;

	}

	if ( object.type === 'DirectionalLight' ) return <Sun {...iconProps} />;
	if ( object.type === 'PointLight' ) return <LampDesk {...iconProps} />;
	if ( object.type === 'SpotLight' ) return <Flashlight {...iconProps} />;
	if ( object.type.includes( 'Camera' ) ) return <Camera {...iconProps} />;

	return <Shapes {...iconProps} />;

} );

ObjectIcon.displayName = 'ObjectIcon';

// Extract the indent lines to a separate component
const IndentLines = memo( ( { depth } ) => {

	return Array.from( { length: depth } ).map( ( _, index ) => (
		<div
			key={index}
			className="absolute top-0 bottom-0 border-l border-border/90"
			style={{
				left: `${( index * 16 ) + 20}px`,
				height: '100%'
			}}
		/>
	) );

} );

IndentLines.displayName = 'IndentLines';

// Extract the chevron toggle into its own component
const ChevronToggle = memo( ( { isOpen, onToggle, hasChildren } ) => {

	if ( ! hasChildren ) return <div className="w-4" />;

	return (
		<div
			onClick={onToggle}
			className="flex items-center justify-center w-4 h-4 hover:bg-transparent cursor-pointer"
		>
			{isOpen ?
				<ChevronDown className="h-3 w-3 text-muted-foreground/50" /> :
				<ChevronRight className="h-3 w-3 text-muted-foreground/50" />
			}
		</div>
	);

} );

ChevronToggle.displayName = 'ChevronToggle';

// Extract the visibility toggle into its own component
const VisibilityToggle = memo( ( { item } ) => {

	const toggleMeshVisibility = useStore( ( state ) => state.toggleMeshVisibility );

	const getMeshVisibility = useCallback( () => {

		if ( ! window.pathTracerApp ) return true;
		const object = window.pathTracerApp.scene.getObjectByProperty( 'uuid', item.uuid );
		return object?.visible ?? true;

	}, [ item.uuid ] );

	const [ isVisible, setIsVisible ] = useState( getMeshVisibility );

	const handleToggle = useCallback( ( e ) => {

		e.stopPropagation();
		toggleMeshVisibility( item.uuid );
		setIsVisible( prev => ! prev );

	}, [ toggleMeshVisibility, item.uuid ] );

	// Only show visibility toggle for meshes, return empty space for alignment
	if ( item.type !== 'Mesh' ) {

		return <div className="w-4 h-4" />;

	}

	return (
		<div
			onClick={handleToggle}
			className="flex items-center justify-center w-4 h-4 hover:bg-accent/50 cursor-pointer rounded-sm"
		>
			{isVisible ?
				<Eye className="h-3 w-3 text-muted-foreground/70 hover:text-foreground" /> :
				<EyeOff className="h-3 w-3 text-muted-foreground/70 hover:text-foreground" />
			}
		</div>
	);

} );

VisibilityToggle.displayName = 'VisibilityToggle';

// Extract the layer item node header into its own component
const LayerTreeItemHeader = memo( ( { item, depth, isSelected, isOpen, onNodeClick, onToggle } ) => {

	const paddingLeft = `${depth * 16 + 8}px`;
	const hasChildren = item.children.length > 0;

	return (
		<div className="relative">
			<IndentLines depth={depth} />
			<div
				onClick={onNodeClick}
				className={cn(
					"relative flex items-center w-full select-none group",
					"h-7 text-sm outline-hidden",
					"hover:bg-accent/50 hover:text-accent-foreground",
					"focus-visible:outline-hidden",
					isSelected && "bg-accent/50 text-accent-foreground",
				)}
			>
				<div
					className="flex items-center gap-0.5 px-1"
					style={{ paddingLeft }}
				>
					<VisibilityToggle item={item} />
					<ChevronToggle
						isOpen={isOpen}
						onToggle={onToggle}
						hasChildren={hasChildren}
					/>
					<div className={cn(
						"flex items-center gap-1 flex-1",
						"text-muted-foreground/70",
						"group-hover:text-accent-foreground/90",
						isSelected && "text-accent-foreground/90"
					)}>
						<div className="w-4 h-4 flex items-center justify-center opacity-50">
							<ObjectIcon object={item} />
						</div>
						<span className="text-xs truncate flex-1">
							{item.name}
						</span>
					</div>
				</div>
			</div>
		</div>
	);

} );

LayerTreeItemHeader.displayName = 'LayerTreeItemHeader';

// Extract the layer tree item content into its own component
const LayerTreeItemContent = memo( ( { item, isOpen, depth } ) => {

	if ( ! item.children.length ) return null;

	return (
		<Collapsible open={isOpen}>
			<CollapsibleContent>
				{item.children.map( ( child ) => (
					<LayerTreeItem key={child.uuid} item={child} depth={depth + 1} />
				) )}
			</CollapsibleContent>
		</Collapsible>
	);

} );

LayerTreeItemContent.displayName = 'LayerTreeItemContent';

// Main LayerTreeItem component that composes the above components
const LayerTreeItem = memo( ( { item, depth } ) => {

	const [ isOpen, setIsOpen ] = useState( true );
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setSelectedObject = useStore( ( state ) => state.setSelectedObject );

	const handleNodeClick = useCallback( ( e ) => {

		e.stopPropagation();

		if ( ! window.pathTracerApp ) return;

		if ( selectedObject && selectedObject.uuid === item.uuid ) {

			window.pathTracerApp.selectObject( null );
			window.pathTracerApp.refreshFrame();
			setSelectedObject( null );
			return;

		}

		const object = window.pathTracerApp.scene.getObjectByProperty( 'uuid', item.uuid );
		if ( object ) {

			window.pathTracerApp.selectObject( object );
			window.pathTracerApp.refreshFrame();
			setSelectedObject( object );

		}

	}, [ selectedObject, setSelectedObject, item.uuid ] );

	const handleChevronClick = useCallback( ( e ) => {

		e.stopPropagation();
		setIsOpen( prev => ! prev );

	}, [] );

	const isSelected = selectedObject && selectedObject.uuid === item.uuid;

	return (
		<div>
			<LayerTreeItemHeader
				item={item}
				depth={depth}
				isSelected={isSelected}
				isOpen={isOpen}
				onNodeClick={handleNodeClick}
				onToggle={handleChevronClick}
			/>
			<LayerTreeItemContent
				item={item}
				isOpen={isOpen}
				depth={depth}
			/>
		</div>
	);

} );

LayerTreeItem.displayName = 'LayerTreeItem';

// Extract search component
const SearchBar = memo( ( { value, onChange } ) => {

	return (
		<div className="flex items-center px-3 py-2 rounded-md bg-muted/50">
			<Search size={14} className="text-muted-foreground mr-2" />
			<input
				type="text"
				placeholder="Search layers..."
				className="bg-transparent text-xs w-full outline-hidden placeholder:text-muted-foreground/70"
				value={value}
				onChange={onChange}
			/>
		</div>
	);

} );

SearchBar.displayName = 'SearchBar';

// Extract header component
const OutlinerHeader = memo( ( { searchTerm, onSearchChange } ) => {

	return (
		<div className="p-2 border-b border-border">
			<div className="flex items-center justify-between mb-3">
				<span className="text-sm font-medium">Layers</span>
				<Plus
					size={16}
					className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
				/>
			</div>
			<SearchBar value={searchTerm} onChange={onSearchChange} />
		</div>
	);

} );

OutlinerHeader.displayName = 'OutlinerHeader';

// Main Outliner component now focuses on data and orchestrating the UI components
const Outliner = () => {

	const [ searchTerm, setSearchTerm ] = useState( '' );
	const layers = useStore( ( state ) => state.layers );
	const setLayers = useStore( ( state ) => state.setLayers );

	const createLayerItem = useCallback( ( object ) => {

		return {
			name: object.name || `${object.type} ${object.id}`,
			type: object.type,
			uuid: object.uuid,
			geometry: object.geometry?.constructor?.name,
			children: object.children.map( child => createLayerItem( child ) ),
		};

	}, [] );

	const getSceneElements = useCallback( () => {

		const scene = window.pathTracerApp?.scene;
		if ( ! scene ) return [];

		return [ createLayerItem( scene ) ];

	}, [ createLayerItem ] );

	const updateLayers = useCallback( () => {

		setLayers( getSceneElements() );

	}, [ getSceneElements, setLayers ] );

	useEffect( () => {

		const handleSceneUpdate = () => updateLayers();
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );
		// Initial update
		updateLayers();
		return () => window.removeEventListener( 'SceneRebuild', handleSceneUpdate );

	}, [ updateLayers ] );

	const renderFilteredLayers = useCallback( ( layers, term ) => {

		if ( ! term ) return layers;

		return layers
			.filter( layer => {

				const matchesSearch =
          layer.name.toLowerCase().includes( term.toLowerCase() ) ||
          layer.type.toLowerCase().includes( term.toLowerCase() );
				const hasMatchingChildren =
          layer.children.length > 0 &&
          renderFilteredLayers( layer.children, term ).length > 0;
				return matchesSearch || hasMatchingChildren;

			} )
			.map( layer => ( {
				...layer,
				children: renderFilteredLayers( layer.children, term ),
			} ) );

	}, [] );

	// Memoize filtered layers to avoid recalculation on every render
	const filteredLayers = useMemo( () =>
		renderFilteredLayers( layers, searchTerm )
	, [ layers, searchTerm, renderFilteredLayers ] );

	const handleSearchChange = useCallback( ( e ) => {

		setSearchTerm( e.target.value );

	}, [] );

	return (
		<div className="w-full h-full border-r border-border flex flex-col bg-background">
			<OutlinerHeader searchTerm={searchTerm} onSearchChange={handleSearchChange} />
			<div className="flex-1 overflow-y-auto py-2">
				{filteredLayers.length > 0 ? (
					filteredLayers.map( ( layer ) => (
						<LayerTreeItem key={layer.uuid} item={layer} depth={0} />
					) )
				) : (
					<div className="text-xs text-muted-foreground/70 px-4 py-2">
            No layers found.
					</div>
				)}
			</div>
		</div>
	);

};

export default Outliner;
