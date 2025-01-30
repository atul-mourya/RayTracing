import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, Layers, Box, Circle, Cylinder, Cone, Lightbulb, Camera, ChevronRight, ChevronDown, Sun, Flashlight, Boxes, Folder, Shapes, Triangle, LampDesk } from 'lucide-react';
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useStore } from '@/store';

import { cn } from "@/lib/utils";

const getObjectIcon = ( object ) => {

	const iconProps = {
	  size: 13,
	  className: "text-muted-foreground/70"
	};

	if ( object.type === 'Group' || object.type === 'Object3D' ) {

	  return <Folder {...iconProps} />;

	}

	if ( object.type === 'Scene' ) {

	  return <Boxes {...iconProps} />;

	}

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

};

const LayerTreeItem = ( { item, depth } ) => {

	const [ isOpen, setIsOpen ] = useState( true );
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setSelectedObject = useStore( ( state ) => state.setSelectedObject );

	const handleNodeClick = ( e ) => {

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

	};

	const handleChevronClick = ( e ) => {

	  e.stopPropagation();
	  setIsOpen( ! isOpen );

	};

	const isSelected = selectedObject && selectedObject.uuid === item.uuid;

	return (
	  <div>
			<div className="relative">
				{/* Vertical indent lines */}
				{Array.from( { length: depth } ).map( ( _, index ) => (
					<div
						key={index}
						className="absolute top-0 bottom-0 border-l border-border/90"
						style={{
							left: `${( index * 16 ) + 20}px`,
							height: '100%'
			  			}}
					/>
				) )}
				<div
					onClick={handleNodeClick}
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
						style={{
							paddingLeft: `${depth * 16 + 8}px`,
			  			}}
					>
			  			{item.children.length > 0 && (
							<div
								onClick={handleChevronClick}
								className="flex items-center justify-center w-4 h-4 hover:bg-transparent cursor-pointer"
							>
								{isOpen ?
									<ChevronDown className="h-3 w-3 text-muted-foreground/50" /> :
									<ChevronRight className="h-3 w-3 text-muted-foreground/50" />
				  				}
							</div>
						)}
						{! item.children.length && (
							<div className="w-4" />
						)}
						<div className={cn(
							"flex items-center gap-1",
							"text-muted-foreground/70",
							"group-hover:text-accent-foreground/90",
							isSelected && "text-accent-foreground/90"
			  			)}>
							<div className="w-4 h-4 flex items-center justify-center opacity-50">
				  				{getObjectIcon( item )}
							</div>
							<span className="text-xs truncate">
				  				{item.name}
							</span>
			  			</div>
					</div>
				</div>
			</div>
			{item.children.length > 0 && (
		  		<Collapsible open={isOpen}>
					<CollapsibleContent>
			  			{item.children.map( ( child ) => (
							<LayerTreeItem key={child.uuid} item={child} depth={depth + 1} />
			  		) )}
					</CollapsibleContent>
		  		</Collapsible>
			)}
	  	</div>
	);

};

const LeftSidebar = () => {

	const [ layers, setLayers ] = useState( [] );
	const [ searchTerm, setSearchTerm ] = useState( '' );

	const getSceneElements = useCallback( () => {

		const scene = window.pathTracerApp?.scene;
		if ( ! scene ) return [];

		const createLayerItem = ( object ) => {

			let icon;
			switch ( object.type ) {

				case 'Mesh':
					if ( object.geometry.type.includes( 'Box' ) ) icon = <Box size={14} />;
					else if ( object.geometry.type.includes( 'Sphere' ) ) icon = <Circle size={14} />;
					else if ( object.geometry.type.includes( 'Cylinder' ) ) icon = <Cylinder size={14} />;
					else if ( object.geometry.type.includes( 'Cone' ) ) icon = <Cone size={14} />;
					else icon = <Layers size={14} />;
					break;
				case 'PointLight':
				case 'DirectionalLight':
				case 'SpotLight':
					icon = <Lightbulb size={14} />;
					break;
				case 'PerspectiveCamera':
				case 'OrthographicCamera':
					icon = <Camera size={14} />;
					break;
				default:
					icon = <Layers size={14} />;

			}

			return {
				name: object.name || `${object.type} ${object.id}`,
				type: object.type,
				uuid: object.uuid,
				icon: icon,
				children: object.children.map( createLayerItem ),
			};

		};

		return [ createLayerItem( scene ) ];

	}, [] );

	const updateLayers = useCallback( () => {

		setLayers( getSceneElements() );

	}, [ getSceneElements ] );

	useEffect( () => {

		const handleSceneUpdate = () => updateLayers();
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );
		return () => window.removeEventListener( 'SceneRebuild', handleSceneUpdate );

	}, [ updateLayers ] );

	const renderFilteredLayers = ( layers, searchTerm ) => {

		return layers
			.filter( ( layer ) => {

				const matchesSearch =
					layer.name.toLowerCase().includes( searchTerm.toLowerCase() ) ||
					layer.type.toLowerCase().includes( searchTerm.toLowerCase() );
				const hasMatchingChildren =
					layer.children.length > 0 && renderFilteredLayers( layer.children, searchTerm ).length > 0;
				return matchesSearch || hasMatchingChildren;

			} )
			.map( ( layer ) => ( {
				...layer,
				children: renderFilteredLayers( layer.children, searchTerm ),
			} ) );

	};

	const filteredLayers = renderFilteredLayers( layers, searchTerm );

	return (
		<div className="w-full h-full border-r border-border flex flex-col bg-background">
		  <div className="p-4 border-b border-border">
				<div className="flex items-center justify-between mb-3">
			  <span className="text-sm font-medium">Layers</span>
			  <Plus
						size={16}
						className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
			  />
				</div>
				<div className="flex items-center px-3 py-2 rounded-md bg-muted/50">
			  <Search size={14} className="text-muted-foreground mr-2" />
			  <input
						type="text"
						placeholder="Search layers..."
						className="bg-transparent text-xs w-full outline-hidden placeholder:text-muted-foreground/70"
						value={searchTerm}
						onChange={( e ) => setSearchTerm( e.target.value )}
			  />
				</div>
		  </div>
		  <div className="flex-1 overflow-y-auto py-2">
				{filteredLayers.map( ( layer, index ) => (
			  <LayerTreeItem key={index} item={layer} depth={0} />
				) )}
		  </div>
		</div>
	  );

};

export default LeftSidebar;
