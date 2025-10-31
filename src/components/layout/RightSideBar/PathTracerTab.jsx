import { Grip, Sun, Sunrise, RefreshCcwDot, Brain, Zap, Target } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Exposure } from '@/assets/icons';
import { Separator } from '@/components/ui/separator';

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
		samplingTechnique,
		enableEmissiveTriangleSampling,
		emissiveBoost,
		adaptiveSampling,
		adaptiveSamplingMin,
		adaptiveSamplingMax,
		adaptiveSamplingVarianceThreshold,
		showAdaptiveSamplingHelper,
		adaptiveSamplingMaterialBias,
		adaptiveSamplingEdgeBias,
		adaptiveSamplingConvergenceSpeed,
		adaptiveSamplingQualityPreset,
		fireflyThreshold,
		renderMode,
		tiles,
		tilesHelper,
		resolution,
		useGBuffer,
		debugMode,
		debugThreshold,
		enableBloom,
		bloomThreshold,
		bloomStrength,
		bloomRadius,
		oidnQuality,
		oidnHdr,
		exposure,
		enableEnvironment,
		useImportanceSampledEnvironment,
		showBackground,
		backgroundIntensity,
		environmentIntensity,
		environmentRotation,
		GIIntensity,
		toneMapping,
		interactionModeEnabled,
		asvgfQualityPreset,
		asvgfDebugMode,
		showAsvgfHeatmap,
		denoiserStrategy,
		pixelEdgeSharpness,
		edgeSharpenSpeed,
		edgeThreshold,

		// Handlers - now from store
		handlePathTracerChange,
		handleAccumulationChange,
		handleBouncesChange,
		handleSamplesPerPixelChange,
		handleTransmissiveBouncesChange,
		handleSamplingTechniqueChange,
		handleEnableEmissiveTriangleSamplingChange,
		handleEmissiveBoostChange,
		handleResolutionChange,
		handleAdaptiveSamplingChange,
		handleAdaptiveSamplingMinChange,
		handleAdaptiveSamplingMaxChange,
		handleAdaptiveSamplingVarianceThresholdChange,
		handleAdaptiveSamplingHelperToggle,
		handleAdaptiveSamplingMaterialBiasChange,
		handleAdaptiveSamplingEdgeBiasChange,
		handleAdaptiveSamplingConvergenceSpeedChange,
		handleAdaptiveSamplingQualityPresetChange,
		handleFireflyThresholdChange,
		handleRenderModeChange,
		handleTileUpdate,
		handleTileHelperToggle,
		handleOidnQualityChange,
		handleOidnHdrChange,
		handleUseGBufferChange,
		handleDebugThresholdChange,
		handleDebugModeChange,
		handleEnableBloomChange,
		handleBloomThresholdChange,
		handleBloomStrengthChange,
		handleBloomRadiusChange,
		handleExposureChange,
		handleEnableEnvironmentChange,
		handleUseImportanceSampledEnvironmentChange,
		handleShowBackgroundChange,
		handleBackgroundIntensityChange,
		handleEnvironmentIntensityChange,
		handleEnvironmentRotationChange,
		handleGIIntensityChange,
		handleToneMappingChange,
		handleInteractionModeEnabledChange,
		handleAsvgfQualityPresetChange,
		handleAsvgfDebugModeChange,
		handleShowAsvgfHeatmapChange,
		handleDenoiserStrategyChange,
		handlePixelEdgeSharpnessChange,
		handleEdgeSharpenSpeedChange,
		handleEdgeThresholdChange,
	} = pathTracerStore;

	return (
		<div className="">
			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<div className="flex items-center justify-between">
					<Switch label={"Enable"} checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
				</div>
				<div className="flex items-center justify-between">
					<Switch label={"Interaction Mode"} checked={interactionModeEnabled} onCheckedChange={handleInteractionModeEnabledChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Bounces"} min={0} max={20} step={1} value={[ bounces ]} onValueChange={handleBouncesChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Rays Per Pixel"} icon={Grip} min={1} max={20} step={1} value={[ samplesPerPixel ]} onValueChange={handleSamplesPerPixelChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Transmissive Bounces"} min={0} max={10} step={1} value={[ transmissiveBounces ]} onValueChange={handleTransmissiveBouncesChange} />
				</div>
				<div className="flex items-center justify-between">
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
				</div>
				{renderMode === '1' && (
					<>
						<div className="flex items-center justify-between">
							<Slider label={"Tile Size"} min={1} max={10} step={1} value={[ tiles ]} onValueChange={handleTileUpdate} />
						</div>
						<div className="flex items-center justify-between">
							<Switch label={"Tile Helper"} checked={tilesHelper} onCheckedChange={handleTileHelperToggle} />
						</div>
					</>
				)}
				<div className="flex items-center justify-between">
					<Select value={resolution.toString()} onValueChange={handleResolutionChange}>
						<span className="opacity-50 text-xs truncate">Resolution</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue placeholder="Select resolution" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="0">256</SelectItem>
							<SelectItem value="1">512</SelectItem>
							<SelectItem value="2">1024</SelectItem>
							<SelectItem value="3">2048</SelectItem>
							<SelectItem value="4">4096</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</ControlGroup>

			<ControlGroup name="Scene">
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
					<Slider icon={Exposure} label={"Exposure"} min={0} max={2} step={0.01} value={[ exposure ]} snapPoints={[ 1 ]} onValueChange={handleExposureChange} />
				</div>
				<div className="flex items-center justify-between">
					<Switch label={"Use Importance Sampling"} checked={useImportanceSampledEnvironment} onCheckedChange={handleUseImportanceSampledEnvironmentChange} />
				</div>
				<div className="flex items-center justify-between">
					<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} snapPoints={[ 1 ]} onValueChange={handleGIIntensityChange} />
				</div>
				<div className="flex items-center justify-between">
					<SliderToggle label={"Background Intensity"} enabled={showBackground} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ backgroundIntensity ]} onValueChange={handleBackgroundIntensityChange} onToggleChange={handleShowBackgroundChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Environment Rotation"} icon={RefreshCcwDot} min={0} max={360} step={1} value={[ environmentRotation ]} snapPoints={[ 90, 180, 270 ]} onValueChange={handleEnvironmentRotationChange} />
				</div>
			</ControlGroup>

			<ControlGroup name="Denoising">
				<div className="flex items-center justify-between">
					<Select value={denoiserStrategy} onValueChange={handleDenoiserStrategyChange}>
						<span className="opacity-50 text-xs truncate">Denoiser Strategy</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select strategy" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							<SelectItem value="edgeaware">EdgeAware</SelectItem>
							<SelectItem value="asvgf">ASVGF</SelectItem>
							<SelectItem value="oidn">OIDN</SelectItem>
						</SelectContent>
					</Select>
				</div>

				{denoiserStrategy === 'edgeaware' && ( <>
					<div className="flex items-center justify-between">
						<Slider label={"Edge Sharpness"} min={0} max={2} step={0.01} value={[ pixelEdgeSharpness ]} onValueChange={handlePixelEdgeSharpnessChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Sharpen Speed"} min={0} max={0.2} step={0.001} value={[ edgeSharpenSpeed ]} onValueChange={handleEdgeSharpenSpeedChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Edge Threshold"} min={0} max={5} step={0.1} value={[ edgeThreshold ]} onValueChange={handleEdgeThresholdChange} />
					</div>
				</> )}

				{denoiserStrategy === 'asvgf' && ( <>
					<div className="flex items-center justify-between">
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
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Show Heatmap"} checked={showAsvgfHeatmap} onCheckedChange={handleShowAsvgfHeatmapChange}/>
					</div>
					{showAsvgfHeatmap && (
						<div className="flex items-center justify-between">
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
						</div>
					)}
				</> )}

				{denoiserStrategy === 'oidn' && ( <>
					<div className="flex items-center justify-between">
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
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"HDR"} disabled checked={oidnHdr} onCheckedChange={handleOidnHdrChange} />
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Use GBuffer"} checked={useGBuffer} onCheckedChange={handleUseGBufferChange} />
					</div>
				</> )}
			</ControlGroup>

			<ControlGroup name="Sampling">
				<div className="flex items-center justify-between">
					<Select value={samplingTechnique.toString()} onValueChange={handleSamplingTechniqueChange}>
						<span className="opacity-50 text-xs truncate">Sampler</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select sampler" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem key='PCG' value={"0"}>PCG</SelectItem>
							<SelectItem key='Halton' value={"1"}>Halton</SelectItem>
							<SelectItem key='Sobol' value={"2"}>Sobol</SelectItem>
							<SelectItem key='BlueNoise' value={"3"}>BlueNoise</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Firefly Threshold"} min={0} max={10} step={0.1} value={[ fireflyThreshold ]} onValueChange={handleFireflyThresholdChange} />
				</div>
				<div className="flex items-center justify-between">
					<SliderToggle label={"Emissive Mesh Sampling"} enabled={ enableEmissiveTriangleSampling } min={1} max={1000} step={1} value={[ emissiveBoost ]} onValueChange={ handleEmissiveBoostChange } onToggleChange={ handleEnableEmissiveTriangleSamplingChange } />
				</div>
				{/* Feature disabled temporarily */}
				<Separator />
				<div className="flex items-center justify-between">
					<Switch label={"Adaptive Sampling"} checked={adaptiveSampling} onCheckedChange={handleAdaptiveSamplingChange} />
				</div>
				{adaptiveSampling && ( <>
					<div className="flex items-center justify-between">
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
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Min Samples"} min={0} max={4} step={1} value={[ adaptiveSamplingMin ]} onValueChange={handleAdaptiveSamplingMinChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Max Samples"} min={4} max={32} step={2} value={[ adaptiveSamplingMax ]} onValueChange={handleAdaptiveSamplingMaxChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Convergence Threshold"} min={0.0001} max={0.01} step={0.0001} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
					</div>
					<Separator />
					<div className="flex items-center justify-between">
						<Slider label={"Material Intelligence"} icon={Brain} min={0.5} max={3.0} step={0.1} value={[ adaptiveSamplingMaterialBias ]} onValueChange={handleAdaptiveSamplingMaterialBiasChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Edge Focus"} icon={Zap} min={0.5} max={3.0} step={0.1} value={[ adaptiveSamplingEdgeBias ]} onValueChange={handleAdaptiveSamplingEdgeBiasChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Convergence Speed"} icon={Target} min={0.5} max={5.0} step={0.1} value={[ adaptiveSamplingConvergenceSpeed ]} onValueChange={handleAdaptiveSamplingConvergenceSpeedChange} />
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Show Heatmap"} checked={showAdaptiveSamplingHelper} onCheckedChange={handleAdaptiveSamplingHelperToggle} />
					</div>
				</> )}
			</ControlGroup>

			<ControlGroup name="Post Processing">
				<div className="flex items-center justify-between">
					<SliderToggle label={"Bloom Strength"} enabled={ enableBloom } min={0} max={3} step={0.1} value={[ bloomStrength ]} onValueChange={ handleBloomStrengthChange } onToggleChange={ handleEnableBloomChange } />
				</div>
				{enableBloom && ( <>
					<div className="flex items-center justify-between">
						<Slider label={"Bloom Radius"} min={0} max={1} step={0.01} value={[ bloomRadius ]} onValueChange={handleBloomRadiusChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Bloom Threshold"} min={0} max={1} step={0.01} value={[ bloomThreshold ]} onValueChange={handleBloomThresholdChange} />
					</div></>
				)}
			</ControlGroup>

			{enablePathTracer && (
				<ControlGroup name="Debugging">
					<div className="flex items-center justify-between">
						<Switch label={"Accumulation"} checked={enableAccumulation} onCheckedChange={handleAccumulationChange} />
					</div>
					<div className="flex items-center justify-between">
						<Select value={debugMode.toString()} onValueChange={handleDebugModeChange}>
							<span className="opacity-50 text-xs truncate">Mode</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select mode" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">Beauty</SelectItem>
								<SelectItem value="1">Triangle test count</SelectItem>
								<SelectItem value="2">Box test count</SelectItem>
								<SelectItem value="3">Distance</SelectItem>
								<SelectItem value="4">Normal</SelectItem>
								<SelectItem value="5">Sampling</SelectItem>
								<SelectItem value="6">EnvMap Luminance</SelectItem>
								<SelectItem value="7">Env MIS PDF Direction</SelectItem>
								<SelectItem value="8">Emissive Lighting</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Display Threshold"} min={1} max={500} step={1} value={[ debugThreshold ]} onValueChange={handleDebugThresholdChange} />
					</div>
				</ControlGroup>
			)}
		</div>
	);

};

export default PathTracerTab;
