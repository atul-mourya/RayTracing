import { Sunrise, Rainbow, Sun, Lightbulb, Grid3X3, ArrowsUpFromLine, CircleDot, Trash2, Spotlight } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLightStore } from '@/store';
import { Separator } from '@/components/ui/separator';
import { useEffect, useCallback } from 'react';

const LightsTab = () => {

	const { lights, setLights, updateLight, updateDirectionalLightAngle, addLight, removeLight, clearAllLights } = useLightStore();

	const handleLightChange = ( index, property, value ) => {

		updateLight( index, property, value );

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
			case 'SpotLight': return <Spotlight size="14" className="mr-2" />;
			default: return <Sun className="mr-2" />;

		}

	};

	const getMinMaxStep = ( type ) => { // where type is type of light

		switch ( type ) {

			case 'DirectionalLight': return { min: 0, max: 100, step: 0.5 };
			case 'PointLight': return { min: 0, max: 100, step: 0.5 };
			case 'SpotLight': return { min: 0, max: 100, step: 0.5 };
			case 'RectAreaLight': return { min: 0, max: 200, step: 5 };
			default: return { min: 0, max: 100, step: 0.5 };

		}

	};

	const updateLightsFromScene = useCallback( () => {

		if ( window.pathTracerApp ) {

			const sceneLights = window.pathTracerApp.getLights();

			// Only update if there are actual changes to prevent unnecessary resets
			if ( JSON.stringify( sceneLights ) !== JSON.stringify( lights ) ) {

				setLights( sceneLights );

			}

		}

	}, [ setLights, lights ] );

	useEffect( () => {

		updateLightsFromScene();
		window.addEventListener( 'SceneRebuild', updateLightsFromScene );

		return () => window.removeEventListener( 'SceneRebuild', updateLightsFromScene );

	}, [ updateLightsFromScene ] );

	// Handle adding new light
	const handleAddLight = async ( lightType ) => {

		await addLight( lightType );

	};

	// Handle removing a light
	const handleRemoveLight = ( index ) => {

		removeLight( index );

	};

	// Handle clearing all lights
	const handleClearAllLights = () => {

		clearAllLights();

	};


	return (
		<div className="px-2 space-y-4">
			<Separator className="bg-primary" />
			{/* Light Management Controls */}
			<div className="flex items-center justify-between py-2 px-1 mb-0">
				<span className="text-sm font-medium">Lights ( {lights.length} )</span>
				<div className="flex gap-2">
					{/* Add Light Dropdown */}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="sm" variant="outline" className="h-5">
								Add
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" >
							<DropdownMenuItem className="text-xs" onClick={() => handleAddLight( 'DirectionalLight' )}>
								<ArrowsUpFromLine className="mr-2 h-3 w-3 rotate-45 -scale-100" />
								Directional Light
							</DropdownMenuItem>
							<DropdownMenuItem className="text-xs" onClick={() => handleAddLight( 'PointLight' )}>
								<Lightbulb className="mr-2 h-3 w-3" />
								Point Light
							</DropdownMenuItem>
							<DropdownMenuItem className="text-xs" onClick={() => handleAddLight( 'SpotLight' )}>
								<Spotlight className="mr-2 h-3 w-3" />
								Spot Light
							</DropdownMenuItem>
							<DropdownMenuItem className="text-xs" onClick={() => handleAddLight( 'RectAreaLight' )}>
								<Grid3X3 className="mr-2 h-3 w-3" />
								Area Light
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					{/* Clear All Lights */}
					{lights.length > 0 && (
						<Button size="sm" variant="outline" onClick={handleClearAllLights} className="h-5">
							Clear All
						</Button>
					)}
				</div>
			</div>

			{/* Lights List */}
			{lights.length === 0 ? (
				<div className="text-center py-8">
					<Lightbulb className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
					<p className="text-sm text-muted-foreground">No lights in scene</p>
					<p className="text-xs text-muted-foreground mt-1">Add a new light</p>
				</div>
			) : (
				lights.map( ( light, index ) => (
					<div key={light.uuid} className="space-y-2 p-2 border border-border rounded-lg bg-accent/10">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								{getLightIcon( light.type )}
								<div className="text-xs font-medium truncate">{light.name}</div>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => handleRemoveLight( index )}
								className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
							>
								<Trash2 className="h-3 w-3" />
							</Button>
						</div>
						<Separator />
						<div className="flex items-center justify-center">
							<div className="text-xs text-muted-foreground">{light.type}</div>
						</div>
						<div className="flex items-center justify-between">
							<Slider label={`Intensity`} icon={Sunrise} min={ getMinMaxStep( light.type ).min } max={ getMinMaxStep( light.type ).max } step={ getMinMaxStep( light.type ).step } value={[ light.intensity ]} onValueChange={value => handleLightChange( index, 'intensity', value )} />
						</div>
						<div className="flex items-center justify-between">
							<ColorInput label={`Color`} icon={Rainbow} value={light.color} onChange={color => handleLightChange( index, 'color', color )} />
						</div>
						<div className="flex items-center justify-between">
							<Vector3Component label={`Position`} value={light.position} onValueChange={value => handleLightChange( index, 'position', value )} />
						</div>
						{light.type === 'DirectionalLight' && (
							<div className="flex items-center justify-between">
								<Slider
									label={`Soft Shadow Angle`}
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
							<>
								<div className="flex items-center justify-between">
									<Vector3Component
										label={`Target`}
										value={light.target || [ 0, 0, - 1 ]}
										onValueChange={value => handleLightChange( index, 'target', value )}
									/>
								</div>
								<div className="flex items-center justify-between">
									<Slider
										label={`Cone Angle`}
										icon={CircleDot}
										min={0}
										max={90}
										step={1}
										value={[ light.angle ]}
										onValueChange={value => handleLightChange( index, 'angle', value )}
									/>
								</div>
							</>
						)}
					</div>
				) ) )}
		</div>
	);

};

export default LightsTab;
