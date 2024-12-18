import { Sun, Sunrise } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from "@/components/ui/slider-toggle";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_STATE } from '../../core/Processor/Constants';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { create } from 'zustand';
import { Exposure } from '@/assets/icons';

const useSceneStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	setExposure: ( value ) => set( { exposure: value } ),
	setEnableEnvironment: ( value ) => set( { enableEnvironment: value } ),
	setShowBackground: ( value ) => set( { showBackground: value } ),
	setEnvironmentIntensity: ( value ) => set( { environmentIntensity: value } ),
	setGIIntensity: ( value ) => set( { GIIntensity: value } ),
	setToneMapping: ( value ) => set( { toneMapping: value } )
} ) );

const toneMappingOptions = [
	{ label: 'None', value: 0 },
	{ label: 'Linear', value: 1 },
	{ label: 'Reinhard', value: 2 },
	{ label: 'Cineon', value: 3 },
	{ label: 'ACESFilmic', value: 4 },
	{ label: 'AgXToneMapping', value: 6 },
	{ label: 'NeutralToneMapping', value: 7 }
];

const SceneTab = () => {

	const {
		exposure, setExposure,
		enableEnvironment, setEnableEnvironment,
		showBackground, setShowBackground,
		environmentIntensity, setEnvironmentIntensity,
		GIIntensity, setGIIntensity,
		toneMapping, setToneMapping
	} = useSceneStore();

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

	const handleToneMappingChange = ( value ) => {

		value = parseInt( value );
		setToneMapping( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.renderer.toneMapping = value;
			window.pathTracerApp.reset();

		}

	};

	return (
		<div className="space-y-4 p-4">
			<div className="flex items-center justify-between">
				<Select value={toneMapping.toString()} onValueChange={handleToneMappingChange}>
					<span className="opacity-50 text-xs truncate">ToneMapping</span>
					<SelectTrigger className="max-w-32 h-5 rounded-full" >
						<SelectValue placeholder="Select ToneMapping" />
					</SelectTrigger>
					<SelectContent>
						{toneMappingOptions.map( ( { label, value } ) => (
							<SelectItem key={value} value={value.toString()}>{label}</SelectItem>
						) )}
					</SelectContent>
				</Select>
			</div>
			<div className="flex items-center justify-between">
				<Slider icon={Exposure} label={"Exposure"} min={0} max={2} step={0.01} value={[ exposure ]} onValueChange={handleExposureChange} />
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
