import { Waypoints, Grip, Bug } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { create } from 'zustand';
import { DEFAULT_STATE } from '../../core/Processor/Constants';
import { ControlGroup } from '@/components/ui/control-group';

const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/.test( navigator.userAgent );
const useStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	setEnablePathTracer: ( value ) => set( { enablePathTracer: value } ),
	setEnableAccumulation: ( value ) => set( { enableAccumulation: value } ),
	setBounces: ( value ) => set( { bounces: value } ),
	setSamplesPerPixel: ( value ) => set( { samplesPerPixel: value } ),
	setSamplingTechnique: ( value ) => set( { samplingTechnique: value } ),
	setAdaptiveSampling: ( value ) => set( { adaptiveSampling: value } ),
	setAdaptiveSamplingMin: ( value ) => set( { adaptiveSamplingMin: value } ),
	setAdaptiveSamplingMax: ( value ) => set( { adaptiveSamplingMax: value } ),
	setAdaptiveSamplingVarianceThreshold: ( value ) => set( { adaptiveSamplingVarianceThreshold: value } ),
	setRenderMode: ( value ) => set( { renderMode: value } ),
	setCheckeredSize: ( value ) => set( { checkeredSize: value } ),
	setTiles: ( value ) => set( { tiles: value } ),
	setTilesHelper: ( value ) => set( { tilesHelper: value } ),
	setResolution: ( value ) => set( { resolution: value } ),
	setDownSampledMovement: ( value ) => set( { downSampledMovement: value } ),
	setEnableOIDN: ( value ) => set( { enableOIDN: value } ),
	setUseGBuffer: ( value ) => set( { useGBuffer: value } ),
	setUseAlbedoMap: ( value ) => set( { useAlbedoMap: value } ),
	setUseNormalMap: ( value ) => set( { useNormalMap: value } ),
	setEnableRealtimeDenoiser: ( value ) => set( { enableRealtimeDenoiser: value } ),
	setDenoiserBlurStrength: ( value ) => set( { denoiserBlurStrength: value } ),
	setDenoiserBlurRadius: ( value ) => set( { denoiserBlurRadius: value } ),
	setDenoiserDetailPreservation: ( value ) => set( { denoiserDetailPreservation: value } ),
	setDebugMode: ( value ) => set( { debugMode: value } ),
	setDebugThreshold: ( value ) => set( { debugThreshold: value } ),
	bloomStrength: 0.2,
	bloomRadius: 0.15,
	bloomThreshold: 0.85,
	setBloomThreshold: ( value ) => set( { bloomThreshold: value } ),
	setBloomStrength: ( value ) => set( { bloomStrength: value } ),
	setBloomRadius: ( value ) => set( { bloomRadius: value } ),
	setOidnQuality: ( value ) => set( { oidnQuality: value } ),
} ) );

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
		checkeredSize, setCheckeredSize,
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
		bloomThreshold, setBloomThreshold,
		bloomStrength, setBloomStrength,
		bloomRadius, setBloomRadius,
		oidnQuality, setOidnQuality,
	} = useStore();

	const handlePathTracerChange = ( value ) => {

		setEnablePathTracer( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.accPass.enabled = value;
			window.pathTracerApp.temporalReprojectionPass.enabled = value;
			window.pathTracerApp.pathTracingPass.enabled = value;
			window.pathTracerApp.renderPass.enabled = ! value;
			window.pathTracerApp.reset();

		}

	};

	const handleAccumulationChange = ( value ) => {

		setEnableAccumulation( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.accPass.enabled = value;
			window.pathTracerApp.reset();

		}

	};

	const handleBouncesChange = ( value ) => {

		setBounces( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleSamplesPerPixelChange = ( value ) => {

		setSamplesPerPixel( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleSamplingTechniqueChange = ( value ) => {

		setSamplingTechnique( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.samplingTechnique.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleAdaptiveSamplingChange = ( value ) => {

		setAdaptiveSampling( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.useAdaptiveSampling.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleAdaptiveSamplingMinChange = ( value ) => {

		setAdaptiveSamplingMin( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingMin.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleAdaptiveSamplingMaxChange = ( value ) => {

		setAdaptiveSamplingMax( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingMax.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleAdaptiveSamplingVarianceThresholdChange = ( value ) => {

		setAdaptiveSamplingVarianceThreshold( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.adaptiveSamplingVarianceThreshold.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleRenderModeChange = ( value ) => {

		setRenderMode( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( value );
			window.pathTracerApp.reset();

		}

	};

	const handleCheckeredRenderingSize = ( value ) => {

		setCheckeredSize( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.checkeredFrameInterval.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleTileUpdate = ( value ) => {

		setTiles( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.tiles = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleTileHelperToggle = ( value ) => {

		setTilesHelper( value );
		if ( window.pathTracerApp && parseInt( renderMode ) === 2 ) {

			window.pathTracerApp.tileHighlightPass.enabled = value;

		}

	};

	const handleResolutionChange = ( value ) => {

		setResolution( value );
		let result = 0.25;
		if ( window.pathTracerApp ) {

			switch ( value ) {

				case '0': result = 0.25; break;
				case '1': result = 0.5; break;
				case '2': result = 1; break;

			}

			window.pathTracerApp.updateResolution( window.devicePixelRatio * result );

		}

	};

	const handleDownSampledMovementChange = ( value ) => {

		setDownSampledMovement( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.useDownSampledInteractions = value;
			window.pathTracerApp.reset();

		}

	};

	const handleEnableOIDNChange = ( value ) => {

		setEnableOIDN( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiser.enabled = value;

		}

	};

	const handleUseGBufferChange = ( value ) => {

		setUseGBuffer( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.useGBuffer = value;

		}

	};

	const handleUseAlbedoMapChange = ( value ) => {

		setUseAlbedoMap( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.useAlbedoMap = value;

		}

	};

	const handleUseNormalMapChange = ( value ) => {

		setUseNormalMap( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.useNormalMap = value;

		}

	};

	const handleEnableRealtimeDenoiserChange = ( value ) => {

		setEnableRealtimeDenoiser( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.enabled = value;

		}

	};

	const handleDenoiserBlurStrengthChange = ( value ) => {

		setDenoiserBlurStrength( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.sigma.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleDenoiserBlurRadiusChange = ( value ) => {

		setDenoiserBlurRadius( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.kSigma.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleDenoiserDetailPreservationChange = ( value ) => {

		setDenoiserDetailPreservation( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiserPass.denoiseQuad.material.uniforms.threshold.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleDebugModeChange = ( value ) => {

		setDebugMode( value );
		if ( window.pathTracerApp ) {

			let mode = 0;
			switch ( value ) {

				case '0': mode = 0; break; //beauty
				case '1': mode = 1; break; //triangle
				case '2': mode = 2; break; //box
				case '3': mode = 3; break; //distance
				case '4': mode = 4; break; //normal
				case '5': mode = 5; break; //sampling

			}

			window.pathTracerApp.pathTracingPass.material.uniforms.visMode.value = mode;
			window.pathTracerApp.reset();

		}

	};

	const handleDebugThresholdChange = ( value ) => {

		setDebugThreshold( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.debugVisScale.value = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleBloomThresholdChange = ( value ) => {

		setBloomThreshold( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.bloomPass.threshold = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleBloomStrengthChange = ( value ) => {

		setBloomStrength( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.bloomPass.strength = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleBloomRadiusChange = ( value ) => {

		setBloomRadius( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.bloomPass.radius = value[ 0 ];
			window.pathTracerApp.reset();

		}

	};

	const handleOidnQualityChange = ( value ) => {

		setOidnQuality( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.denoiser.quality = value;

		}

	};

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
							<SelectItem value="1">Checkered</SelectItem>
							<SelectItem value="2">Tiled</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{renderMode === '1' && (
					<div className="flex items-center justify-between">
						<Slider label={"Checkered Size"} min={1} max={10} step={1} value={[ checkeredSize ]} onValueChange={handleCheckeredRenderingSize} />
					</div>
				)}
				{renderMode === '2' && (
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
						<Slider label={"Variance Threshold"} min={0.0001} max={0.01} step={0.001} value={[ adaptiveSamplingVarianceThreshold ]} onValueChange={handleAdaptiveSamplingVarianceThresholdChange} />
					</div>
				</> )}
			</ControlGroup>
			<ControlGroup name="Bloom">
				<div className="flex items-center justify-between">
					<Slider label={"Bloom Strength"} min={0} max={3} step={0.1} value={[ bloomStrength ]} onValueChange={handleBloomStrengthChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Bloom Radius"} min={0} max={1} step={0.01} value={[ bloomRadius ]} onValueChange={handleBloomRadiusChange} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Bloom Threshold"} min={0} max={1} step={0.01} value={[ bloomThreshold ]} onValueChange={handleBloomThresholdChange} />
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
