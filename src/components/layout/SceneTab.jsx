
import { useState } from 'react';
import { Sun, Sunrise } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from "@/components/ui/slider-toggle";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { HDR_FILES, DEFAULT_STATE } from '../../core/Processor/Constants';

const SceneTab = () => {

	const { toast } = useToast();
	const [ exposure, setExposure ] = useState( DEFAULT_STATE.exposure );
	const [ enableEnvironment, setEnableEnvironment ] = useState( DEFAULT_STATE.enableEnvironment );
	const [ showBackground, setShowBackground ] = useState( DEFAULT_STATE.showBackground );
	const [ environmentIntensity, setEnvironmentIntensity ] = useState( DEFAULT_STATE.environmentIntensity );
	const [ GIIntensity, setGIIntensity ] = useState( DEFAULT_STATE.globalIlluminationIntensity );

	const handleExposureChange = ( value ) => {

		setExposure( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.renderer.toneMappingExposure = value;
			window.pathTracerApp.reset();

		}

	};

	const handleEnableEnvironmentChange = ( value ) => {

		setEnableEnvironment( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.enableEnvironmentLight.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleShowBackgroundChange = ( value ) => {

		setShowBackground( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.scene.background = value ? window.pathTracerApp.scene.environment : null;
			window.pathTracerApp.pathTracingPass.material.uniforms.showBackground.value = value ? true : false;
			window.pathTracerApp.reset();

		}

	};

	const handleEnvironmentIntensityChange = ( value ) => {

		setEnvironmentIntensity( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.scene.environmentIntensity = value;
			window.pathTracerApp.pathTracingPass.material.uniforms.environmentIntensity.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleGIIntensityChange = ( value ) => {

		setGIIntensity( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = value * Math.PI;
			window.pathTracerApp.reset();

		}

	};

	return (
		<div className="space-y-4 p-4">
			<div className="flex items-center justify-between">
				<Slider label={"Exposure"} min={0} max={2} step={0.01} value={[ exposure ]} onValueChange={handleExposureChange} />
			</div>
			<div className="flex items-center justify-between">
				<Switch label={"Show Background"} checked={showBackground} onCheckedChange={handleShowBackgroundChange} />
			</div>
			<div className="flex items-center justify-between">
				<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
			</div>
			<div className="flex items-center justify-between">
				<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} onValueChange={handleGIIntensityChange} />
			</div>
		</div>
	);

};

export default SceneTab;
