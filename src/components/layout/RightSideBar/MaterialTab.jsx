import { useState, useEffect, useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { useStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { TextRow } from '@/components/ui/text-row';

const MaterialTab = () => {

	const selectedObject = useStore( ( state ) => state.selectedObject );
	const name = selectedObject?.name ?? "Unknown";

	// Material property states
	const [ color, setColor ] = useState( '#ffffff' );
	const [ roughness, setRoughness ] = useState( 0.5 );
	const [ metalness, setMetalness ] = useState( 0.5 );
	const [ ior, setIor ] = useState( 1.5 );
	const [ transmission, setTransmission ] = useState( 0 );
	const [ thickness, setThickness ] = useState( 0.1 );
	const [ attenuationColor, setAttenuationColor ] = useState( '#ffffff' );
	const [ attenuationDistance, setAttenuationDistance ] = useState( 0 );
	const [ dispersion, setDispersion ] = useState( 0 );
	const [ emissiveIntensity, setEmissiveIntensity ] = useState( 1 );
	const [ clearcoat, setClearcoat ] = useState( 0 );
	const [ clearcoatRoughness, setClearcoatRoughness ] = useState( 0 );
	const [ opacity, setOpacity ] = useState( 1 );
	const [ side, setSide ] = useState( 0 );
	const [ emissive, setEmissive ] = useState( '#000000' );
	const [ transparent, setTransparent ] = useState( false );
	const [ alphaTest, setAlphaTest ] = useState( 0 );
	const [ visible, setVisible ] = useState( true );
	const [ sheen, setSheen ] = useState( 0 );
	const [ sheenRoughness, setSheenRoughness ] = useState( 1 );
	const [ sheenColor, setSheenColor ] = useState( '#000000' );
	const [ specularIntensity, setSpecularIntensity ] = useState( 1 );
	const [ specularColor, setSpecularColor ] = useState( '#ffffff' );
	const [ iridescence, setIridescence ] = useState( 0 );
	const [ iridescenceIOR, setIridescenceIOR ] = useState( 1.5 );
	const [ iridescenceThicknessRange, setIridescenceThicknessRange ] = useState( [ 100, 400 ] );

	// Update material states from selected object
	const updateMaterialStates = useCallback( () => {

		if ( ! selectedObject?.isMesh || ! selectedObject.material ) return;

		try {

			// Helper function to safely get hex string
			const getHexString = ( colorObj ) => {

				return colorObj && typeof colorObj.getHexString === 'function'
					? `#${colorObj.getHexString()}`
					: '#ffffff';

			};

			// Update all material states at once
			setColor( getHexString( selectedObject.material.color ) );
			setRoughness( selectedObject.material.roughness ?? 0.5 );
			setMetalness( selectedObject.material.metalness ?? 0.5 );
			setIor( selectedObject.material.ior ?? 1.5 );
			setTransmission( selectedObject.material.transmission ?? 0 );
			setThickness( selectedObject.material.thickness ?? 0.1 );
			setAttenuationColor( getHexString( selectedObject.material.attenuationColor ) );
			setAttenuationDistance( selectedObject.material.attenuationDistance ?? 0 );
			setDispersion( selectedObject.material.dispersion ?? 0 );
			setEmissiveIntensity( selectedObject.material.emissiveIntensity ?? 1 );
			setClearcoat( selectedObject.material.clearcoat ?? 0 );
			setClearcoatRoughness( selectedObject.material.clearcoatRoughness ?? 0 );
			setOpacity( selectedObject.material.opacity ?? 1 );
			setSide( selectedObject.material.side ?? 0 );
			setEmissive( getHexString( selectedObject.material.emissive ) );
			setTransparent( selectedObject.material.transparent ?? false );
			setAlphaTest( selectedObject.material.alphaTest ?? 0 );
			setVisible( selectedObject.material.visible ?? true );
			setSheen( selectedObject.material.sheen ?? 0 );
			setSheenRoughness( selectedObject.material.sheenRoughness ?? 1 );
			setSheenColor( getHexString( selectedObject.material.sheenColor ) );
			setSpecularIntensity( selectedObject.material.specularIntensity ?? 1 );
			setSpecularColor( getHexString( selectedObject.material.specularColor ) );
			setIridescence( selectedObject.material.iridescence ?? 0 );
			setIridescenceIOR( selectedObject.material.iridescenceIOR ?? 1.5 );
			setIridescenceThicknessRange( selectedObject.material.iridescenceThicknessRange ?? [ 100, 400 ] );

		} catch ( error ) {

			console.error( "Error updating material states:", error );

		}

	}, [ selectedObject ] );

	// Setup event listener for material updates
	useEffect( () => {

		updateMaterialStates();

		window.addEventListener( 'MaterialUpdate', updateMaterialStates );
		return () => window.removeEventListener( 'MaterialUpdate', updateMaterialStates );

	}, [ updateMaterialStates ] );

	// Improved material property update function
	const updateMaterialProperty = ( property, value ) => {

		if ( ! selectedObject?.isMesh || ! selectedObject.material ) return;

		try {

			// Update the Three.js material property
			selectedObject.material[ property ] = value;

			// Get material index with fallback
			const materialIndex = selectedObject.userData?.materialIndex ?? 0;

			// Update the path tracer material (supporting multiple APIs)
			const pathTracer = window.pathTracerApp?.pathTracingPass;
			if ( ! pathTracer ) {

				console.warn( "Path tracer not available" );
				return;

			}

			// Try different APIs in order of preference
			if ( typeof pathTracer.updateMaterial === 'function' ) {

				// New API - update entire material
				pathTracer.updateMaterial( materialIndex, selectedObject.material );

			} else if ( typeof pathTracer.updateMaterialProperty === 'function' ) {

				// Mid-level API - update specific property
				pathTracer.updateMaterialProperty( materialIndex, property, value );

			} else if ( typeof pathTracer.updateMaterialDataTexture === 'function' ) {

				// Legacy API - update through data texture
				pathTracer.updateMaterialDataTexture( materialIndex, property, value );

			} else if ( typeof pathTracer.rebuildMaterialDataTexture === 'function' ) {

				// Oldest API - rebuild entire texture
				pathTracer.rebuildMaterialDataTexture( materialIndex, selectedObject.material );

			} else {

				console.warn( "No compatible material update method found" );

			}

			// Reset rendering to apply changes
			if ( window.pathTracerApp?.reset ) {

				window.pathTracerApp.reset();

			}

		} catch ( error ) {

			console.error( `Error updating material property ${property}:`, error );

		}

	};

	// Handler functions (simplified to avoid repetition)
	const createHandler = ( setter, property, transform = value => value ) => {

		return ( value ) => {

			setter( value );
			updateMaterialProperty( property, transform( value ) );

		};

	};

	// Create handlers for all properties
	const handleColorChange = createHandler( setColor, 'color', value => selectedObject.material.color.set( value ) );
	const handleRoughnessChange = createHandler( setRoughness, 'roughness', value => value[ 0 ] );
	const handleMetalnessChange = createHandler( setMetalness, 'metalness', value => value[ 0 ] );
	const handleIorChange = createHandler( setIor, 'ior', value => value[ 0 ] );
	const handleTransmissionChange = createHandler( setTransmission, 'transmission', value => value[ 0 ] );
	const handleThicknessChange = createHandler( setThickness, 'thickness', value => value[ 0 ] );
	const handleAttenuationColorChange = createHandler(
		setAttenuationColor,
		'attenuationColor',
		value => selectedObject.material.attenuationColor.set( value )
	);
	const handleAttenuationDistanceChange = createHandler( setAttenuationDistance, 'attenuationDistance' );
	const handleDispersionChange = createHandler( setDispersion, 'dispersion', value => value[ 0 ] );
	const handleEmissiveIntensityChange = createHandler( setEmissiveIntensity, 'emissiveIntensity', value => value[ 0 ] );
	const handleClearcoatChange = createHandler( setClearcoat, 'clearcoat', value => value[ 0 ] );
	const handleClearcoatRoughnessChange = createHandler( setClearcoatRoughness, 'clearcoatRoughness', value => value[ 0 ] );
	const handleOpacityChange = createHandler( setOpacity, 'opacity', value => value[ 0 ] );
	const handleSideChange = createHandler( setSide, 'side' );
	const handleEmissiveChange = createHandler(
		setEmissive,
		'emissive',
		value => selectedObject.material.emissive.set( value )
	);
	const handleTransparentChange = createHandler( setTransparent, 'transparent', value => value ? 1 : 0 );
	const handleAlphaTestChange = createHandler( setAlphaTest, 'alphaTest', value => value[ 0 ] );
	const handleSheenChange = createHandler( setSheen, 'sheen', value => value[ 0 ] );
	const handleSheenRoughnessChange = createHandler( setSheenRoughness, 'sheenRoughness', value => value[ 0 ] );
	const handleSheenColorChange = createHandler(
		setSheenColor,
		'sheenColor',
		value => selectedObject.material.sheenColor.set( value )
	);
	const handleSpecularIntensityChange = createHandler( setSpecularIntensity, 'specularIntensity', value => value[ 0 ] );
	const handleSpecularColorChange = createHandler(
		setSpecularColor,
		'specularColor',
		value => selectedObject.material.specularColor.set( value )
	);
	const handleIridescenceChange = createHandler( setIridescence, 'iridescence', value => value[ 0 ] );
	const handleIridescenceIORChange = createHandler( setIridescenceIOR, 'iridescenceIOR', value => value[ 0 ] );
	const handleIridescenceThicknessRangeChange = createHandler( setIridescenceThicknessRange, 'iridescenceThicknessRange' );

	// Special handler for visibility that affects the object itself
	const handleVisibleChange = ( value ) => {

		setVisible( value );
		if ( selectedObject ) {

			selectedObject.visible = value;
			updateMaterialProperty( 'visible', value ? 1 : 0 );

		}

	};

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
				<TextRow label="Name" text={name}/>
			</div>
			<div className="flex items-center justify-between">
				<Switch label="Visible" checked={visible} onCheckedChange={handleVisibleChange} />
			</div>
			<div className="flex items-center justify-between">
				<ColorInput label={"Color"} value={color} onChange={handleColorChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Roughness"} min={0} max={1} step={0.01} value={[ roughness ]} onValueChange={handleRoughnessChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Metalness"} min={0} max={1} step={0.01} value={[ metalness ]} onValueChange={handleMetalnessChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Clearcoat"} min={0} max={1} step={0.01} value={[ clearcoat ]} onValueChange={handleClearcoatChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Clearcoat Roughness"} min={0} max={1} step={0.01} value={[ clearcoatRoughness ]} onValueChange={handleClearcoatRoughnessChange} />
			</div>
			<Separator />
			<div className="flex items-center justify-between">
				<Slider label={"Specular Intensity"} min={0} max={1} step={0.01} value={[ specularIntensity ]} onValueChange={handleSpecularIntensityChange} />
			</div>
			<div className="flex items-center justify-between">
				<ColorInput label={"Specular Color"} value={specularColor} onChange={handleSpecularColorChange} />
			</div>
			<Separator />
			<div className="flex items-center justify-between">
				<Slider label={"Sheen"} min={0} max={1} step={0.01} value={[ sheen ]} onValueChange={handleSheenChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Sheen Roughness"} min={0} max={1} step={0.01} value={[ sheenRoughness ]} onValueChange={handleSheenRoughnessChange} />
			</div>
			<div className="flex items-center justify-between">
				<ColorInput label={"Sheen Color"} value={sheenColor} onChange={handleSheenColorChange} />
			</div>
			<Separator />
			<div className="flex items-center justify-between">
				<ColorInput label={"Emissive"} value={emissive} onChange={handleEmissiveChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Emissive Intensity"} min={0} max={10} step={0.1} value={[ emissiveIntensity ]} onValueChange={handleEmissiveIntensityChange} />
			</div>
			<Separator />
			<div className="flex items-center justify-between">
				<Slider label={"Iridescence"} min={0} max={1} step={0.01} value={[ iridescence ]} onValueChange={handleIridescenceChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Iridescence IOR"} min={1} max={2.5} step={0.01} value={[ iridescenceIOR ]} onValueChange={handleIridescenceIORChange} />
			</div>
			{/* <div className="flex items-center justify-between">
				<DraggableInput label={"Iridescence Thickness Range"} min={0} max={1000} step={1} value={iridescenceThicknessRange} onValueChange={handleIridescenceThicknessRangeChange} />
			</div> */}
			<Separator />
			<div className="flex items-center justify-between">
				<Slider label={"Opacity"} min={0} max={1} step={0.01} value={[ opacity ]} onValueChange={handleOpacityChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"IOR"} min={1} max={2.5} step={0.01} value={[ ior ]} onValueChange={handleIorChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Transmission"} min={0} max={1} step={0.01} value={[ transmission ]} onValueChange={handleTransmissionChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Transmission Thickness"} min={0} max={1} step={0.01} value={[ thickness ]} onValueChange={handleThicknessChange} />
			</div>
			<div className="flex items-center justify-between">
				<ColorInput label={"Attenuation Color"} value={attenuationColor} onChange={handleAttenuationColorChange} />
			</div>
			<div className="flex items-center justify-between">
				<NumberInput label={"Attenuation Distance"} min={0} max={1000} step={1} value={attenuationDistance} onValueChange={handleAttenuationDistanceChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Dispersion"} min={0} max={10} step={0.01} value={[ dispersion ]} onValueChange={handleDispersionChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Alpha Test"} min={0} max={1} step={0.01} value={[ alphaTest ]} onValueChange={handleAlphaTestChange} />
			</div>
			<div className="flex items-center justify-between">
				<label className="opacity-50 text-xs truncate">Transparent</label>
				<input type="checkbox" checked={transparent} onChange={( e ) => handleTransparentChange( e.target.checked )} />
			</div>
			<Separator />
			<div className="flex items-center justify-between">
				<Select value={side} onValueChange={handleSideChange}>
					<span className="opacity-50 text-xs truncate">Side</span>
					<SelectTrigger className="max-w-20 h-5 rounded-full" >
						<SelectValue placeholder="Select quality" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={0}>Front</SelectItem>
						<SelectItem value={1}>Back</SelectItem>
						<SelectItem value={2}>Double</SelectItem>
					</SelectContent>
				</Select>
			</div>
		</div>
	);

};

export default MaterialTab;
