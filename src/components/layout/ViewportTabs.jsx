import { useState, useEffect } from 'react';
import MainViewport from './MainViewport';
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore, usePathTracerStore } from '@/store'; // Import the path tracer store

const ViewportTabs = () => {

	const [ activeTab, setActiveTab ] = useState( "interactive" );
	const setAppMode = useStore( state => state.setAppMode );
	const setBounces = usePathTracerStore( state => state.setBounces );
	const setSamplesPerPixel = usePathTracerStore( state => state.setSamplesPerPixel );
	const setInteractionModeEnabled = usePathTracerStore( state => state.setInteractionModeEnabled );
	const setEnableOIDN = usePathTracerStore( state => state.setEnableOIDN );
	const setResolution = usePathTracerStore( state => state.setResolution );

	// Update app mode when tab changes
	useEffect( () => {

		// Update our global mode state when tab changes
		setAppMode( activeTab );

		// Configure the renderer settings based on mode
		if ( activeTab === "interactive" ) {

			setBounces( 2 );
			setSamplesPerPixel( 1 );
			setInteractionModeEnabled( true );
			setEnableOIDN( false );
			setResolution( '1' );
			window.pathTracerApp.updateResolution( window.devicePixelRatio * 0.5 );
			window.pathTracerApp.controls.enabled = true;

		} else {

			setBounces( 8 );
			setSamplesPerPixel( 4 );
			setInteractionModeEnabled( false );
			setEnableOIDN( true );
			setResolution( '3' );
			window.pathTracerApp.updateResolution( window.devicePixelRatio * 2.0 );
			window.pathTracerApp.controls.enabled = false;

		}

	}, [ activeTab, setAppMode, setBounces, setSamplesPerPixel, setInteractionModeEnabled, setEnableOIDN, setResolution ] );

	const handleTabChange = ( value ) => {

		setActiveTab( value );

	};

	return (
		<div className="w-full h-full relative">
			{/* Single viewport that's always rendered */}
			<MainViewport mode={activeTab} />

			{/* Tabs UI overlay */}
			<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-10">
				<Tabs
					defaultValue="interactive"
					value={activeTab}
					onValueChange={handleTabChange}
				>
					<TabsList>
						<TabsTrigger value="interactive">Interactive</TabsTrigger>
						<TabsTrigger value="final">Final Render</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
		</div>
	);

};

export default ViewportTabs;
