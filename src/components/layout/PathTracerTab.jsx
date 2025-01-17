import { Grip } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { create } from 'zustand';
import { DEFAULT_STATE } from '../../core/Processor/Constants';
import { ControlGroup } from '@/components/ui/control-group';
import { Separator } from '@/components/ui/separator';
import { SliderToggle } from '@/components/ui/slider-toggle';

const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/.test( navigator.userAgent );
const useStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	setEnablePathTracer: value => set( { enablePathTracer: value } ),
	setEnableAccumulation: value => set( { enableAccumulation: value } ),
	setBounces: value => set( { bounces: value } ),
	setSamplesPerPixel: value => set( { samplesPerPixel: value } ),
	setSamplingTechnique: value => set( { samplingTechnique: value } ),
	setAdaptiveSampling: value => set( { adaptiveSampling: value } ),
	setAdaptiveSamplingMin: value => set( { adaptiveSamplingMin: value } ),
	setAdaptiveSamplingMax: value => set( { adaptiveSamplingMax: value } ),
	setAdaptiveSamplingVarianceThreshold: value => set( { adaptiveSamplingVarianceThreshold: value } ),
	setRenderMode: value => set( { renderMode: value } ),
	setTiles: value => set( { tiles: value } ),
	setTilesHelper: value => set( { tilesHelper: value } ),
	setResolution: value => set( { resolution: value } ),
	setDownSampledMovement: value => set( { downSampledMovement: value } ),
	setEnableOIDN: value => set( { enableOIDN: value } ),
	setUseGBuffer: value => set( { useGBuffer: value } ),
	setUseAlbedoMap: value => set( { useAlbedoMap: value } ),
	setUseNormalMap: value => set( { useNormalMap: value } ),
	setEnableRealtimeDenoiser: value => set( { enableRealtimeDenoiser: value } ),
	setDenoiserBlurStrength: value => set( { denoiserBlurStrength: value } ),
	setDenoiserBlurRadius: value => set( { denoiserBlurRadius: value } ),
	setDenoiserDetailPreservation: value => set( { denoiserDetailPreservation: value } ),
	setDebugMode: value => set( { debugMode: value } ),
	setDebugThreshold: value => set( { debugThreshold: value } ),
	setEnableBloom: value => set( { enableBloom: value } ),
	setBloomThreshold: value => set( { bloomThreshold: value } ),
	setBloomStrength: value => set( { bloomStrength: value } ),
	setBloomRadius: value => set( { bloomRadius: value } ),
	setEnableTemporalReprojection: value => set( { enableTemporalReprojection: value } ),
	setOidnQuality: value => set( { oidnQuality: value } ),
} ) );

const handleChange = ( setter, appUpdater, needsReset = true ) => value => {

	setter( value );
	if ( window.pathTracerApp ) {

		appUpdater( value );
		needsReset && window.pathTracerApp.reset();

	}

};

const PathTracerTab = () => {

	const {
		enablePathTracer, setEnablePathTracer,
		enableAccumulation, setEnableAccumulation,
		bounces, setBounces,
		samplesPerPixel, setSamplesPerPixel,
		samplingTechnique, setSamplingTechnique,
		adaptiveSampling, setAdaptiveSampling,
		adaptiveSamplingMin, setAdaptiveSamplingMin,
		adaptiveSamplingMax, setAdaptiveSamplingMax,
		adaptiveSamplingVarianceThreshold, setAdaptiveSamplingVarianceThreshold,
		renderMode, setRenderMode,
		tiles, setTiles,
		tilesHelper, setTilesHelper,
		resolution, setResolution,
		downSampledMovement, setDownSampledMovement,
		enableOIDN, setEnableOIDN,
		useGBuffer, setUseGBuffer,
		useAlbedoMap, setUseAlbedoMap,
		useNormalMap, setUseNormalMap,
		enableRealtimeDenoiser, setEnableRealtimeDenoiser,
		denoiserBlurStrength, setDenoiserBlurStrength,
		denoiserBlurRadius, setDenoiserBlurRadius,
		denoiserDetailPreservation, setDenoiserDetailPreservation,
		debugMode, setDebugMode,
		debugThreshold, setDebugThreshold,
		enableBloom, setEnableBloom,
		bloomThreshold, setBloomThreshold,
		bloomStrength, setBloomStrength,
		bloomRadius, setBloomRadius,
		enableTemporalReprojection, setEnableTemporalReprojection,
		oidnQuality, setOidnQuality,
	} = useStore();

	const handlePathTracerChange = handleChange( setEnablePathTracer, value => {

		window.pathTracerApp.accPass.enabled = value;
		window.pathTracerApp.temporalReprojectionPass.enabled = value;
		window.pathTracerApp.pathTracingPass.enabled = value;
		window.pathTracerApp.renderPass.enabled = ! value;

	} );

	const handleAccumulationChange = handleChange( setEnableAccumulation, value => window.pathTracerApp.accPass.enabled = value );
	const handleBouncesChange = handleChange( setBounces, value => window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = value );
	const handleSamplesPerPixelChange = handleChange( setSamplesPerPixel, value => window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = value );
	const handleSamplingTechniqueChange = handleChange( setSamplingTechnique, value => window.pathTracerApp.pathTracingPass.material.uniforms.samplingTechnique.value = value );
	const handleAdaptiveSamplingChange = handleChange( setAdaptiveSampling, value => window.pathTracerApp.pathTracingPass.material.uniforms.useAdaptiveSampling.value = value );
	const handleAdaptiveSamplingMinChange = handleChange( setAdaptiveSamplingMin, value => window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingMin.value = value[ 0 ] );
	const handleAdaptiveSamplingMaxChange = handleChange( setAdaptiveSamplingMax, value => window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingMax.value = value[ 0 ] );
	const handleAdaptiveSamplingVarianceThresholdChange = handleChange( setAdaptiveSamplingVarianceThreshold, value => window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingVarianceThreshold.value = value[ 0 ] );
	const handleRenderModeChange = handleChange( setRenderMode, value => window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( value ) );
	const handleTileUpdate = handleChange( setTiles, value => window.pathTracerApp.pathTracingPass.tiles = value[ 0 ], false );
	const handleTileHelperToggle = handleChange( setTilesHelper, value => parseInt( renderMode ) === 1 && ( window.pathTracerApp.tileHighlightPass.enabled = value, false ) );


	const handleResolutionChange = handleChange( setResolution, value => {

		let result;
		switch ( value ) {

			case '1': result = 0.5; break;
			case '2': result = 1; break;
			default: result = 0.25;

		}

		window.pathTracerApp.updateResolution( window.devicePixelRatio * result );

	} );
	const handleDownSampledMovementChange = handleChange( setDownSampledMovement, value => window.pathTracerApp.pathTracingPass.useDownSampledInteractions = value, false );
	const handleEnableOIDNChange = handleChange( setEnableOIDN, value => window.pathTracerApp.denoiser.enabled = value, false );
	const handleUseGBufferChange = handleChange( setUseGBuffer, value => window.pathTracerApp.denoiser.useGBuffer = value, false );
	const handleUseAlbedoMapChange = handleChange( setUseAlbedoMap, value => window.pathTracerApp.denoiser.useAlbedoMap = value, false );
	const handleUseNormalMapChange = handleChange( setUseNormalMap, value => window.pathTracerApp.denoiser.useNormalMap = value, false );
	const handleEnableRealtimeDenoiserChange = handleChange( setEnableRealtimeDenoiser, value => window.pathTracerApp.denoiserPass.enabled = value, false );
	const handleDenoiserBlurStrengthChange = handleChange( setDenoiserBlurStrength, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.sigma.value = value[ 0 ], false );
	const handleDenoiserBlurRadiusChange = handleChange( setDenoiserBlurRadius, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.kSigma.value = value[ 0 ], false );
	const handleDenoiserDetailPreservationChange = handleChange( setDenoiserDetailPreservation, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.threshold.value = value[ 0 ], false );

	const handleDebugModeChange = handleChange( setDebugMode, value => {

		let mode;
		switch ( value ) {

			case '1': mode = 1; break;
			case '2': mode = 2; break;
			case '3': mode = 3; break;
			case '4': mode = 4; break;
			case '5': mode = 5; break;
			default: mode = 0;

		}

		window.pathTracerApp.pathTracingPass.material.uniforms.visMode.value = mode;

	} );
	const handleDebugThresholdChange = handleChange( setDebugThreshold, value => window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = value[ 0 ] );
	const handleEnableBloomChange = handleChange( setEnableBloom, value => window.pathTracerApp.bloomPass.enabled = value );
	const handleBloomThresholdChange = handleChange( setBloomThreshold, value => window.pathTracerApp.bloomPass.threshold = value[ 0 ] );
	const handleBloomStrengthChange = handleChange( setBloomStrength, value => window.pathTracerApp.bloomPass.strength = value[ 0 ] );
	const handleBloomRadiusChange = handleChange( setBloomRadius, value => window.pathTracerApp.bloomPass.radius = value[ 0 ] );
	const handleTemporalReprojectionChange = handleChange( setEnableTemporalReprojection, value => window.pathTracerApp.temporalReprojectionPass.enabled = value, false );
	const handleOidnQualityChange = handleChange( setOidnQuality, value => window.pathTracerApp.denoiser.denoiser.quality = value, false );

	return (
		<div className="">
			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<div className="flex items-center justify-between">
					<Switch label={"Enable"} checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
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
					<span className="opacity-50 text-xs truncate">Resolution</span>
					<ToggleGroup className="bg-secondary" type="single" value={resolution.toString()} onValueChange={handleResolutionChange}>
						<ToggleGroupItem
							className="h-full rounded-full data-[state=on]:bg-primary data-[state=on]:text-foreground"
							value="0"
							aria-label="Quarter Resolution"
						>
                        1:4
						</ToggleGroupItem>
						<ToggleGroupItem
							className="h-full rounded-full data-[state=on]:bg-primary data-[state=on]:text-foreground"
							value="1"
							aria-label="Half Resolution"
						>
                        1:2
						</ToggleGroupItem>
						<ToggleGroupItem
							className="h-full rounded-full data-[state=on]:bg-primary data-[state=on]:text-foreground"
							value="2"
							aria-label="Full Resolution"
						>
                        1:1
						</ToggleGroupItem>
					</ToggleGroup>
				</div>
			</ControlGroup>
			<ControlGroup name="Denoising">
				<div className="flex items-center justify-between">
					<Switch label={"Enable AI Denoising"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange} disabled={isMobileDevice}/>
				</div>
				{enableOIDN && ( <>
					<div className="flex items-center justify-between">
						<Select value={oidnQuality} onValueChange={handleOidnQualityChange}>
							<span className="opacity-50 text-xs truncate">OIDN Quality</span>
							<SelectTrigger className="max-w-20 h-5 rounded-full" >
								<SelectValue placeholder="Select quality" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="fast">Fast</SelectItem>
								<SelectItem value="balance">Balance</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Use GBuffer"} checked={useGBuffer} onCheckedChange={handleUseGBufferChange} />
					</div>
					{useGBuffer && ( <>
						<div className="flex items-center justify-between">
							<Switch label={"Use Albedo Map"} checked={useAlbedoMap} onCheckedChange={handleUseAlbedoMapChange} />
						</div>
						<div className="flex items-center justify-between">
							<Switch label={"Use Normal Map"} checked={useNormalMap} onCheckedChange={handleUseNormalMapChange} />
						</div>
					</> )}
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
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue placeholder="Select sampler" />
						</SelectTrigger>
						<SelectContent>
							{[ 'PCG', 'Halton', 'Sobol', 'STBN', 'Stratified', 'BlueNoise', 'Stratified Blue Noise' ].map( ( sampler, i ) => (
								<SelectItem key={sampler} value={i.toString()}>{sampler}</SelectItem>
							) )}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center justify-between">
					<Switch label={"Downsampled Movement"} checked={downSampledMovement} onCheckedChange={handleDownSampledMovementChange} />
				</div>
				<div className="flex items-center justify-between">
					<Switch label={"Adaptive Sampling"} checked={adaptiveSampling} onCheckedChange={handleAdaptiveSamplingChange} />
				</div>
				{adaptiveSampling && ( <>
					<div className="flex items-center justify-between">
						<Slider label={"Min Samples"} min={0} max={4} step={1} value={[ adaptiveSamplingMin ]} onValueChange={handleAdaptiveSamplingMinChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Max Samples"} min={4} max={8} step={1} value={[ adaptiveSamplingMax ]} onValueChange={handleAdaptiveSamplingMaxChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Variance Threshold"} min={1} max={10} step={0.1} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
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
				<Separator />
				<div className="flex items-center justify-between">
					<Switch label={"Temporal Reprojection"} checked={enableTemporalReprojection} onCheckedChange={handleTemporalReprojectionChange} />
				</div>
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
