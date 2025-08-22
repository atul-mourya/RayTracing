import { Sunrise, Rainbow, Sun, Lightbulb, Grid3X3, ArrowsUpFromLine, CircleDot } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { useLightStore } from '@/store';
import { Separator } from '@/components/ui/separator';
import { useEffect } from 'react';

const LightsTab = () => {

	const { lights, setLights, updateLight, updateDirectionalLightAngle } = useLightStore();

	const handleLightChange = ( index, property, value ) => {

		updateLight( index, property, value );
		if ( window.pathTracerApp ) {

			const light = window.pathTracerApp.scene.getObjectsByProperty( 'isLight', true ).find( child => child.uuid === lights[ index ].uuid );
			if ( light ) {

				if ( property === 'intensity' ) light.intensity = value[ 0 ];
				else if ( property === 'color' ) light.color.set( value );
				else if ( property === 'position' ) light.position.set( ...value );
				else if ( property === 'angle' && light.type === 'DirectionalLight' ) {

					// Store angle in radians for shader
					light.angle = value[ 0 ] * ( Math.PI / 180 ); // Convert degrees to radians

				}
				else if ( property === 'angle' && light.type === 'SpotLight' ) {

					// Store angle in radians for shader (already converted in the UI handler)
					light.angle = value[ 0 ];

				}

				window.pathTracerApp.pathTracingPass.updateLights();
				window.pathTracerApp.reset();

			}

		}

	};

	// Add angle change handler specifically for directional lights
	const handleDirectionalLightAngleChange = ( index, value ) => {

		const angleInDegrees = value[ 0 ];
		updateDirectionalLightAngle( index, angleInDegrees );
		handleLightChange( index, 'angle', value );

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
			case 'PointLight': return { min: 0, max: 1000, step: 10 };
			case 'SpotLight': return { min: 0, max: 1000, step: 10 };
			case 'RectAreaLight': return { min: 0, max: 2000, step: 50 };
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
				position: [ light.position.x, light.position.y, light.position.z ],
				// Add angle property for directional and spot lights (convert from radians to degrees for UI)
				angle: light.type === 'DirectionalLight' ? ( light.angle || 0 ) * ( 180 / Math.PI ) : 
					   light.type === 'SpotLight' ? ( light.angle || Math.PI / 4 ) * ( 180 / Math.PI ) : 0
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
		<div className="p-2">
			{lights.map( ( light, index ) => (
				<div key={light.uuid} className="space-y-4">
					<div className="flex items-center justify-between">
						{getLightIcon( light.type )}
						<div className="text-xs opacity-65 truncate">{light.name}</div>
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
					{light.type === 'DirectionalLight' && (
						<div className="flex items-center justify-between">
							<Slider
								label={`Soft Shadow Angle ${index + 1}`}
								icon={CircleDot}
								min={0}
								max={10}
								step={0.1}
								value={[ light.angle || 0 ]}
								onValueChange={value => handleDirectionalLightAngleChange( index, value )}
							/>
						</div>
					)}
					{light.type === 'SpotLight' && (
						<div className="flex items-center justify-between">
							<Slider
								label={`Cone Angle ${index + 1}`}
								icon={CircleDot}
								min={0}
								max={90}
								step={1}
								value={[ (light.angle || Math.PI / 4) * (180 / Math.PI) ]}
								onValueChange={value => handleLightChange( index, 'angle', [value[0] * (Math.PI / 180)] )}
							/>
						</div>
					)}
					<Separator />
				</div>
			) )}
		</div>
	);

};

export default LightsTab;
