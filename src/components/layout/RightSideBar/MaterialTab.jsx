import { useState, useEffect, useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore, useMaterialStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { TexturePreview } from '@/components/ui/texture-preview';

// Configuration for all material properties - pregrouped by section
const MATERIAL_PROPERTIES = {
	basic: [
		[ 'visible', { type: 'switch', default: true, label: 'Visible' } ],
		[ 'color', { type: 'color', default: '#ffffff', label: 'Color' } ],
		[ 'roughness', { type: 'slider', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Roughness' } ],
		[ 'metalness', { type: 'slider', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Metalness' } ],
		[ 'clearcoat', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Clearcoat' } ],
		[ 'clearcoatRoughness', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Clearcoat Roughness' } ],
	],
	specular: [
		[ 'specularIntensity', { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Specular Intensity' } ],
		[ 'specularColor', { type: 'color', default: '#ffffff', label: 'Specular Color' } ],
	],
	sheen: [
		[ 'sheen', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Sheen' } ],
		[ 'sheenRoughness', { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Sheen Roughness' } ],
		[ 'sheenColor', { type: 'color', default: '#000000', label: 'Sheen Color' } ],
	],
	emissive: [
		[ 'emissive', { type: 'color', default: '#000000', label: 'Emissive' } ],
		[ 'emissiveIntensity', { type: 'slider', default: 1, min: 0, max: 10, step: 0.1, label: 'Emissive Intensity' } ],
	],
	iridescence: [
		[ 'iridescence', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Iridescence' } ],
		[ 'iridescenceIOR', { type: 'slider', default: 1.5, min: 1, max: 2.5, step: 0.01, label: 'Iridescence IOR' } ],
	],
	transmission: [
		[ 'opacity', { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' } ],
		[ 'ior', { type: 'slider', default: 1.5, min: 1, max: 2.5, step: 0.01, label: 'IOR' } ],
		[ 'transmission', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Transmission' } ],
		[ 'attenuationColor', { type: 'color', default: '#ffffff', label: 'Attenuation Color' } ],
		[ 'attenuationDistance', { type: 'number', default: 0, min: 0, max: 1000, step: 1, label: 'Attenuation Distance' } ],
		[ 'dispersion', { type: 'slider', default: 0, min: 0, max: 10, step: 0.01, label: 'Dispersion' } ],
		[ 'thickness', { type: 'slider', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Thickness' } ],
		[ 'alphaTest', { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Alpha Test' } ],
	],
	other: [
		[ 'transparent', { type: 'switch', default: false, label: 'Transparent' } ],
		[ 'side', { type: 'select', default: 0, options: [ { value: 0, label: 'Front' }, { value: 1, label: 'Back' }, { value: 2, label: 'Double' } ], label: 'Side' } ],
	]
};

// Flattened properties for initialization
const ALL_MATERIAL_PROPERTIES = Object.values( MATERIAL_PROPERTIES ).flat().reduce( ( acc, [ key, config ] ) => {

	acc[ key ] = config;
	return acc;

}, {} );


// Texture properties configuration
const TEXTURE_PROPERTIES = {
	offset: { type: 'vector2', default: { x: 0, y: 0 }, label: 'Offset' },
	repeat: { type: 'vector2', default: { x: 1, y: 1 }, label: 'Repeat' },
	normalScale: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Normal Scale', textureTypes: [ 'normalMap' ] },
	bumpScale: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Bump Scale', textureTypes: [ 'bumpMap' ] },
	displacementScale: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Displacement Scale', textureTypes: [ 'displacementMap' ] },
	rotation: { type: 'slider', default: 0, min: 0, max: 360, step: 1, label: 'Rotation (°)' },
};

// Common texture names that might be available on materials
const COMMON_TEXTURE_NAMES = [
	'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
	'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
	'specularMap', 'envMap', 'lightMap', 'clearcoatMap',
	'clearcoatNormalMap', 'clearcoatRoughnessMap'
];

const MaterialTab = () => {

	const selectedObject = useStore( useCallback( state => state.selectedObject, [] ) );
	const name = selectedObject?.name ?? "Unknown";
	const materialStore = useMaterialStore();

	// Tab state
	const [ activeTab, setActiveTab ] = useState( 'properties' );

	// Single state object for all material properties
	const [ materialState, setMaterialState ] = useState( () => {

		const initialState = {};
		Object.entries( ALL_MATERIAL_PROPERTIES ).forEach( ( [ key, config ] ) => {

			initialState[ key ] = config.default;

		} );
		return initialState;

	} );

	// Texture state for available textures
	const [ availableTextures, setAvailableTextures ] = useState( [] );
	const [ textureStates, setTextureStates ] = useState( {} );

	// Helper function to safely get hex string
	const getHexString = useCallback( ( colorObj ) => {

		return colorObj && typeof colorObj.getHexString === 'function'
			? `#${colorObj.getHexString()}`
			: '#ffffff';

	}, [] );

	// Update material states from selected object
	const updateMaterialStates = useCallback( () => {

		if ( ! selectedObject?.isMesh || ! selectedObject.material ) return;

		try {

			const newState = {};
			Object.entries( ALL_MATERIAL_PROPERTIES ).forEach( ( [ key, config ] ) => {

				if ( config.type === 'color' ) {

					newState[ key ] = getHexString( selectedObject.material[ key ] );

				} else {

					newState[ key ] = selectedObject.material[ key ] ?? config.default;

				}

			} );
			setMaterialState( newState );

		} catch ( error ) {

			console.error( "Error updating material states:", error );

		}

	}, [ selectedObject, getHexString ] );

	// Update available textures when selected object changes
	const updateAvailableTextures = useCallback( () => {

		if ( ! selectedObject?.isMesh || ! selectedObject.material ) {

			setAvailableTextures( [] );
			setTextureStates( {} );
			return;

		}

		const material = selectedObject.material;
		const textures = [];
		const newTextureStates = {};

		COMMON_TEXTURE_NAMES.forEach( textureName => {

			const texture = material[ textureName ];
			if ( texture?.isTexture ) {

				textures.push( {
					name: textureName,
					displayName: textureName.replace( /([A-Z])/g, ' $1' ).replace( /^./, str => str.toUpperCase() ),
					texture: texture
				} );

				// Initialize texture state
				newTextureStates[ textureName ] = {
					offset: { x: texture.offset?.x ?? 0, y: texture.offset?.y ?? 0 },
					repeat: { x: texture.repeat?.x ?? 1, y: texture.repeat?.y ?? 1 },
					rotation: texture.rotation ?? 0,
					normalScale: textureName === 'normalMap' ? (
						typeof material.normalScale === 'number' ? material.normalScale :
							material.normalScale?.x ?? 1
					) : undefined,
					bumpScale: textureName === 'bumpMap' ? (
						typeof material.bumpScale === 'number' ? material.bumpScale :
							material.bumpScale?.x ?? 1
					) : undefined,
					displacementScale: textureName === 'displacementMap' ? (
						typeof material.displacementScale === 'number' ? material.displacementScale :
							material.displacementScale?.x ?? 1
					) : undefined,
				};

			}

		} );

		setAvailableTextures( textures );
		setTextureStates( newTextureStates );

	}, [ selectedObject ] );

	// Setup event listeners
	useEffect( () => {

		updateMaterialStates();
		updateAvailableTextures();

		const handleUpdate = () => {

			updateMaterialStates();
			updateAvailableTextures();

		};

		window.addEventListener( 'MaterialUpdate', handleUpdate );
		return () => window.removeEventListener( 'MaterialUpdate', handleUpdate );

	}, [ updateMaterialStates, updateAvailableTextures ] );

	// Generic handler for all property changes
	const handlePropertyChange = useCallback( ( property, value ) => {

		setMaterialState( prev => ( { ...prev, [ property ]: value } ) );

		const handlerName = `handle${property.charAt( 0 ).toUpperCase() + property.slice( 1 )}Change`;
		const handler = materialStore[ handlerName ];

		if ( handler && typeof handler === 'function' ) {

			handler( value );

		} else {

			console.warn( `No handler found for property: ${property}` );

		}

	}, [ materialStore ] );

	// Handle texture property changes
	const handleTexturePropertyChange = useCallback( ( textureName, property, value ) => {

		setTextureStates( prev => ( {
			...prev,
			[ textureName ]: {
				...prev[ textureName ],
				[ property ]: value
			}
		} ) );

		// Consolidated switch with fallback
		const handlers = {
			offset: () => materialStore.handleTextureOffsetChange( textureName, value ),
			repeat: () => materialStore.handleTextureRepeatChange( textureName, value ),
			rotation: () => materialStore.handleTextureRotationChange( textureName, value ),
			normalScale: () => materialStore.handleNormalScaleChange( value ),
			bumpScale: () => materialStore.handleBumpScaleChange( value ),
			displacementScale: () => materialStore.handleDisplacementScaleChange( value )
		};

		handlers[ property ]?.();

	}, [ materialStore ] );

	// Optimized render function with memoized components
	const renderPropertyComponent = useCallback( ( property, config ) => {

		const value = materialState[ property ];
		const onChange = ( newValue ) => handlePropertyChange( property, newValue );

		const components = {
			color: () => <ColorInput label={config.label} value={value} onChange={onChange} />,
			slider: () => <Slider label={config.label} min={config.min} max={config.max} step={config.step} value={[ value ]} onValueChange={onChange} />,
			number: () => <NumberInput label={config.label} min={config.min} max={config.max} step={config.step} value={value} onValueChange={onChange} />,
			switch: () => <Switch label={config.label} checked={value} onCheckedChange={onChange} />,
			select: () => (
				<div className="flex items-center justify-between w-full">
					<div className="opacity-50 text-xs truncate">{config.label}</div>
					<Select value={value} onValueChange={onChange}>
						<SelectTrigger className="max-w-25 h-5 rounded-full">
							<SelectValue placeholder="Select" />
						</SelectTrigger>
						<SelectContent>
							{config.options.map( option => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							) )}
						</SelectContent>
					</Select>
				</div>
			)
		};

		const component = components[ config.type ]?.();
		return component ? (
			<div key={property} className="flex items-center justify-between">
				{component}
			</div>
		) : null;

	}, [ materialState, handlePropertyChange ] );

	// Simplified texture property renderer
	const renderTexturePropertyComponent = useCallback( ( textureName, property, config ) => {

		const textureState = textureStates[ textureName ];
		if ( ! textureState ||
			( config.textureTypes && ! config.textureTypes.includes( textureName ) ) ||
			textureState[ property ] === undefined ) {

			return null;

		}

		const value = textureState[ property ];
		const onChange = ( newValue ) => handleTexturePropertyChange( textureName, property, newValue );

		switch ( config.type ) {

			case 'vector2':
				return (
					<>
						<div className="opacity-50 text-xs">{config.label}</div>
						<div className="grid grid-cols-2 gap-y-1">
							<NumberInput
								label="X"
								value={value.x}
								step={0.1}
								onValueChange={( x ) => onChange( { ...value, x } )}
							/>
							<NumberInput
								label="Y"
								value={value.y}
								step={0.1}
								onValueChange={( y ) => onChange( { ...value, y } )}
							/>
						</div>
					</>
				);
			case 'slider':
				return <Slider className="h-4" label={config.label} min={config.min} max={config.max} step={config.step} value={[ value ]} onValueChange={( val ) => onChange( val[ 0 ] )} />;
			case 'number':
			{

				const numericValue = typeof value === 'number' ? value : ( value?.x ?? 1 );
				return <NumberInput label={config.label} min={config.min} max={config.max} step={config.step} value={numericValue} onValueChange={onChange} />;

			}

			default:
				return null;

		}

	}, [ textureStates, handleTexturePropertyChange ] );

	// Render section helper
	const renderSection = useCallback( ( sectionName, properties ) => (
		properties?.length > 0 && (
			<>
				{properties.map( ( [ property, config ] ) => renderPropertyComponent( property, config ) )}
				<Separator />
			</>
		)
	), [ renderPropertyComponent ] );

	// Early returns for invalid states
	if ( ! selectedObject ) {

		return <div className="p-4"><p className="text-sm text-center text-muted-foreground">Please select an object to customize its material properties</p></div>;

	}

	if ( ! selectedObject.isMesh ) {

		return <div className="p-4"><p className="text-sm text-center text-muted-foreground">Selected object is not a mesh. Please select a mesh object</p></div>;

	}

	return (
		<div className="flex flex-col h-full">
			<div className="py-1 flex-shrink-0">
				<div className="text-xs text-center px-2 font-medium truncate" title={name}>
					{name}
				</div>
			</div>

			<Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full flex-1 min-h-0">
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border flex-shrink-0">
					<TabsTrigger value="properties" className="text-xs rounded-full">
						Properties
					</TabsTrigger>
					<TabsTrigger value="textures" className="text-xs rounded-full">
						Textures
					</TabsTrigger>
				</TabsList>

				{/* Properties Tab */}
				<TabsContent value="properties" className="flex-1 min-h-0 overflow-y-auto mx-2 py-2 space-y-3">
					{MATERIAL_PROPERTIES.basic.map( ( [ property, config ] ) => renderPropertyComponent( property, config ) )}
					<Separator />
					{renderSection( 'specular', MATERIAL_PROPERTIES.specular )}
					{renderSection( 'sheen', MATERIAL_PROPERTIES.sheen )}
					{renderSection( 'emissive', MATERIAL_PROPERTIES.emissive )}
					{renderSection( 'iridescence', MATERIAL_PROPERTIES.iridescence )}
					{renderSection( 'transmission', MATERIAL_PROPERTIES.transmission )}
					{MATERIAL_PROPERTIES.other?.map( ( [ property, config ] ) => renderPropertyComponent( property, config ) )}
				</TabsContent>

				{/* Textures Tab */}
				<TabsContent value="textures" className="flex-1 min-h-0 overflow-y-auto mx-2 py-2 space-y-3">
					{availableTextures.length === 0 ? (
						<div className="text-center text-muted-foreground text-sm py-8">
							No textures available on this material
						</div>
					) : (
						<div className="space-y-4">
							{availableTextures.map( ( { name, displayName, texture } ) => (
								<div key={name} className="space-y-3">
									<div className="text-center opacity-50 text-xs bg-primary/20 rounded-full">{displayName}</div>
									<TexturePreview texture={texture} />
									{Object.entries( TEXTURE_PROPERTIES ).map( ( [ property, config ] ) => {

										const component = renderTexturePropertyComponent( name, property, config );
										return component ? (
											<div key={`${name}-${property}`} className="flex items-center justify-between">
												{component}
											</div>
										) : null;

									} )}
									<Separator className="mb-2" />
								</div>
							) )}
						</div>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default MaterialTab;


