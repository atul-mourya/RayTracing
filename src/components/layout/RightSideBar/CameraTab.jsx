import { Ruler, Telescope, Aperture, Camera, Target } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trackpad } from "@/components/ui/trackpad";
import { remap } from "@/lib/utils";
import { CAMERA_RANGES, CAMERA_PRESETS } from '@/Constants';
import { useCameraStore } from '@/store';
import { useEffect } from 'react';
import { FieldOfView } from "@/assets/icons";

const CameraTab = () => {

	const {
		fov, focusDistance, aperture, focalLength, activePreset, focusMode,
		cameraNames, selectedCameraIndex,
		setFov, setFocusDistance, setAperture, setFocalLength,
		setPreset, setCameraNames, setSelectedCameraIndex, setFocusMode
	} = useCameraStore();

	useEffect( () => {

		if ( window.pathTracerApp ) {

			// Set up camera names and initial selection
			setCameraNames( window.pathTracerApp.getCameraNames() );
			setSelectedCameraIndex( window.pathTracerApp.currentCameraIndex );

			// Initialize click-to-focus functionality
			window.pathTracerApp.setupClickToFocus();

			// Listen for focus change events
			window.pathTracerApp.addEventListener( 'focusChanged', handleFocusChangeEvent );

			// Clean up event listener on component unmount
			return () => {

				window.pathTracerApp.removeEventListener( 'focusChanged', handleFocusChangeEvent );

			};

		}

	}, [] );

	// Handle focus change events from the 3D view
	const handleFocusChangeEvent = ( event ) => {

		// Update the focus distance slider with the new value
		setFocusDistance( event.distance );
		setFocusMode( false );

	};

	// Toggle focus mode
	const handleToggleFocusMode = () => {

		if ( window.pathTracerApp ) {

			const isActive = window.pathTracerApp.toggleFocusMode();
			console.log( 'Focus mode:', isActive ? 'enabled' : 'disabled' );
			setFocusMode( isActive );

		}

	};

	// Update focus distance from slider
	const handleFocusDistanceChange = ( value ) => {

		setFocusDistance( value );
		if ( window.pathTracerApp ) {

			// Get scene scale factor for proper scaling
			const sceneScale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;
			const scaledFocusDistance = value * sceneScale;
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = scaledFocusDistance;
			window.pathTracerApp.reset();

		}

	};

	const handlePresetChange = ( presetKey ) => {

		setPreset( presetKey );
		if ( presetKey === "custom" ) return;

		const preset = CAMERA_PRESETS[ presetKey ];
		if ( window.pathTracerApp ) {

			// Get scene scale factor
			const sceneScale = window.pathTracerApp.assetLoader?.getSceneScale() || 1.0;

			// Update Three.js camera
			window.pathTracerApp.camera.fov = preset.fov;
			window.pathTracerApp.camera.updateProjectionMatrix();

			// Update path tracer uniforms
			window.pathTracerApp.pathTracingPass.material.uniforms.focusDistance.value = preset.focusDistance * sceneScale;
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

			// Ensure focal length is properly set
			window.pathTracerApp.pathTracingPass.material.uniforms.focalLength.value = value;

			// If focal length is 0, ensure aperture is set to disable DOF
			if ( value <= 0 ) {

				window.pathTracerApp.pathTracingPass.material.uniforms.aperture.value = 16.0;

			}

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

	const handleApertureScaleChange = ( value ) => {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.pathTracingPass.material.uniforms.apertureScale.value = value;
			window.pathTracerApp.reset();

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
					icon={FieldOfView}
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
					max={5.0}
					step={0.1}
					value={[ 2.0 ]} // Default value
					onValueChange={( values ) => handleApertureScaleChange( values[ 0 ] )}
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
