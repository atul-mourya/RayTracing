import { Sunrise, Rainbow, Sun, Lightbulb, Grid3X3, ArrowsUpFromLine } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { useLightStore } from '@/store';
import { Separator } from '@/components/ui/separator';
import { useEffect } from 'react';

const LightsTab = () => {

	const { lights, setLights, updateLight } = useLightStore();

	const handleLightChange = ( index, property, value ) => {

		updateLight( index, property, value );
		if ( window.pathTracerApp ) {

			const light = window.pathTracerApp.scene.getObjectsByProperty( 'isLight', true ).find( child => child.uuid === lights[ index ].uuid );
			if ( light ) {

				if ( property === 'intensity' ) light.intensity = value[ 0 ];
				else if ( property === 'color' ) light.color.set( value );
				else if ( property === 'position' ) light.position.set( ...value );

				window.pathTracerApp.pathTracingPass.updateLights();
				window.pathTracerApp.reset();

			}

		}

	};

	const getLightIcon = ( type ) => {

		switch ( type ) {

			case 'DirectionalLight': return <ArrowsUpFromLine size="14" className="mr-2 rotate-45 -scale-100" />;
			case 'PointLight': return <Lightbulb size="14" className="mr-2" />;
			case 'RectAreaLight': return <Grid3X3 size="14" className="mr-2" />;
			default: return <Sun className="mr-2" />;

		}

	};

	const getMinMaxStep = ( type ) => { // where type is type of light

		switch ( type ) {

			case 'DirectionalLight': return { min: 0, max: 5, step: 0.1 };
			case 'RectAreaLight': return { min: 0, max: 1000, step: 50 };
			default: return { min: 0, max: 5, step: 0.1 };

		}

	};

	const updateLightsFromScene = () => {

		if ( window.pathTracerApp ) {

			const sceneLights = window.pathTracerApp.scene.getObjectsByProperty( 'isLight', true ).map( light => ( {
				uuid: light.uuid,
				name: light.name || light.uuid,
				type: light.type,
				intensity: light.intensity,
				color: `#${light.color.getHexString()}`,
				position: [ light.position.x, light.position.y, light.position.z ]
			} ) );
			setLights( sceneLights );

		}

	};

	useEffect( () => {

		updateLightsFromScene();
		window.addEventListener( 'SceneRebuild', updateLightsFromScene );

		return () => window.removeEventListener( 'SceneRebuild', updateLightsFromScene );

	}, [] );

	return (
		<div className="space-y-4 p-4">
			{lights.map( ( light, index ) => (
				<div key={light.uuid} className="space-y-4">
					<div className="flex items-center justify-between">
						<span className="flex items-center text-sm opacity-65 truncate">
							{getLightIcon( light.type )}
							{light.name}
						</span>
					</div>
					<div className="flex items-center justify-end">
						<div className="text-xs opacity-65">{light.type}</div>
					</div>
					<div className="flex items-center justify-between">
						<Slider label={`Intensity ${index + 1}`} icon={Sunrise} min={ getMinMaxStep( light.type ).min } max={ getMinMaxStep( light.type ).max } step={ getMinMaxStep( light.type ).step } value={[ light.intensity ]} onValueChange={value => handleLightChange( index, 'intensity', value )} />
					</div>
					<div className="flex items-center justify-between">
						<ColorInput label={`Color ${index + 1}`} icon={Rainbow} value={light.color} onChange={color => handleLightChange( index, 'color', color )} />
					</div>
					<div className="flex items-center justify-between">
						<Vector3Component label={`Position ${index + 1}`} value={light.position} onValueChange={value => handleLightChange( index, 'position', value )} />
					</div>
					<Separator />
				</div>
			) )}
		</div>
	);

};

export default LightsTab;
