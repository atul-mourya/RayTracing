import { Grip, Sun, Sunrise, RefreshCcwDot } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore as useStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Exposure } from '@/assets/icons';


const handleChange = ( setter, appUpdater, needsReset = true ) => value => {

	if ( typeof setter !== 'function' ) {

		console.error( "Invalid setter function passed to handleChange:", setter );
		return;

	}

	setter( value );
	if ( window.pathTracerApp ) {

		appUpdater( value );
		needsReset && window.pathTracerApp.reset();

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
		showAdaptiveSamplingHelper, setShowAdaptiveSamplingHelper,
		fireflyThreshold, setFireflyThreshold,
		renderMode, setRenderMode,
		tiles, setTiles,
		tilesHelper, setTilesHelper,
		resolution, setResolution,
		enableOIDN, setEnableOIDN,
		useGBuffer, setUseGBuffer,
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
		oidnQuality, setOidnQuality,
		oidnHdr, setOidnHdr,
		exposure, setExposure,
		enableEnvironment, setEnableEnvironment,
		showBackground, setShowBackground,
		backgroundIntensity, setBackgroundIntensity,
		environmentIntensity, setEnvironmentIntensity,
		environmentRotation, setEnvironmentRotation,
		GIIntensity, setGIIntensity,
		toneMapping, setToneMapping,
		interactionModeEnabled, setInteractionModeEnabled,
	} = useStore();

	const handlePathTracerChange = handleChange( setEnablePathTracer, value => {

		window.pathTracerApp.accPass.enabled = value;
		window.pathTracerApp.pathTracingPass.enabled = value;
		window.pathTracerApp.renderPass.enabled = ! value;

	} );

	// Path Tracer
	const handleAccumulationChange = handleChange( setEnableAccumulation, value => window.pathTracerApp.accPass.enabled = value );
	const handleBouncesChange = handleChange( setBounces, value => window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = value );
	const handleSamplesPerPixelChange = handleChange( setSamplesPerPixel, value => window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = value );
	const handleSamplingTechniqueChange = handleChange( setSamplingTechnique, value => window.pathTracerApp.pathTracingPass.material.uniforms.samplingTechnique.value = value );
	const handleResolutionChange = handleChange( setResolution, value => {

		let result;
		switch ( value ) {

			case '1': result = window.devicePixelRatio * 0.5; break;
			case '2': result = window.devicePixelRatio * 1; break;
			case '3': result = window.devicePixelRatio * 2; break;
			case '4': result = window.devicePixelRatio * 4; break;
			default: result = window.devicePixelRatio * 0.25;

		}

		window.pathTracerApp.updateResolution( result );

	} );

	// Adaptive Sampling
	const handleAdaptiveSamplingChange = handleChange( setAdaptiveSampling, value => {

		window.pathTracerApp.pathTracingPass.material.uniforms.useAdaptiveSampling.value = value;
		window.pathTracerApp.adaptiveSamplingPass.enabled = value;
		window.pathTracerApp.adaptiveSamplingPass.toggleHelper( false );

	} );
	const handleAdaptiveSamplingMinChange = handleChange( setAdaptiveSamplingMin, value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMin.value = value[ 0 ] );
	const handleAdaptiveSamplingMaxChange = handleChange( setAdaptiveSamplingMax, value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingMax.value = value[ 0 ] );
	const handleAdaptiveSamplingVarianceThresholdChange = handleChange( setAdaptiveSamplingVarianceThreshold, value => window.pathTracerApp.adaptiveSamplingPass.material.uniforms.adaptiveSamplingVarianceThreshold.value = value[ 0 ] );
	const handleAdaptiveSamplingHelperToggle = handleChange( setShowAdaptiveSamplingHelper, value => window.pathTracerApp?.adaptiveSamplingPass?.toggleHelper( value ) );

	const handleFireflyThresholdChange = handleChange( setFireflyThreshold, value => window.pathTracerApp.pathTracingPass.material.uniforms.fireflyThreshold.value = value[ 0 ] );

	// Render Mode
	const handleRenderModeChange = handleChange( setRenderMode, value => window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( value ) );
	const handleTileUpdate = handleChange( setTiles, value => window.pathTracerApp.pathTracingPass.tiles = value[ 0 ], false );
	const handleTileHelperToggle = handleChange( setTilesHelper, value => parseInt( renderMode ) === 1 && ( window.pathTracerApp.tileHighlightPass.enabled = value, false ) );

	// OIDN
	const handleEnableOIDNChange = handleChange( setEnableOIDN, value => window.pathTracerApp.denoiser.enabled = value, false );
	const handleOidnQualityChange = handleChange( setOidnQuality, value => window.pathTracerApp.denoiser.updateQuality( value ), false );
	const handleOidnHdrChange = handleChange( setOidnHdr, value => window.pathTracerApp.denoiser.toggleHDR( value ), false );
	const handleUseGBufferChange = handleChange( setUseGBuffer, value => window.pathTracerApp.denoiser.toggleUseGBuffer( value ), false );

	// Realtime Denoiser
	const handleEnableRealtimeDenoiserChange = handleChange( setEnableRealtimeDenoiser, value => window.pathTracerApp.denoiserPass.enabled = value, false );
	const handleDenoiserBlurStrengthChange = handleChange( setDenoiserBlurStrength, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.sigma.value = value[ 0 ], false );
	const handleDenoiserBlurRadiusChange = handleChange( setDenoiserBlurRadius, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.kSigma.value = value[ 0 ], false );
	const handleDenoiserDetailPreservationChange = handleChange( setDenoiserDetailPreservation, value => window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.threshold.value = value[ 0 ], false );

	// Debugging
	const handleDebugThresholdChange = handleChange( setDebugThreshold, value => window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = value[ 0 ] );
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

	// Post Processing
	const handleEnableBloomChange = handleChange( setEnableBloom, value => window.pathTracerApp.bloomPass.enabled = value );
	const handleBloomThresholdChange = handleChange( setBloomThreshold, value => window.pathTracerApp.bloomPass.threshold = value[ 0 ] );
	const handleBloomStrengthChange = handleChange( setBloomStrength, value => window.pathTracerApp.bloomPass.strength = value[ 0 ] );
	const handleBloomRadiusChange = handleChange( setBloomRadius, value => window.pathTracerApp.bloomPass.radius = value[ 0 ] );

	// Scene Settings
	const handleExposureChange = handleChange( setExposure, value => {

		window.pathTracerApp.renderer.toneMappingExposure = value;
		window.pathTracerApp.pathTracingPass.material.uniforms.exposure.value = value;
		window.pathTracerApp.reset();

	} );

	const handleEnableEnvironmentChange = handleChange( setEnableEnvironment, value => {

		window.pathTracerApp.pathTracingPass.material.uniforms.enableEnvironmentLight.value = value;
		window.pathTracerApp.reset();

	} );

	const handleShowBackgroundChange = handleChange( setShowBackground, value => {

		window.pathTracerApp.scene.background = value ? window.pathTracerApp.scene.environment : null;
		window.pathTracerApp.pathTracingPass.material.uniforms.showBackground.value = value ? true : false;
		window.pathTracerApp.reset();

	} );

	const handleBackgroundIntensityChange = handleChange( setBackgroundIntensity, value => {

		window.pathTracerApp.scene.backgroundIntensity = value;
		window.pathTracerApp.pathTracingPass.material.uniforms.backgroundIntensity.value = value;
		window.pathTracerApp.reset();

	} );

	const handleEnvironmentIntensityChange = handleChange( setEnvironmentIntensity, value => {

		window.pathTracerApp.scene.environmentIntensity = value;
		window.pathTracerApp.pathTracingPass.material.uniforms.environmentIntensity.value = value;
		window.pathTracerApp.reset();

	} );

	const handleEnvironmentRotationChange = handleChange( setEnvironmentRotation, value => {

		window.pathTracerApp.pathTracingPass.material.uniforms.environmentRotation.value = value[ 0 ] * ( Math.PI / 180 );
		window.pathTracerApp.reset();

	} );

	const handleGIIntensityChange = handleChange( setGIIntensity, value => {

		window.pathTracerApp.pathTracingPass.material.uniforms.globalIlluminationIntensity.value = value * Math.PI;
		window.pathTracerApp.reset();

	} );

	const handleToneMappingChange = handleChange( setToneMapping, value => {

		value = parseInt( value );
		window.pathTracerApp.renderer.toneMapping = value;
		window.pathTracerApp.reset();

	} );

	const handleInteractionModeEnabledChange = handleChange( setInteractionModeEnabled, value => {

		window.pathTracerApp.pathTracingPass.setInteractionModeEnabled( value );

	} );

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
					<Slider icon={Exposure} label={"Exposure"} min={0} max={2} step={0.01} value={[ exposure ]} onValueChange={handleExposureChange} />
				</div>
				<div className="flex items-center justify-between">
					<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} onValueChange={handleGIIntensityChange} />
				</div>
				<div className="flex items-center justify-between">
					<SliderToggle label={"Background Intensity"} enabled={showBackground} icon={Sun} min={0} max={2} step={0.01} value={[ backgroundIntensity ]} onValueChange={handleBackgroundIntensityChange} onToggleChange={handleShowBackgroundChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Environment Rotation"} icon={RefreshCcwDot} min={0} max={360} step={1} value={[ environmentRotation ]} onValueChange={handleEnvironmentRotationChange} />
				</div>
			</ControlGroup>
			<ControlGroup name="Denoising">
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
							<SelectItem key='STBN' value={"3"}>STBN</SelectItem>
							<SelectItem key='Stratified' value={"4"}>Stratified</SelectItem>
							<SelectItem key='BlueNoise' value={"5"}>BlueNoise</SelectItem>
							<SelectItem key='Stratified Blue Noise' value={"6"}>Stratified Blue Noise</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center justify-between">
					<Switch label={"Adaptive Sampling"} checked={adaptiveSampling} onCheckedChange={handleAdaptiveSamplingChange} />
				</div>
				{adaptiveSampling && ( <>
					<div className="flex items-center justify-between">
						<Slider label={"Min Samples"} min={0} max={4} step={1} value={[ adaptiveSamplingMin ]} onValueChange={handleAdaptiveSamplingMinChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Max Samples"} min={4} max={16} step={2} value={[ adaptiveSamplingMax ]} onValueChange={handleAdaptiveSamplingMaxChange} />
					</div>
					<div className="flex items-center justify-between">
						<Slider label={"Variance Threshold"} min={0.001} max={1} step={0.001} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
					</div>
					<div className="flex items-center justify-between">
						<Switch label={"Show Heatmap"} checked={showAdaptiveSamplingHelper} onCheckedChange={handleAdaptiveSamplingHelperToggle} />
					</div>
				</> )}
				<div className="flex items-center justify-between">
					<Slider label={"Firefly Threshold"} min={0} max={10} step={0.1} value={[ fireflyThreshold ]} onValueChange={handleFireflyThresholdChange} />
				</div>
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
