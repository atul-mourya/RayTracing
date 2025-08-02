import { Grip } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore as useStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Separator } from '@/components/ui/separator';


const FinalRenderPanel = () => {

	const {
		bounces,
		samplesPerPixel,
		renderMode,
		tiles,
		tilesHelper,
		resolution,
		enableOIDN,
		useGBuffer,
		oidnQuality,
		oidnHdr,

		handleBouncesChange,
		handleSamplesPerPixelChange,
		handleRenderModeChange,
		handleTileUpdate,
		handleTileHelperToggle,
		handleResolutionChange,
		handleEnableOIDNChange,
		handleOidnQualityChange,
		handleOidnHdrChange,
		handleUseGBufferChange,
	} = useStore();

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
