import React from 'react';
import { Slider } from "@/components/ui/slider";
import { useStore } from '@/store';
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Separator } from '@/components/ui/separator';


const ColorCorrectionsTab = () => {

	const imageProcessing = useStore( state => state.imageProcessing );
	const setImageProcessingParam = useStore( state => state.setImageProcessingParam );
	const resetImageProcessing = useStore( state => state.resetImageProcessing );

	const handleParamChange = ( param ) => ( value ) => {

		setImageProcessingParam( param, value[ 0 ] );

	};

	return (
		<div className="space-y-6 p-4">

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Button variant="outline" className={cn( "relative flex h-5 w-full rounded-full touch-none select-none items-center" )} onClick={resetImageProcessing}>
						<span className="text-xm truncate">{"Reset"}</span>
						<RotateCcw size={14} className="shrink-0 pl-1" />
					</Button>
				</div>
				<Separator className="my-2" />
				<div className="flex items-center justify-between">
					<Slider label={"Brightness"} min={- 100} max={100} step={1} value={[ imageProcessing.brightness ]} onValueChange={handleParamChange( 'brightness' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Contrast"} min={- 100} max={100} step={1} value={[ imageProcessing.contrast ]} onValueChange={handleParamChange( 'contrast' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Saturation"} min={- 100} max={100} step={1} value={[ imageProcessing.saturation ]} onValueChange={handleParamChange( 'saturation' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Hue"} min={- 180} max={180} step={1} value={[ imageProcessing.hue ]} onValueChange={handleParamChange( 'hue' )} />
				</div>
				<div className="flex items-center justify-between">
					<Slider label={"Exposure"} min={- 100} max={100} step={1} value={[ imageProcessing.exposure ]} onValueChange={handleParamChange( 'exposure' )} />
				</div>
			</div>
		</div>
	);

};

export default ColorCorrectionsTab;
