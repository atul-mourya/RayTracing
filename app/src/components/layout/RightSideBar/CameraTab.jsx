import { Ruler, Telescope, Aperture, Camera, Target, Crosshair, RotateCcw, Ellipsis } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Row } from "@/components/ui/row";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Trackpad } from "@/components/ui/trackpad";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CAMERA_RANGES, CAMERA_PRESETS } from '@/Constants';
import { useCameraStore } from '@/store';
import { useEffect, useCallback } from 'react';
import { getApp } from '@/lib/appProxy';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { useActiveApp } from '@/hooks/useActiveApp';
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
		apertureScale,
		anamorphicRatio,
		cameraNames,
		selectedCameraIndex,

		// Auto-focus state
		autoFocusMode,
		afScreenPoint,
		afPlacingPoint,

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
		handleAnamorphicRatioChange,
		handleFocusChangeEvent,

		// Auto-focus handlers
		handleAutoFocusModeChange,
		handleToggleAFPointPlacement,
		handleAFResetToCenter,
	} = useCameraStore();

	const activeApp = useActiveApp();

	useBackendEvent( 'focusChanged', handleFocusChangeEvent );

	useBackendEvent( 'CamerasUpdated', useCallback( () => {

		const app = getApp();
		if ( app ) {

			setCameraNames( app.cameraManager.getNames() );
			if ( ( app.currentCameraIndex ?? 0 ) === 0 ) {

				setSelectedCameraIndex( 0 );

			}

		}

	}, [ setCameraNames, setSelectedCameraIndex ] ) );

	useEffect( () => {

		const app = getApp();
		if ( app ) {

			setCameraNames( app.cameraManager.getNames() );
			setSelectedCameraIndex( app.currentCameraIndex ?? 0 );

		}

	}, [ activeApp, setCameraNames, setSelectedCameraIndex ] );

	const cameraPoints = [
		{ x: 0, y: 50 }, // left view
		{ x: 50, y: 50 }, // front view
		{ x: 100, y: 50 }, // right view
		{ x: 50, y: 0 }, // top view
		{ x: 50, y: 100 }, // bottom view
		{ x: 25, y: 50 }, // front-left view
		{ x: 75, y: 50 }, // front-right view
		{ x: 25, y: 25 }, // top left view
		{ x: 75, y: 25 }, // top right view
		{ x: 25, y: 75 }, // bottom left view
		{ x: 75, y: 75 }, // bottom right view
	];

	const isAutoFocus = autoFocusMode === 'auto';
	const isAFPointCustom = afScreenPoint.x !== 0.5 || afScreenPoint.y !== 0.5;

	return (
		<>
			<Separator className="bg-primary" />
			<div className="space-y-4 p-4">
				<Row>
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
				</Row>

				<Row>
					<Slider
						label={"FOV"}
						icon={FieldOfView}
						min={CAMERA_RANGES.fov.min}
						max={CAMERA_RANGES.fov.max}
						step={1}
						value={[ fov ]}
						onValueChange={handleFovChange}
					/>
				</Row>

				<Row>
					<Switch
						checked={zoomToCursor}
						label="Zoom to Cursor"
						onCheckedChange={handleZoomToCursorChange}
					/>
				</Row>

				<Separator />

				<Row>
					<Switch
						checked={enableDOF}
						label="Depth of Field"
						onCheckedChange={handleEnableDOFChange}
					/>
				</Row>

				{enableDOF && (
					<>
						<Row>
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
						</Row>

						<Row>
							<span className="opacity-50 text-xs truncate">Focus</span>
							<ToggleGroup
								type="single"
								value={autoFocusMode}
								onValueChange={( val ) => val && handleAutoFocusModeChange( val )}
								className="max-w-36"
							>
								<ToggleGroupItem value="manual" className="text-xs px-3 h-5">
									Manual
								</ToggleGroupItem>
								<ToggleGroupItem value="auto" className="text-xs px-3 h-5">
									Auto
								</ToggleGroupItem>
							</ToggleGroup>
						</Row>

						{/* Manual mode: slider + click-to-focus target */}
						{! isAutoFocus && (
							<Row>
								<Slider
									label={"Focus Distance (m)"}
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
							</Row>
						)}

						{/* Auto mode: read-only slider + AF point controls + smoothing */}
						{isAutoFocus && (
							<>
								<Row>
									<Slider
										label={"Focus Distance (m)"}
										icon={Telescope}
										min={CAMERA_RANGES.focusDistance.min}
										max={CAMERA_RANGES.focusDistance.max}
										step={0.1}
										value={[ focusDistance.toFixed( 1 ) ]}
										disabled={true}
									/>
									<span className="ml-2 text-[10px] opacity-40 whitespace-nowrap">(auto)</span>
								</Row>
								<Row>
									<span className="opacity-50 text-xs truncate">AF Point</span>
									<div className="flex items-center gap-1.5">
										<Button
											variant={afPlacingPoint ? "default" : "outline"}
											size="sm"
											onClick={handleToggleAFPointPlacement}
											className="h-5 rounded-full text-xs px-2"
										>
											<Crosshair size={12} className="mr-1" />
											{afPlacingPoint ? "Click viewport..." : "Set Point"}
										</Button>
										{isAFPointCustom && (
											<Button
												variant="outline"
												size="icon"
												onClick={handleAFResetToCenter}
												className="h-5 w-5 rounded-full"
												title="Reset to center"
											>
												<RotateCcw size={10} />
											</Button>
										)}
									</div>
								</Row>
							</>
						)}

						<Row>
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
						</Row>

						<Row>
							<Slider
								label={"Focal Length (mm)"}
								icon={Ruler}
								min={CAMERA_RANGES.focalLength.min}
								max={CAMERA_RANGES.focalLength.max}
								step={1}
								value={[ focalLength ]}
								onValueChange={handleFocalLengthChange}
							/>
						</Row>

						<Row>
							<Slider
								label={"DOF Intensity"}
								icon={Aperture}
								min={0.1}
								max={2.0}
								step={0.1}
								value={[ apertureScale ?? 1.0 ]}
								onValueChange={( values ) => handleApertureScaleChange( values[ 0 ] )}
							/>
						</Row>

						<Row>
							<Slider
								label={"Bokeh Stretch"}
								icon={Ellipsis}
								min={1.0}
								max={2.0}
								step={0.05}
								value={[ anamorphicRatio ?? 1.0 ]}
								onValueChange={( values ) => handleAnamorphicRatioChange( values[ 0 ] )}
							/>
						</Row>
					</>
				)}

				<Separator />

				{selectedCameraIndex == 0 && (
					<div className="flex items-center">
						<Trackpad
							label={"Camera Position"}
							points={cameraPoints}
							onMove={handleCameraMove}
							className="w-[110px] h-[110px]"
						/>
					</div>
				)}
			</div>
		</>
	);

};

export default CameraTab;
