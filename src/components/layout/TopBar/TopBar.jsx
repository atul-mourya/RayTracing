import { useMemo, useCallback } from 'react';
import { Menu } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';
import AuthProvider from './AuthProvider';
import MenuBar from './MenuBar';
import ViewportTabs from './ViewportTabs';
import ActionBar from './ActionBar';
import ImportUrlModal from './ImportUrlModal';
import { usePathTracerCanvas } from '@/hooks/use-path-tracer-canvas';
import { useImportUrl } from '@/hooks/use-import-url';

const TopBar = () => {

	// Get the store values and actions
	const appMode = useStore( state => state.appMode );
	const setAppMode = useStore( state => state.setAppMode );

	// Access the path tracer store actions
	const pathTracerStore = usePathTracerStore();

	// Memoize the store actions to prevent re-renders
	const pathTracerActions = useMemo( () => ( {
		setBounces: pathTracerStore.setBounces,
		setSamplesPerPixel: pathTracerStore.setSamplesPerPixel,
		setInteractionModeEnabled: pathTracerStore.setInteractionModeEnabled,
		setEnableOIDN: pathTracerStore.setEnableOIDN,
		setUseGBuffer: pathTracerStore.setUseGBuffer,
		setResolution: pathTracerStore.setResolution,
		setRenderMode: pathTracerStore.setRenderMode,
		setOidnQuality: pathTracerStore.setOidnQuality,
	} ), [ pathTracerStore ] );

	// Use custom hooks
	const { configureForMode } = usePathTracerCanvas();
	const {
		modalState,
		openImportModal,
		closeImportModal,
		setImportUrl,
		handleImportFromUrl
	} = useImportUrl();

	// Handle tab change
	const handleTabChange = useCallback( ( value ) => {

		// Only update if value has changed
		if ( value !== appMode ) {

			configureForMode( value, pathTracerActions );
			setAppMode( value );

		}

	}, [ appMode, setAppMode, configureForMode, pathTracerActions ] );

	// Handle GitHub redirect
	const handleGithubRedirection = useCallback( () => {

		window.open( 'https://github.com/atul-mourya/RayTracing', '_blank' );

	}, [] );

	// Memoize the logo
	const logo = useMemo( () => (
		<div className="flex items-center space-x-2 mr-4 px-2">
			<Menu size={18} />
			<span className="font-semibold">RayCanvas</span>
		</div>
	), [] );

	return (
		<AuthProvider>
			{ ( { user, handleLoginClick, handleSignOut } ) => (
				<div className="flex items-center h-[48px] border-b border-[#4a4a4a]">
					{logo}
					<MenuBar onOpenImportModal={openImportModal} />

					<div className="grow" />
					<ViewportTabs currentMode={appMode} onModeChange={handleTabChange} />
					<div className="grow" />

					<ActionBar
						user={user}
						onLoginClick={handleLoginClick}
						onSignOut={handleSignOut}
						onGithubClick={handleGithubRedirection}
					/>

					<ImportUrlModal
						isOpen={modalState.isImportModalOpen}
						onClose={closeImportModal}
						importUrl={modalState.importUrl}
						setImportUrl={setImportUrl}
						onImport={handleImportFromUrl}
						isImporting={modalState.isImporting}
					/>
				</div>
			) }
		</AuthProvider>
	);

};

export default TopBar;
