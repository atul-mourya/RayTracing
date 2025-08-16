import { useState, useEffect, useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
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
	normalScale: { type: 'slider', default: 1, min: 0, max: 5, step: 0.1, label: 'Normal Scale' },
	bumpScale: { type: 'slider', default: 1, min: 0, max: 5, step: 0.1, label: 'Bump Scale' },
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
	transparent: { type: 'checkbox', default: false, label: 'Transparent', section: 'other' },
	side: { type: 'select', default: 0, options: [ { value: 0, label: 'Front' }, { value: 1, label: 'Back' }, { value: 2, label: 'Double' } ], label: 'Side', section: 'other' },
	visible: { type: 'switch', default: true, label: 'Visible', section: 'basic' },
};

const MaterialTab = () => {

	const selectedObject = useStore( useCallback( state => state.selectedObject, [] ) );
	const name = selectedObject?.name ?? "Unknown";
	const materialStore = useMaterialStore();

	// Single state object for all material properties
	const [ materialState, setMaterialState ] = useState( () => {

		const initialState = {};
		Object.entries( MATERIAL_PROPERTIES ).forEach( ( [ key, config ] ) => {

			initialState[ key ] = config.default;

		} );
		return initialState;

	} );

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

	// Setup event listener for material updates
	useEffect( () => {

		updateMaterialStates();
		window.addEventListener( 'MaterialUpdate', updateMaterialStates );
		return () => window.removeEventListener( 'MaterialUpdate', updateMaterialStates );

	}, [ updateMaterialStates ] );

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

	// Render component based on property configuration
	const renderPropertyComponent = useCallback( ( property, config ) => {

		const value = materialState[ property ];
		const onChange = ( newValue ) => handlePropertyChange( property, newValue );

		switch ( config.type ) {

			case 'color':
				return <ColorInput label={config.label} value={value} onChange={onChange} />

			case 'slider':
				return <Slider label={config.label} min={config.min} max={config.max} step={config.step} value={[ value ]} onValueChange={onChange} />

			case 'number':
				return <NumberInput label={config.label} min={config.min} max={config.max} step={config.step} value={value} onValueChange={onChange} />

			case 'switch':
				return <Switch label={config.label} checked={value} onCheckedChange={onChange} />

			case 'checkbox':
				return (
					<div className="flex items-center justify-between">
						<label className="opacity-50 text-xs truncate">{config.label}</label>
						<input type="checkbox" checked={value} onChange={( e ) => onChange( e.target.checked )} />
					</div>
				);

			case 'select':
				return (
					<div className="flex items-center justify-between">
						<Select value={value} onValueChange={onChange}>
							<span className="opacity-50 text-xs truncate">{config.label}</span>
							<SelectTrigger className="max-w-20 h-5 rounded-full">
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
		<div className="space-y-4 p-4">
			<div className="flex items-center justify-between">
				<TextRow label="Name" text={name} />
			</div>

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
	);

};

export default MaterialTab;
