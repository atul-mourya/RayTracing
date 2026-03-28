import { Sunrise, Rainbow, Lightbulb, Grid3X3, ArrowsUpFromLine, CircleDot, Trash2, Spotlight, RectangleHorizontal, RectangleVertical, Plus } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Switch } from "@/components/ui/switch";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLightStore, usePathTracerStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { Separator } from '@/components/ui/separator';
import { useEffect, useCallback } from 'react';

const LIGHT_CONFIG = {
	DirectionalLight: {
		icon: ArrowsUpFromLine,
		iconClass: 'rotate-45 -scale-100',
		label: 'Directional',
		intensity: { min: 0, max: 100, step: 0.5 },
	},
	PointLight: {
		icon: Lightbulb,
		iconClass: '',
		label: 'Point',
		intensity: { min: 0, max: 100, step: 0.5 },
	},
	SpotLight: {
		icon: Spotlight,
		iconClass: '',
		label: 'Spot',
		intensity: { min: 0, max: 100, step: 0.5 },
	},
	RectAreaLight: {
		icon: Grid3X3,
		iconClass: '',
		label: 'Area',
		intensity: { min: 0, max: 200, step: 5 },
	},
};

const LightListItem = ( { light, index, isSelected, onSelect, onRemove } ) => {

	const config = LIGHT_CONFIG[ light.type ] || LIGHT_CONFIG.PointLight;
	const Icon = config.icon;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onSelect( index )}
			onKeyDown={( e ) => {

				if ( e.key === 'Enter' || e.key === ' ' ) {

					e.preventDefault();
					onSelect( index );

				}

			}}
			className={`group flex items-center gap-2 py-1 px-2 cursor-pointer transition-colors rounded-sm ${
				isSelected
					? 'bg-primary/15'
					: 'hover:bg-accent/30'
			}`}
		>
			<Icon size={12} className={`shrink-0 ${config.iconClass} ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
			<span className={`text-xs truncate flex-1 ${isSelected ? 'text-primary font-medium' : ''}`}>{light.name}</span>
			<div
				className="w-2.5 h-2.5 rounded-full shrink-0 border border-border"
				style={{ backgroundColor: light.color }}
			/>
			<Button
				size="sm"
				variant="ghost"
				onClick={( e ) => {

					e.stopPropagation();
					onRemove( index );

				}}
				className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
			>
				<Trash2 size={9} />
			</Button>
		</div>
	);

};

const LightDetailPanel = ( { light, index, onLightChange } ) => {

	const config = LIGHT_CONFIG[ light.type ] || LIGHT_CONFIG.PointLight;

	return (
		<div className="space-y-4 py-4 px-2">
			{/* Common controls */}
			<div className="flex items-center justify-between">
				<Slider
					label="Intensity"
					icon={Sunrise}
					min={config.intensity.min}
					max={config.intensity.max}
					step={config.intensity.step}
					value={[ light.intensity ]}
					onValueChange={value => onLightChange( index, 'intensity', value )}
				/>
			</div>
			<div className="flex items-center justify-between">
				<ColorInput
					label="Color"
					icon={Rainbow}
					value={light.color}
					onChange={color => onLightChange( index, 'color', color )}
				/>
			</div>
			<div className="flex items-center justify-between">
				<Vector3Component
					label="Position"
					value={light.position}
					onValueChange={value => onLightChange( index, 'position', value )}
				/>
			</div>

			{/* SpotLight-specific controls */}
			{light.type === 'SpotLight' && (
				<>
					<div className="flex items-center justify-between">
						<Vector3Component
							label="Target"
							value={light.target || [ 0, 0, - 1 ]}
							onValueChange={value => onLightChange( index, 'target', value )}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Slider
							label="Cone Angle"
							icon={CircleDot}
							min={0}
							max={90}
							step={1}
							value={[ light.angle ]}
							onValueChange={value => onLightChange( index, 'angle', value )}
						/>
					</div>
				</>
			)}

			{/* RectAreaLight-specific controls */}
			{light.type === 'RectAreaLight' && (
				<>
					<div className="flex items-center justify-between">
						<Slider
							label="Width"
							icon={RectangleHorizontal}
							min={0.1}
							max={20}
							step={0.1}
							value={[ light.width || 2 ]}
							onValueChange={value => onLightChange( index, 'width', value )}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Slider
							label="Height"
							icon={RectangleVertical}
							min={0.1}
							max={20}
							step={0.1}
							value={[ light.height || 2 ]}
							onValueChange={value => onLightChange( index, 'height', value )}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Vector3Component
							label="Target"
							value={light.target || [ 0, 0, 0 ]}
							onValueChange={value => onLightChange( index, 'target', value )}
						/>
					</div>
				</>
			)}
		</div>
	);

};

const LightsTab = () => {

	const {
		lights, setLights, updateLight,
		addLight, removeLight, clearAllLights,
		showLightHelper, handleShowLightHelperChange,
		selectedLightIndex, setSelectedLightIndex,
	} = useLightStore();

	const {
		enableEmissiveTriangleSampling,
		emissiveBoost,
		handleEnableEmissiveTriangleSamplingChange,
		handleEmissiveBoostChange,
	} = usePathTracerStore();

	const handleLightChange = ( index, property, value ) => {

		updateLight( index, property, value );

	};

	const updateLightsFromScene = useCallback( () => {

		const app = getApp();
		if ( app ) {

			const sceneLights = app.getLights();
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

	const handleAddLight = async ( lightType ) => {

		await addLight( lightType );

	};

	const handleRemoveLight = ( index ) => {

		removeLight( index );

	};

	const handleClearAllLights = () => {

		clearAllLights();

	};

	const selectedLight = selectedLightIndex !== null && lights[ selectedLightIndex ] ? lights[ selectedLightIndex ] : null;

	return (
		<div>
			{/* Emissive Mesh Sampling */}
			<div className="flex items-center justify-between py-2 px-2">
				<SliderToggle label={"Emissive Geometry"} enabled={ enableEmissiveTriangleSampling } min={0} max={100} step={1} value={[ emissiveBoost ]} onValueChange={ handleEmissiveBoostChange } onToggleChange={ handleEnableEmissiveTriangleSamplingChange } />
			</div>

			<Separator className="bg-primary" />

			{/* Header */}
			<div className="flex items-center justify-between py-2 px-2 text-xs bg-muted opacity-60">
				<span>Lights</span>
				<div className="flex items-center gap-1.5">
					{lights.length > 0 && (
						<span className="text-[10px] opacity-80">{lights.length}</span>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button className="hover:opacity-100 opacity-60 transition-opacity">
								<Plus size={14} />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
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
							{lights.length > 0 && (
								<>
									<Separator className="my-1" />
									<DropdownMenuItem className="text-xs text-destructive focus:text-destructive" onClick={handleClearAllLights}>
										<Trash2 className="mr-2 h-3 w-3" />
										Clear All
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Empty state */}
			{lights.length === 0 ? (
				<div className="text-center py-8 px-2">
					<Lightbulb className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
					<p className="text-sm text-muted-foreground">No lights in scene</p>
					<p className="text-xs text-muted-foreground mt-1">Add a light to get started</p>
				</div>
			) : (
				<>
					{/* Light Helper Toggle */}
					<div className="flex items-center justify-between py-2 px-2">
						<Switch label="Light Helper" checked={showLightHelper} onCheckedChange={handleShowLightHelperChange} />
					</div>

					<Separator className="bg-primary" />
					{/* Lights list */}
					<div className="border-b-[0.5px] border-current opacity-60" />
					<div className="py-1">
						{lights.map( ( light, index ) => (
							<LightListItem
								key={light.uuid}
								light={light}
								index={index}
								isSelected={selectedLightIndex === index}
								onSelect={( idx ) => setSelectedLightIndex( selectedLightIndex === idx ? null : idx )}
								onRemove={handleRemoveLight}
							/>
						) )}
					</div>

					{/* Selected light detail panel */}
					{selectedLight && (
						<>
							<Separator />
							<LightDetailPanel
								light={selectedLight}
								index={selectedLightIndex}
								onLightChange={handleLightChange}
							/>
						</>
					)}
				</>
			)}
		</div>
	);

};

export default LightsTab;
