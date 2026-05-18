import { Sunrise, Rainbow, Lightbulb, Grid3X3, ArrowsUpFromLine, CircleDot, Trash2, Spotlight, RectangleHorizontal, RectangleVertical, Plus, FilmIcon, X, Contrast, Ruler, CircleDashed, Activity } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Switch } from "@/components/ui/switch";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLightStore, usePathTracerStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { GOBO_LIBRARY } from '@/services/GoboLibrary';
import { IES_LIBRARY } from '@/services/IESLibrary';
import { Separator } from '@/components/ui/separator';
import { useEffect, useCallback, useState, useRef } from 'react';

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

// Tile grid: 4 columns × 5 rows visible (~60px tile + 4px gap). Beyond that the
// content area scrolls vertically.
const GOBO_TILE_PX = 60;
const GOBO_GAP_PX = 6;
const GOBO_VISIBLE_ROWS = 5;
const GOBO_GRID_HEIGHT = GOBO_TILE_PX * GOBO_VISIBLE_ROWS + GOBO_GAP_PX * ( GOBO_VISIBLE_ROWS - 1 );

// Generic thumbnail-grid picker used by both gobos and IES profiles.
// `items` rows must expose: { name, label, url, preview? } — `preview` is the
// thumbnail (falls back to `url` for image-based libraries like gobos).
const LibraryPicker = ( { value, onChange, items, title, addTooltip = 'Assign' } ) => {

	const [ open, setOpen ] = useState( false );
	const selected = items.find( g => g.name === value );
	const thumb = ( it ) => it.preview || it.url;
	const selectedTileRef = useRef( null );

	// When the popover opens, scroll the currently-selected tile into view so
	// the user sees their assignment instead of the start of the list.
	useEffect( () => {

		if ( ! open ) return;
		// Defer to next frame so Radix has mounted the portal contents.
		const id = requestAnimationFrame( () => {

			selectedTileRef.current?.scrollIntoView( { block: 'nearest', inline: 'nearest' } );

		} );
		return () => cancelAnimationFrame( id );

	}, [ open ] );

	const pick = ( name ) => {

		onChange( name );
		setOpen( false );

	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="h-7 w-7 rounded-md border border-border bg-background flex items-center justify-center overflow-hidden hover:border-primary/60 transition-colors"
					title={selected ? selected.label : addTooltip}
				>
					{selected ? (
						<img src={thumb( selected )} alt={selected.label} className="h-full w-full object-cover" />
					) : (
						<Plus size={14} className="text-muted-foreground" />
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="p-2"
				style={{ width: GOBO_TILE_PX * 4 + GOBO_GAP_PX * 3 + 16 }}
			>
				<div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1">{title}</div>
				<div
					className="grid grid-cols-4 overflow-y-auto pr-1"
					style={{ gap: GOBO_GAP_PX, maxHeight: GOBO_GRID_HEIGHT }}
				>
					<button
						type="button"
						onClick={() => pick( null )}
						title="None"
						ref={! selected ? selectedTileRef : null}
						className={`flex flex-col items-center justify-center rounded-md border bg-background hover:border-primary/60 transition-colors ${
							! selected ? 'border-primary ring-1 ring-primary/40' : 'border-border'
						}`}
						style={{ width: GOBO_TILE_PX, height: GOBO_TILE_PX }}
					>
						<X size={18} className="text-muted-foreground" />
						<span className="text-[9px] text-muted-foreground mt-0.5">None</span>
					</button>
					{items.map( g => (
						<button
							key={g.name}
							type="button"
							onClick={() => pick( g.name )}
							title={g.label}
							ref={selected?.name === g.name ? selectedTileRef : null}
							className={`relative rounded-md overflow-hidden border hover:border-primary/60 transition-colors ${
								selected?.name === g.name ? 'border-primary ring-1 ring-primary/40' : 'border-border'
							}`}
							style={{ width: GOBO_TILE_PX, height: GOBO_TILE_PX }}
						>
							<img
								src={thumb( g )}
								alt={g.label}
								className="h-full w-full object-cover bg-black"
								draggable={false}
							/>
						</button>
					) )}
				</div>
			</PopoverContent>
		</Popover>
	);

};

const GoboPicker = ( props ) => (
	<LibraryPicker {...props} items={GOBO_LIBRARY} title="Gobo Masks" addTooltip="Assign gobo mask" />
);

const IESPicker = ( props ) => (
	<LibraryPicker {...props} items={IES_LIBRARY} title="IES Profiles" addTooltip="Assign IES profile" />
);

const GoboControls = ( { light, index, onLightChange, showScale = false } ) => (
	<>
		<Row>
			<span className="opacity-50 text-xs truncate flex items-center gap-1"><FilmIcon size={11} /> Gobo Mask</span>
			<div className="flex items-center gap-1.5">
				{light.gobo && (
					<button
						type="button"
						onClick={() => onLightChange( index, 'goboInverted', ! light.goboInverted )}
						title={light.goboInverted ? 'Mask inverted — click to restore' : 'Invert mask'}
						className={`h-7 w-7 rounded-md border flex items-center justify-center transition-colors ${
							light.goboInverted
								? 'border-primary bg-primary/15 text-primary'
								: 'border-border bg-background text-muted-foreground hover:border-primary/60'
						}`}
					>
						<Contrast size={14} />
					</button>
				)}
				<GoboPicker
					value={light.gobo || null}
					onChange={name => onLightChange( index, 'gobo', name )}
				/>
			</div>
		</Row>
		{light.gobo && (
			<>
				<Row>
					<Slider
						label="Mask Strength"
						icon={FilmIcon}
						min={0}
						max={1}
						step={0.05}
						value={[ light.goboIntensity ?? 1 ]}
						onValueChange={value => onLightChange( index, 'goboIntensity', value )}
					/>
				</Row>
				{showScale && (
					<Row>
						<Slider
							label="Tile Scale"
							icon={FilmIcon}
							min={0.1}
							max={50}
							step={0.1}
							value={[ light.goboScale ?? 5 ]}
							onValueChange={value => onLightChange( index, 'goboScale', value )}
						/>
					</Row>
				)}
			</>
		)}
	</>
);

const LightDetailPanel = ( { light, index, onLightChange } ) => {

	const config = LIGHT_CONFIG[ light.type ] || LIGHT_CONFIG.PointLight;

	return (
		<div className="space-y-4 py-4 px-2">
			{/* Common controls */}
			<Row>
				<Slider
					label="Intensity"
					icon={Sunrise}
					min={config.intensity.min}
					max={config.intensity.max}
					step={config.intensity.step}
					value={[ light.intensity ]}
					onValueChange={value => onLightChange( index, 'intensity', value )}
				/>
			</Row>
			<Row>
				<ColorInput
					label="Color"
					icon={Rainbow}
					value={light.color}
					onChange={color => onLightChange( index, 'color', color )}
				/>
			</Row>
			<Row>
				<Vector3Component
					label="Position"
					value={light.position}
					onValueChange={value => onLightChange( index, 'position', value )}
				/>
			</Row>

			{/* SpotLight-specific controls */}
			{light.type === 'SpotLight' && (
				<>
					<Row>
						<Vector3Component
							label="Target"
							value={light.target || [ 0, 0, - 1 ]}
							onValueChange={value => onLightChange( index, 'target', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Cone Angle"
							icon={CircleDot}
							min={0}
							max={90}
							step={1}
							value={[ light.angle ]}
							onValueChange={value => onLightChange( index, 'angle', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Penumbra"
							icon={CircleDashed}
							min={0}
							max={1}
							step={0.05}
							value={[ light.penumbra ?? 0 ]}
							onValueChange={value => onLightChange( index, 'penumbra', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Distance"
							icon={Ruler}
							min={0}
							max={100}
							step={0.5}
							value={[ light.distance ?? 0 ]}
							onValueChange={value => onLightChange( index, 'distance', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Decay"
							icon={Activity}
							min={0}
							max={4}
							step={0.1}
							value={[ light.decay ?? 2 ]}
							onValueChange={value => onLightChange( index, 'decay', value )}
						/>
					</Row>
					<GoboControls light={light} index={index} onLightChange={onLightChange} />
					<Row>
						<span className="opacity-50 text-xs truncate flex items-center gap-1"><Lightbulb size={11} /> IES Profile</span>
						<IESPicker
							value={light.ies || null}
							onChange={name => onLightChange( index, 'ies', name )}
						/>
					</Row>
					{light.ies && (
						<>
							<Row>
								<Slider
									label="IES Strength"
									icon={Lightbulb}
									min={0}
									max={1}
									step={0.05}
									value={[ light.iesIntensity ?? 1 ]}
									onValueChange={value => onLightChange( index, 'iesIntensity', value )}
								/>
							</Row>
							{Number.isFinite( light.fixtureLumens ) && light.fixtureLumens > 0 && (
								<Row>
									<span className="opacity-50 text-xs">Fixture Lumens</span>
									<span className="text-xs text-muted-foreground">{Math.round( light.fixtureLumens ).toLocaleString()}</span>
								</Row>
							)}
						</>
					)}
				</>
			)}

			{/* DirectionalLight-specific controls */}
			{light.type === 'DirectionalLight' && (
				<GoboControls light={light} index={index} onLightChange={onLightChange} showScale />
			)}

			{/* PointLight-specific controls */}
			{light.type === 'PointLight' && (
				<>
					<Row>
						<Slider
							label="Distance"
							icon={Ruler}
							min={0}
							max={100}
							step={0.5}
							value={[ light.distance ?? 0 ]}
							onValueChange={value => onLightChange( index, 'distance', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Decay"
							icon={Activity}
							min={0}
							max={4}
							step={0.1}
							value={[ light.decay ?? 2 ]}
							onValueChange={value => onLightChange( index, 'decay', value )}
						/>
					</Row>
				</>
			)}

			{/* RectAreaLight-specific controls */}
			{light.type === 'RectAreaLight' && (
				<>
					<Row>
						<Slider
							label="Width"
							icon={RectangleHorizontal}
							min={0.1}
							max={20}
							step={0.1}
							value={[ light.width || 2 ]}
							onValueChange={value => onLightChange( index, 'width', value )}
						/>
					</Row>
					<Row>
						<Slider
							label="Height"
							icon={RectangleVertical}
							min={0.1}
							max={20}
							step={0.1}
							value={[ light.height || 2 ]}
							onValueChange={value => onLightChange( index, 'height', value )}
						/>
					</Row>
					<Row>
						<Vector3Component
							label="Target"
							value={light.target || [ 0, 0, 0 ]}
							onValueChange={value => onLightChange( index, 'target', value )}
						/>
					</Row>
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

			const sceneLights = app.lightManager.getAll();
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
			<Row className="py-2 px-2">
				<SliderToggle label={"Emissive Geometry"} enabled={ enableEmissiveTriangleSampling } min={0} max={100} step={1} value={[ emissiveBoost ]} onValueChange={ handleEmissiveBoostChange } onToggleChange={ handleEnableEmissiveTriangleSamplingChange } />
			</Row>

			<Separator className="bg-primary" />

			{/* Header */}
			<Row className="py-2 px-2 text-xs bg-muted opacity-60">
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
			</Row>

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
					<Row className="py-2 px-2">
						<Switch label="Light Helper" checked={showLightHelper} onCheckedChange={handleShowLightHelperChange} />
					</Row>

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
