import { Ruler, Telescope, Aperture, Camera, Target } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Trackpad } from "@/components/ui/trackpad";
import { CAMERA_RANGES, CAMERA_PRESETS } from '@/Constants';
import { useCameraStore } from '@/store';
import { useEffect } from 'react';
import { FieldOfView } from "@/assets/icons";
import { Separator } from "@/components/ui/separator";

const CameraTab = () => {

	const {
		// State
		fov,
		focusDistance,
		aperture,
		focalLength,
		enableDOF,
		zoomToCursor,
		activePreset,
		focusMode,
		cameraNames,
		selectedCameraIndex,

		// Basic setters
		setCameraNames,
		setSelectedCameraIndex,

		// Handlers
		handleToggleFocusMode,
		handleFocusDistanceChange,
		handlePresetChange,
		handleFovChange,
		handleApertureChange,
		handleFocalLengthChange,
		handleEnableDOFChange,
		handleZoomToCursorChange,
		handleCameraMove,
		handleCameraChange,
		handleApertureScaleChange,
		handleFocusChangeEvent,
	} = useCameraStore();

	useEffect( () => {

		if ( window.pathTracerApp ) {

			// Set up camera names and initial selection
			const updateCameraList = () => {

				setCameraNames( window.pathTracerApp.getCameraNames() );
				setSelectedCameraIndex( window.pathTracerApp.currentCameraIndex );

			};

			// Initial setup
			updateCameraList();

			// Initialize click-to-focus functionality
			window.pathTracerApp.setupClickToFocus();

			// Listen for focus change events
			window.pathTracerApp.addEventListener( 'focusChanged', handleFocusChangeEvent );

			// Listen for camera updates from model loading
			const handleCameraUpdate = ( event ) => {

				updateCameraList();

				// Always reset to default camera (index 0) in UI as well
				if ( window.pathTracerApp.currentCameraIndex === 0 ) {

					// Force UI update to show default camera is selected
					setSelectedCameraIndex( 0 );

				}

			};

			window.pathTracerApp.addEventListener( 'CamerasUpdated', handleCameraUpdate );

			// Clean up event listeners on component unmount
			return () => {

				window.pathTracerApp.removeEventListener( 'focusChanged', handleFocusChangeEvent );
				window.pathTracerApp.removeEventListener( 'CamerasUpdated', handleCameraUpdate );

			};

		}

	}, [] );

	const cameraPoints = [
		{ x: 0, y: 50 }, // left view
		{ x: 50, y: 50 }, // front view
		{ x: 100, y: 50 }, // right view
		{ x: 50, y: 0 }, // top view
		{ x: 50, y: 100 }, // bottom view
		{ x: 25, y: 25 }, // top left view
		{ x: 75, y: 25 }, // top right view
		{ x: 25, y: 75 }, // bottom left view
		{ x: 75, y: 75 }, // bottom right view
	];

	return (
		<div className="space-y-4 p-4">
			<Separator className="bg-primary" />
			<div className="flex items-center justify-between">
				<Select value={selectedCameraIndex.toString()} onValueChange={handleCameraChange}>
					<span className="opacity-50 text-xs truncate">Select Camera</span>
					<SelectTrigger className="max-w-32 h-5 rounded-full">
						<div className="h-full pr-1 inline-flex justify-start items-center">
							<Camera size={12} className="z-10" />
						</div>
						<SelectValue placeholder="Select camera" />
					</SelectTrigger>
					<SelectContent>
						{cameraNames.map( ( name, index ) => (
							<SelectItem key={index} value={index.toString()}>{name}</SelectItem>
						) )}
					</SelectContent>
				</Select>
			</div>

			<div className="flex items-center justify-between">
				<Slider
					label={"FOV"}
					icon={FieldOfView}
					min={CAMERA_RANGES.fov.min}
					max={CAMERA_RANGES.fov.max}
					step={5}
					value={[ fov ]}
					onValueChange={handleFovChange}
				/>
			</div>

			<div className="flex items-center justify-between">
				<Switch
					checked={zoomToCursor}
					label="Zoom to Cursor"
					onCheckedChange={handleZoomToCursorChange}
				/>
			</div>

			<Separator />

			<div className="flex items-center justify-between">
				<Switch
					checked={enableDOF}
					label="Depth of Field"
					onCheckedChange={handleEnableDOFChange}
				/>
			</div>

			{enableDOF && (
				<>
					<div className="flex items-center justify-between">
						<Select value={activePreset} onValueChange={handlePresetChange}>
							<span className="opacity-50 text-xs truncate">DOF Preset</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full">
								<div className="h-full pr-1 inline-flex justify-start items-center">
									<Camera size={12} className="z-10" />
								</div>
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="custom">Custom</SelectItem>
								{Object.entries( CAMERA_PRESETS ).map( ( [ key, preset ] ) => (
									<SelectItem key={key} value={key}>
										<div>
											<div className="font-medium">{preset.name}</div>
											<div className="text-xs opacity-50">{preset.description}</div>
										</div>
									</SelectItem>
								) )}
							</SelectContent>
						</Select>
					</div>

					<div className="flex items-center justify-between">
						<Slider
							label={"Focal Distance (m)"}
							icon={Telescope}
							min={CAMERA_RANGES.focusDistance.min}
							max={CAMERA_RANGES.focusDistance.max}
							step={0.1}
							value={[ focusDistance.toFixed( 1 ) ]}
							onValueChange={( values ) => handleFocusDistanceChange( values[ 0 ] )}
						/>
						<Button
							variant={focusMode ? "default" : "outline"}
							size="icon"
							onClick={handleToggleFocusMode}
							className="ml-2 h-5 rounded-full"
							title="Click in scene to set focus point"
						>
							<Target size={12} />
						</Button>
					</div>

					<div className="flex items-center justify-between">
						<Select value={aperture.toString()} onValueChange={handleApertureChange}>
							<span className="opacity-50 text-xs truncate">Aperture (f)</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full">
								<div className="h-full pr-1 inline-flex justify-start items-center">
									<Aperture size={12} className="z-10" />
								</div>
								<SelectValue placeholder="Select aperture" />
							</SelectTrigger>
							<SelectContent>
								{CAMERA_RANGES.aperture.options.map( f => (
									<SelectItem key={f} value={f.toString()}>{f}</SelectItem>
								) )}
							</SelectContent>
						</Select>
					</div>

					<div className="flex items-center justify-between">
						<Slider
							label={"Focal Length (mm)"}
							icon={Ruler}
							min={CAMERA_RANGES.focalLength.min}
							max={CAMERA_RANGES.focalLength.max}
							step={1}
							value={[ focalLength ]}
							onValueChange={handleFocalLengthChange}
						/>
					</div>

					<div className="flex items-center justify-between">
						<Slider
							label={"DOF Intensity"}
							icon={Aperture}
							min={0.1}
							max={2.0}
							step={0.1}
							value={[ 1.0 ]} // Default value
							onValueChange={( values ) => handleApertureScaleChange( values[ 0 ] )}
						/>
					</div>
				</>
			)}

			<Separator />

			{selectedCameraIndex == 0 && (
				<div className="flex items-center justify-between">
					<Trackpad
						label={"Camera Position"}
						points={cameraPoints}
						onMove={handleCameraMove}
						className="w-[110px] h-[110px]"
					/>
				</div>
			)}
		</div>
	);

};

export default CameraTab;
