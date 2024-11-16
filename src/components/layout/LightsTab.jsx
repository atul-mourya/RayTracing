
import { useState } from 'react';
import { Sunrise, Rainbow } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { DEFAULT_STATE } from '../../core/Processor/Constants';

const LightsTab = () => {

	const [ directionalLightIntensity, setDirectionalLightIntensity ] = useState( DEFAULT_STATE.directionalLightIntensity );
	const [ directionalLightColor, setDirectionalLightColor ] = useState( DEFAULT_STATE.directionalLightColor );
	const [ directionalLightPosition, setDirectionalLightPosition ] = useState( DEFAULT_STATE.directionalLightPosition );

	const handleDirectionalLightIntensityChange = ( value ) => {

		setDirectionalLightIntensity( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.intensity = value[ 0 ];
			window.pathTracerApp.pathTracingPass.updateLights();
			window.pathTracerApp.reset();

		}

	};

	const handleDirectionalLightColorChange = ( value ) => {

		setDirectionalLightColor( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.color.set( value );
			window.pathTracerApp.pathTracingPass.updateLights();
			window.pathTracerApp.reset();

		}

	};

	const handleDirectionalLightPositionChange = ( value ) => {

		setDirectionalLightPosition( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.position.set( ...value );
			window.pathTracerApp.pathTracingPass.updateLights();
			window.pathTracerApp.reset();

		}

	};

	return (
		<div className="space-y-4 p-4">
			<div className="flex items-center justify-between">
				<Slider label={"Intensity"} icon={Sunrise} min={0} max={20} step={0.1} value={[ directionalLightIntensity ]} onValueChange={handleDirectionalLightIntensityChange} />
			</div>
			<div className="flex items-center justify-between">
				<ColorInput label={"Color"} icon={Rainbow} value={directionalLightColor} onChange={color => handleDirectionalLightColorChange( color )} />
			</div>
			<div className="flex items-center justify-between">
				<Vector3Component label="Position" value={directionalLightPosition} onValueChange={handleDirectionalLightPositionChange} />
			</div>
		</div>
	);

};

export default LightsTab;
