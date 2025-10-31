
import { useCallback } from 'react';
import { Slider } from "@/components/ui/slider";
import { useStore } from '@/store';
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from '@/components/ui/separator';


const ColorCorrectionsTab = () => {

	const imageProcessing = useStore( useCallback( state => state.imageProcessing, [] ) );
	const handleImageProcessingParamChange = useStore( useCallback( state => state.handleImageProcessingParamChange, [] ) );
	const handleResetImageProcessing = useStore( useCallback( state => state.handleResetImageProcessing || state.resetImageProcessing, [] ) );

	return (
		<div className="">
			<Separator className="bg-primary" />
			<div className="space-y-2 px-2">
				<div className="flex items-center justify-between my-2">
					<Button variant="outline" className={cn( "relative flex h-5 w-full rounded-full touch-none select-none items-center cursor-pointer" )} onClick={handleResetImageProcessing}>
						<span className="text-xm truncate">{"Reset"}</span>
						<RotateCcw size={14} className="shrink-0 pl-1" />
					</Button>
				</div>
				<Separator className="my-2" />
				<div className="flex items-center justify-between">
					<Slider label={"Brightness"} min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.brightness ]} onValueChange={handleImageProcessingParamChange( 'brightness' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Contrast"} min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.contrast ]} onValueChange={handleImageProcessingParamChange( 'contrast' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Saturation"} min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.saturation ]} onValueChange={handleImageProcessingParamChange( 'saturation' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Hue"} min={- 180} max={180} step={1} value={[ imageProcessing.hue ]} onValueChange={handleImageProcessingParamChange( 'hue' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Exposure"} min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.exposure ]} onValueChange={handleImageProcessingParamChange( 'exposure' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Gamma"} min={0.1} max={4} step={0.1} snapPoints={[ 0.1, 1, 2.2, 3, 4 ]} value={[ imageProcessing.gamma ]} onValueChange={handleImageProcessingParamChange( 'gamma' )} />
				</div>
			</div>
		</div>
	);

};

export default ColorCorrectionsTab;
