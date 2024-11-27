import { Ruler, Telescope, Aperture, Camera } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trackpad } from "@/components/ui/trackpad";
import { remap } from "@/lib/utils";
import { DEFAULT_STATE } from '../../core/Processor/Constants';
import { create } from 'zustand';
import { useState, useEffect } from 'react';

const CAMERA_RANGES = {
	fov: {
		min: 20, // Super telephoto equivalent
		max: 90, // Wide angle
		default: DEFAULT_STATE.fov // Standard lens
	},
	focusDistance: {
		min: 0.3, // 30cm - close focus
		max: 100.0, // 100m - distant focus
		default: DEFAULT_STATE.focusDistance // 2m - standard middle distance
	},
	aperture: {
		options: [ 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0 ],
		default: DEFAULT_STATE.aperture // f/5.6 - good balance between depth of field and sharpness
	},
	focalLength: {
		min: 16, // Ultra wide angle
		max: 200, // Telephoto
		default: DEFAULT_STATE.focalLength // Standard lens
	}
};

// Define photography presets
const CAMERA_PRESETS = {
	sharp: {
		name: "Sharp",
		description: "Infinite focus, everything in focus",
		fov: 65,
		focusDistance: 0,
		aperture: 16.0,
		focalLength: 0
	},
	portrait: {
		name: "Portrait",
		description: "Shallow depth of field, background blur",
		fov: 45,
		focusDistance: 1.5,
		aperture: 2.0,
		focalLength: 85
	},
	landscape: {
		name: "Landscape",
		description: "Maximum depth of field, everything in focus",
		fov: 65,
		focusDistance: 10.0,
		aperture: 11.0,
		focalLength: 24
	},
	macro: {
		name: "Macro",
		description: "Extreme close-up with thin focus plane",
		fov: 40,
		focusDistance: 0.3,
		aperture: 2.8,
		focalLength: 100
	},
	product: {
		name: "Product",
		description: "Sharp detail with subtle background separation",
		fov: 50,
		focusDistance: 0.8,
		aperture: 5.6,
		focalLength: 50
	},
	architectural: {
		name: "Architectural",
		description: "Wide view with deep focus",
		fov: 75,
		focusDistance: 5.0,
		aperture: 8.0,
		focalLength: 16
	},
	cinematic: {
		name: "Cinematic",
		description: "Dramatic depth separation",
		fov: 40,
		focusDistance: 3.0,
		aperture: 1.4,
		focalLength: 135
	}
};

const useCameraStore = create( ( set ) => ( {
	...DEFAULT_STATE,
	activePreset: "custom",
	cameraNames: [], setCameraNames: ( names ) => set( { cameraNames: names } ),
	selectedCameraIndex: 0, setSelectedCameraIndex: ( index ) => set( { selectedCameraIndex: index } ),
	setFov: ( value ) => set( { fov: value, activePreset: "custom" } ),
	setFocusDistance: ( value ) => set( { focusDistance: value, activePreset: "custom" } ),
	setAperture: ( value ) => set( { aperture: value, activePreset: "custom" } ),
	setFocalLength: ( value ) => set( { focalLength: value, activePreset: "custom" } ),
	setPreset: ( presetKey ) => {

		if ( presetKey === "custom" ) return;
		const preset = CAMERA_PRESETS[ presetKey ];
		set( {
			fov: preset.fov,
			focusDistance: preset.focusDistance,
			aperture: preset.aperture,
			focalLength: preset.focalLength,
			activePreset: presetKey
		} );

	}
} ) );

const CameraTab = () => {

	const { fov, focusDistance, aperture, focalLength, activePreset, cameraNames, selectedCameraIndex, setFov, setFocusDistance, setAperture, setFocalLength, setPreset, setCameraNames, setSelectedCameraIndex } = useCameraStore();

	useEffect( () => {

		if ( window.pathTracerApp ) {

			setCameraNames( window.pathTracerApp.getCameraNames() );
			setSelectedCameraIndex( window.pathTracerApp.currentCameraIndex );

		}

	}, [] );

	const handlePresetChange = ( presetKey ) => {

		setPreset( presetKey );
		if ( presetKey === "custom" ) return;
		const preset = CAMERA_PRESETS[ presetKey ];
		if ( window.pathTracerApp ) {

			window.pathTracerApp.camera.fov = preset.fov;
			window.pathTracerApp.camera.updateProjectionMatrix();
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = preset.focusDistance * window.pathTracerApp.sceneScale;
			window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = preset.aperture;
			window.pathTracerApp.pathTracingPass.material.uniforms.focalLength.value = preset.focalLength;
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

			const scaledFocusDistance = value * window.pathTracerApp.sceneScale;
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = scaledFocusDistance;
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

	const handleCameraMove = ( point ) => {

		if ( ! window.pathTracerApp || ! window.pathTracerApp.controls ) return;

		const controls = window.pathTracerApp.controls;
		const camera = window.pathTracerApp.camera;

		const target = controls.target.clone();
		const distance = camera.position.distanceTo( target );
		const phi = remap( point.y, 0, 100, 0, - Math.PI );
		const theta = remap( point.x, 0, 100, 0, - Math.PI );

		const newX = target.x + distance * Math.sin( phi ) * Math.cos( theta );
		const newY = target.y + distance * Math.cos( phi );
		const newZ = target.z + distance * Math.sin( phi ) * Math.sin( theta );

		camera.position.set( newX, newY, newZ );
		camera.lookAt( target );
		controls.update();

	};

	const handleCameraChange = ( index ) => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.switchCamera( index );
			setSelectedCameraIndex( index );

		}

	};

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
				<Select value={activePreset} onValueChange={handlePresetChange}>
					<span className="opacity-50 text-xs truncate">Camera Preset</span>
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
					label={"FOV"}
					min={CAMERA_RANGES.fov.min}
					max={CAMERA_RANGES.fov.max}
					step={5}
					value={[ fov ]}
					onValueChange={handleFovChange}
				/>
			</div>

			<div className="flex items-center justify-between">
				<Slider
					label={"Focal Distance (m)"}
					icon={Telescope}
					min={CAMERA_RANGES.focusDistance.min}
					max={CAMERA_RANGES.focusDistance.max}
					step={0.1}
					value={[ focusDistance ]}
					onValueChange={handleFocusDistanceChange}
				/>
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
