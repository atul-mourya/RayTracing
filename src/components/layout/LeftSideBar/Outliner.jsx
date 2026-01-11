import { useState, useEffect, useCallback, memo, useMemo } from 'react';
import {
	Search, Box, Circle, Cylinder, Camera, ChevronRight, ChevronDown,
	Sun, Flashlight, Boxes, Folder, Shapes, Triangle, LampDesk,
	Eye, EyeOff, Layers, Filter
} from 'lucide-react';
import { useStore } from '@/store';
import { cn } from "@/lib/utils";

// Theme-compliant styling constants
const STYLES = {
	bg: 'bg-background',
	itemActive: 'bg-accent text-accent-foreground',
	text: 'text-foreground',
	textMuted: 'text-muted-foreground',
	border: 'border-border',
	inputBg: 'bg-muted/50',
	iconOrange: 'text-orange-500',
	iconGreen: 'text-emerald-500',
	iconDefault: 'text-foreground',
};

// Icon component with theme colors
const ObjectIcon = memo( ( { object } ) => {

	const baseClass = "w-3 h-3 opacity-70";

	if ( object.type === 'Group' || object.type === 'Object3D' )
		return <Folder className={cn( baseClass, STYLES.iconDefault, "opacity-70" )} />;

	if ( object.type === 'Scene' )
		return <Boxes className={cn( baseClass, STYLES.iconDefault )} />;

	// Meshes - Orange (Blender convention, mapped to Tailwind palette)
	if ( object.type === 'Mesh' ) {

		const geometryType = object.geometry?.constructor?.name || '';
		const meshClass = cn( baseClass, STYLES.iconOrange );

		if ( geometryType.includes( 'BoxGeometry' ) ) return <Box className={meshClass} />;
		if ( geometryType.includes( 'SphereGeometry' ) ) return <Circle className={meshClass} />;
		if ( geometryType.includes( 'CylinderGeometry' ) ) return <Cylinder className={meshClass} />;
		if ( geometryType.includes( 'ConeGeometry' ) ) return <Triangle className={meshClass} />;
		return <Shapes className={meshClass} />;

	}

	// Lights & Camera - Orange
	if ( object.type === 'DirectionalLight' ) return <Sun className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type === 'PointLight' ) return <LampDesk className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type === 'SpotLight' ) return <Flashlight className={cn( baseClass, STYLES.iconOrange )} />;
	if ( object.type.includes( 'Camera' ) ) return <Camera className={cn( baseClass, STYLES.iconOrange )} />;

	return <Shapes className={cn( baseClass, STYLES.iconOrange )} />;

} );

ObjectIcon.displayName = 'ObjectIcon';

const VisibilityToggle = memo( ( { item, isVisible, onVisibilityChange } ) => {

	const toggleMeshVisibility = useStore( ( state ) => state.toggleMeshVisibility );

	const handleToggle = useCallback( ( e ) => {

		e.stopPropagation();
		toggleMeshVisibility( item.uuid );
		onVisibilityChange?.( ! isVisible );

	}, [ toggleMeshVisibility, item.uuid, isVisible, onVisibilityChange ] );

	// Only show visibility toggle for meshes as currently supported by the store
	const show = item.type === 'Mesh';

	if ( ! true ) return <div className="w-5" />;

	return (
		<div
			onClick={handleToggle}
			className={cn(
				"flex items-center justify-center w-5 h-5 cursor-pointer hover:bg-accent/50 rounded-sm ml-auto",
				! isVisible && "opacity-50"
			)}
		>
			{isVisible ?
				<Eye size={14} className={STYLES.text} /> :
				<EyeOff size={14} className={STYLES.text} />
			}
		</div>
	);

} );

VisibilityToggle.displayName = 'VisibilityToggle';

const ChevronToggle = memo( ( { isOpen, onToggle, hasChildren } ) => {

	return (
		<div
			onClick={hasChildren ? onToggle : undefined}
			className={cn(
				"flex items-center justify-center w-5 h-full cursor-pointer hover:text-foreground",
				! hasChildren && "opacity-0 pointer-events-none"
			)}
		>
			{isOpen ?
				<ChevronDown size={14} className="opacity-50" /> :
				<ChevronRight size={14} className="opacity-50" />
			}
		</div>
	);

} );

ChevronToggle.displayName = 'ChevronToggle';

const LayerTreeItem = memo( ( { item, depth } ) => {

	const [ isOpen, setIsOpen ] = useState( true );
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setSelectedObject = useStore( ( state ) => state.setSelectedObject );

	const getInitialVisibility = useCallback( () => {

		if ( item.visible !== undefined ) return item.visible;
		if ( item.type !== 'Mesh' || ! window.pathTracerApp ) return true;
		const object = window.pathTracerApp.scene.getObjectByProperty( 'uuid', item.uuid );
		return object?.visible ?? true;

	}, [ item ] );

	const [ isVisible, setIsVisible ] = useState( getInitialVisibility );

	const handleVisibilityChange = useCallback( ( newVisibility ) => {

		setIsVisible( newVisibility );

	}, [] );

	useEffect( () => {

		const handleMeshVisibilityChanged = ( event ) => {

			if ( event.detail.uuid === item.uuid ) {

				setIsVisible( event.detail.visible );

			}

		};

		window.addEventListener( 'meshVisibilityChanged', handleMeshVisibilityChanged );
		return () => window.removeEventListener( 'meshVisibilityChanged', handleMeshVisibilityChanged );

	}, [ item.uuid ] );

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

	const toggleOpen = useCallback( ( e ) => {

		e.stopPropagation();
		setIsOpen( p => ! p );

	}, [] );

	const isSelected = selectedObject && selectedObject.uuid === item.uuid;
	const paddingLeft = depth * 12 + 8;

	return (
		<div className="flex flex-col select-none min-w-full w-fit">
			<div
				className={cn(
					"group flex items-center h-7 pr-1 cursor-pointer transition-colors border-none outline-none min-w-full w-fit",
					isSelected ? STYLES.itemActive : "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
					! isVisible && "opacity-50"
				)}
				style={{ paddingLeft: paddingLeft }}
				onClick={handleNodeClick}
			>
				<ChevronToggle isOpen={isOpen} onToggle={toggleOpen} hasChildren={item.children.length > 0} />

				<div className="flex items-center justify-center w-5 h-full">
					<ObjectIcon object={item} />
				</div>

				<span className={cn(
					"text-xs ml-1 flex-1 whitespace-nowrap pr-2",
					isSelected ? "text-accent-foreground font-medium" : "opacity-70"
				)}>
					{item.name}
				</span>

				{/* Right side controls */}
				<div className="sticky right-0 flex items-center h-full pl-2 pr-1 ml-auto">
					<div className="absolute inset-0 bg-background -z-20" />
					<div className={cn(
						"absolute inset-0 -z-10 transition-colors",
						isSelected ? "bg-accent" : "group-hover:bg-accent/0"
					)} />
					{/* Gradient mask for smooth transition - simplified */}
					<div className={cn(
						"absolute left-0 top-0 bottom-0 w-4 -translate-x-full bg-gradient-to-l from-background to-transparent pointer-events-none",
						isSelected && "from-accent"
					)} />
					<VisibilityToggle item={item} isVisible={isVisible} onVisibilityChange={handleVisibilityChange} />
				</div>
			</div>

			{item.children.length > 0 && isOpen && (
				<div className="flex flex-col">
					{item.children.map( child => (
						<LayerTreeItem key={child.uuid} item={child} depth={depth + 1} />
					) )}
				</div>
			)}
		</div>
	);

} );

LayerTreeItem.displayName = 'LayerTreeItem';

const OutlinerHeader = memo( ( { searchTerm, onSearchChange } ) => {

	return (
		<div className={cn( "flex items-center px-2 py-1 gap-1 shrink-0 border-b h-10", STYLES.bg, STYLES.border )}>
			{/* View Layer Button */}
			<div className={cn( "h-7 w-7 flex items-center justify-center rounded hover:bg-accent/50 cursor-pointer text-muted-foreground hover:text-foreground transition-colors" )}>
				<Layers size={14} strokeWidth={1.5} />
			</div>

			{/* Search Bar */}
			<div className={cn( "flex-1 h-7 flex items-center px-2 rounded gap-2", STYLES.inputBg )}>
				<Search size={12} className="text-muted-foreground/50" />
				<input
					value={searchTerm}
					onChange={onSearchChange}
					placeholder="Search..."
					className="bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground/50 w-full focus:ring-0 p-0 leading-none"
				/>
			</div>

			{/* Filter Button */}
			<div className={cn( "h-7 w-7 flex items-center justify-center rounded hover:bg-accent/50 cursor-pointer text-muted-foreground hover:text-foreground transition-colors" )}>
				<Filter size={14} strokeWidth={1.5} />
			</div>
		</div>
	);

} );

OutlinerHeader.displayName = 'OutlinerHeader';

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
			visible: object.visible ?? true,
			children: object.children.map( child => createLayerItem( child ) ),
		};

	}, [] );

	const getSceneElements = useCallback( () => {

		const scene = window.pathTracerApp?.scene;
		if ( ! scene ) return [];

		const sceneGraph = [ createLayerItem( scene ) ];

		if ( sceneGraph.length > 0 && sceneGraph[ 0 ].type === 'Scene' ) {

			sceneGraph[ 0 ].name = "Scene Collection";

		}

		return sceneGraph;

	}, [ createLayerItem ] );

	const updateLayers = useCallback( () => {

		setLayers( getSceneElements() );

	}, [ getSceneElements, setLayers ] );

	useEffect( () => {

		const handleSceneUpdate = () => updateLayers();
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );
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

	const filteredLayers = useMemo( () =>
		renderFilteredLayers( layers, searchTerm )
	, [ layers, searchTerm, renderFilteredLayers ] );

	const handleSearchChange = useCallback( ( e ) => {

		setSearchTerm( e.target.value );

	}, [] );

	return (
		<div className={cn( "w-full h-full flex flex-col overflow-hidden select-none", STYLES.bg )}>
			<OutlinerHeader searchTerm={searchTerm} onSearchChange={handleSearchChange} />
			<div className="flex-1 overflow-auto py-1">
				<div className="flex flex-col min-w-full w-fit">
					{filteredLayers.length > 0 ? (
						filteredLayers.map( ( layer ) => (
							<LayerTreeItem key={layer.uuid} item={layer} depth={0} />
						) )
					) : (
						<div className="text-xs text-muted-foreground/50 px-4 py-8 text-center italic">
            No items found
						</div>
					)}
				</div>
			</div>
		</div>
	);

};

export default Outliner;
