import { Grip } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore as useStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Separator } from '@/components/ui/separator';


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

const FinalRenderPanel = () => {

	const {
		bounces, setBounces,
		samplesPerPixel, setSamplesPerPixel,
		renderMode, setRenderMode,
		tiles, setTiles,
		tilesHelper, setTilesHelper,
		resolution, setResolution,
		enableOIDN, setEnableOIDN,
		useGBuffer, setUseGBuffer,
		oidnQuality, setOidnQuality,
		oidnHdr, setOidnHdr,
	} = useStore();

	// Path Tracer
	const handleBouncesChange = handleChange( setBounces, value => window.pathTracerApp.pathTracingPass.material.uniforms.maxBounceCount.value = value );
	const handleSamplesPerPixelChange = handleChange( setSamplesPerPixel, value => window.pathTracerApp.pathTracingPass.material.uniforms.numRaysPerPixel.value = value );
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

	// Render Mode
	const handleRenderModeChange = handleChange( setRenderMode, value => window.pathTracerApp.pathTracingPass.material.uniforms.renderMode.value = parseInt( value ) );
	const handleTileUpdate = handleChange( setTiles, value => window.pathTracerApp.pathTracingPass.setTileCount( value[ 0 ] ), false );
	const handleTileHelperToggle = handleChange( setTilesHelper, value => parseInt( renderMode ) === 1 && ( window.pathTracerApp.tileHighlightPass.enabled = value, false ) );

	// OIDN
	const handleEnableOIDNChange = handleChange( setEnableOIDN, value => window.pathTracerApp.denoiser.enabled = value, false );
	const handleOidnQualityChange = handleChange( setOidnQuality, value => window.pathTracerApp.denoiser.updateQuality( value ), false );
	const handleOidnHdrChange = handleChange( setOidnHdr, value => window.pathTracerApp.denoiser.toggleHDR( value ), false );
	const handleUseGBufferChange = handleChange( setUseGBuffer, value => window.pathTracerApp.denoiser.toggleUseGBuffer( value ), false );

	return (
		<div className="">
			<ControlGroup name="Path Tracer" defaultOpen={true}>
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
			<Separator className="bg-primary/20 mt-3.5 mb-3.5" />
			<div className="flex items-center justify-between py-2 px-2">
				<Switch label={"Enable AI Denoising"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange}/>
			</div>
			{enableOIDN && ( <>
				<div className="flex items-center justify-between py-2 px-2">
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
				<div className="flex items-center justify-between py-2 px-2">
					<Switch label={"HDR"} disabled checked={oidnHdr} onCheckedChange={handleOidnHdrChange} />
				</div>
				<div className="flex items-center justify-between py-2 px-2">
					<Switch label={"Use GBuffer"} checked={useGBuffer} onCheckedChange={handleUseGBufferChange} />
				</div>
			</> )}
			<Separator className="bg-primary/20 mt-3.5 mb-3.5" />
		</div>
	);

};

export default FinalRenderPanel;
