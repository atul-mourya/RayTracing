import { useState } from 'react';
import { Ruler, Telescope, Aperture } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trackpad } from "@/components/ui/trackpad";
import { remap } from "@/lib/utils";
import { DEFAULT_STATE } from '../../core/Processor/Constants';

const CameraTab = () => {

	const [ fov, setFov ] = useState( DEFAULT_STATE.fov );
	const [ focusDistance, setFocusDistance ] = useState( DEFAULT_STATE.focusDistance );
	const [ aperture, setAperture ] = useState( DEFAULT_STATE.aperture );
	const [ focalLength, setFocalLength ] = useState( DEFAULT_STATE.focalLength );

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

	const handleCameraMove = ( point ) => {

		if ( ! window.pathTracerApp || ! window.pathTracerApp.controls ) return;

		const controls = window.pathTracerApp.controls;
		const camera = window.pathTracerApp.camera;

		const target = controls.target.clone();
		const distance = camera.position.distanceTo( target );
		const phi = remap( point.y, 0, 100, 0, - Math.PI );
		const theta = remap( point.x, 0, 100, 0, - Math.PI );

		// Calculate the new camera position in spherical coordinates
		const newX = target.x + distance * Math.sin( phi ) * Math.cos( theta );
		const newY = target.y + distance * Math.cos( phi ); // Adjusts for vertical position
		const newZ = target.z + distance * Math.sin( phi ) * Math.sin( theta );

		camera.position.set( newX, newY, newZ );
		camera.lookAt( target ); // Ensure the camera still looks at the target
		controls.update();

	};

	const cameraPoints = [
		{ x: 0, y: 50, }, // left view
		{ x: 50, y: 50, }, // front view
		{ x: 100, y: 50, }, // right view
		{ x: 50, y: 0, }, // top view
		{ x: 50, y: 100, }, // bottom view
		{ x: 25, y: 25, }, // top left view
		{ x: 75, y: 25, }, // top right view
		{ x: 25, y: 75, }, // bottom left view
		{ x: 75, y: 75, }, // bottom right view
	];

	return (
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
			<div className="flex items-center justify-between">
				<Trackpad label={"Camera Position"} points={cameraPoints} onMove={handleCameraMove} className="w-[110px] h-[110px]"/>
			</div>
		</div>
	);

};

export default CameraTab;
