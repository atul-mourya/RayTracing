import { Play, Pause, Square, Film, Gauge, ListMusic } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from '@/components/ui/separator';
import { useAnimationStore } from '@/store';

const AnimationTab = () => {

	const clips = useAnimationStore( s => s.clips );
	const selectedClip = useAnimationStore( s => s.selectedClip );
	const isPlaying = useAnimationStore( s => s.isPlaying );
	const isPaused = useAnimationStore( s => s.isPaused );
	const speed = useAnimationStore( s => s.speed );
	const loop = useAnimationStore( s => s.loop );
	const handlePlay = useAnimationStore( s => s.handlePlay );
	const handlePause = useAnimationStore( s => s.handlePause );
	const handleStop = useAnimationStore( s => s.handleStop );
	const handleClipChange = useAnimationStore( s => s.handleClipChange );
	const handleSpeedChange = useAnimationStore( s => s.handleSpeedChange );
	const handleLoopChange = useAnimationStore( s => s.handleLoopChange );

	if ( clips.length === 0 ) {

		return (
			<>
				<Separator className="bg-primary" />
				<div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
					<Film size={32} strokeWidth={1.5} />
					<p className="text-sm">No animations available</p>
					<p className="text-xs text-center px-6">Load a GLTF model with animation clips to see controls here.</p>
				</div>
			</>
		);

	}

	const selectedClipData = clips[ selectedClip ] || clips[ 0 ];

	return (
		<>
			<Separator className="bg-primary" />
			<div className="space-y-4 p-4">

				{/* Clip Selector */}
				<div className="flex items-center justify-between">
					<Select
						value={String( selectedClip )}
						onValueChange={( val ) => handleClipChange( Number( val ) )}
					>
						<span className="opacity-50 text-xs truncate">Animation Clip</span>
						<SelectTrigger className="max-w-40 h-5 rounded-full">
							<div className="h-full pr-1 inline-flex justify-start items-center">
								<ListMusic size={12} className="z-10" />
							</div>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{clips.map( ( clip ) => (
								<SelectItem key={clip.index} value={String( clip.index )}>
									{clip.name} ({clip.duration.toFixed( 1 )}s)
								</SelectItem>
							) )}
						</SelectContent>
					</Select>
				</div>

				{/* Transport Controls */}
				<div className="flex items-center gap-2">
					<Button
						variant={isPlaying ? "secondary" : "default"}
						size="sm"
						className="flex-1 h-6 text-xs"
						onClick={isPlaying ? handlePause : handlePlay}
					>
						{isPlaying ? (
							<><Pause size={12} className="mr-1" /> Pause</>
						) : (
							<><Play size={12} className="mr-1" /> {isPaused ? 'Resume' : 'Play'}</>
						)}
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-6"
						onClick={handleStop}
						disabled={! isPlaying && ! isPaused}
						aria-label="Stop animation"
					>
						<Square size={12} />
					</Button>
				</div>

				{/* Duration Info */}
				{selectedClipData && (
					<div className="flex justify-between text-xs">
						<span className="opacity-50">Duration</span>
						<span className="opacity-70">{selectedClipData.duration.toFixed( 2 )}s</span>
					</div>
				)}

				<Separator />

				{/* Speed */}
				<div className="flex items-center justify-between">
					<Slider
						label="Speed"
						icon={Gauge}
						min={0.1}
						max={3.0}
						step={0.1}
						value={[ speed ]}
						onValueChange={( [ val ] ) => handleSpeedChange( val )}
					/>
				</div>

				{/* Loop */}
				<div className="flex items-center justify-between">
					<Switch
						checked={loop}
						label="Loop"
						onCheckedChange={handleLoopChange}
					/>
				</div>

			</div>
		</>
	);

};

export default AnimationTab;
