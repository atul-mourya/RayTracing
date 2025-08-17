import { useState, useEffect, useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore, useMaterialStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { TextRow } from '@/components/ui/text-row';

// Configuration for all material properties
const MATERIAL_PROPERTIES = {
	// Basic properties
	color: { type: 'color', default: '#ffffff', label: 'Color' },
	roughness: { type: 'slider', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Roughness' },
	metalness: { type: 'slider', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Metalness' },
	clearcoat: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Clearcoat' },
	clearcoatRoughness: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Clearcoat Roughness' },

	// Specular properties
	specularIntensity: { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Specular Intensity', section: 'specular' },
	specularColor: { type: 'color', default: '#ffffff', label: 'Specular Color', section: 'specular' },

	// Sheen properties
	sheen: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Sheen', section: 'sheen' },
	sheenRoughness: { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Sheen Roughness', section: 'sheen' },
	sheenColor: { type: 'color', default: '#000000', label: 'Sheen Color', section: 'sheen' },

	// Emissive properties
	emissive: { type: 'color', default: '#000000', label: 'Emissive', section: 'emissive' },
	emissiveIntensity: { type: 'slider', default: 1, min: 0, max: 10, step: 0.1, label: 'Emissive Intensity', section: 'emissive' },

	// Iridescence properties
	iridescence: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Iridescence', section: 'iridescence' },
	iridescenceIOR: { type: 'slider', default: 1.5, min: 1, max: 2.5, step: 0.01, label: 'Iridescence IOR', section: 'iridescence' },

	// Transmission properties
	opacity: { type: 'slider', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity', section: 'transmission' },
	ior: { type: 'slider', default: 1.5, min: 1, max: 2.5, step: 0.01, label: 'IOR', section: 'transmission' },
	transmission: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Transmission', section: 'transmission' },
	thickness: { type: 'slider', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Transmission Thickness', section: 'transmission' },
	attenuationColor: { type: 'color', default: '#ffffff', label: 'Attenuation Color', section: 'transmission' },
	attenuationDistance: { type: 'number', default: 0, min: 0, max: 1000, step: 1, label: 'Attenuation Distance', section: 'transmission' },
	dispersion: { type: 'slider', default: 0, min: 0, max: 10, step: 0.01, label: 'Dispersion', section: 'transmission' },
	alphaTest: { type: 'slider', default: 0, min: 0, max: 1, step: 0.01, label: 'Alpha Test', section: 'transmission' },

	// Special properties
	transparent: { type: 'switch', default: false, label: 'Transparent', section: 'other' },
	side: { type: 'select', default: 0, options: [ { value: 0, label: 'Front' }, { value: 1, label: 'Back' }, { value: 2, label: 'Double' } ], label: 'Side', section: 'other' },
	visible: { type: 'switch', default: true, label: 'Visible', section: 'basic' },
};

// Texture properties configuration
const TEXTURE_PROPERTIES = {
	offset: { type: 'vector2', default: { x: 0, y: 0 }, label: 'Offset' },
	repeat: { type: 'vector2', default: { x: 1, y: 1 }, label: 'Repeat' },
	normalScale: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Normal Scale', textureTypes: [ 'normalMap' ] },
	bumpScale: { type: 'number', default: 1, min: 0, max: 5, step: 0.1, label: 'Bump Scale', textureTypes: [ 'bumpMap' ] },
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
		Object.entries( MATERIAL_PROPERTIES ).forEach( ( [ key, config ] ) => {

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
			Object.entries( MATERIAL_PROPERTIES ).forEach( ( [ key, config ] ) => {

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
			if ( texture && texture.isTexture ) {

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
					) : undefined
				};

			}

		} );

		setAvailableTextures( textures );
		setTextureStates( newTextureStates );

	}, [ selectedObject ] );

	// Setup event listener for material updates
	useEffect( () => {

		updateMaterialStates();
		window.addEventListener( 'MaterialUpdate', updateMaterialStates );
		return () => window.removeEventListener( 'MaterialUpdate', updateMaterialStates );

	}, [ updateMaterialStates ] );

	// Setup event listener for texture updates
	useEffect( () => {

		updateAvailableTextures();
		window.addEventListener( 'MaterialUpdate', updateAvailableTextures );
		return () => window.removeEventListener( 'MaterialUpdate', updateAvailableTextures );

	}, [ updateAvailableTextures ] );

	// Generic handler for all property changes
	const handlePropertyChange = useCallback( ( property, value ) => {

		// Update local state
		setMaterialState( prev => ( { ...prev, [ property ]: value } ) );

		// Get the corresponding store handler
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

		// Update local state
		setTextureStates( prev => ( {
			...prev,
			[ textureName ]: {
				...prev[ textureName ],
				[ property ]: value
			}
		} ) );

		// Apply to store which will update the material data texture
		switch ( property ) {

			case 'offset':
				materialStore.handleTextureOffsetChange( textureName, value );
				break;
			case 'repeat':
				materialStore.handleTextureRepeatChange( textureName, value );
				break;
			case 'rotation':
				materialStore.handleTextureRotationChange( textureName, value );
				break;
			case 'normalScale':
				materialStore.handleNormalScaleChange( value );
				break;
			case 'bumpScale':
				materialStore.handleBumpScaleChange( value );
				break;

		}

	}, [ materialStore ] );

	// Render component based on property configuration
	const renderPropertyComponent = useCallback( ( property, config ) => {

		const value = materialState[ property ];
		const onChange = ( newValue ) => handlePropertyChange( property, newValue );

		switch ( config.type ) {

			case 'color':
				return <ColorInput label={config.label} value={value} onChange={onChange} />;

			case 'slider':
				return <Slider label={config.label} min={config.min} max={config.max} step={config.step} value={[ value ]} onValueChange={onChange} />;

			case 'number':
				return <NumberInput label={config.label} min={config.min} max={config.max} step={config.step} value={value} onValueChange={onChange} />;

			case 'switch':
				return <Switch label={config.label} checked={value} onCheckedChange={onChange} />;

			case 'checkbox':
				return (
					<div className="flex items-center justify-between">
						<label className="opacity-50 text-xs truncate">{config.label}</label>
						<input type="checkbox" checked={value} onChange={( e ) => onChange( e.target.checked )} />
					</div>
				);

			case 'select':
				return (
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
				);

			default:
				return null;

		}

	}, [ materialState, handlePropertyChange ] );

	// Render texture property component
	const renderTexturePropertyComponent = useCallback( ( textureName, property, config ) => {

		const textureState = textureStates[ textureName ];
		if ( ! textureState ) return null;

		// Check if this property applies to this texture type
		if ( config.textureTypes && ! config.textureTypes.includes( textureName ) ) {

			return null;

		}

		// Skip if the property doesn't exist for this texture
		if ( textureState[ property ] === undefined ) {

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
				return <Slider label={config.label} min={config.min} max={config.max} step={config.step} value={[ value ]} onValueChange={( val ) => onChange( val[ 0 ] )} />;

			case 'number': {

				// Ensure value is a number for scale properties
				const numericValue = typeof value === 'number' ? value : ( value?.x ?? 1 );
				return <NumberInput label={config.label} min={config.min} max={config.max} step={config.step} value={numericValue} onValueChange={onChange} />;

			}

			default:
				return null;

		}

	}, [ textureStates, handleTexturePropertyChange ] );

	// Group properties by section
	const groupedProperties = Object.entries( MATERIAL_PROPERTIES ).reduce( ( acc, [ key, config ] ) => {

		const section = config.section || 'basic';
		if ( ! acc[ section ] ) acc[ section ] = [];
		acc[ section ].push( [ key, config ] );
		return acc;

	}, {} );

	// Render placeholders if no valid object is selected
	if ( ! selectedObject ) {

		return <div className="p-4">Please select an object to customize its material properties.</div>;

	}

	if ( ! selectedObject.isMesh ) {

		return <div className="p-4">Selected object is not a mesh. Please select a mesh object.</div>;

	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between p-2">
				<TextRow label="Name" text={name} />
			</div>

			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border">
					<TabsTrigger value="properties" className="text-xs rounded-full">
						Properties
					</TabsTrigger>
					<TabsTrigger value="textures" className="text-xs rounded-full">
						Textures
					</TabsTrigger>
				</TabsList>

				{/* Properties Tab */}
				<TabsContent value="properties" className="flex-1 min-h-0 mx-2 pb-2">
					<div className="space-y-3">
						{/* Basic Properties */}
						{groupedProperties.basic?.map( ( [ property, config ] ) => (
							<div key={property} className="flex items-center justify-between">
								{renderPropertyComponent( property, config )}
							</div>
						) )}

						{/* Core Material Properties */}
						{groupedProperties.undefined?.map( ( [ property, config ] ) => (
							<div key={property} className="flex items-center justify-between">
								{renderPropertyComponent( property, config )}
							</div>
						) )}

						<Separator />

						{/* Specular Properties */}
						{groupedProperties.specular && (
							<>
								{groupedProperties.specular.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
								<Separator />
							</>
						)}

						{/* Sheen Properties */}
						{groupedProperties.sheen && (
							<>
								{groupedProperties.sheen.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
								<Separator />
							</>
						)}

						{/* Emissive Properties */}
						{groupedProperties.emissive && (
							<>
								{groupedProperties.emissive.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
								<Separator />
							</>
						)}

						{/* Iridescence Properties */}
						{groupedProperties.iridescence && (
							<>
								{groupedProperties.iridescence.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
								<Separator />
							</>
						)}

						{/* Transmission Properties */}
						{groupedProperties.transmission && (
							<>
								{groupedProperties.transmission.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
								<Separator />
							</>
						)}

						{/* Other Properties */}
						{groupedProperties.other && (
							<>
								{groupedProperties.other.map( ( [ property, config ] ) => (
									<div key={property} className="flex items-center justify-between">
										{renderPropertyComponent( property, config )}
									</div>
								) )}
							</>
						)}
					</div>
				</TabsContent>

				{/* Textures Tab */}
				<TabsContent value="textures" className="flex-1 min-h-0 mx-2 pb-2">
					<div className="">
						{availableTextures.length === 0 ? (
							<div className="text-center text-muted-foreground text-sm py-8">
								No textures available on this material
							</div>
						) : (
							availableTextures.map( ( { name, displayName } ) => (
								<div key={name} className="space-y-3">
									<div className="text-center opacity-50 text-xs bg-primary/20 rounded-full">{displayName}</div>

									{Object.entries( TEXTURE_PROPERTIES ).map( ( [ property, config ] ) => {

										const component = renderTexturePropertyComponent( name, property, config );

										if ( ! component ) return null;

										return (
											<div
												key={`${name}-${property}`}
												className="flex items-center justify-between"
											>
												{component}
											</div>
										);

									} )}
									<Separator />
								</div>
							) )
						)}
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default MaterialTab;
