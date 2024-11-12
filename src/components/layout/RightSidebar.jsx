import { useState } from 'react';
import { Sliders, Camera, Box, Sun, Bug, Ruler, Telescope, Aperture, Waypoints, Grip, Sunrise, Rainbow } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Slider } from "@/components/ui/slider";
import { SliderToggle } from "@/components/ui/slider-toggle";
import { Switch } from "@/components/ui/switch";
import { Vector3Component } from "@/components/ui/vector3";
import { ColorInput } from "@/components/ui/colorinput";
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HDR_FILES, MODEL_FILES, DEFAULT_STATE, DEBUG_MODELS } from '../../engine/Processor/Constants';

const RightSidebar = () => {

	const { toast } = useToast();

	const [ exposure, setExposure ] = useState( DEFAULT_STATE.exposure );
	const [ enableEnvironment, setEnableEnvironment ] = useState( DEFAULT_STATE.enableEnvironment );
	const [ showBackground, setShowBackground ] = useState( DEFAULT_STATE.showBackground );
	const [ model, setModel ] = useState( DEFAULT_STATE.model );
	const [ environment, setEnvironment ] = useState( DEFAULT_STATE.environment );
	const [ environmentIntensity, setEnvironmentIntensity ] = useState( DEFAULT_STATE.environmentIntensity );
	const [ fov, setFov ] = useState( DEFAULT_STATE.fov );
	const [ focusDistance, setFocusDistance ] = useState( DEFAULT_STATE.focusDistance );
	const [ aperture, setAperture ] = useState( DEFAULT_STATE.aperture );
	const [ focalLength, setFocalLength ] = useState( DEFAULT_STATE.focalLength );
	const [ enablePathTracer, setEnablePathTracer ] = useState( DEFAULT_STATE.enablePathTracer );
	const [ enableAccumulation, setEnableAccumulation ] = useState( DEFAULT_STATE.enableAccumulation );
	const [ bounces, setBounces ] = useState( DEFAULT_STATE.bounces );
	const [ samplesPerPixel, setSamplesPerPixel ] = useState( DEFAULT_STATE.samplesPerPixel );
	const [ samplingTechnique, setSamplingTechnique ] = useState( DEFAULT_STATE.samplingTechnique );
	const [ adaptiveSampling, setAdaptiveSampling ] = useState( DEFAULT_STATE.adaptiveSampling );
	const [ adaptiveSamplingMin, setAdaptiveSamplingMin ] = useState( DEFAULT_STATE.adaptiveSamplingMin );
	const [ adaptiveSamplingMax, setAdaptiveSamplingMax ] = useState( DEFAULT_STATE.adaptiveSamplingMax );
	const [ adaptiveSamplingVarianceThreshold, setAdaptiveSamplingVarianceThreshold ] = useState( DEFAULT_STATE.adaptiveSamplingVarianceThreshold );
	const [ renderMode, setRenderMode ] = useState( DEFAULT_STATE.renderMode );
	const [ checkeredSize, setCheckeredSize ] = useState( DEFAULT_STATE.checkeredSize );
	const [ tiles, setTiles ] = useState( DEFAULT_STATE.tiles );
	const [ tilesHelper, setTilesHelper ] = useState( DEFAULT_STATE.tilesHelper );
	const [ resolution, setResolution ] = useState( DEFAULT_STATE.resolution );
	const [ downSampledMovement, setDownSampledMovement ] = useState( DEFAULT_STATE.downSampledMovement );
	const [ directionalLightIntensity, setDirectionalLightIntensity ] = useState( DEFAULT_STATE.directionalLightIntensity );
	const [ directionalLightColor, setDirectionalLightColor ] = useState( DEFAULT_STATE.directionalLightColor );
	const [ directionalLightPosition, setDirectionalLightPosition ] = useState( DEFAULT_STATE.directionalLightPosition );
	const [ enableOIDN, setEnableOIDN ] = useState( DEFAULT_STATE.enableOIDN );
	const [ useGBuffer, setUseGBuffer ] = useState( DEFAULT_STATE.useGBuffer );
	const [ useAlbedoMap, setUseAlbedoMap ] = useState( DEFAULT_STATE.useAlbedoMap );
	const [ useNormalMap, setUseNormalMap ] = useState( DEFAULT_STATE.useNormalMap );
	const [ enableRealtimeDenoiser, setEnableRealtimeDenoiser ] = useState( DEFAULT_STATE.enableRealtimeDenoiser );
	const [ denoiserBlurStrength, setDenoiserBlurStrength ] = useState( DEFAULT_STATE.denoiserBlurStrength );
	const [ denoiserBlurRadius, setDenoiserBlurRadius ] = useState( DEFAULT_STATE.denoiserBlurRadius );
	const [ denoiserDetailPreservation, setDenoiserDetailPreservation ] = useState( DEFAULT_STATE.denoiserDetailPreservation );
	const [ debugMode, setDebugMode ] = useState( DEFAULT_STATE.debugMode );
	const [ debugThreshold, setDebugThreshold ] = useState( DEFAULT_STATE.debugThreshold );
	const [ debugModel, setDebugModel ] = useState( DEFAULT_STATE.debugModel );


	const handleExposureChange = ( value ) => {

		setExposure( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.renderer.toneMappingExposure = value;
			window.pathTracerApp.reset();

		}

	};

	const handleEnableEnvironmentChange = ( value ) => {

		setEnableEnvironment( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.enableEnvironmentLight.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleShowBackgroundChange = ( value ) => {

		setShowBackground( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.scene.background = value ? window.pathTracerApp.scene.environment : null;
			window.pathTracerApp.pathTracingPass.material.uniforms.showBackground.value = value ? true : false;

			window.pathTracerApp.reset();

		}

	};

	const handleEnvironmentChange = ( value ) => {

		setEnvironment( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadEnvironment( value )
				.then( () => {

					toast( {
						title: "Environment Loaded Successfully",
						description: `${HDR_FILES[ value ].name}`,
					} );

				} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Environment",
						description: `${HDR_FILES[ value ].name}: ${error.message}`,
						variant: "destructive",
					} );

				} );

		}

	};

	const handleModelChange = ( value ) => {

		setModel( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadExampleModels( value )
				.then( () => {

					toast( {
						title: "Model Loaded Successfully",
						description: `${MODEL_FILES[ value ].name}`,
					} );

				} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Model",
						description: `${MODEL_FILES[ value ].name}: ${error.message}`,
						variant: "destructive",
					} );

				} );

		}

	};

	const handleEnvironmentIntensityChange = ( value ) => {

		setEnvironmentIntensity( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.scene.environmentIntensity = value;
			window.pathTracerApp.pathTracingPass.material.uniforms.environmentIntensity.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleFovChange = ( value ) => {

		setFov( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.camera.fov = value;
			window.pathTracerApp.camera.updateProjectionMatrix();
			window.pathTracerApp.reset();

		}

	};

	const handleFocusDistanceChange = ( value ) => {

		setFocusDistance( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleApertureChange = ( value ) => {

		setAperture( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = value;
			window.pathTracerApp.reset();

		}

	};

	const handleFocalLengthChange = ( value ) => {

		setFocalLength( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.focalLength.value = value;
			window.pathTracerApp.reset();

		}

	};

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

	const handleDirectionalLightIntensityChange = ( value ) => {

		setDirectionalLightIntensity( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.intensity = value[ 0 ];
			window.pathTracerApp.pathTracingPass.updateLights();
			window.pathTracerApp.reset();

		}

	};

	const handleDirectionalLightColorChange = ( value ) => {

		setDirectionalLightColor( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.color.set( value );
			window.pathTracerApp.pathTracingPass.updateLights();
			window.pathTracerApp.reset();

		}

	};

	const handleDirectionalLightPositionChange = ( value ) => {

		setDirectionalLightPosition( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.directionalLight.position.set( ...value );
			window.pathTracerApp.pathTracingPass.updateLights();
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

	const handleDebugModelChange = ( value ) => {

		setDebugModel( value );
		if ( window.pathTracerApp ) {

			window.pathTracerApp.loadModel( DEBUG_MODELS[ value ].url ).then( () => {

				toast( {
					title: "Model Loaded Successfully",
					description: `${MODEL_FILES[ value ].name}`,
				} );

			} )
				.catch( ( error ) => {

					toast( {
						title: "Error Loading Model",
						description: `${error.message}`,
						variant: "destructive",
					} );

				} );

		}

	};

	return (
		<div className="relative border-l flex flex-col overflow-hidden h-full w-full">
			<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
				<TabsList className="relative grid w-full grid-cols-5 h-12 p-0">
					<TabsTrigger value="pathtracer" className="flex flex-col items-center py-2">
						<Sliders size={12} />
						<span className="text-xs mt-1">Tracer</span>
					</TabsTrigger>
					<TabsTrigger value="scene" className="flex flex-col items-center py-2">
						<Box size={12} />
						<span className="text-xs mt-1">Scene</span>
					</TabsTrigger>
					<TabsTrigger value="camera" className="flex flex-col items-center py-2">
						<Camera size={12} />
						<span className="text-xs mt-1">Camera</span>
					</TabsTrigger>
					<TabsTrigger value="light" className="flex flex-col items-center py-2">
						<Sun size={12} />
						<span className="text-xs mt-1">Light</span>
					</TabsTrigger>
					<TabsTrigger value="assets" className="flex flex-col items-center py-2">
						<Box size={12} />
						<span className="text-xs mt-1">Assets</span>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="scene"
					className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col"
				>
					<div className="space-y-4 p-4">
						<div className="flex items-center justify-between">
							<Slider label={"Exposure"} min={0} max={2} step={0.01} value={[ exposure ]} onValueChange={handleExposureChange} />
						</div>
						<div className="flex items-center justify-between">
							<Switch label={"Show Background"} checked={showBackground} onCheckedChange={handleShowBackgroundChange} />
						</div>
						<div className="flex items-center justify-between">
							<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
						</div>
					</div>
				</TabsContent>

				<TabsContent value="camera"
					className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col"
				>
					<div className="space-y-4 p-4">
						<div className="flex items-center justify-between">
							<Slider label={"FOV"} min={30} max={90} step={5} value={[ fov ]} onValueChange={handleFovChange} />
						</div>
						<div className="flex items-center justify-between">
							<Slider label={"Focal Distance (m)"} icon={Telescope} min={0} max={3} step={0.1} value={[ focusDistance ]} onValueChange={handleFocusDistanceChange} />
						</div>
						<div className="flex items-center justify-between">
							<Select value={aperture.toString()} onValueChange={handleApertureChange}>
								<span className="opacity-50 text-xs truncate">Aperture (f)</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full" >
									<div className="h-full pr-1 inline-flex justify-start items-center">
										<Aperture size={12} className="z-10" />
									</div>
									<SelectValue placeholder="Select aperture" />
								</SelectTrigger>
								<SelectContent>
									{[ 1.4, 2.8, 4, 5.6, 8, 11, 16 ].map( f => (
										<SelectItem key={f} value={f.toString()}>{f}</SelectItem>
									) )}
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center justify-between">
							<Slider label={"Focal Length (mm)"} icon={Ruler} min={0} max={0.1} step={0.001} value={[ focalLength ]} onValueChange={handleFocalLengthChange} />
						</div>
					</div>
				</TabsContent>

				<TabsContent value="pathtracer"
					className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col"
				>
					<div className="space-y-4 p-4">
						<div className="flex items-center justify-between">
							<Switch label={"Enable"} checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
						</div>
						<div className="flex items-center justify-between">
							<Slider label={"Bounces"} icon={Waypoints} min={0} max={20} step={1} value={[ bounces ]} onValueChange={handleBouncesChange} />
						</div>
						<div className="flex items-center justify-between">
							<Slider label={"Rays Per Pixel"} icon={Grip} min={1} max={20} step={1} value={[ samplesPerPixel ]} onValueChange={handleSamplesPerPixelChange} />
						</div>
						<div className="flex items-center justify-between">
							<Select value={renderMode.toString()} onValueChange={handleRenderModeChange}>
								<span className="opacity-50 text-xs truncate">Render Mode</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full" >
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
						<div className="flex items-center justify-between">
							<Switch label={"Enable AI Denoising"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange} />
						</div>
						{enableOIDN && ( <>
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
						<div className="flex items-center justify-between">
							<Switch label={"Downsampled Movement"} checked={downSampledMovement} onCheckedChange={handleDownSampledMovementChange} />
						</div>
						<div className="flex items-center justify-between">
							<Select value={samplingTechnique.toString()} onValueChange={handleSamplingTechniqueChange}>
								<span className="opacity-50 text-xs truncate">Sampler</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full" >
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
						{enablePathTracer && (
							<Accordion type="single" collapsible>
								<AccordionItem value="debug">
									<AccordionTrigger className="text-sm">
										<div className="flex items-center">
											<Bug className="h-4 w-4 mr-2" />
											Debugging
										</div>
									</AccordionTrigger>
									<AccordionContent>
										<div className="space-y-4 pt-4">
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
										</div>
									</AccordionContent>
								</AccordionItem>
							</Accordion>
						)}
					</div>
				</TabsContent>

				<TabsContent value="light"
					className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col"
				>
					<div className="space-y-4 p-4">
						<div className="flex items-center justify-between">
							<Slider label={"Intensity"} icon={Sunrise} min={0} max={20} step={0.1} value={[ directionalLightIntensity ]} onValueChange={handleDirectionalLightIntensityChange} />
						</div>
						<div className="flex items-center justify-between">
							<ColorInput label={"Color"} icon={Rainbow} value={directionalLightColor} onChange={color => handleDirectionalLightColorChange( color )} />
						</div>
						<div className="flex items-center justify-between">
							<Vector3Component label="Position" value={directionalLightPosition} onValueChange={handleDirectionalLightPositionChange} />
						</div>
					</div>
				</TabsContent>
				<TabsContent
					value="assets"
					className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col mt-0"
				>
					<div className='absolute h-[calc(100%-48px)] w-full'>
						<Separator className="bg-primary"/>
						<Tabs defaultValue="models" className="flex flex-col h-full w-full">
							<TabsList className="relative grid w-full grid-cols-3 h-auto p-0">
								<TabsTrigger value="models" className="text-xs truncate py-2" >
									Models
								</TabsTrigger>
								<TabsTrigger value="environments" className="text-xs truncate py-2">
									Env
								</TabsTrigger>
								<TabsTrigger value="tests" className="text-xs truncate py-2">
									Tests
								</TabsTrigger>
							</TabsList>
							<TabsContent value="models" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
								<ItemsCatalog data={MODEL_FILES} value={model} onValueChange={handleModelChange}/>
							</TabsContent>
							<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
								<ItemsCatalog data={HDR_FILES} value={environment} onValueChange={handleEnvironmentChange} />
							</TabsContent>
							<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
								<ItemsCatalog data={DEBUG_MODELS} value={debugModel} onValueChange={handleDebugModelChange} />
							</TabsContent>
						</Tabs>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default RightSidebar;
