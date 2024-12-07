import { useState, useEffect, useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { ColorInput } from "@/components/ui/colorinput";
import { DraggableInput } from "@/components/ui/draggable-input";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { useStore } from '@/store';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';

const MaterialTab = () => {

	const selectedObject = useStore( ( state ) => state.selectedObject );
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

	const updateMaterialStates = useCallback( () => {

		if ( selectedObject?.isMesh ) {

			setColor( `#${selectedObject.material.color.getHexString()}` );
			setRoughness( selectedObject.material.roughness );
			setMetalness( selectedObject.material.metalness );
			setIor( selectedObject.material.ior ?? 1.5 );
			setTransmission( selectedObject.material.transmission ?? 0 );
			setThickness( selectedObject.material.thickness ?? 0.1 );
			setAttenuationColor( `#${selectedObject.material.attenuationColor.getHexString()}` );
			setAttenuationDistance( selectedObject.material.attenuationDistance ?? 0 );
			setDispersion( selectedObject.material.dispersion ?? 0 );
			setEmissiveIntensity( selectedObject.material.emissiveIntensity ?? 1 );
			setClearcoat( selectedObject.material.clearcoat ?? 0 );
			setClearcoatRoughness( selectedObject.material.clearcoatRoughness ?? 0 );
			setOpacity( selectedObject.material.opacity ?? 1 );
			setSide( selectedObject.material.side ?? 0 );
			setEmissive( `#${selectedObject.material.emissive.getHexString()}` );
			setTransparent( selectedObject.material.transparent ?? false );
			setAlphaTest( selectedObject.material.alphaTest ?? 0 );
			setVisible( selectedObject.visible );
			setSheen( selectedObject.material.sheen ?? 0 );
			setSheenRoughness( selectedObject.material.sheenRoughness ?? 1 );
			setSheenColor( `#${selectedObject.material.sheenColor.getHexString()}` );
			setSpecularIntensity( selectedObject.material.specularIntensity ?? 1 );
			setSpecularColor( `#${selectedObject.material.specularColor.getHexString()}` );

		}

	}, [ selectedObject ] );

	// Combine both effects into one
	useEffect( () => {

		updateMaterialStates();

		window.addEventListener( 'MaterialUpdate', updateMaterialStates );
		return () => window.removeEventListener( 'MaterialUpdate', updateMaterialStates );

	}, [ updateMaterialStates ] );

	// Update material property function remains the same
	const updateMaterialProperty = ( property, value ) => {

		if ( selectedObject?.isMesh ) {

			selectedObject.material[ property ] = value;
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture(
				selectedObject.userData.materialIndex,
				property,
				value
			);

		}

	};

	const handleColorChange = ( value ) => {

		setColor( value );
		updateMaterialProperty( 'color', selectedObject.material.color.set( value ) );

	};

	const handleRoughnessChange = ( value ) => {

		setRoughness( value[ 0 ] );
		updateMaterialProperty( 'roughness', value[ 0 ] );

	};

	const handleMetalnessChange = ( value ) => {

		setMetalness( value[ 0 ] );
		updateMaterialProperty( 'metalness', value[ 0 ] );

	};

	const handleIorChange = ( value ) => {

		setIor( value[ 0 ] );
		updateMaterialProperty( 'ior', value[ 0 ] );

	};

	const handleTransmissionChange = ( value ) => {

		setTransmission( value[ 0 ] );
		updateMaterialProperty( 'transmission', value[ 0 ] );

	};

	const handleThicknessChange = ( value ) => {

		setThickness( value[ 0 ] );
		updateMaterialProperty( 'thickness', value[ 0 ] );

	};

	const handleAttenuationColorChange = ( value ) => {

		setAttenuationColor( value );
		updateMaterialProperty( 'attenuationColor', selectedObject.material.attenuationColor.set( value ) );

	};

	const handleAttenuationDistanceChange = ( value ) => {

		setAttenuationDistance( value );
		updateMaterialProperty( 'attenuationDistance', value );

	};

	const handleDispersionChange = ( value ) => {

		setDispersion( value[ 0 ] );
		updateMaterialProperty( 'dispersion', value[ 0 ] );

	};

	const handleEmissiveIntensityChange = ( value ) => {

		setEmissiveIntensity( value[ 0 ] );
		updateMaterialProperty( 'emissiveIntensity', value[ 0 ] );

	};

	const handleClearcoatChange = ( value ) => {

		setClearcoat( value[ 0 ] );
		updateMaterialProperty( 'clearcoat', value[ 0 ] );

	};

	const handleClearcoatRoughnessChange = ( value ) => {

		setClearcoatRoughness( value[ 0 ] );
		updateMaterialProperty( 'clearcoatRoughness', value[ 0 ] );

	};

	const handleOpacityChange = ( value ) => {

		setOpacity( value[ 0 ] );
		updateMaterialProperty( 'opacity', value[ 0 ] );

	};

	const handleSideChange = ( value ) => {

		setSide( value );
		updateMaterialProperty( 'side', value );

	};

	const handleEmissiveChange = ( value ) => {

		setEmissive( value );
		updateMaterialProperty( 'emissive', selectedObject.material.emissive.set( value ) );

	};

	const handleTransparentChange = ( value ) => {

		setTransparent( value );
		updateMaterialProperty( 'transparent', value ? 1 : 0 );

	};

	const handleAlphaTestChange = ( value ) => {

		setAlphaTest( value[ 0 ] );
		updateMaterialProperty( 'alphaTest', value[ 0 ] );

	};

	const handleVisibleChange = ( value ) => {

		setVisible( value );
		if ( selectedObject ) {

			selectedObject.visible = value;
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture( selectedObject.userData.materialIndex, 'visible', value ? 1 : 0 );

		}

	};

	const handleSheenChange = ( value ) => {

		setSheen( value[ 0 ] );
		updateMaterialProperty( 'sheen', value[ 0 ] );

	};

	const handleSheenRoughnessChange = ( value ) => {

		setSheenRoughness( value[ 0 ] );
		updateMaterialProperty( 'sheenRoughness', value[ 0 ] );

	};

	const handleSheenColorChange = ( value ) => {

		setSheenColor( value );
		updateMaterialProperty( 'sheenColor', selectedObject.material.sheenColor.set( value ) );

	};

	const handleSpecularIntensityChange = ( value ) => {

		setSpecularIntensity( value[ 0 ] );
		updateMaterialProperty( 'specularIntensity', value[ 0 ] );

	};

	const handleSpecularColorChange = ( value ) => {

		setSpecularColor( value );
		updateMaterialProperty( 'specularColor', selectedObject.material.specularColor.set( value ) );

	};

	if ( ! selectedObject ) {

		return <div className="p-4">Please select an object to customize its material properties.</div>;

	}

	if ( ! selectedObject.isMesh ) {

		return <div className="p-4">Selected object is not a mesh. Please select a mesh object.</div>;

	}

	return (
		<div className="space-y-4 p-4">
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
				<DraggableInput label={"Attenuation Distance"} min={0} max={10000} step={1} value={attenuationDistance} onValueChange={handleAttenuationDistanceChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Dispersion"} min={0} max={1} step={0.001} value={[ dispersion ]} onValueChange={handleDispersionChange} />
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
