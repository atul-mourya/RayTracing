
import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, Layers, Box, Circle, Cylinder, Cone, Lightbulb, Camera, ChevronRight, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const LayerTreeItem = ( { item, depth } ) => {

	const [ isOpen, setIsOpen ] = useState( true );
	const [ selectedNode, setSelectedNode ] = useState( null );

	const handleNodeClick = ( item ) => {

		if ( ! window.pathTracerApp ) return;

		if ( selectedNode && selectedNode?.uuid === item.uuid ) {

			window.pathTracerApp.selectObject( null );
			setSelectedNode( null );
			return;

		}

		const object = window.pathTracerApp.scene.getObjectByProperty( 'uuid', item.uuid );
		object && window.pathTracerApp.selectObject( object );
		window.pathTracerApp.refreshFrame();
		setSelectedNode( item.uuid );


	};

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger
				onClick={() => handleNodeClick( item )}
				className="flex items-center space-x-2 p-1 hover:bg-secondary rounded cursor-pointer w-full text-left opacity-50"
				style={{ paddingLeft: `${depth * 12 + 4}px` }}
			>
				{item.children.length > 0 && (
					isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />
				)}
				{item.icon}
				<span className="text-xs py-1 text-secondary-foreground">{item.name}</span>
			</CollapsibleTrigger>
			{item.children.length > 0 && (
				<CollapsibleContent>
					{item.children.map( ( child ) => (
						<LayerTreeItem key={child.uuid} item={child} depth={depth + 1} />
					) )}
				</CollapsibleContent>
			)}
		</Collapsible>
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
				children: object.children.map( createLayerItem )
			};

		};

		return [ createLayerItem( scene ) ];

	}, [] );

	const updateLayers = useCallback( () => {

		setLayers( getSceneElements() );

	}, [ getSceneElements ] );

	useEffect( () => {

		updateLayers();
		window.pathTracerApp?.addEventListener( 'SceneRebuild', updateLayers );
		return () => {

			window.pathTracerApp?.removeEventListener( 'SceneRebuild', updateLayers );

		};

	}, [ updateLayers ] );

	const renderFilteredLayers = ( layers, searchTerm ) => {

		return layers.filter( layer => {

			const matchesSearch = layer.name.toLowerCase().includes( searchTerm.toLowerCase() ) ||
                            layer.type.toLowerCase().includes( searchTerm.toLowerCase() );
			const hasMatchingChildren = layer.children.length > 0 && renderFilteredLayers( layer.children, searchTerm ).length > 0;
			return matchesSearch || hasMatchingChildren;

		} ).map( layer => ( {
			...layer,
			children: renderFilteredLayers( layer.children, searchTerm )
		} ) );

	};

	const filteredLayers = renderFilteredLayers( layers, searchTerm );

	return (
		<div className="w-full border-r flex flex-col">
			<div className="p-2 border-b">
				<div className="flex items-center justify-between mb-2">
					<span className="font-semibold">Layers</span>
					<Plus size={16} className="hover cursor-pointer" />
				</div>
				<div className="rounded flex items-center p-1">
					<Search size={14} className="mr-2" />
					<input
						type="text"
						placeholder="Search"
						className="bg-transparent outline-none text-xs w-full"
						value={searchTerm}
						onChange={( e ) => setSearchTerm( e.target.value )}
					/>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">
				{filteredLayers.map( ( layer, index ) => (
					<LayerTreeItem key={index} item={layer} depth={0} />
				) )}
			</div>
		</div>
	);

};

export default LeftSidebar;
