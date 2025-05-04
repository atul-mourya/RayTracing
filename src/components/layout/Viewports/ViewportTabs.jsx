import { useRef } from 'react';
import MainViewport from './MainViewport';
import ResultsViewport from './ResultsViewport';
import RenderControls from './RenderControls';
import { useStore } from '@/store';

const ViewportTabs = () => {

	const appMode = useStore( state => state.appMode );
	const mainViewportRef = useRef( null );
	const resultsViewportRef = useRef( null );

	// Show controls only in interactive and final modes
	const showControls = appMode === "interactive" || appMode === "final";

	return (
		<div className="w-full h-full relative">
			{/* Keep MainViewport always in the DOM but hide it when on Results tab */}
			<div style={{ display: appMode !== "results" ? 'block' : 'none', width: '100%', height: '100%' }}>
				<MainViewport mode={appMode} ref={mainViewportRef} />
			</div>

			{/* Results viewport - only show when results tab is active */}
			{appMode === "results" && (
				<div style={{ width: '100%', height: '100%' }}>
					<ResultsViewport ref={resultsViewportRef} />
				</div>
			)}

			{/* Unity-style controls overlay - only shown in interactive and final modes */}
			{showControls && (
				<RenderControls pathTracerApp={window.pathTracerApp} />
			)}
		</div>
	);

};

export default ViewportTabs;
