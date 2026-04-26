import { Grip, Sun, Sunrise, RefreshCcwDot, Brain, Target, Image, Blend, Palette, ArrowUp, CloudSun, Wind } from 'lucide-react';
// import { Zap, ArrowDown, Minus, Droplets } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ColorInput } from "@/components/ui/colorinput";
import { usePathTracerStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Row } from '@/components/ui/row';
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Exposure } from '@/assets/icons';
import { Separator } from '@/components/ui/separator';
import { memo } from 'react';
import CanvasDimensionControls from './CanvasDimensionControls';

/**
 * Optimized component for displaying computed auto-exposure value
 * Uses Zustand selector to subscribe only to currentAutoExposure state
 * This prevents unnecessary rerenders of the parent PathTracerTab component
 */
const AutoExposureValue = memo( () => {

	// Use Zustand selector pattern for optimal performance
	// Only subscribes to currentAutoExposure, avoiding full component rerenders
	const currentExposure = usePathTracerStore( ( state ) => state.currentAutoExposure );

	// Don't render if no value available yet
	if ( currentExposure === undefined || currentExposure === null ) {

		return <span className="text-xs opacity-50">Calculating...</span>;

	}

	return (
		<span className="text-xs opacity-70">
			{ currentExposure.toFixed( 3 ) }
		</span>
	);

} );

AutoExposureValue.displayName = 'AutoExposureValue';

// Per-debug-mode control renderers. Add a new case to expose mode-specific
// parameters (e.g. thresholds, scales) when introducing a new debug mode.
const renderDebugModeControls = ( debugMode, props ) => {

	switch ( debugMode ) {

		case '7': // Triangle Tests
		case '8': // Box Tests
			return (
				<Row>
					<Slider label={"Display Threshold"} min={1} max={500} step={1} value={[ props.debugThreshold ]} onValueChange={props.handleDebugThresholdChange} />
				</Row>
			);
		default:
			return null;

	}

};

const toneMappingOptions = [
	{ label: 'None', value: 0 },
	{ label: 'Linear', value: 1 },
	{ label: 'Reinhard', value: 2 },
	{ label: 'Cineon', value: 3 },
	{ label: 'ACESFilmic', value: 4 },
	{ label: 'AgXToneMapping', value: 6 },
	{ label: 'NeutralToneMapping', value: 7 }
];

const PathTracerTab = () => {

	const pathTracerStore = usePathTracerStore();

	// Destructure all state and handlers from the store
	const {
		// State
		enablePathTracer,
		enableAccumulation,
		bounces,
		samplesPerPixel,
		transmissiveBounces,
		adaptiveSampling,
		adaptiveSamplingMin,
		adaptiveSamplingMax,
		adaptiveSamplingVarianceThreshold,
		showAdaptiveSamplingHelper,
		adaptiveSamplingMaterialBias,
		adaptiveSamplingConvergenceSpeed,
		adaptiveSamplingQualityPreset,
		fireflyThreshold,
		renderMode,
		tiles,
		tilesHelper,
		debugMode,
		debugThreshold,
		showInspector,
		oidnQuality,
		enableOIDN,
		enableUpscaler,
		upscalerScale,
		upscalerQuality,
		exposure,
		saturation,
		enableEnvironment,
		showBackground,
		transparentBackground,
		backgroundIntensity,
		environmentIntensity,
		environmentRotation,
		GIIntensity,
		toneMapping,
		// Environment Mode
		environmentMode,
		gradientZenithColor,
		gradientHorizonColor,
		gradientGroundColor,
		solidSkyColor,
		// Procedural Sky (Preetham Model)
		skySunAzimuth,
		skySunElevation,
		skySunIntensity,
		skyRayleighDensity,
		skyTurbidity,
		skyMieAnisotropy,
		skyPreset,
		enableAlphaShadows,
		interactionModeEnabled,
		asvgfQualityPreset,
		asvgfDebugMode,
		showAsvgfHeatmap,
		denoiserStrategy,
		// SSRC
		ssrcTemporalAlpha,
		ssrcSpatialRadius,
		ssrcSpatialWeight,
		filterStrength,
		strengthDecaySpeed,
		edgeThreshold,
		// Auto-exposure state
		autoExposure,
		autoExposureKeyValue,
		autoExposureMinExposure,
		autoExposureMaxExposure,
		autoExposureAdaptSpeedBright,

		// Handlers - now from store
		handlePathTracerChange,
		handleAccumulationChange,
		handleBouncesChange,
		handleSamplesPerPixelChange,
		handleTransmissiveBouncesChange,
		handleAdaptiveSamplingChange,
		handleAdaptiveSamplingMinChange,
		handleAdaptiveSamplingMaxChange,
		handleAdaptiveSamplingVarianceThresholdChange,
		handleAdaptiveSamplingHelperToggle,
		handleAdaptiveSamplingMaterialBiasChange,
		handleAdaptiveSamplingConvergenceSpeedChange,
		handleAdaptiveSamplingQualityPresetChange,
		handleFireflyThresholdChange,
		handleEnableAlphaShadowsChange,
		handleRenderModeChange,
		handleTileUpdate,
		handleTileHelperToggle,
		handleOidnQualityChange,
		handleEnableOIDNChange,
		handleEnableUpscalerChange,
		handleUpscalerScaleChange,
		handleUpscalerQualityChange,
		handleDebugThresholdChange,
		handleDebugModeChange,
		handleInspectorToggle,
		handleExposureChange,
		handleSaturationChange,
		handleEnableEnvironmentChange,
		handleShowBackgroundChange,
		handleTransparentBackgroundChange,
		handleBackgroundIntensityChange,
		handleEnvironmentIntensityChange,
		handleEnvironmentRotationChange,
		handleGIIntensityChange,
		handleToneMappingChange,
		// Environment Mode Handlers
		handleEnvironmentModeChange,
		handleGradientZenithColorChange,
		handleGradientHorizonColorChange,
		handleGradientGroundColorChange,
		handleSolidSkyColorChange,
		// Procedural Sky (Preetham Model) Handlers
		handleSkySunAzimuthChange,
		handleSkySunElevationChange,
		handleSkySunIntensityChange,
		handleSkyRayleighDensityChange,
		handleSkyTurbidityChange,
		handleSkyMieAnisotropyChange,
		handleSkyPresetChange,
		handleInteractionModeEnabledChange,
		handleAsvgfQualityPresetChange,
		handleAsvgfDebugModeChange,
		handleShowAsvgfHeatmapChange,
		handleDenoiserStrategyChange,
		// SSRC handlers
		handleSsrcTemporalAlphaChange,
		handleSsrcSpatialRadiusChange,
		handleSsrcSpatialWeightChange,
		handleFilterStrengthChange,
		handleStrengthDecaySpeedChange,
		handleEdgeThresholdChange,
		// Auto-exposure handlers
		handleAutoExposureChange,
		handleAutoExposureKeyValueChange,
		handleAutoExposureMinExposureChange,
		handleAutoExposureMaxExposureChange,
		handleAutoExposureAdaptSpeedChange,
	} = pathTracerStore;

	return (
		<div className="">
			<Separator className="bg-primary" />

			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<Row>
					<Switch label={"Enable"} checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
				</Row>
				<Row>
					<Switch label={"Interaction Mode"} checked={interactionModeEnabled} onCheckedChange={handleInteractionModeEnabledChange} />
				</Row>
				<Row>
					<Slider label={"Bounces"} min={0} max={20} step={1} value={[ bounces ]} onValueChange={handleBouncesChange} />
				</Row>
				<Row>
					<Slider label={"Rays Per Pixel"} icon={Grip} min={1} max={6} step={1} value={[ samplesPerPixel ]} onValueChange={handleSamplesPerPixelChange} />
				</Row>
				<Row>
					<Slider label={"Transmissive Bounces"} min={0} max={10} step={1} value={[ transmissiveBounces ]} onValueChange={handleTransmissiveBouncesChange} />
				</Row>
				<Row>
					<Select value={renderMode.toString()} onValueChange={handleRenderModeChange}>
						<span className="opacity-50 text-xs truncate">Render Mode</span>
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue placeholder="Select mode" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="0">Regular</SelectItem>
							<SelectItem value="1">Tiled</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				{renderMode === '1' && (
					<>
						<Row>
							<Slider label={"Tile Size"} min={1} max={10} step={1} value={[ tiles ]} onValueChange={handleTileUpdate} />
						</Row>
						<Row>
							<Switch label={"Tile Helper"} checked={tilesHelper} onCheckedChange={handleTileHelperToggle} />
						</Row>
					</>
				)}
				<CanvasDimensionControls />
			</ControlGroup>

			<ControlGroup name="Scene">
				<Row>
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
				</Row>
				<Row more={autoExposure ? (
					<>
						<Row>
							<Slider icon={Target} label={"Target Brightness"} min={0.05} max={0.5} step={0.01} value={[ autoExposureKeyValue ]} snapPoints={[ 0.18 ]} onValueChange={handleAutoExposureKeyValueChange} />
						</Row>
						{/* <Row>
							<Slider icon={ArrowDown} label={"Min Exposure"} min={0.01} max={1.0} step={0.01} value={[ autoExposureMinExposure ]} onValueChange={handleAutoExposureMinExposureChange} />
						</Row>
						<Row>
							<Slider icon={ArrowUp} label={"Max Exposure"} min={1.0} max={20.0} step={0.1} value={[ autoExposureMaxExposure ]} onValueChange={handleAutoExposureMaxExposureChange} />
						</Row>
						<Row>
							<Slider icon={Zap} label={"Adaptation Speed"} min={0.5} max={10.0} step={0.1} value={[ autoExposureAdaptSpeedBright ]} snapPoints={[ 3.0 ]} onValueChange={handleAutoExposureAdaptSpeedChange} />
						</Row> */}
					</>
				) : null}>
					<span className="opacity-50 text-xs truncate">Auto Exposure</span>
					<div className="flex items-center gap-2">
						{autoExposure && <AutoExposureValue />}
						<Switch checked={autoExposure} onCheckedChange={handleAutoExposureChange} />
					</div>
				</Row>
				{! autoExposure && (
					<Row>
						<Slider icon={Exposure} label={"Exposure"} min={0} max={10} step={0.01} value={[ exposure ]} snapPoints={[ 1 ]} onValueChange={handleExposureChange} />
					</Row>
				)}
				{/* <Row>
					<Slider icon={Exposure} label={"Saturation"} min={0} max={2} step={0.01} value={[ saturation ]} snapPoints={[ 1 ]} onValueChange={handleSaturationChange} />
				</Row> */}
				{/* <Row>
					<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} snapPoints={[ 1 ]} onValueChange={handleGIIntensityChange} />
				</Row> */}
				<Separator className="my-1 opacity-30" />

				{/* Environment Mode Selector */}
				<Row>
					<Select value={environmentMode} onValueChange={handleEnvironmentModeChange}>
						<span className="opacity-50 text-xs truncate">Environment Mode</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hdri">
								<div className="flex items-center">
									<Image size={14} className="mr-1" />
									<span>HDRI</span>
								</div>
							</SelectItem>
							<SelectItem value="procedural">
								<div className="flex items-center">
									<CloudSun size={14} className="mr-1" />
									<span>Procedural Sky</span>
								</div>
							</SelectItem>
							<SelectItem value="gradient">
								<div className="flex items-center">
									<Blend size={14} className="mr-1" />
									<span>Gradient</span>
								</div>
							</SelectItem>
							<SelectItem value="color">
								<div className="flex items-center">
									<Palette size={14} className="mr-1" />
									<span>Solid Color</span>
								</div>
							</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{/* Gradient Mode Controls */}
				{environmentMode === 'gradient' && (
					<>
						<Row>
							<ColorInput label="Zenith" value={gradientZenithColor} onChange={handleGradientZenithColorChange} />
						</Row>
						<Row>
							<ColorInput label="Horizon" value={gradientHorizonColor} onChange={handleGradientHorizonColorChange} />
						</Row>
						<Row>
							<ColorInput label="Ground" value={gradientGroundColor} onChange={handleGradientGroundColorChange} />
						</Row>
					</>
				)}

				{/* Solid Color Mode Controls */}
				{environmentMode === 'color' && (
					<Row>
						<ColorInput label="Sky Color" value={solidSkyColor} onChange={handleSolidSkyColorChange} />
					</Row>
				)}

				{/* Procedural Sky Mode Controls */}
				{environmentMode === 'procedural' && (
					<>
						{/* Preset Selector */}
						<Row>
							<Select value={skyPreset} onValueChange={handleSkyPresetChange}>
								<span className="opacity-50 text-xs truncate">Preset</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full">
									<SelectValue placeholder="Select Preset" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="clearMorning">Clear Morning</SelectItem>
									<SelectItem value="clearNoon">Clear Noon</SelectItem>
									<SelectItem value="overcast">Overcast</SelectItem>
									<SelectItem value="goldenHour">Golden Hour</SelectItem>
									<SelectItem value="sunset">Sunset</SelectItem>
									<SelectItem value="dusk">Dusk</SelectItem>
								</SelectContent>
							</Select>
						</Row>

						{/* Sun Position */}
						<Row>
							<Slider label="Sun Rotation" icon={RefreshCcwDot} min={0} max={360} step={1} value={[ skySunAzimuth ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkySunAzimuthChange} />
						</Row>
						<Row>
							<Slider label="Sun Height" icon={ArrowUp} min={- 10} max={90} step={1} value={[ skySunElevation ]} snapPoints={[ 0, 45, 90 ]} onValueChange={handleSkySunElevationChange} />
						</Row>
						<Row>
							<Slider label="Sun Brightness" icon={Sun} min={0} max={50} step={0.5} value={[ skySunIntensity ]} snapPoints={[ 20 ]} onValueChange={handleSkySunIntensityChange} />
						</Row>

						{/* Atmospheric Properties */}
						<Row>
							<Slider label="Sky Clarity" icon={CloudSun} min={0} max={2} step={0.1} value={[ skyRayleighDensity ]} snapPoints={[ 1 ]} onValueChange={handleSkyRayleighDensityChange} />
						</Row>
						<Row>
							<Slider label="Atmospheric Haze" icon={Wind} min={0} max={5} step={0.1} value={[ skyTurbidity ]} snapPoints={[ 1 ]} onValueChange={handleSkyTurbidityChange} />
						</Row>
					</>
				)}

				<Separator className="my-1 opacity-30" />

				{/* Common Environment Controls */}
				<Row>
					<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
				</Row>
				<Row>
					<SliderToggle label={"Background Intensity"} enabled={showBackground} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ backgroundIntensity ]} onValueChange={handleBackgroundIntensityChange} onToggleChange={handleShowBackgroundChange} />
				</Row>
				<Row>
					<Switch label={"Transparent Background"} checked={transparentBackground} onCheckedChange={handleTransparentBackgroundChange} />
				</Row>

				{/* HDRI Mode Controls */}
				{environmentMode === 'hdri' && (
					<>
						<Row>
							<Slider label={"Environment Rotation"} icon={RefreshCcwDot} min={0} max={360} step={1} value={[ environmentRotation ]} snapPoints={[ 90, 180, 270 ]} onValueChange={handleEnvironmentRotationChange} />
						</Row>
					</>
				)}
			</ControlGroup>

			<ControlGroup name="Denoising">
				<Row>
					<Select value={denoiserStrategy} onValueChange={handleDenoiserStrategyChange}>
						<span className="opacity-50 text-xs truncate">Real-Time Denoiser</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select strategy" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							<SelectItem value="edgeaware">EdgeAware</SelectItem>
							<SelectItem value="asvgf">ASVGF</SelectItem>
							<SelectItem value="ssrc">SSRC</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{denoiserStrategy === 'edgeaware' && ( <>
					<Row>
						<Slider label={"Filter Strength"} min={0} max={1} step={0.01} value={[ filterStrength ]} onValueChange={handleFilterStrengthChange} />
					</Row>
					<Row>
						<Slider label={"Decay Speed"} min={0} max={0.2} step={0.001} value={[ strengthDecaySpeed ]} onValueChange={handleStrengthDecaySpeedChange} />
					</Row>
					<Row>
						<Slider label={"Edge Threshold"} min={0} max={5} step={0.1} value={[ edgeThreshold ]} onValueChange={handleEdgeThresholdChange} />
					</Row>
				</> )}

				{denoiserStrategy === 'asvgf' && ( <>
					<Row>
						<Select value={asvgfQualityPreset} onValueChange={handleAsvgfQualityPresetChange}>
							<span className="opacity-50 text-xs truncate">Quality Preset</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="low">Low</SelectItem>
								<SelectItem value="medium">Medium</SelectItem>
								<SelectItem value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row>
						<Switch label={"Show Heatmap"} checked={showAsvgfHeatmap} onCheckedChange={handleShowAsvgfHeatmapChange}/>
					</Row>
					{showAsvgfHeatmap && (
						<Row>
							<Select value={asvgfDebugMode.toString()} onValueChange={handleAsvgfDebugModeChange}>
								<span className="opacity-50 text-xs truncate">Debug View</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full" >
									<SelectValue placeholder="Select view" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="0">Beauty</SelectItem>
									<SelectItem value="1">Variance</SelectItem>
									<SelectItem value="2">History Length</SelectItem>
									<SelectItem value="3">Motion Vectors</SelectItem>
									<SelectItem value="4">Normals</SelectItem>
									<SelectItem value="5">Temporal Gradient</SelectItem>
								</SelectContent>
							</Select>
						</Row>
					)}
				</> )}

				{denoiserStrategy === 'ssrc' && ( <>
					<Row>
						<Slider label={"Temporal Alpha"} min={0.01} max={0.3} step={0.01} value={[ ssrcTemporalAlpha ]} onValueChange={handleSsrcTemporalAlphaChange} />
					</Row>
					<Row>
						<Slider label={"Spatial Radius"} min={1} max={16} step={1} value={[ ssrcSpatialRadius ]} onValueChange={handleSsrcSpatialRadiusChange} />
					</Row>
					<Row>
						<Slider label={"Spatial Weight"} min={0} max={1} step={0.05} value={[ ssrcSpatialWeight ]} onValueChange={handleSsrcSpatialWeightChange} />
					</Row>
				</> )}

				{/* Separator before AI Denoising section */}
				<Separator />

				{/* Independent OIDN Control - Placed after real-time denoiser controls */}
				<Row>
					<Switch label={"AI Denoising (OIDN)"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange} />
				</Row>

				{/* OIDN Quality Controls - Independent of real-time denoiser selection */}
				{enableOIDN && ( <>
					<Row>
						<Select value={oidnQuality} onValueChange={handleOidnQualityChange}>
							<span className="opacity-50 text-xs truncate">OIDN Quality</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select quality" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="fast">Fast</SelectItem>
								<SelectItem value="balance">Balance</SelectItem>
								<SelectItem disabled value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</> )}

				<Separator />

				{/* AI Upscaler Control */}
				<Row>
					<Switch label={"AI Upscaler"} checked={enableUpscaler} onCheckedChange={handleEnableUpscalerChange} />
				</Row>

				{enableUpscaler && ( <>
					<Row>
						<Select value={upscalerScale.toString()} onValueChange={handleUpscalerScaleChange}>
							<span className="opacity-50 text-xs truncate">Scale Factor</span>
							<SelectTrigger className="max-w-24 h-5 rounded-full" >
								<SelectValue placeholder="Select scale" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="2">2x</SelectItem>
								<SelectItem value="4">4x</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row>
						<Select value={upscalerQuality} onValueChange={handleUpscalerQualityChange}>
							<span className="opacity-50 text-xs truncate">Quality</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select quality" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="fast">Fast</SelectItem>
								<SelectItem value="balanced">Balanced</SelectItem>
								<SelectItem value="quality">Quality</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</> )}
			</ControlGroup>

			<ControlGroup name="Advanced">
				{enablePathTracer && (
					<Row>
						<Switch label={"Accumulation"} checked={enableAccumulation} onCheckedChange={handleAccumulationChange} />
					</Row>
				)}
				<Row>
					<Slider label={"Firefly Threshold"} min={0} max={10} step={0.1} value={[ fireflyThreshold ]} onValueChange={handleFireflyThresholdChange} />
				</Row>
				<Row>
					<Switch label={"Alpha Shadows"} checked={enableAlphaShadows} onCheckedChange={handleEnableAlphaShadowsChange} />
				</Row>
				<Separator />
				<Row>
					<Switch label={"Adaptive Sampling"} checked={adaptiveSampling} onCheckedChange={handleAdaptiveSamplingChange} />
				</Row>
				{adaptiveSampling && ( <>
					<Row more={
						<>
							<Row>
								<Slider label={"Min Samples"} min={0} max={4} step={1} value={[ adaptiveSamplingMin ]} onValueChange={handleAdaptiveSamplingMinChange} />
							</Row>
							<Row>
								<Slider label={"Max Samples"} min={4} max={32} step={2} value={[ adaptiveSamplingMax ]} onValueChange={handleAdaptiveSamplingMaxChange} />
							</Row>
							<Row>
								<Slider label={"Convergence Threshold"} min={0.01} max={0.5} step={0.01} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
							</Row>
							<Separator />
							<Row>
								<Slider label={"Sensitivity"} icon={Brain} min={0.5} max={3.0} step={0.1} value={[ adaptiveSamplingMaterialBias ]} onValueChange={handleAdaptiveSamplingMaterialBiasChange} />
							</Row>
							<Row>
								<Slider label={"Convergence Speed"} icon={Target} min={0.5} max={5.0} step={0.1} value={[ adaptiveSamplingConvergenceSpeed ]} onValueChange={handleAdaptiveSamplingConvergenceSpeedChange} />
							</Row>
						</>
					}>
						<Select value={adaptiveSamplingQualityPreset} onValueChange={handleAdaptiveSamplingQualityPresetChange}>
							<span className="opacity-50 text-xs truncate">Quality Preset</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full">
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="performance">Performance</SelectItem>
								<SelectItem value="balanced">Balanced</SelectItem>
								<SelectItem value="quality">Quality</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row>
						<Switch label={"Show Heatmap"} checked={showAdaptiveSamplingHelper} onCheckedChange={handleAdaptiveSamplingHelperToggle} />
					</Row>
				</> )}
				{enablePathTracer && ( <>
					<Separator />
					<Row>
						<Select value={debugMode.toString()} onValueChange={handleDebugModeChange}>
							<span className="opacity-50 text-xs truncate">Debug Mode</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select mode" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">None</SelectItem>
								<SelectItem value="1">Normals</SelectItem>
								<SelectItem value="2">Depth</SelectItem>
								<SelectItem value="3">Albedo</SelectItem>
								<SelectItem value="4">Emissive</SelectItem>
								<SelectItem value="5">Indirect (GI)</SelectItem>
								<SelectItem value="6">Env Reflection</SelectItem>
								<SelectItem value="7">Triangle Tests</SelectItem>
								<SelectItem value="8">Box Tests</SelectItem>
								<SelectItem value="9">Stratified Samples</SelectItem>
								<SelectItem value="10">Env Luminance</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					{renderDebugModeControls( debugMode.toString(), { debugThreshold, handleDebugThresholdChange } )}
					{import.meta.env.DEV && (
						<Row>
							<Switch label={"Inspector"} checked={showInspector} onCheckedChange={handleInspectorToggle} />
						</Row>
					)}
				</> )}
			</ControlGroup>
		</div>
	);

};

export default PathTracerTab;
