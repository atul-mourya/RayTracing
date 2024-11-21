import { useState, useEffect } from 'react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ColorInput } from "@/components/ui/colorinput";
import { useStore } from '@/store';

const MaterialTab = () => {

	const selectedObject = useStore( ( state ) => state.selectedObject );
	const [ color, setColor ] = useState( '#ffffff' );
	const [ roughness, setRoughness ] = useState( 0.5 );
	const [ metalness, setMetalness ] = useState( 0.5 );
	const [ transparency, setTransparency ] = useState( false );

	useEffect( () => {

		if ( selectedObject && selectedObject.isMesh ) {

			setColor( `#${selectedObject.material.color.getHexString()}` );
			setRoughness( selectedObject.material.roughness );
			setMetalness( selectedObject.material.metalness );
			setTransparency( selectedObject.material.transparent );
			console.log( selectedObject.material.color );

		}

	}, [ selectedObject ] );

	useEffect( () => {

		const handleMaterialUpdate = () => {

			if ( selectedObject && selectedObject.isMesh ) {

				setColor( `#${selectedObject.material.color.getHexString()}` );
				setRoughness( selectedObject.material.roughness );
				setMetalness( selectedObject.material.metalness );
				setTransparency( selectedObject.material.transparent );

			}

		};

		window.addEventListener( 'MaterialUpdate', handleMaterialUpdate );
		return () => window.removeEventListener( 'MaterialUpdate', handleMaterialUpdate );

	}, [ selectedObject ] );

	const handleColorChange = ( value ) => {

		setColor( value );
		if ( selectedObject && selectedObject.isMesh ) {

			selectedObject.material.color.set( value );
			const color = selectedObject.material.color;
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture( selectedObject.userData.materialIndex, 'color', color );

		}

	};

	const handleRoughnessChange = ( value ) => {

		setRoughness( value[ 0 ] );
		if ( selectedObject && selectedObject.isMesh ) {

			selectedObject.material.roughness = value[ 0 ];
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture( selectedObject.userData.materialIndex, 'roughness', value[ 0 ] );

		}

	};

	const handleMetalnessChange = ( value ) => {

		setMetalness( value[ 0 ] );
		if ( selectedObject && selectedObject.isMesh ) {

			selectedObject.material.metalness = value[ 0 ];
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture( selectedObject.userData.materialIndex, 'metalness', value[ 0 ] );

		}

	};

	const handleTransparencyChange = ( value ) => {

		setTransparency( value );
		if ( selectedObject && selectedObject.isMesh ) {

			selectedObject.material.transparent = value;
			window.pathTracerApp.pathTracingPass.updateMaterialDataTexture( selectedObject.userData.materialIndex, 'transparent', value );

		}

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
				<ColorInput label={"Color"} value={color} onChange={handleColorChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Roughness"} min={0} max={1} step={0.01} value={[ roughness ]} onValueChange={handleRoughnessChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Metalness"} min={0} max={1} step={0.01} value={[ metalness ]} onValueChange={handleMetalnessChange} />
			</div>
			<div className="flex items-center justify-between">
				<Switch label={"Transparency"} checked={transparency} onCheckedChange={handleTransparencyChange} />
			</div>
		</div>
	);

};

export default MaterialTab;
