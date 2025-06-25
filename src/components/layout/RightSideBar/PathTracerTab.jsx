import { Grip, Sun, Sunrise, RefreshCcwDot } from 'lucide-react';
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
		samplingTechnique,
		adaptiveSampling,
		performanceModeAdaptive,
		adaptiveSamplingMin,
		adaptiveSamplingMax,
		adaptiveSamplingVarianceThreshold,
		showAdaptiveSamplingHelper,
		temporalVarianceWeight,
		enableEarlyTermination,
		earlyTerminationThreshold,
		fireflyThreshold,
		renderMode,
		tiles,
		tilesHelper,
		resolution,
		enableOIDN,
		useGBuffer,
		enableRealtimeDenoiser,
		denoiserBlurStrength,
		denoiserBlurRadius,
		denoiserDetailPreservation,
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
		enableASVGF,
		asvgfQualityPreset,

		// Handlers - now from store
		handlePathTracerChange,
		handleAccumulationChange,
		handleBouncesChange,
		handleSamplesPerPixelChange,
		handleSamplingTechniqueChange,
		handleResolutionChange,
		handleAdaptiveSamplingChange,
		handlePerformanceModeAdaptiveChange,
		handleAdaptiveSamplingMinChange,
		handleAdaptiveSamplingMaxChange,
		handleAdaptiveSamplingVarianceThresholdChange,
		handleAdaptiveSamplingHelperToggle,
		handleTemporalVarianceWeightChange,
		handleEnableEarlyTerminationChange,
		handleEarlyTerminationThresholdChange,
		handleFireflyThresholdChange,
		handleRenderModeChange,
		handleTileUpdate,
		handleTileHelperToggle,
		handleEnableOIDNChange,
		handleOidnQualityChange,
		handleOidnHdrChange,
		handleUseGBufferChange,
		handleEnableRealtimeDenoiserChange,
		handleDenoiserBlurStrengthChange,
		handleDenoiserBlurRadiusChange,
		handleDenoiserDetailPreservationChange,
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
		handleEnableASVGFChange,
		handleAsvgfQualityPresetChange,
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
					<Switch label={"Enable ASVGF"} checked={enableASVGF} onCheckedChange={handleEnableASVGFChange}/>
				</div>
				{enableASVGF && ( <>
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
								<SelectItem value="ultra">Ultra</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</> )}
				<Separator />

				<div className="flex items-center justify-between">
					<Switch label={"Enable AI Denoising"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange}/>
				</div>
				{enableOIDN && ( <>
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
				<div className="flex items-center justify-between">
					<Switch label={"Enable Realtime Denoiser"} checked={enableRealtimeDenoiser} onCheckedChange={handleEnableRealtimeDenoiserChange} />
				</div>
				{enableRealtimeDenoiser && ( <>
					<div className="flex items-center justify-between">
						<Slider label={"Blur Strength"} min={0.5} max={5} step={0.1} value={[ denoiserBlurStrength ]} onValueChange={handleDenoiserBlurStrengthChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Blur Radius"} min={1} max={3} step={0.1} value={[ denoiserBlurRadius ]} onValueChange={handleDenoiserBlurRadiusChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Detail Preservation"} min={0.01} max={0.1} step={0.01} value={[ denoiserDetailPreservation ]} onValueChange={handleDenoiserDetailPreservationChange} />
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
					<Switch label={"Adaptive Sampling"} checked={adaptiveSampling} onCheckedChange={handleAdaptiveSamplingChange} />
				</div>
				{adaptiveSampling && ( <>
					<div className="flex items-center justify-between">
						<Select value={performanceModeAdaptive} onValueChange={handlePerformanceModeAdaptiveChange}>
							<span className="opacity-50 text-xs truncate">Performance Mode</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full">
								<SelectValue placeholder="Select performance mode" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="low">Low (Faster)</SelectItem>
								<SelectItem value="medium">Medium</SelectItem>
								<SelectItem value="high">High (Slower)</SelectItem>
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
						<Slider label={"Variance Threshold"} min={0.0001} max={0.01} step={0.0001} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Show Heatmap"} checked={showAdaptiveSamplingHelper} onCheckedChange={handleAdaptiveSamplingHelperToggle} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Temporal Weight"} min={0} max={1} step={0.05} value={[ temporalVarianceWeight ]} onValueChange={handleTemporalVarianceWeightChange} />
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Early Termination"} checked={enableEarlyTermination} onCheckedChange={handleEnableEarlyTerminationChange} />
					</div>
					{enableEarlyTermination && (
						<div className="flex items-center justify-between">
							<Slider label={"Termination Threshold"} min={0.0001} max={0.005} step={0.0001} value={[ earlyTerminationThreshold ]} onValueChange={handleEarlyTerminationThresholdChange} />
						</div>
					)}
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
